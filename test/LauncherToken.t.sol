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

    function test_fastRatchetSparesBystandersAndBitesTheSecondSwap() public {
        vm.prank(curve, curve);
        token.transfer(alice, 200_000e18);
        vm.prank(curve, curve);
        token.transfer(bob, 200_000e18);
        // alice: a swap is two transfers (pool + hook); bob: one swap in the same block
        vm.startPrank(alice, alice);
        token.transfer(poolManager, 10_000e18); // global #1, alice #1
        token.transfer(poolManager, 10_000e18); // global #2, alice #2: free
        vm.stopPrank();
        vm.startPrank(bob, bob);
        token.transfer(poolManager, 10_000e18); // global #3, bob #1: a bystander, free
        token.transfer(poolManager, 10_000e18); // global #4, bob #2: still free
        vm.stopPrank();
        assertEq(token.balanceOf(poolManager), 40_000e18, "nobody has paid yet");
        assertEq(token.referencesThisBlock(), 4);
        assertEq(token.referencesThisBlockBy(bob), 2);
        // alice's second swap in the block: her 3rd and 4th own references, global #5 and #6
        vm.startPrank(alice, alice);
        token.transfer(poolManager, 10_000e18); // fast 10 bp * 25 = 250 bp
        token.transfer(poolManager, 10_000e18); // fast 10 bp * 36 = 360 bp
        vm.stopPrank();
        uint256 fee5 = 10_000e18 * 250 / 10_000;
        uint256 fee6 = 10_000e18 * 360 / 10_000;
        assertEq(token.balanceOf(poolManager), 60_000e18 - fee5 - fee6);
        assertEq(token.balanceOf(squareSink), fee5 + fee6);
        assertEq(token.balanceOf(DEAD), 0, "nothing burned in kind");
        assertEq(token.totalSupply(), 1_000_000e18, "nothing burned");
        vm.roll(vm.getBlockNumber() + 1);
        assertEq(token.referencesThisBlock(), 0);
        assertEq(token.referencesThisBlockBy(alice), 0);
    }

    function test_slowRatchetFollowsTheWalletForAWeek() public {
        uint256 W = token.SLOW_WINDOW();
        vm.roll(W * 10);
        vm.prank(curve, curve);
        token.transfer(alice, 500_000e18);
        // sixteen touches over the week are free; each in its own block so the fast gate never opens
        for (uint256 i = 0; i < 16; i++) {
            vm.roll(W * 10 + 1000 * (i + 1));
            vm.prank(alice, alice);
            token.transfer(poolManager, 1_000e18);
        }
        assertEq(token.balanceOf(poolManager), 16_000e18, "sixteen free");
        assertEq(token.referencesThisWindowBy(alice), 16);
        // the seventeenth pays 2 bp * 17² = 578 bp
        vm.roll(W * 10 + 1000 * 17);
        vm.prank(alice, alice);
        token.transfer(poolManager, 1_000e18);
        assertEq(token.balanceOf(poolManager), 17_000e18 - 1_000e18 * 578 / 10_000);
        // next week, clean slate
        vm.roll(W * 11);
        assertEq(token.referencesThisWindowBy(alice), 0);
    }

    function test_dustCannotRaiseTheBlockCount() public {
        vm.prank(curve, curve);
        token.transfer(alice, 100_000e18);
        vm.prank(curve, curve);
        token.transfer(bob, 100_000e18);
        // a griefer sprays dust: supply is 1M, so under 100 tokens is under 100 ppm
        vm.startPrank(alice, alice);
        for (uint256 i = 0; i < 5; i++) {
            token.transfer(poolManager, 1e18);
        }
        vm.stopPrank();
        assertEq(token.referencesThisBlock(), 0, "dust never touched the global count");
        assertEq(token.referencesThisWindowBy(alice), 5, "but it all counted on the sprayer");
        vm.prank(bob, bob);
        token.transfer(poolManager, 10_000e18);
        assertEq(token.referencesThisBlock(), 1);
        assertEq(token.balanceOf(poolManager), 5e18 + 10_000e18, "bob paid nothing, and the dust was under the slow free count too");
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
