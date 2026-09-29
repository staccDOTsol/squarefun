// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC12384} from "../../v2/ReferenceFeeERC20.sol";

/// @title ReferenceFeeERC20V2: the reference fee, after a live launch.
/// @notice The first token launched through Uniswap's Liquidity Launcher with the reference fee
///         traded for a day, and two things in the first version turned out wrong for a venue
///         where a swap is one transfer and a block is a quarter second.
///
///         The fast ratchet only charged a wallet already on its third own transfer in the
///         block. That gate was there to spare a bystander in a busy block. A crew that buys
///         from three wallets in one block, one transfer each, never reaches it: on the first
///         launch 13 such wallets made 92 trades and paid nothing, while the gate spared
///         ordinary buyers 0.6 basis points. It is gone. The k-th transfer of the token in a
///         block pays, whoever makes it.
///
///         The slow ratchet counted every transfer, so one trade routed through three contracts
///         used three of a wallet's weekly allowance. It now counts once per transaction. And
///         the allowance was sixteen, sized for a venue where a swap is two transfers; here the
///         ninetieth percentile of ordinary wallets made four trades on a token and the crew's
///         wallets made nine. It is six.
///
///         Everything else is unchanged: fees are taken in kind, paid to a settler with no
///         owner, sold for native, and all of it becomes stake. Nothing is burned.
abstract contract ReferenceFeeERC20V2 is ERC20, IERC12384 {
    /// @notice Fast ratchet: 10 bp per k² of the block's transfers, the first two free, at most 100%.
    uint256 public constant FAST_FLOOR = 10;
    uint256 public constant FAST_FREE = 2;
    uint256 public constant FAST_CAP = 10_000;
    /// @notice Kept for readers of the first version: every transfer is eligible, so the gate is one.
    uint256 public constant FAST_OWN_MIN = 1;
    /// @notice Slow ratchet: 2 bp per m² of one originator's transactions on this token in a week
    ///         (2,419,200 blocks of 250 ms), the first six free, at most 100%.
    uint256 public constant SLOW_FLOOR = 2;
    uint256 public constant SLOW_FREE = 6;
    uint256 public constant SLOW_CAP = 10_000;
    uint256 public constant SLOW_WINDOW = 2_419_200;
    /// @notice Transfers below this many parts per million of total supply (0.01%) do not move
    ///         the block's count: dust cannot raise anyone else's k.
    uint256 public constant MIN_REF_PPM = 100;
    uint256 internal constant BPS = 10_000;

    address private immutable _beneficiary;

    /// @dev Arbitrum-family chains expose their own block number here; elsewhere there is no code.
    address private constant ARB_SYS = 0x0000000000000000000000000000000000000064;

    /// @dev One word each: block or window number in the high bits, count in the low 64.
    uint256 private _global;
    mapping(address => uint256) private _byOrigin;
    mapping(address => uint256) private _ownBlock;
    /// @dev The originator's ordinal in its window, set by the first counted transfer of a
    ///      transaction and read by the rest of them. Cleared by the chain when the transaction ends.
    uint256 private transient _ordinalThisTx;

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

    /// @notice Transactions by `origin` that touched this token in the current window.
    function referencesThisWindowBy(address origin) public view returns (uint256) {
        return _count(_byOrigin[origin], uint64(_blockNumber() / SLOW_WINDOW));
    }

    /// @notice Transfers `origin` itself has made in the current block. Informational: nothing is gated on it.
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

    /// @dev Count on both ratchets; return the block ordinal and the fee rate that applies.
    function _reference(uint256 value) internal returns (uint256 n, uint256 bps) {
        uint64 current = _blockNumber();
        if (countsGlobally(value)) {
            n = _count(_global, current) + 1;
            _global = (uint256(current) << 64) | n;
            _ownBlock[tx.origin] = (uint256(current) << 64) | (_count(_ownBlock[tx.origin], current) + 1);
        }
        uint256 m = _ordinalThisTx;
        if (m == 0) {
            uint64 window = uint64(current / SLOW_WINDOW);
            m = _count(_byOrigin[tx.origin], window) + 1;
            _byOrigin[tx.origin] = (uint256(window) << 64) | m;
            _ordinalThisTx = m;
        }
        uint256 fast = referenceFeeBps(n);
        uint256 slow = slowFeeBps(m);
        bps = fast > slow ? fast : slow;
    }

    /// @dev Whether a transfer counts. Mint and burn never do, nor does what the settler sells.
    function _counted(address from, address to) internal view virtual returns (bool) {
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
