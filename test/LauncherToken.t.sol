// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PonsV2LauncherToken} from "../contracts/src/v2/PonsV2LauncherToken.sol";

/// @dev The four protocol getters the token snapshots at construction.
contract FactoryStub {
    address public memeHook = address(0x400C);
    address public buybackVault = address(0x7A17);
    address public locker = address(0x10C4);
    address public graduationExecutor = address(0xE8EC);
}

contract LauncherTokenTest is Test {
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address curve = address(0xC0DE);
    address deployer = address(0xDE91);
    address squareSink = address(0x5111C);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address poolManager = address(0x8366);

    FactoryStub factory;
    PonsV2LauncherToken token;

    function setUp() public {
        factory = new FactoryStub();
        token = new PonsV2LauncherToken(
            "Launch",
            "LNCH",
            "logo",
            "desc",
            PonsV2LauncherToken.Socials("", "", "", "", ""),
            deployer,
            curve,
            address(factory),
            1_000_000e18,
            squareSink
        );
        vm.roll(2048);
    }

    function test_supplyMintsToCurveWithoutCounting() public view {
        assertEq(token.balanceOf(curve), 1_000_000e18);
        assertEq(token.referencesThisBlock(), 0);
        assertEq(token.beneficiary(), squareSink);
        assertEq(token.memeHook(), address(0x400C));
        assertEq(token.graduationExecutor(), address(0xE8EC));
    }

    function test_curveSalesAreNotReferences() public {
        vm.startPrank(curve, curve);
        token.transfer(alice, 10_000e18);
        token.transfer(bob, 10_000e18);
        token.transfer(alice, 10_000e18);
        vm.stopPrank();
        assertEq(token.referencesThisBlock(), 0);
        assertEq(token.balanceOf(alice), 20_000e18);
        // and selling back to the curve is not one either
        vm.prank(alice, alice);
        token.transfer(curve, 5_000e18);
        assertEq(token.referencesThisBlock(), 0);
    }

    function test_protocolMovesAreNotReferences() public {
        vm.prank(curve, curve);
        token.transfer(address(factory), 100e18);
        vm.prank(address(factory));
        token.transfer(address(0xE8EC), 100e18); // graduation executor
        vm.prank(address(0xE8EC));
        token.transfer(poolManager, 100e18); // executor seeds the pool
        vm.prank(poolManager, poolManager);
        token.transfer(address(0x400C), 1e18); // hook takes a fee
        vm.prank(address(0x400C));
        token.transfer(address(0x7A17), 1e18); // hook locks into the vault
        assertEq(token.referencesThisBlock(), 0);
        assertEq(token.balanceOf(poolManager), 99e18);
    }

    function test_fastRatchetIsGlobalAndSparesTheVictim() public {
        vm.prank(curve, curve);
        token.transfer(alice, 100_000e18);
        vm.prank(curve, curve);
        token.transfer(bob, 100_000e18);
        // a sandwich from two wallets: front (alice), victim (bob), back (alice via a second wallet, carol)
        vm.prank(alice, alice);
        token.transfer(poolManager, 10_000e18); // #1 free
        vm.prank(bob, bob);
        token.transfer(poolManager, 10_000e18); // #2, the victim, free
        vm.prank(bob, bob);
        token.transfer(alice, 1_000e18); // bob's 2nd in the window: slow 8 bp, fast #3 = 90 bp → 90 bp
        assertEq(token.referencesThisBlock(), 3);
        uint256 fee3 = 1_000e18 * 90 / 10_000;
        assertEq(token.balanceOf(alice), 100_000e18 - 10_000e18 + 1_000e18 - fee3);
        assertEq(token.balanceOf(squareSink), fee3);
        assertEq(token.balanceOf(DEAD), 0, "nothing burned in kind");
        assertEq(token.totalSupply(), 1_000_000e18, "nothing burned");
        vm.roll(4096);
        assertEq(token.referencesThisBlock(), 0);
    }

    function test_slowRatchetFollowsTheWallet() public {
        vm.roll(2048 * 10); // start of a window
        vm.prank(curve, curve);
        token.transfer(alice, 100_000e18);
        vm.prank(alice, alice);
        token.transfer(poolManager, 10_000e18); // window ref #1, free
        vm.roll(2048 * 10 + 1000); // same window, new block
        vm.prank(alice, alice);
        token.transfer(poolManager, 10_000e18); // window ref #2: slow 8 bp; fast #1 = free
        assertEq(token.referencesThisWindowBy(alice), 2);
        uint256 fee = 10_000e18 * 8 / 10_000;
        assertEq(token.balanceOf(poolManager), 20_000e18 - fee);
        vm.roll(2048 * 11); // next window
        assertEq(token.referencesThisWindowBy(alice), 0);
    }

    function test_dustCannotRaiseTheBlockCount() public {
        vm.prank(curve, curve);
        token.transfer(alice, 100_000e18);
        vm.prank(curve, curve);
        token.transfer(bob, 100_000e18);
        // a griefer (alice) sprays dust: supply is 1M, so under 10 tokens is under 10 ppm
        vm.startPrank(alice, alice);
        for (uint256 i = 0; i < 5; i++) {
            token.transfer(poolManager, 1e18);
        }
        vm.stopPrank();
        assertEq(token.referencesThisBlock(), 0, "dust never touched the global count");
        assertEq(token.referencesThisWindowBy(alice), 5, "but it all counted on the sprayer");
        // a bystander's real transfer in the same block is the first global reference: free
        vm.prank(bob, bob);
        token.transfer(poolManager, 10_000e18);
        assertEq(token.referencesThisBlock(), 1);
        assertEq(token.balanceOf(poolManager), 5e18 - (5e18 * 0) + 10_000e18 - 0 - _dustFees(), "bob paid nothing");
    }

    function _dustFees() internal pure returns (uint256 f) {
        // alice's five dust transfers paid her own slow ratchet: m = 2..5 → 8, 18, 32, 50 bp of 1e18
        f = 1e18 * 8 / 10_000 + 1e18 * 18 / 10_000 + 1e18 * 32 / 10_000 + 1e18 * 50 / 10_000;
    }

    function test_burnStillWorksAndIsNotAReference() public {
        vm.prank(curve, curve);
        token.transfer(alice, 10e18);
        vm.prank(alice, alice);
        token.burn(1e18);
        assertEq(token.totalSupply(), 1_000_000e18 - 1e18);
        assertEq(token.referencesThisBlock(), 0);
    }
}
