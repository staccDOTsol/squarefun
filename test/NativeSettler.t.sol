// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReferenceFeeERC20} from "../contracts/src/v2/ReferenceFeeERC20.sol";
import {SquareSink} from "../contracts/src/square/SquareSink.sol";
import {NativeSettler, IWETH, IStakePool} from "../contracts/src/square/NativeSettler.sol";
import {IVenue} from "../contracts/src/square/venues/IVenue.sol";
import {PonsCurveVenue, IPonsCurve, IPonsFactory} from "../contracts/src/square/venues/PonsCurveVenue.sol";

contract LaunchLike is ReferenceFeeERC20 {
    constructor(address settler_) ERC20("Launch", "LNCH") ReferenceFeeERC20(settler_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract Plain is ERC20 {
    constructor() ERC20("Square", "SQUARE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract WETHStub is ERC20, IWETH {
    constructor() ERC20("Wrapped Ether", "WETH") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }
}

contract FactoryStub is IPonsFactory {
    mapping(address => address) public curves;

    function set(address token, address curve) external {
        curves[token] = curve;
    }

    function getLaunchedToken(address token) external view returns (Launch memory l) {
        l.token = token;
        l.curve = curves[token];
        l.exists = curves[token] != address(0);
    }
}

contract CurveStub is IPonsCurve {
    IERC20 public token;
    uint256 public q;
    uint256 public t;
    bool public graduated;

    constructor(IERC20 token_, uint256 q_, uint256 t_) {
        token = token_;
        q = q_;
        t = t_;
    }

    receive() external payable {}

    function getReserves() external view returns (uint256, uint256) {
        return (q, t);
    }

    function readyToGraduate() external pure returns (bool) {
        return false;
    }

    function isNativeQuote() external pure returns (bool) {
        return true;
    }

    function buy(uint256 quoteIn, uint256 minOut, address to) external payable returns (uint256 out) {
        uint256 net = quoteIn * 99 / 100;
        out = t * net / (q + net);
        require(out >= minOut, "slip");
        q += net;
        t -= out;
        token.transfer(to, out);
    }

    function sell(uint256 tokensIn, uint256 minOut, address to) external returns (uint256 out) {
        token.transferFrom(msg.sender, address(this), tokensIn);
        uint256 gross = q * tokensIn / (t + tokensIn);
        out = gross * 99 / 100;
        require(out >= minOut, "slip");
        q -= gross;
        t += tokensIn;
        (bool ok,) = to.call{value: out}("");
        require(ok);
    }
}

contract NativeSettlerTest is Test {
    address constant BURN = 0x000000000000000000000000000000000000dEaD;
    address wizards = address(0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    WETHStub weth;
    SquareSink pool;
    Plain square; // the stake token (plain here; on chain it is the flagship launch)
    LaunchLike launch; // some other launch
    FactoryStub ponsFactory;
    PonsCurveVenue venue;
    NativeSettler settler;
    CurveStub launchCurve;

    function setUp() public {
        weth = new WETHStub();
        pool = new SquareSink(wizards, 2_000);
        ponsFactory = new FactoryStub();
        venue = new PonsCurveVenue(ponsFactory);
        IVenue[] memory vs = new IVenue[](1);
        vs[0] = venue;
        square = new Plain();
        pool.setSquare(address(square));
        settler = new NativeSettler(vs, IStakePool(address(pool)), weth);
        launch = new LaunchLike(address(settler));

        // a market for `launch`: 1M tokens against 10 ETH
        launchCurve = new CurveStub(IERC20(address(launch)), 10 ether, 1_000_000e18);
        vm.deal(address(launchCurve), 10 ether);
        launch.mint(address(launchCurve), 1_000_000e18);
        ponsFactory.set(address(launch), address(launchCurve));

        square.mint(alice, 1_000_000e18);
        square.mint(bob, 3_000_000e18);
        launch.mint(alice, 100_000e18);
        vm.roll(2048);
    }

    function test_walletCannotBeADestination() public {
        IVenue[] memory vs = new IVenue[](0);
        vm.expectRevert();
        new NativeSettler(vs, IStakePool(address(0xBEEF)), weth);
    }

    function test_feesSettleToBurnedEthAndStakedWeth() public {
        // alice and bob stake $SQUARE
        vm.startPrank(alice, alice);
        square.approve(address(pool), 1_000_000e18);
        pool.stake(1_000_000e18);
        vm.stopPrank();
        vm.roll(4096);
        vm.startPrank(bob, bob);
        square.approve(address(pool), 3_000_000e18);
        pool.stake(3_000_000e18);
        vm.stopPrank();
        vm.roll(6144);

        // a machine walks `launch` three times in one block: #3 pays 90 bp, all of it to the settler
        vm.startPrank(alice, alice);
        launch.transfer(bob, 10_000e18);
        launch.transfer(bob, 10_000e18);
        launch.transfer(bob, 10_000e18);
        vm.stopPrank();
        uint256 landed = launch.balanceOf(address(settler));
        assertGt(landed, 0, "fee landed in kind at the settler");
        assertEq(launch.balanceOf(BURN), 0, "nothing burned in kind any more");
        assertEq(settler.pending(address(launch)), landed);

        // anyone settles: tokens → ETH, half burned, half WETH to the pool, synced
        uint256 burnBefore = BURN.balance;
        vm.roll(8192);
        vm.prank(address(0xCA11), address(0xCA11));
        uint256 ethOut = settler.settle(address(launch), 0);
        assertGt(ethOut, 0);
        assertEq(BURN.balance - burnBefore, ethOut / 2, "half the ETH burned");
        assertEq(weth.balanceOf(address(pool)) + weth.balanceOf(wizards), ethOut - ethOut / 2, "half wrapped and staked");
        // the venue's own hop into the curve can be a reference; whatever it paid lands back here for next time
        assertLt(settler.pending(address(launch)), landed / 50, "at most a sliver waits for the next settle");
        assertEq(address(settler).balance, 0, "settler holds nothing");
        // the pool split it: wizards 20%, stakers 80% pro rata 1:3
        uint256 staked = ethOut - ethOut / 2;
        uint256 toWiz = staked * 2_000 / 10_000;
        assertEq(weth.balanceOf(wizards), toWiz);
        vm.roll(10240);
        assertEq(pool.claimable(alice, address(weth)), (staked - toWiz) / 4);
        assertEq(pool.claimable(bob, address(weth)), (staked - toWiz) * 3 / 4);
        vm.prank(bob, bob);
        uint256 got = pool.claim(address(weth), 50);
        assertEq(weth.balanceOf(bob), got);
    }

    function test_noMarketNoSettle() public {
        LaunchLike orphan = new LaunchLike(address(settler));
        orphan.mint(alice, 10_000e18);
        vm.startPrank(alice, alice);
        orphan.transfer(bob, 1_000e18);
        orphan.transfer(bob, 1_000e18);
        vm.stopPrank();
        assertGt(orphan.balanceOf(address(settler)), 0);
        vm.expectRevert(NativeSettler.NoMarket.selector);
        settler.settle(address(orphan), 0);
    }
}
