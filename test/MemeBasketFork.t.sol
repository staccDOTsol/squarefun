// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolsVenue} from "../contracts/src/square/pools/PoolsVenue.sol";
import {NativeSettler} from "../contracts/src/square/NativeSettler.sol";
import {TokenMetadata} from "../contracts/src/square/pools/SquarePoolsToken.sol";
import {MemeBasketToken, BasketItem} from "../contracts/src/square/pools/MemeBasketToken.sol";
import {MemeBasketFactory} from "../contracts/src/square/pools/MemeBasketFactory.sol";
import {Trader, Distribution, ILiquidityLauncher} from "./PoolsLaunchV2Fork.t.sol";

/// @dev Live Robinhood state, the live launcher, the live Pools settler, and NFTs from a real wallet.
///      forge test --match-path test/MemeBasketFork.t.sol --fork-url $RH_RPC -vv
contract MemeBasketForkTest is Test {
    address constant LAUNCHER = 0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0;
    address constant INSTANT = 0x23f8209572b4a1C2AD88A42749E830791Fb027f1;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant SETTLER = 0x45866DE9E1b1dFcCE288454D14F23E15ef76B77A;
    address payable constant VENUE = payable(0x25539Ae27C7e4ABEd9FB7ac5a749089a6579Fd5F);
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant STAKE_POOL = 0x78CD5692961cd0dc9bC15327BF34cDc1bCdca41C;
    address payable constant NATIVE_SINK = payable(0x1c6fE80f37D97AaED55d9313a643b6dF0A59B3Dc);
    address constant ARB_SYS = 0x0000000000000000000000000000000000000064;
    uint128 constant SUPPLY = 1_000_000_000e18;

    /// the wallet whose NFTs make the basket
    address constant STACC = 0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158;
    address constant STRAY = 0xC6132BD1B7eE344ba6a53fa203116D168cDc5307;
    address constant HOMECOMING = 0x7c165Ae6E7BFD939Fee1ACA99Ca5aeDf85c52dD4;
    address constant BAGGERS = 0xf0415872Cd9283F2D7b687Fa2D8Be96B10cDAb88;
    address constant CCFF00 = 0x505A22Ffed8d37ebE580FfD98d2Cdb0021189146;
    address constant CHILIPUNKS = 0xA70d69a859D388b0E5cD5ff63371eC69557ce4eD;
    address constant CASHDOGS = 0x904A3F7E32D7259d9b520b5C0C158e5c3a60D860;
    address constant ROBINHOODIANS = 0x0996bA506B65A0a27c2E4A2206c30157096aA5c7;
    address constant OMNIGODS = 0xDCd9c4087963d4bffE7179a143D5bdEab6622bC6;

    MemeBasketFactory factory;
    MemeBasketToken meme;
    Trader router;
    PoolsVenue venue = PoolsVenue(VENUE);
    uint256 blockNo;
    uint256 bn;
    BasketItem[] basket;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address keeper = makeAddr("keeper");

    modifier onFork() {
        if (block.chainid != 4663) return;
        _;
    }

    function _roll() internal {
        blockNo += 1;
        vm.mockCall(ARB_SYS, abi.encodeWithSelector(bytes4(0xa3b1b31d)), abi.encode(blockNo));
        bn += 1;
        vm.roll(bn);
    }

    /// move the EVM block (the one pulls commit to) forward without touching the chain block count
    function _evmRoll(uint256 by) internal {
        bn += by;
        vm.roll(bn);
    }

    function _candidates() internal pure returns (BasketItem[] memory c) {
        c = new BasketItem[](12);
        c[0] = BasketItem(STRAY, 122);
        c[1] = BasketItem(STRAY, 121);
        c[2] = BasketItem(STRAY, 116);
        c[3] = BasketItem(HOMECOMING, 4993);
        c[4] = BasketItem(HOMECOMING, 4246);
        c[5] = BasketItem(BAGGERS, 183);
        c[6] = BasketItem(BAGGERS, 238);
        c[7] = BasketItem(CCFF00, 8416);
        c[8] = BasketItem(CHILIPUNKS, 1851);
        c[9] = BasketItem(CASHDOGS, 8112);
        c[10] = BasketItem(ROBINHOODIANS, 49);
        c[11] = BasketItem(OMNIGODS, 12433);
    }

    function _data(uint64 delay, uint16 premium) internal pure returns (bytes memory) {
        return abi.encode(
            TokenMetadata({
                description: "a bag of jpegs i like, in a meme. EIP-8429 v0.",
                website: "https://staccpad.fun",
                image: "",
                xProofTweetId: 0
            }),
            delay,
            premium
        );
    }

    function _launch(address who, string memory name, string memory symbol, bytes memory data)
        internal
        returns (address token)
    {
        bytes[] memory calls;
        (token, calls) = _launchCalls(who, name, symbol, data);
        vm.prank(who, who);
        ILiquidityLauncher(LAUNCHER).multicall(calls);
    }

    function _launchCalls(address who, string memory name, string memory symbol, bytes memory data)
        internal
        view
        returns (address token, bytes[] memory calls)
    {
        token = factory.getTokenAddress(
            name, symbol, SUPPLY, LAUNCHER, data, LAUNCHER, ILiquidityLauncher(LAUNCHER).getGraffiti(who)
        );
        calls = new bytes[](2);
        calls[0] = abi.encodeCall(
            ILiquidityLauncher.createToken, (address(factory), name, symbol, 18, SUPPLY, LAUNCHER, data)
        );
        calls[1] = abi.encodeCall(
            ILiquidityLauncher.distributeToken,
            (token, Distribution({strategy: INSTANT, amount: SUPPLY, configData: abi.encode(who)}), bytes32(0))
        );
    }

    function setUp() public {
        if (block.chainid != 4663) return;
        blockNo = 80_000_000;
        bn = block.number;
        vm.mockCall(ARB_SYS, abi.encodeWithSelector(bytes4(0xa3b1b31d)), abi.encode(blockNo));
        factory = new MemeBasketFactory(LAUNCHER, SETTLER);
        router = new Trader(IPoolManager(POOL_MANAGER), venue);

        // keep the candidates that can go in and come back out; report the ones that cannot
        BasketItem[] memory c = _candidates();
        for (uint256 i; i < c.length; ++i) {
            if (_roundTrips(c[i])) basket.push(c[i]);
            else console2.log("cannot round-trip, left out:", c[i].collection, c[i].id);
        }
        vm.startPrank(STACC, STACC);
        for (uint256 i; i < basket.length; ++i) {
            IERC721(basket[i].collection).setApprovalForAll(address(factory), true);
        }
        factory.stage(basket);
        vm.stopPrank();
        meme = MemeBasketToken(_launch(STACC, "Stacc Bag", "BAG", _data(1 days, 2_000)));

        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    /// an NFT is only safe to put in if a contract can take it in and hand it back out
    function _roundTrips(BasketItem memory it) internal returns (bool ok) {
        uint256 snap = vm.snapshotState();
        Holder h = new Holder();
        try IERC721(it.collection).ownerOf(it.id) returns (address o) {
            if (o != STACC) return _restore(snap, false);
        } catch {
            return _restore(snap, false);
        }
        // the real path: the owner approves a contract, the contract pulls as an operator, and later hands it
        // out as its owner
        vm.startPrank(STACC, STACC);
        IERC721(it.collection).setApprovalForAll(address(h), true);
        vm.stopPrank();
        vm.prank(STACC, STACC);
        try h.pull(it.collection, STACC, it.id) {
            vm.prank(alice, alice);
            try h.send(it.collection, it.id, alice) {
                ok = IERC721(it.collection).ownerOf(it.id) == alice;
            } catch {}
        } catch {}
        return _restore(snap, ok);
    }

    function _restore(uint256 snap, bool ok) internal returns (bool) {
        vm.revertToState(snap);
        return ok;
    }

    function _buy(address who, uint256 eth) internal returns (uint256 got) {
        _roll();
        vm.prank(who, who);
        got = router.buy{value: eth}(address(meme), eth, who);
    }

    // ------------------------------------------------------------------ launch

    function test_launch_puts_the_supply_in_the_pool_and_the_nfts_in_the_token() public onFork {
        uint256 n = basket.length;
        assertGt(n, 4, "enough of the wallet round-trips");
        assertEq(meme.held(), n);
        assertEq(meme.launchCount(), n);
        assertEq(meme.totalSupply(), SUPPLY);
        assertGt(meme.balanceOf(POOL_MANAGER), SUPPLY * 999 / 1000, "the supply is in the pool");
        for (uint256 i; i < n; ++i) {
            assertEq(IERC721(basket[i].collection).ownerOf(basket[i].id), address(meme), "every NFT is in the token");
            assertTrue(meme.holds(basket[i].collection, basket[i].id));
        }
        assertEq(meme.unit(), (uint256(SUPPLY) + n - 1) / n);
        assertEq(factory.stagedBy(STACC).length, 0, "staging is cleared");
        assertEq(meme.referencesThisBlock(), 0, "the launch was not a reference");
        assertEq(meme.sink(), SETTLER);
        assertTrue(venue.canSell(address(meme)));
        uint256 spot = venue.spot(address(meme));
        console2.log("NFTs in the basket:", n);
        console2.log("ETH per token at open, 1e18:", spot);
        console2.log("market cap at open, wei:", spot * (SUPPLY / 1e18));
    }

    function test_what_one_nft_costs_at_the_open() public onFork {
        // buy until a unit is in hand, then report what it cost
        uint256 u = meme.unit();
        uint256 spent;
        uint256 got;
        while (got < u) {
            got += _buy(alice, 0.02 ether);
            spent += 0.02 ether;
        }
        console2.log("ETH to hold one NFT's unit at the open:", spent);
        assertGt(spent, 0);
    }

    /// the basket sells along the pool's curve: the k-th NFT needs k/N of the supply out of the pool
    function test_the_basket_is_a_curve() public onFork {
        uint256 n = basket.length;
        uint256 u = meme.unit();
        uint256 spent;
        uint256 got;
        for (uint256 k = 1; k + 2 <= n; ++k) {
            uint256 step;
            while (got < k * u) {
                got += _buy(alice, 0.05 ether);
                step += 0.05 ether;
            }
            spent += step;
            console2.log("NFT", k, "costs ETH, 1e15:", step / 1e15);
        }
        console2.log("total for all but the last two, ETH 1e15:", spent / 1e15);
    }

    function test_nobody_else_can_launch_with_your_nfts() public onFork {
        // stacc stages a second basket; bob tries to launch: the launcher gives bob his own tag, not stacc's
        BasketItem[] memory more = new BasketItem[](1);
        more[0] = BasketItem(STRAY, 115);
        vm.prank(STACC, STACC);
        factory.stage(more);
        (, bytes[] memory calls) = _launchCalls(bob, "Stolen Bag", "STOLE", _data(0, 0));
        vm.expectRevert(MemeBasketFactory.NothingStaged.selector);
        vm.prank(bob, bob);
        ILiquidityLauncher(LAUNCHER).multicall(calls);
        assertEq(IERC721(STRAY).ownerOf(115), address(factory), "still stacc's, still staged");
        assertEq(factory.stagedBy(STACC).length, 1);
    }

    function test_only_the_launcher_can_create() public onFork {
        bytes32 g = ILiquidityLauncher(LAUNCHER).getGraffiti(STACC);
        bytes memory data = _data(0, 0);
        vm.expectRevert(MemeBasketFactory.OnlyLauncher.selector);
        factory.createToken("x", "x", 18, SUPPLY, alice, data, g);
    }

    function test_unstage_gives_everything_back() public onFork {
        MemeBasketFactory f2 = new MemeBasketFactory(LAUNCHER, SETTLER);
        // a fresh factory, a fresh item the wallet still holds: the first basket item went into the token, so
        // hand one back out of it first
        BasketItem[] memory one = new BasketItem[](1);
        one[0] = basket[0];
        vm.warp(block.timestamp + 1 days);
        _buy(alice, 2 ether);
        vm.startPrank(alice, alice);
        meme.pick(one[0].collection, one[0].id, alice);
        IERC721(one[0].collection).setApprovalForAll(address(f2), true);
        f2.stage(one);
        assertEq(IERC721(one[0].collection).ownerOf(one[0].id), address(f2));
        f2.unstage();
        vm.stopPrank();
        assertEq(IERC721(one[0].collection).ownerOf(one[0].id), alice);
    }

    // ------------------------------------------------------------------ out

    function test_redemptions_wait_for_the_delay() public onFork {
        _buy(alice, 2 ether);
        vm.startPrank(alice, alice);
        vm.expectRevert(MemeBasketToken.Closed.selector);
        meme.pick(basket[0].collection, basket[0].id, alice);
        vm.expectRevert(MemeBasketToken.Closed.selector);
        meme.pull(alice);
        vm.stopPrank();
    }

    function test_pick_burns_a_unit_and_pays_the_premium_to_the_settler() public onFork {
        _buy(alice, 2 ether);
        vm.warp(block.timestamp + 1 days);
        uint256 supplyBefore = meme.totalSupply();
        uint256 settlerBefore = meme.balanceOf(SETTLER);
        uint256 aliceBefore = meme.balanceOf(alice);
        (uint256 total, uint256 premium) = meme.pickCost();
        uint256 unitBefore = meme.unit();
        BasketItem memory it = basket[3];
        uint256 refsBefore = meme.referencesThisBlock();
        vm.prank(alice, alice);
        meme.pick(it.collection, it.id, alice);
        assertEq(IERC721(it.collection).ownerOf(it.id), alice, "alice has the one she chose");
        assertEq(aliceBefore - meme.balanceOf(alice), total, "she paid a unit and the premium");
        assertEq(premium, unitBefore * 2_000 / 10_000);
        assertEq(meme.balanceOf(SETTLER) - settlerBefore, premium, "the premium is a fee: to the settler");
        assertEq(supplyBefore - meme.totalSupply(), total - premium, "the unit is burned");
        assertEq(meme.held(), basket.length - 1);
        assertApproxEqAbs(meme.unit(), unitBefore, 1, "a unit is still a unit");
        assertEq(meme.referencesThisBlock(), refsBefore, "and it was not a reference");
    }

    function test_pull_is_random_settled_by_anyone_a_block_later() public onFork {
        _buy(alice, 2 ether);
        vm.warp(block.timestamp + 1 days);
        uint256 u = meme.unit();
        vm.prank(alice, alice);
        uint256 id = meme.pull(bob);
        assertEq(meme.balanceOf(address(meme)), u, "the unit is held for the pull");
        vm.expectRevert(MemeBasketToken.NotYet.selector);
        meme.reveal(id);
        _evmRoll(1);
        vm.expectRevert(MemeBasketToken.NotYet.selector);
        meme.reveal(id);
        vm.setBlockhash(bn, keccak256("the next block"));
        _evmRoll(1);
        uint256 held = meme.held();
        vm.prank(keeper, keeper);
        meme.reveal(id);
        assertEq(meme.held(), held - 1, "one came out");
        assertEq(meme.balanceOf(address(meme)), 0, "the unit is burned");
        (,,, bool settled,) = meme.pulls(id);
        assertTrue(settled);
        uint256 got;
        for (uint256 i; i < basket.length; ++i) {
            if (!meme.holds(basket[i].collection, basket[i].id)) {
                assertEq(IERC721(basket[i].collection).ownerOf(basket[i].id), bob, "bob got the random one");
                got++;
            }
        }
        assertEq(got, 1);
    }

    function test_a_due_pull_is_settled_by_the_next_person_to_touch_the_basket() public onFork {
        _buy(alice, 2 ether);
        vm.warp(block.timestamp + 1 days);
        vm.prank(alice, alice);
        uint256 id = meme.pull(alice);
        _evmRoll(1);
        vm.setBlockhash(bn, keccak256("next"));
        _evmRoll(1);
        _buy(bob, 2 ether);
        vm.prank(bob, bob);
        meme.pick(basket[0].collection, basket[0].id, bob);
        (,,, bool settled,) = meme.pulls(id);
        assertTrue(settled, "bob's pick settled alice's pull first");
        assertEq(meme.openPulls().length, 0);
    }

    // ------------------------------------------------------------------ in

    function test_a_launch_nft_can_come_back_and_nothing_else_can() public onFork {
        _buy(alice, 2 ether);
        vm.warp(block.timestamp + 1 days);
        BasketItem memory it = basket[1];
        vm.startPrank(alice, alice);
        meme.pick(it.collection, it.id, alice);
        uint256 minted = meme.mintUnit();
        uint256 before = meme.balanceOf(alice);
        IERC721(it.collection).setApprovalForAll(address(meme), true);
        meme.deposit(it.collection, it.id, alice);
        vm.stopPrank();
        assertEq(meme.balanceOf(alice) - before, minted, "a unit, rounded down");
        assertTrue(meme.holds(it.collection, it.id));
        // an NFT that was never in the basket cannot be deposited
        vm.expectRevert(MemeBasketToken.NotInLaunchBasket.selector);
        vm.prank(STACC, STACC);
        meme.deposit(STRAY, 115, STACC);
    }

    function test_an_emptied_basket_still_takes_its_nfts_back() public onFork {
        // buying the whole supply out of a full-range pool costs without bound, so hand it over directly
        _roll();
        uint256 all = meme.balanceOf(POOL_MANAGER);
        vm.prank(POOL_MANAGER, POOL_MANAGER);
        meme.transfer(alice, all);
        vm.warp(block.timestamp + 1 days);
        uint256 n = basket.length;
        vm.startPrank(alice, alice);
        for (uint256 i; i < n; ++i) {
            // every pick pays its premium to the settler; take it back so the whole supply keeps picking
            vm.stopPrank();
            uint256 fees = meme.balanceOf(SETTLER);
            if (fees != 0) {
                vm.prank(SETTLER, SETTLER);
                meme.transfer(alice, fees);
            }
            // the launch leaves a few wei of supply outside the pool; the last pick needs every one of them
            (uint256 cost,) = meme.pickCost();
            uint256 bal = meme.balanceOf(alice);
            if (bal < cost) deal(address(meme), alice, cost);
            vm.startPrank(alice, alice);
            BasketItem memory it = meme.itemAt(0);
            meme.pick(it.collection, it.id, alice);
        }
        assertEq(meme.held(), 0);
        uint256 last = meme.lastUnit();
        assertGt(last, 0);
        BasketItem memory back = basket[0];
        IERC721(back.collection).setApprovalForAll(address(meme), true);
        uint256 before = meme.balanceOf(alice);
        meme.deposit(back.collection, back.id, alice);
        vm.stopPrank();
        assertEq(meme.balanceOf(alice) - before, last, "an empty basket mints the last unit");
    }

    // ------------------------------------------------------------------ fees

    function test_premiums_and_reference_fees_become_stake() public onFork {
        _buy(alice, 2 ether);
        vm.warp(block.timestamp + 1 days);
        vm.prank(alice, alice);
        meme.pick(basket[2].collection, basket[2].id, alice);
        // and a crew buying three times in one block pays the reference fee on the third
        _roll();
        vm.startPrank(bob, bob);
        router.buy{value: 0.1 ether}(address(meme), 0.1 ether, bob);
        router.buy{value: 0.1 ether}(address(meme), 0.1 ether, bob);
        router.buy{value: 0.1 ether}(address(meme), 0.1 ether, bob);
        vm.stopPrank();
        uint256 pending = meme.balanceOf(SETTLER);
        assertGt(pending, 0);
        _roll();
        uint256 sinkBefore = NATIVE_SINK.balance;
        uint256 poolBefore = IERC20(WETH).balanceOf(STAKE_POOL);
        vm.prank(keeper, keeper);
        uint256 out = NativeSettler(payable(SETTLER)).settle(address(meme), 0);
        assertGt(out, 0);
        assertEq(NATIVE_SINK.balance - sinkBefore, out / 2, "half to the ownerless sink");
        assertGe(IERC20(WETH).balanceOf(STAKE_POOL) + 1 - poolBefore, out - out / 2, "half to the stake pool");
        console2.log("fees settled, ETH:", out);
    }
}

contract Holder {
    function pull(address collection, address from, uint256 id) external {
        IERC721(collection).transferFrom(from, address(this), id);
    }

    function send(address collection, uint256 id, address to) external {
        IERC721(collection).transferFrom(address(this), to, id);
    }
}
