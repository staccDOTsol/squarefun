// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title IERC12384: block-scoped reference counting with an escalating in-kind fee.
/// @notice The ERC-20 form of EIP-12384. Where the EIP has the client count calls into
///         an enrolled address per block and charge gas, this token counts its own
///         transfers per block and charges itself, in kind. Same schedule, same
///         destinations, no protocol change needed, deployable on any EVM chain today.
interface IERC12384 {
    /// @notice A counted transfer paid its reference fee.
    /// @param n the reference ordinal in this block (1 = first)
    /// @param fee tokens taken from `value` and split between sink and beneficiary
    event Reference(address indexed from, address indexed to, uint256 n, uint256 fee);

    /// @notice Fast ratchet: references counted in the current block, across every originator.
    function referencesThisBlock() external view returns (uint256);
    /// @notice Slow ratchet: references `origin` has made in the current window.
    function referencesThisWindowBy(address origin) external view returns (uint256);
    /// @notice References `origin` itself has made in the current block (the fast ratchet's gate).
    function referencesThisBlockBy(address origin) external view returns (uint256);
    /// @notice Fast fee in basis points for the n-th reference in a block (first `FAST_FREE` free).
    function referenceFeeBps(uint256 n) external pure returns (uint256);
    /// @notice Slow fee in basis points for an originator's n-th reference in a window (first `SLOW_FREE` free).
    function slowFeeBps(uint256 n) external pure returns (uint256);
    /// @notice Where fees land, in kind, before settlement. Same as `beneficiary()`.
    function sink() external view returns (address);
    /// @notice The settler that turns fees into native: half burned, half to a stake pool.
    function beneficiary() external view returns (address);
}

/// @title ReferenceFeeERC20: reference implementation of IERC12384.
/// @notice Rules, in the EIP's terms:
///
///           1. Every transfer between two non-zero addresses is a reference to this
///              token. Mint and burn are not.
///           2. Two ratchets, and a transfer pays the larger:
///              FAST, global, per block: every reference to this token in the chain's
///                own block counts, whoever made it, but the fee only applies to an
///                originator already on its third own reference in the block (its second
///                swap). The first FAST_FREE are free, then FAST_FLOOR·k² bp, capped at
///                100%. A bystander's single swap never pays it; a machine walking the
///                token in one block pays on every leg after its first swap.
///              SLOW, per originator, per token, per window of SLOW_WINDOW blocks (a
///                week): what tx.origin itself has done to this token lately. The first
///                SLOW_FREE (sixteen) free, then SLOW_FLOOR·m² bp, capped at 100%. A
///                wallet that keeps coming back over hours and days pays more each time.
///                Nobody can raise anyone else's count.
///           2a. Dust does not count on the fast ratchet: a transfer under MIN_REF_PPM of
///              supply leaves the global count alone, so nobody can raise anyone else's k
///              for the price of dust. It still counts on the sender's own slow ratchet.
///           2b. "Block" is the chain's own block. On Arbitrum-family chains
///              `block.number` is the parent chain's height (a ~12 s window), so the
///              ArbSys precompile is read when it is present.
///           3. The k-th reference in a block pays `FLOOR_BPS * k²` basis points of the
///              transferred amount, capped at `CAP_BPS`, with the first `K_FREE`
///              references free. A wallet transfer or a single swap is almost always
///              the first reference in its block and pays nothing.
///           4. The fee does not reach the party being priced. It is paid in kind to a
///              settler with no owner, which anyone can trigger to sell it for native:
///              half of the native is burned, half goes to the stake pool the deployer
///              fixed, so the people paid are the ones staking, in the chain's own coin.
///
///         The counter is one storage slot: the block it belongs to and the count.
///         The first reference in a new block rewrites it; later references in the
///         same block update a warm slot.
///
///         What this cannot see: a venue with flash accounting nets a sequence of
///         operations into one settlement transfer, so it counts as one reference.
///         That is the reason the Ethereum core EIP counts calls at the client
///         instead. This contract is the version that needs no fork.
abstract contract ReferenceFeeERC20 is ERC20, IERC12384 {
    /// @notice Fast ratchet: 10 bp per k² of the block's references, first two free, never above 100%.
    ///         It only bites an originator that is already on its second swap in the block (three or
    ///         more of its own references), so a bystander's single swap, which is two transfers on a
    ///         v4 route, never pays it however busy the block is. Replayed on 65 launches: 4,690 of the
    ///         4,713 bot references landing third or later in a block came from a wallet already on its
    ///         third; 23 did not.
    uint256 public constant FAST_FLOOR = 10;
    uint256 public constant FAST_FREE = 2;
    uint256 public constant FAST_CAP = 10_000;
    uint256 public constant FAST_OWN_MIN = 3;
    /// @notice Slow ratchet: 2 bp per m² of one originator's references to this token in a window of a
    ///         week (2,419,200 blocks of 250 ms), the first sixteen free, never above 100%. Bots touched a
    ///         token 6 to 37 times over twelve hours in the replay; humans 3 to 8 over seven minutes.
    uint256 public constant SLOW_FLOOR = 2;
    uint256 public constant SLOW_FREE = 16;
    uint256 public constant SLOW_CAP = 10_000;
    uint256 public constant SLOW_WINDOW = 2_419_200;
    /// @notice Transfers below this many parts per million of total supply (0.01%) do not count on
    ///         the fast ratchet: dust cannot raise anyone else's k. They still count, and pay, on the
    ///         sender's own slow ratchet, so splitting into dust to evade costs the splitter.
    uint256 public constant MIN_REF_PPM = 100;
    uint256 internal constant BPS = 10_000;

    /// @notice Where every fee goes, in kind: the settler that sells it for native, burns half
    ///         and stakes half. Fixed at deployment. `sink()` and `beneficiary()` both name it,
    ///         so v1 readers keep working.
    address private immutable _beneficiary;

    /// @dev Arbitrum-family chains expose their own block number here; elsewhere there is no code.
    address private constant ARB_SYS = 0x0000000000000000000000000000000000000064;

    /// @dev One word each: block or window number in the high bits, count in the low 64.
    uint256 private _global;
    mapping(address => uint256) private _byOrigin;
    /// @dev the originator's own references in the current block, for the fast gate
    mapping(address => uint256) private _ownBlock;

    /// @param beneficiary_ the settler every fee is paid to
    constructor(address beneficiary_) {
        require(beneficiary_ != address(0), "settler");
        _beneficiary = beneficiary_;
    }

    function sink() public view returns (address) {
        return _beneficiary;
    }

    function beneficiary() public view returns (address) {
        return _beneficiary;
    }

    /// @dev The chain's own block: ArbSys.arbBlockNumber() on Arbitrum-family chains, block.number elsewhere.
    function _blockNumber() internal view returns (uint64) {
        if (ARB_SYS.code.length != 0) {
            (bool ok, bytes memory ret) = ARB_SYS.staticcall(hex"a3b1b31d"); // arbBlockNumber()
            if (ok && ret.length == 32) return uint64(abi.decode(ret, (uint256)));
        }
        return uint64(block.number);
    }

    function _count(uint256 packed, uint64 current) private pure returns (uint256) {
        return packed >> 64 == current ? packed & type(uint64).max : 0;
    }

    function referencesThisBlock() public view returns (uint256) {
        return _count(_global, _blockNumber());
    }

    function referencesThisWindowBy(address origin) public view returns (uint256) {
        return _count(_byOrigin[origin], uint64(_blockNumber() / SLOW_WINDOW));
    }

    /// @notice References `origin` itself has made in the current block.
    function referencesThisBlockBy(address origin) public view returns (uint256) {
        return _count(_ownBlock[origin], _blockNumber());
    }

    function referenceFeeBps(uint256 n) public pure returns (uint256) {
        if (n <= FAST_FREE) return 0;
        uint256 r = FAST_FLOOR * n * n;
        return r > FAST_CAP ? FAST_CAP : r;
    }

    function slowFeeBps(uint256 n) public pure returns (uint256) {
        if (n <= SLOW_FREE) return 0;
        uint256 r = SLOW_FLOOR * n * n;
        return r > SLOW_CAP ? SLOW_CAP : r;
    }

    /// @notice Whether a transfer of `value` is big enough to count on the fast ratchet.
    function countsGlobally(uint256 value) public view returns (bool) {
        return value * 1_000_000 >= totalSupply() * MIN_REF_PPM;
    }

    /// @dev Count on both ratchets; return the fast (global) ordinal and the fee rate that applies.
    function _reference(uint256 value) internal returns (uint256 n, uint256 bps) {
        uint64 current = _blockNumber();
        uint256 own;
        if (countsGlobally(value)) {
            n = _count(_global, current) + 1;
            _global = (uint256(current) << 64) | n;
            own = _count(_ownBlock[tx.origin], current) + 1;
            _ownBlock[tx.origin] = (uint256(current) << 64) | own;
        }
        uint64 window = uint64(current / SLOW_WINDOW);
        uint256 m = _count(_byOrigin[tx.origin], window) + 1;
        _byOrigin[tx.origin] = (uint256(window) << 64) | m;
        // the fast ratchet bites only an originator already on its second swap in the block
        uint256 fast = own >= FAST_OWN_MIN ? referenceFeeBps(n) : 0;
        uint256 slow = slowFeeBps(m);
        bps = fast > slow ? fast : slow;
    }

    /// @dev Whether a transfer counts. Mint and burn never do; subclasses may exempt
    ///      more (a curve that is the token's own market, for instance).
    function _counted(address from, address to) internal view virtual returns (bool) {
        // settlement is not market activity: what the settler sells is not a reference
        return from != address(0) && to != address(0) && from != _beneficiary;
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        if (!_counted(from, to)) {
            super._update(from, to, value);
            return;
        }
        (uint256 n, uint256 bps) = _reference(value);
        uint256 fee = (value * bps) / BPS;
        if (fee != 0) super._update(from, _beneficiary, fee);
        super._update(from, to, value - fee);
        emit Reference(from, to, n, fee);
    }
}
