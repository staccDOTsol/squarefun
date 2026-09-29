// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {StakeVault} from "../contracts/src/square/StakeVault.sol";
import {DepositContractDouble} from "./StakeVault.t.sol";

contract StakeVaultHarness is StakeVault {
    constructor(address w) StakeVault(w) {}

    function verify(bytes calldata pubkey, ValidatorProof calldata proof) external view {
        _verify(pubkey, proof);
    }
}

/// Proofs taken from a finalized mainnet state (Fulu, slot in the fixture) by
/// script/beacon/prove.py, which decodes the state, checks its root against the block
/// header the chain reports, and walks the tree. Nothing here was built by the test.
contract StakeVaultMainnetProofTest is Test {
    address constant DEPOSIT = 0x00000000219ab540356cBB839Cbe05303d7705Fa;
    address constant ROOTS = 0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02;
    uint256 constant GENESIS = 1_606_824_023;

    string json;
    uint64 stamp;

    function setUp() public {
        json = vm.readFile("test/fixtures/beacon_mainnet_fulu.json");
        uint256 slot = vm.parseJsonUint(json, ".slot");
        // the block after `slot` carries the root of `slot`
        stamp = uint64(GENESIS + (slot + 1) * 12);
        vm.warp(stamp);
        vm.mockCall(ROOTS, abi.encode(uint256(stamp)), abi.encode(vm.parseJsonBytes32(json, ".blockRoot")));
        vm.etch(DEPOSIT, address(new DepositContractDouble()).code);
    }

    function load(uint256 i) internal view returns (bytes memory pubkey, StakeVault.ValidatorProof memory p) {
        string memory at = string.concat(".validators[", vm.toString(i), "]");
        pubkey = vm.parseJsonBytes(json, string.concat(at, ".pubkey"));
        p.timestamp = stamp;
        p.validatorIndex = uint40(vm.parseJsonUint(json, string.concat(at, ".index")));
        p.fields.withdrawalCredentials = vm.parseJsonBytes32(json, string.concat(at, ".withdrawalCredentials"));
        p.fields.effectiveBalance = uint64(vm.parseJsonUint(json, string.concat(at, ".effectiveBalance")));
        p.fields.slashed = vm.parseJsonBool(json, string.concat(at, ".slashed"));
        p.fields.activationEligibilityEpoch =
            uint64(vm.parseJsonUint(json, string.concat(at, ".activationEligibilityEpoch")));
        p.fields.activationEpoch = uint64(vm.parseJsonUint(json, string.concat(at, ".activationEpoch")));
        p.fields.exitEpoch = uint64(vm.parseJsonUint(json, string.concat(at, ".exitEpoch")));
        p.fields.withdrawableEpoch = uint64(vm.parseJsonUint(json, string.concat(at, ".withdrawableEpoch")));
        p.branch = vm.parseJsonBytes32Array(json, string.concat(at, ".branch"));
    }

    function vaultFor(StakeVault.ValidatorProof memory p) internal returns (StakeVaultHarness) {
        return new StakeVaultHarness(address(uint160(uint256(p.fields.withdrawalCredentials))));
    }

    function test_mainnet_everyProofVerifies() public {
        for (uint256 i; i < 3; ++i) {
            (bytes memory pubkey, StakeVault.ValidatorProof memory p) = load(i);
            vaultFor(p).verify(pubkey, p);
        }
    }

    function test_mainnet_aProofForOneValidatorIsNotAProofForItsNeighbour() public {
        (bytes memory pubkey, StakeVault.ValidatorProof memory p) = load(0);
        StakeVaultHarness v = vaultFor(p);
        p.validatorIndex += 1;
        vm.expectRevert(StakeVault.BadProof.selector);
        v.verify(pubkey, p);
    }

    function test_mainnet_aChangedFieldFails() public {
        (bytes memory pubkey, StakeVault.ValidatorProof memory p) = load(0);
        StakeVaultHarness v = vaultFor(p);
        p.fields.withdrawableEpoch -= 1;
        vm.expectRevert(StakeVault.BadProof.selector);
        v.verify(pubkey, p);
    }

    function test_mainnet_aFullValidatorWithSweptCredentialsIsNotToppedUp() public {
        // an active validator with 0x01 credentials and 32 ETH
        (bytes memory pubkey, StakeVault.ValidatorProof memory p) = load(0);
        assertEq(uint8(p.fields.withdrawalCredentials[0]), 1);
        StakeVaultHarness v = vaultFor(p);
        vm.deal(address(v), 32 ether);
        v.register(pubkey);
        vm.expectRevert(StakeVault.NotStakeable.selector);
        v.stake(pubkey, p);
    }

    function test_mainnet_stakeACompoundingValidator() public {
        (bytes memory pubkey, StakeVault.ValidatorProof memory p) = load(1);
        assertEq(uint8(p.fields.withdrawalCredentials[0]), 2);
        StakeVaultHarness v = vaultFor(p);
        vm.deal(address(v), 32 ether);
        v.register(pubkey);
        v.stake(pubkey, p);
        assertEq(DepositContractDouble(DEPOSIT).lastAmount(), 31 ether);
        assertEq(DepositContractDouble(DEPOSIT).lastPubkey(), pubkey);
    }

    function test_mainnet_anExitedValidatorCannotBeStaked() public {
        (bytes memory pubkey, StakeVault.ValidatorProof memory p) = load(2);
        StakeVaultHarness v = vaultFor(p);
        vm.deal(address(v), 32 ether);
        v.register(pubkey);
        vm.expectRevert(StakeVault.NotStakeable.selector);
        v.stake(pubkey, p);
    }
}
