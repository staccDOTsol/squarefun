// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Square} from "../contracts/src/square/Square.sol";
import {SquareSink} from "../contracts/src/square/SquareSink.sol";
import {ReferenceFeeERC20} from "../contracts/src/v2/ReferenceFeeERC20.sol";

/// @dev Stand-in for a launch token: every transfer between two addresses counts.
contract LaunchLike is ReferenceFeeERC20 {
    constructor(address beneficiary_) ERC20("Launch", "LNCH") ReferenceFeeERC20(beneficiary_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract SquareTest is Test {
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address wizards = address(0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA201);

    SquareSink sink;
    Square square;
    LaunchLike launch;

    function setUp() public {
        sink = new SquareSink(wizards, 2_000); // 20% to the wizards
        square = new Square(address(sink), address(this), 1_000_000e18);
        sink.setSquare(address(square));
        launch = new LaunchLike(address(sink));
        launch.mint(alice, 1_000_000e18);
        // one SQUARE reference per block so both arrive whole
        vm.roll(2048);
        square.transfer(bob, 100_000e18);
        vm.roll(4096);
        square.transfer(carol, 300_000e18);
        vm.roll(6144);
    }

    function next() internal {
        vm.roll(block.number + 2048);
    }

    function test_wiring() public view {
        assertEq(square.beneficiary(), address(sink));
        assertEq(launch.beneficiary(), address(sink));
        assertEq(address(sink.square()), address(square));
        assertEq(sink.wizards(), wizards);
        assertEq(square.balanceOf(bob), 100_000e18);
        assertEq(square.balanceOf(carol), 300_000e18);
    }

    function test_setSquareOnce() public {
        vm.expectRevert(SquareSink.AlreadySet.selector);
        sink.setSquare(address(square));
        SquareSink other = new SquareSink(wizards, 0);
        vm.prank(alice, alice);
        vm.expectRevert(SquareSink.NotDeployer.selector);
        other.setSquare(address(square));
    }

    /// @dev bob stakes 100k, carol 300k in separate blocks: bob owns a quarter
    function _stakeBoth() internal {
        vm.startPrank(bob, bob);
        square.approve(address(sink), type(uint256).max);
        sink.stake(100_000e18);
        vm.stopPrank();
        next();
        vm.startPrank(carol, carol);
        square.approve(address(sink), type(uint256).max);
        sink.stake(300_000e18);
        vm.stopPrank();
        next();
    }

    function test_stakeCountsWhatArrives() public {
        _stakeBoth();
        assertEq(sink.staked(bob), 100_000e18);
        assertEq(sink.staked(carol), 300_000e18);
        assertEq(sink.totalStaked(), 400_000e18);
        assertEq(sink.reserved(address(square)), 400_000e18);
        assertEq(sink.totalStakeAt(uint64(block.number) - 1), 400_000e18);
        assertEq(sink.stakeAt(bob, uint64(block.number) - 1), 100_000e18);
        assertEq(sink.stakeAt(bob, 9), 0);
    }

    function test_feesSplitWizardsThenStakersProRata() public {
        _stakeBoth();
        // a machine walks the launch token: three transfers in one block
        vm.startPrank(alice, alice);
        launch.transfer(bob, 1_000e18); // free
        launch.transfer(bob, 1_000e18); // fast #2 free, slow #2 = 8 bp: 0.8e18 fee, 0.4e18 to sink, 0.4e18 dead
        launch.transfer(bob, 1_000e18); // fast #3 = 90 bp: 9e18 fee, all to the sink
        vm.stopPrank();
        uint256 arrived = launch.balanceOf(address(sink));
        assertEq(arrived, 0.8e18 + 9e18);
        assertEq(launch.balanceOf(DEAD), 0, "nothing burned in kind: the settler burns ETH");

        next();
        (uint256 toWizards, uint256 toStakers) = sink.sync(address(launch));
        assertEq(toWizards, arrived * 2_000 / 10_000);
        assertEq(toStakers, arrived - toWizards);
        assertEq(launch.balanceOf(wizards), toWizards, "first launch reference in its block: no fee");
        assertEq(sink.distributionCount(address(launch)), 1);

        assertEq(sink.claimable(bob, address(launch)), toStakers / 4);
        assertEq(sink.claimable(carol, address(launch)), toStakers * 3 / 4);

        next();
        uint256 bobBefore = launch.balanceOf(bob);
        vm.prank(bob, bob);
        uint256 got = sink.claim(address(launch), 10);
        assertEq(got, toStakers / 4);
        assertEq(launch.balanceOf(bob), bobBefore + got, "claim is the first reference in its block");
        assertEq(sink.claimable(bob, address(launch)), 0);
        assertEq(sink.reserved(address(launch)), toStakers - got, "carol's share stays reserved");
    }

    function test_squareFeesFlowBackToStakers() public {
        _stakeBoth();
        uint256 stakeReserved = sink.reserved(address(square));
        // this contract walks SQUARE itself: the second transfer in the block pays 40 bp
        square.transfer(alice, 10_000e18);
        square.transfer(alice, 10_000e18); // slow #2 = 8 bp: 8e18 fee, all to the sink
        assertEq(square.balanceOf(address(sink)) - stakeReserved, 8e18);
        next();
        (uint256 toWizards, uint256 toStakers) = sink.sync(address(square));
        assertEq(toWizards, 1.6e18);
        assertEq(toStakers, 6.4e18);
        assertEq(sink.claimable(carol, address(square)), 4.8e18);
        next();
        vm.prank(carol, carol);
        assertEq(sink.claim(address(square), 10), 4.8e18);
        next();
        vm.prank(carol, carol);
        sink.unstake(300_000e18);
        assertEq(sink.staked(carol), 0);
        assertEq(sink.totalStaked(), 100_000e18);
        assertEq(sink.reserved(address(square)), 100_000e18 + 1.6e18, "bob's unclaimed 1.6e18 stays reserved");
    }

    function test_nobodyStakedGoesToWizards() public {
        vm.startPrank(alice, alice);
        launch.transfer(bob, 1e18);
        launch.transfer(bob, 1e18); // slow #2 = 8 bp on 1e18 = 8e14, all to sink
        vm.stopPrank();
        next();
        (uint256 toWizards, uint256 toStakers) = sink.sync(address(launch));
        assertEq(toStakers, 0);
        assertEq(toWizards, 8e14);
        assertEq(launch.balanceOf(wizards), 8e14);
        assertEq(sink.distributionCount(address(launch)), 0);
    }

    function test_lateStakerGetsNothingFromBefore() public {
        _stakeBoth();
        vm.startPrank(alice, alice);
        launch.transfer(bob, 1_000e18);
        launch.transfer(bob, 1_000e18);
        vm.stopPrank();
        next();
        sink.sync(address(launch));
        // alice stakes after the distribution: no claim on it, full claim on the next
        square.transfer(alice, 400_000e18);
        next();
        vm.startPrank(alice, alice);
        square.approve(address(sink), type(uint256).max);
        sink.stake(400_000e18);
        vm.stopPrank();
        assertEq(sink.claimable(alice, address(launch)), 0);
        uint256 bobFirst = sink.claimable(bob, address(launch));
        assertGt(bobFirst, 0);

        next();
        vm.startPrank(alice, alice);
        launch.transfer(carol, 1_000e18);
        launch.transfer(carol, 1_000e18); // slow #2 = 8 bp: 0.8e18 fee, all to the sink
        vm.stopPrank();
        next();
        (, uint256 toStakers) = sink.sync(address(launch));
        assertEq(toStakers, 0.8e18 * 8_000 / 10_000);
        // 800k staked now: alice half, carol 3/8, bob 1/8
        assertEq(sink.claimable(alice, address(launch)), toStakers / 2);
        assertEq(sink.claimable(bob, address(launch)), bobFirst + toStakers / 8);
    }

    function test_sameBlockStakeMissesThatBlocksSync() public {
        _stakeBoth();
        vm.startPrank(alice, alice);
        launch.transfer(bob, 1_000e18);
        launch.transfer(bob, 1_000e18);
        vm.stopPrank();
        next();
        // carol doubles up in the sync block: the distribution uses the previous block's stakes
        square.transfer(carol, 300_000e18);
        vm.prank(carol, carol);
        sink.stake(300_000e18);
        (, uint256 toStakers) = sink.sync(address(launch));
        assertEq(sink.claimable(carol, address(launch)), toStakers * 3 / 4);
        assertEq(sink.claimable(bob, address(launch)), toStakers / 4);
    }

    function test_claimInChunks() public {
        _stakeBoth();
        for (uint256 i; i < 3; i++) {
            vm.startPrank(alice, alice);
            launch.transfer(bob, 1_000e18);
            launch.transfer(bob, 1_000e18);
            vm.stopPrank();
            next();
            sink.sync(address(launch));
            next();
        }
        assertEq(sink.distributionCount(address(launch)), 3);
        uint256 all = sink.claimable(bob, address(launch));
        vm.prank(bob, bob);
        uint256 first = sink.claim(address(launch), 2);
        assertEq(sink.claimedThrough(bob, address(launch)), 2);
        next();
        vm.prank(bob, bob);
        uint256 rest = sink.claim(address(launch), 2);
        assertEq(sink.claimedThrough(bob, address(launch)), 3);
        assertEq(first + rest, all);
    }
}
