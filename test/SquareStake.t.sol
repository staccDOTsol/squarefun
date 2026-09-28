// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Square} from "../contracts/src/square/Square.sol";
import {SquareSink} from "../contracts/src/square/SquareSink.sol";
import {SquareStake} from "../contracts/src/square/SquareStake.sol";
import {ReferenceFeeERC20} from "../contracts/src/v2/ReferenceFeeERC20.sol";

contract LaunchLike is ReferenceFeeERC20 {
    constructor(address beneficiary_) ERC20("Launch", "LNCH") ReferenceFeeERC20(beneficiary_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Mirrors mainnet: a legacy sink bound to a placeholder, the real $SQUARE is a launch
///      whose fees go to the legacy sink, and SquareStake sits in front.
contract SquareStakeTest is Test {
    address wizards = address(0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    SquareSink legacy;
    Square placeholder;
    LaunchLike flagship; // the real $SQUARE
    LaunchLike other; // some other launch on the pad
    SquareStake pool;

    function setUp() public {
        legacy = new SquareSink(wizards, 2_000);
        placeholder = new Square(address(legacy), address(this), 1_000_000_000e18);
        legacy.setSquare(address(placeholder));
        flagship = new LaunchLike(address(legacy));
        other = new LaunchLike(address(legacy));

        pool = new SquareStake(wizards, legacy);
        pool.setSquare(address(flagship));
        // the deployer hands the whole placeholder supply to the pool, which stakes it upstream
        vm.roll(2048);
        placeholder.transfer(address(pool), placeholder.balanceOf(address(this)));
        vm.roll(4096);
        pool.stakeLegacy();
        assertEq(legacy.staked(address(pool)), 1_000_000_000e18);

        flagship.mint(alice, 1_000_000e18);
        flagship.mint(bob, 3_000_000e18);
        other.mint(alice, 1_000_000e18);
        vm.roll(6144);
    }

    function next() internal {
        vm.roll(block.number + 2048);
    }

    function test_wiring() public view {
        assertEq(address(pool.square()), address(flagship));
        assertEq(address(pool.legacy()), address(legacy));
        assertEq(address(pool.placeholder()), address(placeholder));
        assertEq(pool.wizardsBps(), 0);
    }

    function test_feesFlowThroughToFlagshipStakers() public {
        // alice and bob stake the real $SQUARE
        vm.startPrank(alice, alice);
        flagship.approve(address(pool), 1_000_000e18);
        pool.stake(1_000_000e18);
        vm.stopPrank();
        next();
        vm.startPrank(bob, bob);
        flagship.approve(address(pool), 3_000_000e18);
        pool.stake(3_000_000e18);
        vm.stopPrank();
        next();

        // a machine walks `other` three times in one block: refs 2 and 3 pay 40 + 90 bp
        vm.startPrank(alice, alice);
        other.transfer(bob, 100_000e18);
        other.transfer(bob, 100_000e18);
        other.transfer(bob, 100_000e18);
        vm.stopPrank();
        uint256 inLegacy = other.balanceOf(address(legacy));
        assertGt(inLegacy, 0, "fees landed upstream");
        next();

        // one sync on the pool pulls, splits, and distributes
        uint256 wizBefore = other.balanceOf(wizards);
        (uint256 toWiz, uint256 toStakers) = pool.sync(address(other));
        assertEq(toWiz, 0, "pool takes no cut");
        assertEq(other.balanceOf(wizards) - wizBefore, inLegacy * 2_000 / 10_000, "wizards paid once, upstream");
        // the pull is that block's second reference to `other`, so it pays 40 bp back to the legacy
        // sink; the next sync picks that up. Nothing leaks, it just lags a sync.
        uint256 expected = inLegacy - inLegacy * 2_000 / 10_000;
        assertApproxEqRel(toStakers, expected, 0.005e18, "everything else to $SQUARE stakers");
        // the haircut is paid to the beneficiary, which is the legacy sink itself
        assertEq(other.balanceOf(address(legacy)), expected - toStakers, "haircut waits in legacy");
        next();

        // pro rata 1:3
        assertEq(pool.claimable(alice, address(other)), toStakers / 4);
        assertEq(pool.claimable(bob, address(other)), toStakers * 3 / 4);
        vm.prank(alice, alice);
        uint256 got = pool.claim(address(other), 50);
        assertEq(got, toStakers / 4);
    }

    function test_flagshipOwnFeesToo() public {
        vm.startPrank(alice, alice);
        flagship.approve(address(pool), 500_000e18);
        pool.stake(500_000e18);
        vm.stopPrank();
        next();
        // bob walks $SQUARE itself twice in a block
        vm.startPrank(bob, bob);
        flagship.transfer(alice, 1_000e18);
        flagship.transfer(alice, 1_000e18);
        vm.stopPrank();
        uint256 inLegacy = flagship.balanceOf(address(legacy));
        assertGt(inLegacy, 0);
        next();
        (, uint256 toStakers) = pool.sync(address(flagship));
        assertApproxEqRel(toStakers, inLegacy - inLegacy * 2_000 / 10_000, 0.005e18);
        next();
        assertEq(pool.claimable(alice, address(flagship)), toStakers);
    }

    function test_syncIdempotent() public {
        vm.startPrank(alice, alice);
        flagship.approve(address(pool), 500_000e18);
        pool.stake(500_000e18);
        vm.stopPrank();
        next();
        (, uint256 a) = pool.sync(address(other));
        assertEq(a, 0);
        (, uint256 b) = pool.sync(address(other));
        assertEq(b, 0);
    }
}
