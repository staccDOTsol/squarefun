// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Square} from "../contracts/src/square/Square.sol";
import {SquareSink} from "../contracts/src/square/SquareSink.sol";
import {SquareStake} from "../contracts/src/square/SquareStake.sol";
import {TwinPool} from "../contracts/src/square/TwinPool.sol";
import {ReferenceFeeERC20} from "../contracts/src/v2/ReferenceFeeERC20.sol";

contract LaunchLike is ReferenceFeeERC20 {
    constructor(address beneficiary_) ERC20("Launch", "LNCH") ReferenceFeeERC20(beneficiary_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev A plain ERC-20, like a token launched on Pons.
contract Plain is ERC20 {
    constructor() ERC20("Twin", "TWIN") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract TwinPoolTest is Test {
    address wizards = address(0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8);
    address alice = address(0xA11CE); // stakes $SQUARE in the main pool
    address bob = address(0xB0B); // holds the twin
    address carol = address(0xCA201); // holds the twin
    address backer = address(0xBAC); // commits $SQUARE for twin holders

    SquareSink legacy;
    Square placeholder;
    LaunchLike flagship;
    LaunchLike other;
    SquareStake pool;
    Plain twin;
    TwinPool twinPool;

    function setUp() public {
        legacy = new SquareSink(wizards, 2_000);
        placeholder = new Square(address(legacy), address(this), 1_000_000_000e18);
        legacy.setSquare(address(placeholder));
        flagship = new LaunchLike(address(legacy));
        other = new LaunchLike(address(legacy));
        pool = new SquareStake(wizards, legacy);
        pool.setSquare(address(flagship));
        vm.roll(2048);
        placeholder.transfer(address(pool), placeholder.balanceOf(address(this)));
        vm.roll(4096);
        pool.stakeLegacy();

        twin = new Plain();
        twinPool = new TwinPool(wizards, pool);
        twinPool.setSquare(address(twin));

        flagship.mint(alice, 3_000_000e18);
        flagship.mint(backer, 1_000_000e18);
        other.mint(alice, 1_000_000e18);
        twin.mint(bob, 100e18);
        twin.mint(carol, 300e18);
        vm.roll(6144);
    }

    function next() internal {
        vm.roll(block.number + 2048);
    }

    function test_commitIsForever() public {
        vm.startPrank(backer, backer);
        flagship.approve(address(twinPool), 1_000_000e18);
        twinPool.commit(1_000_000e18);
        vm.stopPrank();
        // commit is two $SQUARE references in one block (in, then up), so ref #2 pays 40 bp
        assertApproxEqRel(twinPool.committed(), 1_000_000e18, 0.005e18);
        assertEq(pool.staked(address(twinPool)), twinPool.committed());
        // no way out
        vm.prank(backer, backer);
        vm.expectRevert();
        twinPool.unstake(1);
    }

    function test_twinHoldersGetTheirShare() public {
        // alice stakes 3M $SQUARE directly; backer commits 1M for twin holders → twin side is 25%
        vm.startPrank(alice, alice);
        flagship.approve(address(pool), 3_000_000e18);
        pool.stake(3_000_000e18);
        vm.stopPrank();
        vm.startPrank(backer, backer);
        flagship.approve(address(twinPool), 1_000_000e18);
        twinPool.commit(1_000_000e18);
        vm.stopPrank();
        next();
        // bob and carol stake the twin 1:3
        vm.startPrank(bob, bob);
        twin.approve(address(twinPool), 100e18);
        twinPool.stake(100e18);
        vm.stopPrank();
        vm.startPrank(carol, carol);
        twin.approve(address(twinPool), 300e18);
        twinPool.stake(300e18);
        vm.stopPrank();
        next();

        // a machine walks `other`
        vm.startPrank(alice, alice);
        other.transfer(bob, 100_000e18);
        other.transfer(bob, 100_000e18);
        other.transfer(bob, 100_000e18);
        other.transfer(bob, 100_000e18);
        vm.stopPrank();
        next();
        (, uint256 toSquareStakers) = pool.sync(address(other));
        next();
        uint256 twinShare = pool.claimable(address(twinPool), address(other));
        // a quarter, less the 40 bp the commit paid on its way in
        assertApproxEqRel(twinShare, toSquareStakers / 4, 0.02e18, "twin side is a quarter");

        // one sync on the twin pool harvests and distributes
        (, uint256 toTwin) = twinPool.sync(address(other));
        assertApproxEqRel(toTwin, twinShare, 0.005e18);
        next();
        assertEq(twinPool.claimable(bob, address(other)), toTwin / 4);
        assertEq(twinPool.claimable(carol, address(other)), toTwin * 3 / 4);
        vm.prank(carol, carol);
        assertEq(twinPool.claim(address(other), 50), toTwin * 3 / 4);
        // alice, staking directly, still has her three quarters waiting in the main pool
        assertApproxEqRel(pool.claimable(alice, address(other)), toSquareStakers * 3 / 4, 0.02e18);
    }

    function test_nothingCommittedNothingHarvested() public {
        vm.startPrank(alice, alice);
        flagship.approve(address(pool), 3_000_000e18);
        pool.stake(3_000_000e18);
        vm.stopPrank();
        next();
        vm.startPrank(alice, alice);
        other.transfer(bob, 100_000e18);
        other.transfer(bob, 100_000e18);
        other.transfer(bob, 100_000e18);
        vm.stopPrank();
        next();
        pool.sync(address(other));
        next();
        (, uint256 toTwin) = twinPool.sync(address(other));
        assertEq(toTwin, 0);
    }
}
