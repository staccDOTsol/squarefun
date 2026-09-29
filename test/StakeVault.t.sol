// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {StakeVault} from "../contracts/src/square/StakeVault.sol";

/// The deposit contract's own check, so a wrong root fails here as it would on mainnet.
contract DepositContractDouble {
    uint256 public count;
    bytes public lastPubkey;
    bytes public lastCredentials;
    uint256 public lastAmount;

    function deposit(bytes calldata pubkey, bytes calldata credentials, bytes calldata signature, bytes32 root)
        external
        payable
    {
        require(pubkey.length == 48 && credentials.length == 32 && signature.length == 96, "length");
        require(msg.value >= 1 ether && msg.value % 1 gwei == 0, "value");
        bytes32 pubkeyRoot = sha256(abi.encodePacked(pubkey, bytes16(0)));
        bytes32 signatureRoot = sha256(
            abi.encodePacked(
                sha256(abi.encodePacked(signature[:64])), sha256(abi.encodePacked(signature[64:], bytes32(0)))
            )
        );
        bytes32 node = sha256(
            abi.encodePacked(
                sha256(abi.encodePacked(pubkeyRoot, credentials)),
                sha256(abi.encodePacked(le64(uint64(msg.value / 1 gwei)), bytes24(0), signatureRoot))
            )
        );
        require(node == root, "root");
        count++;
        lastPubkey = pubkey;
        lastCredentials = credentials;
        lastAmount = msg.value;
    }

    function le64(uint64 v) internal pure returns (bytes8 r) {
        bytes8 b = bytes8(v);
        bytes memory o = new bytes(8);
        for (uint256 i; i < 8; ++i) {
            o[i] = b[7 - i];
        }
        r = bytes8(o);
    }
}

contract RejectsEther {
    function register(StakeVault vault, bytes calldata pubkey) external {
        vault.register(pubkey);
    }
}

contract StakeVaultTest is Test {
    address constant DEPOSIT = 0x00000000219ab540356cBB839Cbe05303d7705Fa;
    address constant ROOTS = 0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02;
    address constant REQUESTS = 0x00000961Ef480Eb55e80D19ad83579A64c007002;
    uint64 constant FAR = type(uint64).max;
    uint256 constant GENESIS = 1_606_824_023;

    StakeVault sink;
    StakeVault vault;
    address treasury = makeAddr("treasury");
    address operator = makeAddr("operator");
    bytes pubkey =
        hex"a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
    uint64 stamp;

    function setUp() public {
        vm.etch(DEPOSIT, address(new DepositContractDouble()).code);
        vm.warp(GENESIS + 400_000 * 384);
        stamp = uint64(block.timestamp);
        sink = new StakeVault(address(0));
        vault = new StakeVault(treasury);
    }

    // ---------------------------------------------------------------- helpers

    function h(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(a, b));
    }

    /// little-endian uint64 chunk, written the slow way on purpose
    function le(uint64 v) internal pure returns (bytes32 r) {
        bytes memory o = new bytes(32);
        for (uint256 i; i < 8; ++i) {
            o[i] = bytes1(uint8(v >> (8 * i)));
        }
        r = bytes32(o);
    }

    function credentialsOf(StakeVault v, bytes1 prefix) internal view returns (bytes32) {
        return bytes32(abi.encodePacked(prefix, bytes11(0), v.withdrawalAddress()));
    }

    function fields(bytes32 credentials) internal pure returns (StakeVault.ValidatorFields memory f) {
        f.withdrawalCredentials = credentials;
        f.effectiveBalance = 1_000_000_000;
        f.activationEligibilityEpoch = FAR;
        f.activationEpoch = FAR;
        f.exitEpoch = FAR;
        f.withdrawableEpoch = FAR;
    }

    /// Build a beacon block root around the validator and have EIP-4788 answer with it.
    function prove(bytes memory key, uint40 index, StakeVault.ValidatorFields memory f)
        internal
        returns (StakeVault.ValidatorProof memory p)
    {
        bytes32 node = h(
            h(
                h(sha256(abi.encodePacked(key, bytes16(0))), f.withdrawalCredentials),
                h(le(f.effectiveBalance), f.slashed ? bytes32(bytes1(0x01)) : bytes32(0))
            ),
            h(h(le(f.activationEligibilityEpoch), le(f.activationEpoch)), h(le(f.exitEpoch), le(f.withdrawableEpoch)))
        );
        p.timestamp = stamp;
        p.validatorIndex = index;
        p.fields = f;
        p.branch = new bytes32[](50);
        // validators list, then the length mix-in, then the state, then the header
        uint256 path = uint256(index) | (uint256(11) << 41) | (uint256(3) << 47);
        for (uint256 i; i < 50; ++i) {
            bytes32 sibling = keccak256(abi.encode("sibling", i, index));
            p.branch[i] = sibling;
            node = (path >> i) & 1 == 1 ? h(sibling, node) : h(node, sibling);
        }
        vm.mockCall(ROOTS, abi.encode(uint256(stamp)), abi.encode(node));
    }

    function registerAs(StakeVault v, address who) internal {
        vm.prank(who);
        v.register(pubkey);
    }

    // ------------------------------------------------------------------ tests

    function test_sinkIsItsOwnWithdrawalAddress() public view {
        assertEq(sink.withdrawalAddress(), address(sink));
        assertEq(vault.withdrawalAddress(), treasury);
        assertEq(sink.withdrawalCredentials(), bytes32(abi.encodePacked(bytes1(0x01), bytes11(0), address(sink))));
    }

    function test_everyVaultHasTheSameCode() public view {
        assertEq(address(sink).codehash, address(vault).codehash);
    }

    function test_stakeTopsUpAProvenValidator() public {
        vm.deal(address(sink), 32 ether);
        registerAs(sink, operator);
        StakeVault.ValidatorProof memory p = prove(pubkey, 1_234_567, fields(credentialsOf(sink, 0x01)));
        sink.stake(pubkey, p);

        DepositContractDouble d = DepositContractDouble(DEPOSIT);
        assertEq(d.count(), 1);
        assertEq(d.lastAmount(), 31 ether);
        assertEq(d.lastPubkey(), pubkey);
        assertEq(bytes32(d.lastCredentials()), sink.withdrawalCredentials());
        assertEq(address(sink).balance, 1 ether);
        assertEq(sink.bondsOwed(), 1 ether);
    }

    function test_stakeAcceptsCompoundingCredentials() public {
        vm.deal(address(sink), 32 ether);
        registerAs(sink, operator);
        sink.stake(pubkey, prove(pubkey, 7, fields(credentialsOf(sink, 0x02))));
        assertEq(sink.bondsOwed(), 1 ether);
    }

    function test_stakeRefusesAValidatorThatPaysSomeoneElse() public {
        vm.deal(address(sink), 32 ether);
        registerAs(sink, operator);
        bytes32 theirs = bytes32(abi.encodePacked(bytes1(0x01), bytes11(0), operator));
        StakeVault.ValidatorProof memory p = prove(pubkey, 7, fields(theirs));
        vm.expectRevert(StakeVault.NotThisVault.selector);
        sink.stake(pubkey, p);
    }

    function test_stakeRefusesBlsCredentials() public {
        vm.deal(address(sink), 32 ether);
        registerAs(sink, operator);
        StakeVault.ValidatorProof memory p = prove(pubkey, 7, fields(credentialsOf(sink, 0x00)));
        vm.expectRevert(StakeVault.NotThisVault.selector);
        sink.stake(pubkey, p);
    }

    function test_stakeNeedsARegisteredKey() public {
        vm.deal(address(sink), 32 ether);
        StakeVault.ValidatorProof memory p = prove(pubkey, 7, fields(credentialsOf(sink, 0x01)));
        vm.expectRevert(StakeVault.NotRegistered.selector);
        sink.stake(pubkey, p);
    }

    function test_stakeNeedsThirtyTwoFree() public {
        vm.deal(address(sink), 32 ether - 1);
        registerAs(sink, operator);
        StakeVault.ValidatorProof memory p = prove(pubkey, 7, fields(credentialsOf(sink, 0x01)));
        vm.expectRevert(StakeVault.NothingToStake.selector);
        sink.stake(pubkey, p);
    }

    function test_bondsOfEarlierValidatorsAreNotStaked() public {
        vm.deal(address(sink), 64 ether - 1);
        registerAs(sink, operator);
        sink.stake(pubkey, prove(pubkey, 7, fields(credentialsOf(sink, 0x01))));
        // 33 ETH - 1 wei is left and 1 ETH of it is owed: not enough for a second
        bytes memory second = abi.encodePacked(bytes32(uint256(2)), bytes16(uint128(2)));
        vm.prank(operator);
        sink.register(second);
        StakeVault.ValidatorProof memory p = prove(second, 8, fields(credentialsOf(sink, 0x01)));
        vm.expectRevert(StakeVault.NothingToStake.selector);
        sink.stake(second, p);
        vm.deal(address(sink), address(sink).balance + 1);
        sink.stake(second, p);
        assertEq(sink.bondsOwed(), 2 ether);
    }

    function test_stakeOnce() public {
        vm.deal(address(sink), 100 ether);
        registerAs(sink, operator);
        StakeVault.ValidatorProof memory p = prove(pubkey, 7, fields(credentialsOf(sink, 0x01)));
        sink.stake(pubkey, p);
        vm.expectRevert(StakeVault.AlreadyStaked.selector);
        sink.stake(pubkey, p);
    }

    function test_stakeRefusesAFundedValidatorWithSweptCredentials() public {
        // 31 ETH on top of a full 0x01 validator would be swept to the withdrawal address
        vm.deal(address(vault), 32 ether);
        registerAs(vault, operator);
        StakeVault.ValidatorFields memory f = fields(credentialsOf(vault, 0x01));
        f.effectiveBalance = 32_000_000_000;
        StakeVault.ValidatorProof memory p = prove(pubkey, 7, f);
        vm.expectRevert(StakeVault.NotStakeable.selector);
        vault.stake(pubkey, p);
        // a compounding validator keeps what it is given
        f.withdrawalCredentials = credentialsOf(vault, 0x02);
        vault.stake(pubkey, prove(pubkey, 7, f));
    }

    function test_staleProofIsRefused() public {
        vm.deal(address(sink), 32 ether);
        registerAs(sink, operator);
        StakeVault.ValidatorProof memory p = prove(pubkey, 7, fields(credentialsOf(sink, 0x01)));
        vm.warp(block.timestamp + 1 hours + 1);
        vm.expectRevert(StakeVault.StaleProof.selector);
        sink.stake(pubkey, p);
    }

    function test_ejectWaitsForActivation() public {
        _staked(sink);
        // the top-up has not been processed yet: still 1 ETH and not active
        StakeVault.ValidatorProof memory p = prove(pubkey, 7, fields(credentialsOf(sink, 0x01)));
        vm.expectRevert(StakeVault.NotEjectable.selector);
        sink.eject(pubkey, p);
    }

    function test_stakeRefusesAnExitingValidator() public {
        vm.deal(address(sink), 32 ether);
        registerAs(sink, operator);
        StakeVault.ValidatorFields memory f = fields(credentialsOf(sink, 0x01));
        f.exitEpoch = 500_000;
        StakeVault.ValidatorProof memory p = prove(pubkey, 7, f);
        vm.expectRevert(StakeVault.NotStakeable.selector);
        sink.stake(pubkey, p);
    }

    function test_proofIsBoundToIndexFieldsAndKey() public {
        vm.deal(address(sink), 32 ether);
        registerAs(sink, operator);
        StakeVault.ValidatorProof memory p = prove(pubkey, 7, fields(credentialsOf(sink, 0x01)));

        p.validatorIndex = 8;
        vm.expectRevert(StakeVault.BadProof.selector);
        sink.stake(pubkey, p);
        p.validatorIndex = 7;

        p.fields.effectiveBalance = 32_000_000_000;
        vm.expectRevert(StakeVault.BadProof.selector);
        sink.stake(pubkey, p);
        p.fields.effectiveBalance = 1_000_000_000;

        p.branch[49] = bytes32(uint256(1));
        vm.expectRevert(StakeVault.BadProof.selector);
        sink.stake(pubkey, p);
    }

    function test_proofNeedsARootEip4788Knows() public {
        vm.deal(address(sink), 32 ether);
        registerAs(sink, operator);
        StakeVault.ValidatorProof memory p = prove(pubkey, 7, fields(credentialsOf(sink, 0x01)));
        p.timestamp = stamp - 12;
        vm.mockCallRevert(ROOTS, abi.encode(uint256(stamp - 12)), "");
        vm.expectRevert(StakeVault.NoBeaconRoot.selector);
        sink.stake(pubkey, p);
    }

    function test_registerOnceAndOnlyAKey() public {
        vm.expectRevert(StakeVault.BadPubkey.selector);
        sink.register(hex"01");
        registerAs(sink, operator);
        vm.expectRevert(StakeVault.AlreadyRegistered.selector);
        sink.register(pubkey);
    }

    function _staked(StakeVault v) internal {
        vm.deal(address(v), 32 ether);
        registerAs(v, operator);
        v.stake(pubkey, prove(pubkey, 7, fields(credentialsOf(v, 0x01))));
    }

    function test_exitReturnsTheBond() public {
        _staked(sink);
        StakeVault.ValidatorFields memory f = fields(credentialsOf(sink, 0x01));
        f.exitEpoch = 399_000;
        f.withdrawableEpoch = 399_256;
        f.effectiveBalance = 0;
        sink.exit(pubkey, prove(pubkey, 7, f));
        assertEq(operator.balance, 1 ether);
        assertEq(sink.bondsOwed(), 0);
        assertEq(address(sink).balance, 0);
    }

    function test_exitWaitsForWithdrawable() public {
        _staked(sink);
        StakeVault.ValidatorFields memory f = fields(credentialsOf(sink, 0x01));
        f.exitEpoch = 399_990;
        f.withdrawableEpoch = 400_246;
        StakeVault.ValidatorProof memory p = prove(pubkey, 7, f);
        vm.expectRevert(StakeVault.NotWithdrawable.selector);
        sink.exit(pubkey, p);
        p = prove(pubkey, 7, fields(credentialsOf(sink, 0x01)));
        vm.expectRevert(StakeVault.NotWithdrawable.selector);
        sink.exit(pubkey, p);
    }

    function test_slashedForfeitsTheBond() public {
        _staked(sink);
        StakeVault.ValidatorFields memory f = fields(credentialsOf(sink, 0x01));
        f.slashed = true;
        f.exitEpoch = 399_000;
        f.withdrawableEpoch = 399_256;
        sink.exit(pubkey, prove(pubkey, 7, f));
        assertEq(operator.balance, 0);
        assertEq(sink.bondsOwed(), 0);
        assertEq(address(sink).balance, 1 ether, "the bond stays to be staked");
    }

    function test_exitOnce() public {
        _staked(sink);
        StakeVault.ValidatorFields memory f = fields(credentialsOf(sink, 0x01));
        f.exitEpoch = 399_000;
        f.withdrawableEpoch = 399_256;
        StakeVault.ValidatorProof memory p = prove(pubkey, 7, f);
        sink.exit(pubkey, p);
        vm.deal(address(sink), 1 ether);
        vm.expectRevert(StakeVault.AlreadyExited.selector);
        sink.exit(pubkey, p);
    }

    function test_exitFailsWholeIfTheOperatorRefusesEther() public {
        RejectsEther stubborn = new RejectsEther();
        vm.deal(address(sink), 32 ether);
        stubborn.register(sink, pubkey);
        sink.stake(pubkey, prove(pubkey, 7, fields(credentialsOf(sink, 0x01))));
        StakeVault.ValidatorFields memory f = fields(credentialsOf(sink, 0x01));
        f.exitEpoch = 399_000;
        f.withdrawableEpoch = 399_256;
        StakeVault.ValidatorProof memory p = prove(pubkey, 7, f);
        vm.expectRevert(StakeVault.BondNotPaid.selector);
        sink.exit(pubkey, p);
        assertEq(sink.bondsOwed(), 1 ether);
    }

    function test_ejectAsksForAFullExit() public {
        _staked(sink);
        StakeVault.ValidatorFields memory f = fields(credentialsOf(sink, 0x01));
        f.effectiveBalance = 31_000_000_000;
        f.activationEpoch = 300_000;
        StakeVault.ValidatorProof memory p = prove(pubkey, 7, f);
        vm.mockCall(REQUESTS, 7 wei, abi.encodePacked(pubkey, uint64(0)), "");
        vm.expectCall(REQUESTS, 7 wei, abi.encodePacked(pubkey, uint64(0)));
        vm.deal(address(this), 7 wei);
        sink.eject{value: 7 wei}(pubkey, p);
    }

    function test_ejectLeavesAHealthyValidatorAlone() public {
        _staked(sink);
        StakeVault.ValidatorFields memory f = fields(credentialsOf(sink, 0x01));
        f.effectiveBalance = 32_000_000_000;
        StakeVault.ValidatorProof memory p = prove(pubkey, 7, f);
        vm.expectRevert(StakeVault.NotEjectable.selector);
        sink.eject(pubkey, p);
    }

    function test_onlyASelfOwnedVaultCanEject() public {
        _staked(vault);
        StakeVault.ValidatorFields memory f = fields(credentialsOf(vault, 0x01));
        f.effectiveBalance = 31_000_000_000;
        StakeVault.ValidatorProof memory p = prove(pubkey, 7, f);
        vm.expectRevert(StakeVault.CannotRequest.selector);
        vault.eject(pubkey, p);
    }

    function test_nothingElseMovesEther() public {
        vm.deal(address(sink), 100 ether);
        (bool ok,) = address(sink).call(abi.encodeWithSignature("withdraw(uint256)", 1 ether));
        assertFalse(ok);
        (ok,) = address(sink).call(abi.encodeWithSignature("transfer(address,uint256)", address(this), 1 ether));
        assertFalse(ok);
        assertEq(address(sink).balance, 100 ether);
    }
}

/// Against mainnet: the real deposit contract takes the vault's top-up, which it would not
/// if the deposit data root were computed differently from how it computes it.
contract StakeVaultForkTest is Test {
    address constant DEPOSIT = 0x00000000219ab540356cBB839Cbe05303d7705Fa;
    address constant ROOTS = 0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02;
    bytes pubkey =
        hex"a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

    event DepositEvent(bytes pubkey, bytes withdrawal_credentials, bytes amount, bytes signature, bytes index);

    function test_fork_theDepositContractAcceptsTheTopUp() public {
        string memory rpc = vm.envOr("ETH_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
        }
        vm.createSelectFork(rpc);
        StakeVault sink = new StakeVault(address(0));
        vm.deal(address(sink), 32 ether);
        sink.register(pubkey);

        StakeVault.ValidatorProof memory p;
        p.timestamp = uint64(block.timestamp);
        p.validatorIndex = 9;
        p.fields.withdrawalCredentials = sink.withdrawalCredentials();
        p.fields.effectiveBalance = 1_000_000_000;
        p.fields.activationEligibilityEpoch = type(uint64).max;
        p.fields.activationEpoch = type(uint64).max;
        p.fields.exitEpoch = type(uint64).max;
        p.fields.withdrawableEpoch = type(uint64).max;
        bytes32 node = _root(p.fields);
        p.branch = new bytes32[](50);
        uint256 path = uint256(9) | (uint256(11) << 41) | (uint256(3) << 47);
        for (uint256 i; i < 50; ++i) {
            p.branch[i] = bytes32(i + 1);
            node = (path >> i) & 1 == 1
                ? sha256(abi.encodePacked(p.branch[i], node))
                : sha256(abi.encodePacked(node, p.branch[i]));
        }
        vm.mockCall(ROOTS, abi.encode(uint256(p.timestamp)), abi.encode(node));

        uint256 before = DEPOSIT.balance;
        vm.recordLogs();
        sink.stake(pubkey, p);
        assertEq(DEPOSIT.balance - before, 31 ether);
        assertEq(address(sink).balance, 1 ether);
    }

    function _root(StakeVault.ValidatorFields memory f) internal view returns (bytes32) {
        bytes32 far = bytes32(bytes8(type(uint64).max));
        bytes32 gwei1 = bytes32(bytes8(0x00ca9a3b00000000)); // 1_000_000_000 little-endian
        return sha256(
            abi.encodePacked(
                sha256(
                    abi.encodePacked(
                        sha256(abi.encodePacked(sha256(abi.encodePacked(pubkey, bytes16(0))), f.withdrawalCredentials)),
                        sha256(abi.encodePacked(gwei1, bytes32(0)))
                    )
                ),
                sha256(abi.encodePacked(sha256(abi.encodePacked(far, far)), sha256(abi.encodePacked(far, far))))
            )
        );
    }
}
