// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IVenue} from "../contracts/src/square/venues/IVenue.sol";
import {NativeSettler, IStakePool, IWETH} from "../contracts/src/square/NativeSettler.sol";
import {PoolsVenue} from "../contracts/src/square/pools/PoolsVenue.sol";
import {TokenMetadata} from "../contracts/src/square/pools/SquarePoolsToken.sol";
import {SquarePoolsTokenV2} from "../contracts/src/square/pools/SquarePoolsTokenV2.sol";
import {SquarePoolsTokenFactoryV2} from "../contracts/src/square/pools/SquarePoolsTokenFactoryV2.sol";

struct Distribution {
    address strategy;
    uint128 amount;
    bytes configData;
}

interface ILiquidityLauncher {
    function createToken(
        address factory,
        string calldata name,
        string calldata symbol,
        uint8 decimals,
        uint128 initialSupply,
        address recipient,
        bytes calldata tokenData
    ) external returns (address);
    function distributeToken(address token, Distribution calldata distribution, bytes32 salt) external;
    function multicall(bytes[] calldata data) external returns (bytes[] memory);
    function getGraffiti(address originalCreator) external pure returns (bytes32);
}

/// @dev A wallet's router: one transfer per swap, settled against the manager.
contract Trader is IUnlockCallback {
    using StateLibrary for IPoolManager;

    IPoolManager immutable manager;
    PoolsVenue immutable venue;

    constructor(IPoolManager m, PoolsVenue v) {
        manager = m;
        venue = v;
    }

    receive() external payable {}

    function buy(address token, uint256 ethIn, address to) external payable returns (uint256 out) {
        out = abi.decode(manager.unlock(abi.encode(true, token, ethIn, to, msg.sender)), (uint256));
    }

    /// @dev pulls `amount` from the caller straight to the manager, as the universal router does
    function sell(address token, uint256 amount) external returns (uint256 out) {
        out = abi.decode(manager.unlock(abi.encode(false, token, amount, msg.sender, msg.sender)), (uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (bool isBuy, address token, uint256 amount, address to, address payer) =
            abi.decode(data, (bool, address, uint256, address, address));
        PoolKey memory key = venue.keyFor(token);
        if (isBuy) {
            BalanceDelta d = manager.swap(
                key,
                SwapParams({zeroForOne: true, amountSpecified: -int256(amount), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
                ""
            );
            manager.settle{value: uint256(uint128(-d.amount0()))}();
            uint256 out = uint256(uint128(d.amount1()));
            manager.take(key.currency1, to, out);
            return abi.encode(out);
        }
        BalanceDelta s = manager.swap(
            key,
            SwapParams({zeroForOne: false, amountSpecified: -int256(amount), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1}),
            ""
        );
        manager.sync(key.currency1);
        IERC20(token).transferFrom(payer, address(manager), uint256(uint128(-s.amount1())));
        manager.settle();
        uint256 eth = uint256(uint128(s.amount0()));
        manager.take(key.currency0, to, eth);
        return abi.encode(eth);
    }
}

/// @dev Live Robinhood state. Run: forge test --match-path test/PoolsLaunchV2Fork.t.sol --fork-url $RPC -vv
contract PoolsLaunchV2ForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    address constant LAUNCHER = 0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0;
    address constant INSTANT = 0x23f8209572b4a1C2AD88A42749E830791Fb027f1;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant STAKE_POOL = 0x78CD5692961cd0dc9bC15327BF34cDc1bCdca41C;
    address payable constant NATIVE_SINK = payable(0x1c6fE80f37D97AaED55d9313a643b6dF0A59B3Dc);
    address constant ARB_SYS = 0x0000000000000000000000000000000000000064;
    uint128 constant SUPPLY = 1_000_000_000e18;

    PoolsVenue venue;
    NativeSettler settler;
    SquarePoolsTokenFactoryV2 factory;
    SquarePoolsTokenV2 cook;
    Trader router;
    uint256 blockNo;

    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bot = makeAddr("bot");

    function _roll() internal {
        blockNo += 1;
        vm.mockCall(ARB_SYS, abi.encodeWithSelector(bytes4(0xa3b1b31d)), abi.encode(blockNo));
        vm.roll(block.number + 1);
    }

    function setUp() public {
        if (block.chainid != 4663) return;
        // a fork cannot execute the ArbSys precompile, so the chain's block number is mocked
        blockNo = 80_000_000;
        vm.mockCall(ARB_SYS, abi.encodeWithSelector(bytes4(0xa3b1b31d)), abi.encode(blockNo));

        venue = new PoolsVenue(IPoolManager(POOL_MANAGER));
        IVenue[] memory vs = new IVenue[](1);
        vs[0] = venue;
        settler = new NativeSettler(vs, IStakePool(STAKE_POOL), IWETH(WETH), NATIVE_SINK);
        factory = new SquarePoolsTokenFactoryV2(address(settler));
        router = new Trader(IPoolManager(POOL_MANAGER), venue);

        bytes memory tokenData = abi.encode(
            TokenMetadata({
                description: "waiting for the cook? he is in the kitchen.",
                website: "https://squarefun.xyz",
                image: "https://squarefun.xyz/cook.png",
                xProofTweetId: 0
            })
        );
        address predicted = factory.getTokenAddress(
            "Second Helping", "MORE", SUPPLY, LAUNCHER, tokenData, LAUNCHER, ILiquidityLauncher(LAUNCHER).getGraffiti(creator)
        );
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(
            ILiquidityLauncher.createToken, (address(factory), "Second Helping", "MORE", 18, SUPPLY, LAUNCHER, tokenData)
        );
        calls[1] = abi.encodeCall(
            ILiquidityLauncher.distributeToken,
            (predicted, Distribution({strategy: INSTANT, amount: SUPPLY, configData: abi.encode(creator)}), bytes32(0))
        );
        vm.prank(creator, creator);
        ILiquidityLauncher(LAUNCHER).multicall(calls);
        cook = SquarePoolsTokenV2(predicted);

        vm.deal(alice, 10 ether);
        vm.deal(bot, 10 ether);
        vm.prank(alice);
        cook.approve(address(router), type(uint256).max);
        vm.prank(bot);
        cook.approve(address(router), type(uint256).max);
    }

    modifier onFork() {
        if (block.chainid != 4663) return;
        _;
    }

    function test_launch_lands_in_the_pool() public onFork {
        assertEq(cook.name(), "Second Helping");
        assertEq(cook.totalSupply(), SUPPLY);
        assertEq(cook.creator(), LAUNCHER);
        assertEq(cook.graffiti(), ILiquidityLauncher(LAUNCHER).getGraffiti(creator));
        assertEq(cook.sink(), address(settler));
        assertTrue(venue.canSell(address(cook)), "pool is live");
        assertEq(cook.referencesThisBlock(), 0, "the launch itself was not a reference");
        assertEq(cook.balanceOf(address(settler)), 0, "and paid nothing");
        assertGt(cook.balanceOf(POOL_MANAGER), SUPPLY * 999 / 1000, "supply is in the pool");
        console2.log("ETH per COOK at open, 1e18:", venue.spot(address(cook)));
        console2.log(cook.tokenURI());
    }

    function test_a_person_buys_and_sells_free() public onFork {
        _roll();
        vm.prank(alice, alice);
        uint256 got = router.buy{value: 0.05 ether}(address(cook), 0.05 ether, alice);
        assertEq(cook.balanceOf(alice), got, "bought, nothing taken");
        _roll();
        vm.prank(alice, alice);
        uint256 eth = router.sell(address(cook), got);
        assertGt(eth, 0.049 ether * 99 / 100);
        assertEq(cook.balanceOf(address(settler)), 0);
    }

    function test_third_in_a_block_pays_on_a_buy_and_cannot_sell() public onFork {
        _roll();
        vm.startPrank(bot, bot);
        uint256 a = router.buy{value: 0.05 ether}(address(cook), 0.05 ether, bot);
        uint256 b = router.buy{value: 0.05 ether}(address(cook), 0.05 ether, bot);
        assertEq(cook.balanceOf(bot), a + b, "two are free");
        uint256 c = router.buy{value: 0.05 ether}(address(cook), 0.05 ether, bot);
        uint256 fee = c * 90 / 10_000;
        assertEq(cook.balanceOf(bot), a + b + c - fee, "the third buy pays 90 bp");
        assertEq(cook.balanceOf(address(settler)), fee);
        // a fourth reference, this time a sell: the pool is owed more than arrives
        vm.expectRevert();
        router.sell(address(cook), a);
        vm.stopPrank();
    }

    function test_fees_settle_into_the_sink_and_the_stake_pool() public onFork {
        _roll();
        vm.startPrank(bot, bot);
        for (uint256 i = 0; i < 5; i++) {
            router.buy{value: 0.05 ether}(address(cook), 0.05 ether, bot);
        }
        vm.stopPrank();
        uint256 pending = cook.balanceOf(address(settler));
        assertGt(pending, 0);
        _roll();
        uint256 sinkBefore = NATIVE_SINK.balance;
        uint256 poolBefore = IERC20(WETH).balanceOf(STAKE_POOL);
        vm.prank(alice, alice);
        uint256 out = settler.settle(address(cook), 0);
        assertGt(out, 0);
        assertEq(NATIVE_SINK.balance - sinkBefore, out / 2, "half to the ownerless sink");
        assertGe(IERC20(WETH).balanceOf(STAKE_POOL) + 1 - poolBefore, out - out / 2, "half to the stake pool");
        assertEq(cook.balanceOf(address(settler)), 0);
        assertEq(cook.balanceOf(address(venue)), 0);
        console2.log("settled COOK:", pending);
        console2.log("ETH out:", out);
    }

    function test_seventh_of_the_week_pays() public onFork {
        vm.startPrank(bot, bot);
        uint256 held;
        for (uint256 i = 0; i < 6; i++) {
            _roll();
            held += router.buy{value: 0.01 ether}(address(cook), 0.01 ether, bot);
        }
        assertEq(cook.balanceOf(bot), held, "six are free");
        _roll();
        uint256 c = router.buy{value: 0.01 ether}(address(cook), 0.01 ether, bot);
        assertEq(cook.balanceOf(bot), held + c - c * 98 / 10_000, "the seventh pays 98 bp");
        vm.stopPrank();
    }

    /// the crew that beat the first version: three wallets, one block, one transfer each
    function test_three_wallets_in_one_block_the_third_pays() public onFork {
        address w1 = makeAddr("w1");
        address w2 = makeAddr("w2");
        address w3 = makeAddr("w3");
        vm.deal(w1, 1 ether);
        vm.deal(w2, 1 ether);
        vm.deal(w3, 1 ether);
        _roll();
        vm.prank(w1, w1);
        uint256 a = router.buy{value: 0.05 ether}(address(cook), 0.05 ether, w1);
        vm.prank(w2, w2);
        uint256 b = router.buy{value: 0.05 ether}(address(cook), 0.05 ether, w2);
        vm.prank(w3, w3);
        uint256 c = router.buy{value: 0.05 ether}(address(cook), 0.05 ether, w3);
        assertEq(cook.balanceOf(w1), a, "first in the block is free");
        assertEq(cook.balanceOf(w2), b, "second in the block is free");
        assertEq(cook.balanceOf(w3), c - c * 90 / 10_000, "third in the block pays 90 bp, whoever it is");
    }

    /// a trade relayed through contracts is one transaction: it uses one of the week's six
    function test_a_relayed_trade_counts_once_in_the_week() public onFork {
        _roll();
        vm.startPrank(alice, alice);
        uint256 got = router.buy{value: 0.05 ether}(address(cook), 0.05 ether, alice);
        vm.stopPrank();
        _roll();
        // alice passes the tokens on and back inside one transaction: two transfers, one ordinal
        Relay relay = new Relay();
        vm.prank(alice, alice);
        cook.approve(address(relay), type(uint256).max);
        vm.prank(alice, alice);
        relay.bounce(address(cook), got);
        assertEq(cook.referencesThisWindowBy(alice), 2, "the buy and the bounce: two transactions");
        assertEq(cook.balanceOf(alice), got, "and nothing taken");
    }
}

contract Relay {
    function bounce(address token, uint256 amount) external {
        IERC20(token).transferFrom(msg.sender, address(this), amount);
        IERC20(token).transfer(msg.sender, amount);
    }
}
