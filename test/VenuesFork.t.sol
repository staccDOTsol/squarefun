// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IVenue} from "../contracts/src/square/venues/IVenue.sol";
import {PonsCurveVenue, CurveBuyer, IPonsCurve, IPonsFactory} from "../contracts/src/square/venues/PonsCurveVenue.sol";
import {V4Venue} from "../contracts/src/square/venues/V4Venue.sol";
import {UniV3Venue, IUniV3Factory, ISwapRouter02} from "../contracts/src/square/venues/UniV3Venue.sol";
import {UniV2Venue, IUniV2Factory, IUniV2Router} from "../contracts/src/square/venues/UniV2Venue.sol";
import {MigrateFactory} from "../contracts/src/square/MigrateFactory.sol";
import {SquareMigrate} from "../contracts/src/square/SquareMigrate.sol";

interface IWETH9 {
    function deposit() external payable;
}

/// @dev Live Robinhood state. Run: forge test --match-path test/VenuesFork.t.sol --fork-url $RPC
contract VenuesForkTest is Test {
    address constant SQUARE = 0x0E2d71875adFFB2107Eb2c0094060651dFef8Ee8;
    address constant SQUARE_CURVE = 0xF207F7E7AABfd10F3BA4612Daf63d044814BBB29;
    address constant LEGACY_SINK = 0x2E1cf32C1A760bd1603de762D51Fb2A30F271C35;
    address constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant PONS_HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant ROUTER02 = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant V2_FACTORY = 0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f;
    address constant V2_ROUTER = 0x89e5DB8B5aA49aA85AC63f691524311AEB649eba;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    // real tokens, picked from chain logs on 2026-09-28
    address constant ON_CURVE = 0x8E18157341e00910aDcC6fCd587EFEa7a7Ed6Bd3;
    address constant GRADUATED = 0x3A16C2753A9c9369689D5F93D7e92CC65F28786D;
    address constant V1_TOKEN = 0x77D1C7841AE2cb02858D8BD4Ce4f65644b14EeC6;

    PonsCurveVenue curveVenue;
    V4Venue v4Venue;
    UniV3Venue v3Venue;
    UniV2Venue v2Venue;
    MigrateFactory factory;

    receive() external payable {}

    function setUp() public {
        if (block.chainid != 4663) return;
        curveVenue = new PonsCurveVenue(IPonsFactory(PONS_FACTORY));
        v4Venue = new V4Venue(IPoolManager(POOL_MANAGER), IPonsFactory(PONS_FACTORY), IHooks(PONS_HOOK));
        v3Venue = new UniV3Venue(IUniV3Factory(V3_FACTORY), ISwapRouter02(ROUTER02), WETH);
        v2Venue = new UniV2Venue(IUniV2Factory(V2_FACTORY), IUniV2Router(V2_ROUTER), WETH);
        IVenue[] memory vs = new IVenue[](4);
        vs[0] = curveVenue;
        vs[1] = v4Venue;
        vs[2] = v3Venue;
        vs[3] = v2Venue;
        factory = new MigrateFactory(IERC20(SQUARE), new CurveBuyer(IPonsCurve(SQUARE_CURVE), IERC20(SQUARE)), LEGACY_SINK, vs);
    }

    modifier onFork() {
        if (block.chainid != 4663) return;
        _;
    }

    /// @dev Tokens come from a real buy, never from `deal`: a curve's accounting cannot absorb
    ///      tokens that were never sold.
    function _acquire(address token, uint256 ethIn) internal returns (uint256 amount) {
        vm.deal(address(this), ethIn + 1 ether);
        IPonsFactory.Launch memory l = IPonsFactory(PONS_FACTORY).getLaunchedToken(token);
        if (l.exists && l.phase == 0) {
            IPonsCurve(l.curve).buy{value: ethIn}(ethIn, 0, address(this));
        } else if (l.exists) {
            // graduated into v4: a tiny dealt amount is fine, the pool does not track supply
            deal(token, address(this), 1_000e18);
        } else {
            // v3 (Pons v1 shape): buy through the router so the token sees a real transfer
            (, uint24 fee) = v3Venue.bestPool(token);
            IWETH9(WETH).deposit{value: ethIn}();
            IERC20(WETH).approve(ROUTER02, ethIn);
            ISwapRouter02(ROUTER02).exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: WETH,
                    tokenOut: token,
                    fee: fee,
                    recipient: address(this),
                    amountIn: ethIn,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            );
        }
        amount = IERC20(token).balanceOf(address(this));
    }

    function _trySell(IVenue v, address token, uint256) internal returns (uint256 out) {
        uint256 amount = _acquire(token, 0.01 ether);
        IERC20(token).approve(address(v), amount);
        uint256 s = v.spot(token);
        uint256 expected = amount * s / 1e18;
        out = v.sell(token, amount, expected * 80 / 100);
        assertGt(out, 0, "sold for nothing");
        assertLe(out, expected * 101 / 100, "more than spot?");
    }

    function test_curveVenue() public onFork {
        assertTrue(curveVenue.canSell(ON_CURVE), "on curve");
        assertEq(address(factory.venueFor(ON_CURVE)), address(curveVenue));
        uint256 out = _trySell(curveVenue, ON_CURVE, 1_000e18);
        emit log_named_uint("curve sell 1000 to wei", out);
    }

    function test_v4Venue() public onFork {
        assertFalse(curveVenue.canSell(GRADUATED), "left the curve");
        assertTrue(v4Venue.canSell(GRADUATED), "has a v4 pool");
        assertEq(address(factory.venueFor(GRADUATED)), address(v4Venue));
        uint256 out = _trySell(v4Venue, GRADUATED, 1_000e18);
        emit log_named_uint("v4 sell 1000 to wei", out);
    }

    function test_v3Venue() public onFork {
        assertTrue(v3Venue.canSell(V1_TOKEN), "has a v3 pool");
        assertEq(address(factory.venueFor(V1_TOKEN)), address(v3Venue));
        uint256 out = _trySell(v3Venue, V1_TOKEN, 1_000e18);
        emit log_named_uint("v3 sell 1000 to wei", out);
    }

    function test_scoopEndToEnd() public onFork {
        SquareMigrate m = factory.create(
            ON_CURVE,
            SquareMigrate.Params({
                start: 0,
                epochLength: 10 minutes,
                epochs: 2,
                decayBps: 1_000,
                mandate: 0,
                sellCapBps: 5_000,
                cooldown: 30,
                maxImpactBps: 2_000,
                recoverWindow: 1 hours,
                vestLength: 1 hours,
                claimWindow: 7 days
            })
        );
        uint256 have = _acquire(ON_CURVE, 0.02 ether);
        IERC20(ON_CURVE).approve(address(m), type(uint256).max);
        m.deposit(have);
        vm.warp(vm.getBlockTimestamp() + 11 minutes);
        while (m.remaining() > 0) {
            m.recover();
            vm.warp(vm.getBlockTimestamp() + 31);
        }
        assertGt(m.recovered(), 0);
        m.convert(0);
        assertGt(m.totalSquare(), 0);
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + 2 hours);
        uint256 got = m.claim();
        assertEq(got, m.totalSquare());
        assertEq(IERC20(SQUARE).balanceOf(address(this)), got);
        emit log_named_uint("recovered wei", m.recovered());
        emit log_named_uint("square bought", m.totalSquare());
    }
}
