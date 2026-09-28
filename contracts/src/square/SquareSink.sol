// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title SquareSink: where the issuer's half of every reference fee lands.
/// @notice Every launch token the factory deploys names this contract as its
///         IERC12384 beneficiary, and so does SQUARE itself. Fees arrive in kind,
///         in whatever token the machine was walking. Anyone may `sync` a token:
///         the new balance since the last sync is split, `wizardsBps` to the
///         Stacc Wizards fee fanout on Robinhood and the rest to SQUARE stakers,
///         pro rata to their stake as of the end of the previous block.
///
///         Stakes are checkpointed per block, so a distribution can be settled
///         against the stake that existed when it happened, however many reward
///         tokens exist and however late a staker claims. Staking after a
///         distribution earns nothing from it.
///
///         No owner. The fanout address and the split are fixed at deployment.
///         Nothing here can be paused, redirected or withdrawn by anyone but a
///         staker claiming what accrued to their stake.
contract SquareSink is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;

    struct Checkpoint {
        uint64 blockNumber;
        uint192 value;
    }

    struct Distribution {
        uint64 blockNumber;
        uint192 amount;
        uint256 totalStakedBefore; // stake as of the end of the previous block
    }

    /// @notice The Stacc Wizards fee fanout on Robinhood Chain.
    address public immutable wizards;
    /// @notice Share of every synced amount paid to the wizards, in basis points.
    uint256 public immutable wizardsBps;
    /// @notice The staking token. Set once, by the deployer, right after SQUARE is
    ///         deployed with this sink as its beneficiary.
    IERC20 public square;
    address private immutable _deployer;

    uint256 public totalStaked;
    mapping(address => uint256) public staked;
    Checkpoint[] private _totalCheckpoints;
    mapping(address => Checkpoint[]) private _checkpoints;

    /// @dev Per reward token: every distribution to stakers, in order.
    mapping(address => Distribution[]) private _distributions;
    /// @dev Per reward token: balance already accounted for (stake, or distributed and unclaimed).
    mapping(address => uint256) public reserved;
    /// @dev staker => token => number of distributions already claimed.
    mapping(address => mapping(address => uint256)) public claimedThrough;

    event SquareSet(address square);
    event Synced(address indexed token, uint256 toWizards, uint256 toStakers);
    event Staked(address indexed who, uint256 amount);
    event Unstaked(address indexed who, uint256 amount);
    event Claimed(address indexed who, address indexed token, uint256 amount, uint256 through);

    error ZeroAddress();
    error AlreadySet();
    error NotDeployer();
    error BadBps();
    error NotSet();

    constructor(address wizards_, uint256 wizardsBps_) {
        if (wizards_ == address(0)) revert ZeroAddress();
        if (wizardsBps_ > BPS) revert BadBps();
        wizards = wizards_;
        wizardsBps = wizardsBps_;
        _deployer = msg.sender;
    }

    /// @notice One-time wiring of the SQUARE token.
    function setSquare(address square_) external {
        if (msg.sender != _deployer) revert NotDeployer();
        if (address(square) != address(0)) revert AlreadySet();
        if (square_ == address(0)) revert ZeroAddress();
        square = IERC20(square_);
        emit SquareSet(square_);
    }

    // ───────────────────────── checkpoints ─────────────────────────

    function _push(Checkpoint[] storage cps, uint256 value) internal {
        uint64 current = uint64(block.number);
        uint256 n = cps.length;
        if (n != 0 && cps[n - 1].blockNumber == current) {
            cps[n - 1].value = uint192(value);
        } else {
            cps.push(Checkpoint(current, uint192(value)));
        }
    }

    /// @dev Value as of the end of `blockNumber` (latest checkpoint at or before it).
    function _lookup(Checkpoint[] storage cps, uint64 blockNumber) internal view returns (uint256) {
        uint256 lo = 0;
        uint256 hi = cps.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (cps[mid].blockNumber > blockNumber) hi = mid;
            else lo = mid + 1;
        }
        return lo == 0 ? 0 : cps[lo - 1].value;
    }

    /// @notice `who`'s stake as of the end of `blockNumber`.
    function stakeAt(address who, uint64 blockNumber) public view returns (uint256) {
        return _lookup(_checkpoints[who], blockNumber);
    }

    /// @notice Total stake as of the end of `blockNumber`.
    function totalStakeAt(uint64 blockNumber) public view returns (uint256) {
        return _lookup(_totalCheckpoints, blockNumber);
    }

    // ───────────────────────── fees in ─────────────────────────

    /// @notice Account for `token` received since the last sync: the wizards' share
    ///         leaves now, the stakers' share is recorded against the stake that
    ///         existed at the end of the previous block. Anyone may call.
    function sync(address token) public nonReentrant returns (uint256 toWizards, uint256 toStakers) {
        return _sync(token);
    }

    function _sync(address token) internal virtual returns (uint256 toWizards, uint256 toStakers) {
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 delta = balance - reserved[token];
        if (delta == 0) return (0, 0);
        uint256 total = totalStakeAt(uint64(block.number) - 1);
        toWizards = delta * wizardsBps / BPS;
        toStakers = delta - toWizards;
        if (total == 0) {
            // nobody was staked: the wizards take it all rather than stranding it
            toWizards = delta;
            toStakers = 0;
        }
        if (toStakers != 0) {
            _distributions[token].push(Distribution(uint64(block.number), uint192(toStakers), total));
            reserved[token] += toStakers;
        }
        if (toWizards != 0) {
            IERC20(token).safeTransfer(wizards, toWizards);
        }
        // whatever the outgoing transfer's own reference fee returned to us is
        // new balance, picked up by the next sync
        emit Synced(token, toWizards, toStakers);
    }

    function distributionCount(address token) external view returns (uint256) {
        return _distributions[token].length;
    }

    function distribution(address token, uint256 index) external view returns (Distribution memory) {
        return _distributions[token][index];
    }

    // ───────────────────────── staking ─────────────────────────

    function stake(uint256 amount) external nonReentrant {
        if (address(square) == address(0)) revert NotSet();
        uint256 before = square.balanceOf(address(this));
        square.safeTransferFrom(msg.sender, address(this), amount);
        // SQUARE is itself an IERC12384 token: what arrives may be less than `amount`
        uint256 received = square.balanceOf(address(this)) - before;
        staked[msg.sender] += received;
        totalStaked += received;
        reserved[address(square)] += received;
        _push(_checkpoints[msg.sender], staked[msg.sender]);
        _push(_totalCheckpoints, totalStaked);
        emit Staked(msg.sender, received);
    }

    function unstake(uint256 amount) external nonReentrant {
        staked[msg.sender] -= amount;
        totalStaked -= amount;
        reserved[address(square)] -= amount;
        _push(_checkpoints[msg.sender], staked[msg.sender]);
        _push(_totalCheckpoints, totalStaked);
        square.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    /// @dev Sum `who`'s share of `token` distributions from `from` up to at most `max` of them.
    function _accrued(address who, address token, uint256 from, uint256 max)
        internal
        view
        returns (uint256 amount, uint256 through)
    {
        Distribution[] storage ds = _distributions[token];
        uint256 end = ds.length;
        if (end - from > max) end = from + max;
        for (uint256 i = from; i < end; i++) {
            Distribution storage d = ds[i];
            uint256 s = stakeAt(who, d.blockNumber - 1);
            if (s != 0) amount += uint256(d.amount) * s / d.totalStakedBefore;
        }
        through = end;
    }

    /// @notice Claim your share of up to `maxDistributions` unclaimed distributions of `token`.
    function claim(address token, uint256 maxDistributions) external nonReentrant returns (uint256 amount) {
        uint256 from = claimedThrough[msg.sender][token];
        uint256 through;
        (amount, through) = _accrued(msg.sender, token, from, maxDistributions);
        claimedThrough[msg.sender][token] = through;
        if (amount != 0) {
            reserved[token] -= amount;
            IERC20(token).safeTransfer(msg.sender, amount);
        }
        emit Claimed(msg.sender, token, amount, through);
    }

    /// @notice What `who` could claim of `token` right now, over all unclaimed distributions.
    function claimable(address who, address token) external view returns (uint256 amount) {
        (amount,) = _accrued(who, token, claimedThrough[who][token], type(uint256).max);
    }
}
