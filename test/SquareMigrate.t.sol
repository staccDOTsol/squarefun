// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SquareMigrate} from "../contracts/src/square/SquareMigrate.sol";
import {MigrateFactory} from "../contracts/src/square/MigrateFactory.sol";
import {ScoopBatch} from "../contracts/src/square/ScoopBatch.sol";
import {IVenue, IBuyer} from "../contracts/src/square/venues/IVenue.sol";
import {PonsCurveVenue, CurveBuyer, IPonsCurve, IPonsFactory} from "../contracts/src/square/venues/PonsCurveVenue.sol";
import {ReferenceFeeERC20} from "../contracts/src/v2/ReferenceFeeERC20.sol";

contract Plain is ERC20 {
    constructor() ERC20("Twin", "TWIN") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract SquareLike is ReferenceFeeERC20 {
    constructor(address beneficiary_) ERC20("Square", "SQUARE") ReferenceFeeERC20(beneficiary_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev A Pons-shaped factory: token → curve.
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

/// @dev Constant-product curve with a 1% fee, native quote. Same shape as Pons/Square curves.
contract CurveStub is IPonsCurve {
    IERC20 public token;
    uint256 public q; // quote reserve incl. phantom
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

    function setGraduated(bool g) external {
        graduated = g;
    }

    function readyToGraduate() external pure returns (bool) {
        return false;
    }

    function isNativeQuote() external pure returns (bool) {
        return true;
    }

    function buy(uint256 quoteIn, uint256 minOut, address to) external payable returns (uint256 out) {
        require(!graduated, "grad");
        require(msg.value == quoteIn, "value");
        uint256 net = quoteIn * 99 / 100;
        out = t * net / (q + net);
        require(out >= minOut, "slip");
        q += net;
        t -= out;
        token.transfer(to, out);
    }

    function sell(uint256 tokensIn, uint256 minOut, address to) external returns (uint256 out) {
        require(!graduated, "grad");
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

contract SquareMigrateTest is Test {
    address sink = address(0x51);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address keeper = address(0xEE);

    Plain twin;
    SquareLike square;
    CurveStub twinCurve;
    CurveStub squareCurve;
    FactoryStub ponsFactory;
    PonsCurveVenue venue;
    CurveBuyer buyer;
    MigrateFactory factory;
    SquareMigrate m;

    uint64 constant EPOCH = 1 days;

    function params() internal view returns (SquareMigrate.Params memory) {
        return SquareMigrate.Params({
            start: uint64(vm.getBlockTimestamp()),
            epochLength: EPOCH,
            epochs: 3,
            decayBps: 1_000, // 100%, 90%, 80%
            mandate: 100_000e18,
            sellCapBps: 2_500, // a quarter of what is left per trade
            cooldown: 10 minutes,
            maxImpactBps: 1_500,
            recoverWindow: 7 days,
            vestLength: 3 days,
            claimWindow: 90 days
        });
    }

    function setUp() public {
        vm.warp(1_000_000);
        twin = new Plain();
        square = new SquareLike(sink);
        // twin curve: 1M tokens against 10 ETH of quote; square curve: 800M against 1.78 ETH
        twinCurve = new CurveStub(IERC20(address(twin)), 10 ether, 1_000_000e18);
        squareCurve = new CurveStub(IERC20(address(square)), 1.78 ether, 800_000_000e18);
        vm.deal(address(twinCurve), 10 ether);
        square.mint(address(squareCurve), 800_000_000e18);
        twin.mint(alice, 300_000e18);
        twin.mint(bob, 100_000e18);
        ponsFactory = new FactoryStub();
        ponsFactory.set(address(twin), address(twinCurve));
        venue = new PonsCurveVenue(ponsFactory);
        buyer = new CurveBuyer(squareCurve, IERC20(address(square)));
        IVenue[] memory vs = new IVenue[](1);
        vs[0] = venue;
        factory = new MigrateFactory(IERC20(address(square)), buyer, sink, vs);
        m = factory.create(address(twin), params());
    }

    function test_batchScoopsAWallet() public {
        ScoopBatch batch = new ScoopBatch(factory);
        // a second dead token with its own curve
        Plain other = new Plain();
        CurveStub otherCurve = new CurveStub(IERC20(address(other)), 2 ether, 500_000e18);
        vm.deal(address(otherCurve), 2 ether);
        ponsFactory.set(address(other), address(otherCurve));
        other.mint(alice, 40_000e18);
        // one with no market: skipped by preview, would revert in scoop
        Plain dead = new Plain();
        dead.mint(alice, 5e18);

        address[] memory toks = new address[](3);
        toks[0] = address(twin);
        toks[1] = address(other);
        toks[2] = address(dead);
        (bool[] memory ok, bool[] memory needsNew) = batch.preview(toks);
        assertTrue(ok[0] && ok[1] && !ok[2]);
        assertFalse(needsNew[0], "twin already has an open takeover");
        assertTrue(needsNew[1], "other needs one");

        address[] memory go = new address[](2);
        go[0] = address(twin);
        go[1] = address(other);
        uint256[] memory amts = new uint256[](2); // zeros: whole balance
        vm.startPrank(alice, alice);
        twin.approve(address(batch), type(uint256).max);
        other.approve(address(batch), type(uint256).max);
        address[] memory ms = batch.scoop(go, amts, params());
        vm.stopPrank();
        assertEq(ms[0], address(m), "reused the open takeover");
        assertEq(factory.count(), 2, "created one for other");
        assertEq(SquareMigrate(payable(ms[0])).deposited(alice), 300_000e18);
        assertEq(SquareMigrate(payable(ms[1])).deposited(alice), 40_000e18);
        assertEq(twin.balanceOf(address(batch)), 0);
        assertEq(other.balanceOf(address(batch)), 0);
        assertEq(twin.balanceOf(alice), 0);
    }

    function test_factoryGuards() public {
        SquareMigrate.Params memory p = params();
        // no market → no scoop
        Plain nothing = new Plain();
        vm.expectRevert(MigrateFactory.NoMarket.selector);
        factory.create(address(nothing), p);
        // can't scoop $SQUARE into itself
        vm.expectRevert(MigrateFactory.BadVenue.selector);
        factory.create(address(square), p);
        // terms have floors
        p.epochLength = 1 minutes;
        vm.expectRevert(MigrateFactory.Terms.selector);
        factory.create(address(twin), p);
        assertEq(factory.count(), 1);
        assertEq(address(factory.venueFor(address(twin))), address(venue));
        assertEq(factory.byToken(address(twin)).length, 1);
    }

    function depositAll(address who) internal {
        vm.startPrank(who, who);
        twin.approve(address(m), type(uint256).max);
        m.deposit(twin.balanceOf(who));
        vm.stopPrank();
    }

    function test_epochsCreditLess() public {
        depositAll(alice); // epoch 0: 1:1
        assertEq(m.credits(alice), 300_000e18);
        vm.warp(vm.getBlockTimestamp() + EPOCH + 1);
        depositAll(bob); // epoch 1: 90%
        assertEq(m.credits(bob), 90_000e18);
        vm.warp(vm.getBlockTimestamp() + 2 * EPOCH);
        vm.prank(bob, bob);
        vm.expectRevert(SquareMigrate.DepositsClosed.selector);
        m.deposit(1);
    }

    function test_fullFlow() public {
        depositAll(alice);
        depositAll(bob);
        // nothing sells in epoch 0
        vm.prank(keeper, keeper);
        vm.expectRevert(SquareMigrate.NotYet.selector);
        m.recover();
        vm.warp(vm.getBlockTimestamp() + EPOCH + 1);

        // recovery: quarter of what's left each time, cooldown between
        uint256 rounds;
        while (m.remaining() > 0 && rounds < 200) {
            vm.prank(keeper, keeper);
            m.recover();
            rounds++;
            vm.warp(vm.getBlockTimestamp() + 10 minutes);
        }
        assertEq(m.remaining(), 0);
        assertGt(m.recovered(), 0);
        assertEq(address(m).balance, m.recovered());
        // it had 400k of a 1M-token curve: recovered a meaningful chunk of the 10 ETH
        assertGt(m.recovered(), 2 ether);

        // convert into $SQUARE
        vm.prank(keeper, keeper);
        m.convert(0);
        assertTrue(m.converted());
        assertEq(address(m).balance, 0);
        assertGt(m.totalSquare(), 0);
        assertEq(square.balanceOf(address(m)), m.totalSquare());

        // the stub curve is not fee-exempt like the real one, so move past the conversion block
        vm.roll(vm.getBlockNumber() + 2048);
        // vesting: nothing at t0, half at half, all after
        assertEq(m.claimable(alice), 0);
        vm.warp(vm.getBlockTimestamp() + 1.5 days);
        uint256 half = m.totalSquare() * 3 / 4 / 2;
        assertApproxEqRel(m.claimable(alice), half, 1e12);
        vm.prank(alice, alice);
        uint256 got = m.claim();
        assertApproxEqRel(got, half, 1e12);
        // a new block, so the second claim is that block's first $SQUARE reference and pays nothing
        vm.roll(vm.getBlockNumber() + 2048);
        vm.warp(vm.getBlockTimestamp() + 5 days);
        vm.prank(alice, alice);
        m.claim();
        assertApproxEqRel(square.balanceOf(alice), m.totalSquare() * 3 / 4, 1e12);
        // bob never claims; after the window the rest goes to the sink
        vm.expectRevert(SquareMigrate.NotYet.selector);
        m.sweep();
        vm.roll(vm.getBlockNumber() + 2048);
        vm.warp(vm.getBlockTimestamp() + 90 days);
        m.sweep();
        assertApproxEqRel(square.balanceOf(sink), m.totalSquare() / 4, 1e12);
        assertEq(square.balanceOf(address(m)), 0);
    }

    function test_mandateMissedRescues() public {
        depositAll(bob); // 100k... exactly the mandate; use a smaller one
        vm.warp(vm.getBlockTimestamp() + EPOCH + 1);
        // bob alone meets the mandate exactly (100k); make a fresh migrate with a higher mandate
        SquareMigrate.Params memory p = params();
        p.mandate = 1_000_000e18;
        p.start = uint64(vm.getBlockTimestamp());
        SquareMigrate m2 = factory.create(address(twin), p);
        vm.startPrank(alice, alice);
        twin.approve(address(m2), type(uint256).max);
        m2.deposit(300_000e18);
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + EPOCH + 1);
        vm.prank(keeper, keeper);
        vm.expectRevert(SquareMigrate.MandateMissed.selector);
        m2.recover();
        assertFalse(m2.failed());
        vm.warp(vm.getBlockTimestamp() + 3 * EPOCH);
        assertTrue(m2.failed());
        vm.prank(alice, alice);
        m2.rescue();
        assertEq(twin.balanceOf(alice), 300_000e18);
        vm.prank(alice, alice);
        vm.expectRevert(SquareMigrate.AlreadyRescued.selector);
        m2.rescue();
    }

    function test_graduatedTwinRescuesWithPartialRecovery() public {
        depositAll(alice);
        depositAll(bob);
        vm.warp(vm.getBlockTimestamp() + EPOCH + 1);
        vm.prank(keeper, keeper);
        m.recover();
        uint256 soldSoFar = 400_000e18 - m.remaining();
        assertGt(soldSoFar, 0);
        // the twin graduates mid-way: sells revert from now on
        twinCurve.setGraduated(true);
        vm.warp(vm.getBlockTimestamp() + 10 minutes);
        vm.prank(keeper, keeper);
        vm.expectRevert();
        m.recover();
        // past the deadline with tokens unsold → rescue: everyone gets back their share of both
        vm.warp(m.recoverDeadline() + 1);
        assertTrue(m.failed());
        uint256 ethBefore = alice.balance;
        vm.prank(alice, alice);
        m.rescue();
        assertEq(twin.balanceOf(alice), m.remaining() * 3 + 0 == 0 ? 0 : twin.balanceOf(alice)); // shape check below
        assertGt(alice.balance - ethBefore, 0);
        vm.prank(bob, bob);
        m.rescue();
        assertEq(m.remaining(), 0);
        assertEq(m.recovered(), 0);
        assertEq(address(m).balance, 0);
        assertEq(twin.balanceOf(alice), twin.balanceOf(bob) * 3);
    }
}
