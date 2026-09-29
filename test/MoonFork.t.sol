// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IVenue} from "../contracts/src/square/venues/IVenue.sol";
import {PoolsVenue} from "../contracts/src/square/pools/PoolsVenue.sol";
import {TokenMetadata} from "../contracts/src/square/pools/SquarePoolsToken.sol";
import {MoonToken} from "../contracts/src/square/moon/MoonToken.sol";
import {MoonJar, IOpenVRF} from "../contracts/src/square/moon/MoonJar.sol";
import {MoonTokenFactory} from "../contracts/src/square/moon/MoonTokenFactory.sol";
import {Trader, Distribution, ILiquidityLauncher} from "./PoolsLaunchV2Fork.t.sol";

/// @dev Stands in for OpenVRF: same request/callback surface, the test supplies the word.
contract MockVRF {
    uint256 public requestFee;
    uint256 public nextRequestId;
    mapping(uint256 => address) public consumerOf;

    function setFee(uint256 f) external {
        requestFee = f;
    }

    function requestRandomness(uint32) external payable returns (uint256 id) {
        require(msg.value == requestFee, "fee");
        id = nextRequestId++;
        consumerOf[id] = msg.sender;
    }

    function fulfill(uint256 id, uint256 word) external {
        MoonJar(payable(consumerOf[id])).rawFulfillRandomness(id, word);
    }
}

/// @dev Live Robinhood state and the live Pools launcher.
///      forge test --match-path test/MoonFork.t.sol --fork-url https://rpc.mainnet.chain.robinhood.com -vv
contract MoonForkTest is Test {
    address constant LAUNCHER = 0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0;
    address constant INSTANT = 0x23f8209572b4a1C2AD88A42749E830791Fb027f1;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant ARB_SYS = 0x0000000000000000000000000000000000000064;
    uint128 constant SUPPLY = 1_000_000_000e18;

    PoolsVenue venue;
    MoonJar jar;
    MoonTokenFactory factory;
    MoonToken moon;
    MockVRF vrf;
    Trader router;
    uint256 blockNo;
    /// @dev block.number tracked here: under via_ir a test's reads of it are cached (see wiki)
    uint256 l1;

    address steward = makeAddr("steward");
    address payable card = payable(makeAddr("card"));
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address bot = makeAddr("bot");

    function _roll() internal {
        blockNo += 1;
        vm.mockCall(ARB_SYS, abi.encodeWithSelector(bytes4(0xa3b1b31d)), abi.encode(blockNo));
        l1 += 1;
        vm.roll(l1);
        vm.setBlockhash(l1 - 1, keccak256(abi.encode("moon", l1 - 1)));
    }

    function setUp() public {
        if (block.chainid != 4663) return;
        blockNo = 80_000_000;
        l1 = block.number;
        vm.mockCall(ARB_SYS, abi.encodeWithSelector(bytes4(0xa3b1b31d)), abi.encode(blockNo));

        venue = new PoolsVenue(IPoolManager(POOL_MANAGER));
        string[] memory parcels = new string[](3);
        parcels[0] = "Lake of Dreams (Lacus Somniorum)";
        parcels[1] = "Sea of Tranquility (Mare Tranquillitatis)";
        parcels[2] = "Bay of Rainbows (Sinus Iridum)";
        vrf = new MockVRF();
        jar = new MoonJar(venue, IOpenVRF(address(vrf)), steward, card, 0.017 ether, 0.017 ether, parcels);
        factory = new MoonTokenFactory(address(jar), POOL_MANAGER, 500);
        router = new Trader(IPoolManager(POOL_MANAGER), venue);

        bytes memory tokenData = abi.encode(
            TokenMetadata({description: "fees buy moon", website: "", image: "", xProofTweetId: 0})
        );
        address predicted = factory.getTokenAddress(
            "Mooncoin", "MOON", SUPPLY, LAUNCHER, tokenData, LAUNCHER, ILiquidityLauncher(LAUNCHER).getGraffiti(steward)
        );
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(
            ILiquidityLauncher.createToken, (address(factory), "Mooncoin", "MOON", 18, SUPPLY, LAUNCHER, tokenData)
        );
        calls[1] = abi.encodeCall(
            ILiquidityLauncher.distributeToken,
            (predicted, Distribution({strategy: INSTANT, amount: SUPPLY, configData: abi.encode(steward)}), bytes32(0))
        );
        vm.prank(steward, steward);
        ILiquidityLauncher(LAUNCHER).multicall(calls);
        moon = MoonToken(predicted);
        vm.prank(steward);
        jar.bind(address(moon));

        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.deal(bot, 10 ether);
    }

    modifier onFork() {
        if (block.chainid != 4663) return;
        _;
    }

    /// bot buys `n` times in one block; returns the fee that landed in the jar
    function _churn(uint256 n) internal returns (uint256) {
        uint256 before = moon.balanceOf(address(jar));
        vm.startPrank(bot, bot);
        for (uint256 i = 0; i < n; i++) {
            router.buy{value: 0.2 ether}(address(moon), 0.2 ether, bot);
        }
        vm.stopPrank();
        return moon.balanceOf(address(jar)) - before;
    }

    function test_launch_binds_the_jar() public onFork {
        assertEq(moon.sink(), address(jar));
        assertEq(jar.token(), address(moon));
        assertEq(factory.made(), address(moon));
        assertEq(moon.buyFeeBps(), 500);
        assertEq(moon.ticketCount(0), 0, "the launch paid nobody a ticket");
        vm.expectRevert(MoonTokenFactory.AlreadyMade.selector);
        factory.createToken("again", "AGAIN", 18, 1e18, address(this), abi.encode(TokenMetadata("", "", "", 0)), 0);
    }

    function test_a_buy_pays_five_percent_and_a_sell_pays_nothing() public onFork {
        _roll();
        vm.prank(alice, alice);
        uint256 got = router.buy{value: 0.05 ether}(address(moon), 0.05 ether, alice);
        uint256 fee = moon.balanceOf(address(jar));
        assertEq(moon.balanceOf(alice), got - fee);
        assertApproxEqAbs(fee, got * 500 / 10_000, 1, "5% of the buy");
        _roll();
        uint256 held = moon.balanceOf(alice);
        vm.startPrank(alice, alice);
        moon.approve(address(router), held);
        uint256 eth = router.sell(address(moon), held);
        vm.stopPrank();
        assertEq(moon.balanceOf(address(jar)), fee, "the sell paid nothing");
        assertGt(eth, 0.05 ether * 90 / 100);
        console2.log("round trip ETH back of 0.05:", eth);
    }

    function test_tickets_are_fees_by_originator() public onFork {
        _roll();
        vm.prank(alice, alice);
        router.buy{value: 0.05 ether}(address(moon), 0.05 ether, alice);
        // bob buys for a contract: the ticket is still bob's, he paid
        vm.prank(bob, bob);
        router.buy{value: 0.1 ether}(address(moon), 0.1 ether, address(router));
        uint256 r = moon.round();
        assertEq(moon.ticketsOf(r, alice) + moon.ticketsOf(r, bob), moon.balanceOf(address(jar)), "every fee is a ticket");
        // tickets are fee tokens: twice the ETH is a bit under twice the tokens, the buy moved the price
        assertGt(moon.ticketsOf(r, bob), moon.ticketsOf(r, alice) * 17 / 10, "about twice the fee, twice the tickets");
        assertEq(moon.ticketCount(r), 2);
        // a free wallet-to-wallet transfer pays nothing and gets nothing
        _roll();
        vm.prank(alice, alice);
        moon.transfer(bob, 1e18);
        assertEq(moon.ticketCount(r), 2);
    }

    function test_the_card_never_gets_less_than_forwardAt() public onFork {
        vm.prank(steward);
        jar.retune(card, 100 ether, 100 ether);
        _roll();
        assertGt(_churn(4), 0, "the buys paid the jar");
        _roll();
        jar.settle(0);
        assertEq(moon.balanceOf(address(jar)), 0, "sold");
        uint256 eth = address(jar).balance;
        assertGt(eth, 0);
        assertEq(card.balance, 0, "held below forwardAt");
        assertEq(jar.pending(), 0);
        vm.prank(steward);
        jar.retune(card, eth, 100 ether);
        jar.forward();
        assertEq(card.balance, eth, "all of it once it reaches forwardAt");
        assertEq(jar.owed() + jar.dropCount() + (jar.pending() == 0 ? 0 : 1), eth / jar.parcelCost(), "a draw per whole parcel");
        console2.log("jar ETH from 4 x 0.2 ETH buys:", eth);
    }

    function test_a_paid_parcel_draws_by_tickets() public onFork {
        _roll();
        vm.prank(alice, alice);
        router.buy{value: 0.05 ether}(address(moon), 0.05 ether, alice);
        vm.prank(bob, bob);
        router.buy{value: 0.05 ether}(address(moon), 0.05 ether, bob);
        uint256 blocks;
        while (_quote() < jar.parcelCost() && blocks < 40) {
            _roll();
            _churn(8);
            blocks++;
        }
        _roll();
        uint256 r = moon.round();
        uint256 total = moon.totalTickets(r);
        jar.settle(0);
        assertGe(card.balance, 0.017 ether, "the jar went to the card");
        assertEq(address(jar).balance, 0);
        assertEq(moon.round(), r + 1, "the paid-for draw closed the round");
        assertEq(jar.pending(), 1, "and asked OpenVRF");
        // tickets bought after the close go to the next round
        vm.prank(alice, alice);
        router.buy{value: 0.05 ether}(address(moon), 0.05 ether, alice);
        assertEq(moon.totalTickets(r), total);
        assertGt(moon.totalTickets(r + 1), 0);

        // alice holds the first tickets of the round: word 0 lands on her
        vrf.fulfill(0, total * 1000);
        assertEq(jar.dropCount(), 1);
        (address winner, uint64 dr,,) = jar.drops(0);
        assertEq(winner, alice);
        assertEq(dr, r);
        assertEq(jar.pending(), 0);
        console2.log("blocks of churn:", blocks);
        console2.log("forwarded wei:", card.balance);
        console2.log("draws still owed:", jar.owed());
    }

    function test_the_winner_is_weighted_by_fees() public onFork {
        _roll();
        vm.prank(alice, alice);
        router.buy{value: 0.05 ether}(address(moon), 0.05 ether, alice);
        _roll();
        _churn(8);
        uint256 r = moon.round();
        uint256 a = moon.ticketsOf(r, alice);
        assertEq(moon.holderOf(r, 0), alice);
        assertEq(moon.holderOf(r, a - 1), alice);
        assertEq(moon.holderOf(r, a), bot);
        assertEq(moon.holderOf(r, moon.totalTickets(r) - 1), bot);
    }

    function test_a_late_word_is_ignored_after_a_rerequest() public onFork {
        _roll();
        _churn(8);
        _roll();
        vm.prank(steward);
        jar.retune(card, 0.001 ether, 0.001 ether);
        jar.settle(0);
        assertEq(jar.pending(), 1);
        vm.expectRevert(MoonJar.NotYet.selector);
        jar.rerequest();
        vm.warp(block.timestamp + 1 days);
        jar.rerequest();
        assertEq(jar.pending(), 2);
        vrf.fulfill(0, 7);
        assertEq(jar.dropCount(), 0, "the superseded word does nothing");
        vrf.fulfill(1, 7);
        assertEq(jar.dropCount(), 1);
    }

    function test_only_the_router_answers_and_only_the_steward_retunes() public onFork {
        vm.expectRevert(MoonJar.NotRouter.selector);
        jar.rawFulfillRandomness(0, 1);
        vm.expectRevert(MoonJar.NotSteward.selector);
        jar.retune(card, 1, 1);
        vm.expectRevert(MoonToken.NotJar.selector);
        moon.closeRound();
        vm.expectRevert(MoonJar.Bad.selector);
        vm.prank(steward);
        jar.bind(address(moon));
    }

    function _quote() internal view returns (uint256) {
        uint256 held = moon.balanceOf(address(jar));
        return held == 0 ? 0 : held * venue.spot(address(moon)) / 1e18 * 95 / 100;
    }
}
