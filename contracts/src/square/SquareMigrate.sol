// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IVenue, IBuyer} from "./venues/IVenue.sol";

/// @title SquareMigrate: bring a token launched elsewhere onto the square.
/// @notice The Pons takeover flow, permissionless, with one change: the replacement is
///         not a fresh pool, it is $SQUARE already on its curve.
///
///           1. deposit   holders hand in the old token during epoch windows; the first
///                        epoch credits one for one, each later epoch credits less, and a
///                        credit is fixed the moment it is made
///           2. mandate   nothing sells until the first epoch closes and deposits reach
///                        the mandate
///           3. recover   anyone sells the deposited old token into its own curve, capped
///                        per trade, with a cooldown and a minimum output
///           4. convert   the recovered ETH buys $SQUARE on the square curve
///           5. claim     depositors vest their $SQUARE linearly, pro rata to credits;
///                        what nobody claims by the deadline goes to the fee sink, so
///                        it reaches $SQUARE stakers
///           R. rescue    if recovery cannot finish by its deadline, depositors take
///                        back their share of what is left plus what was recovered
///
///         No owner. Every parameter is fixed at deployment.
contract SquareMigrate is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    /// @dev a slice worth less than this is sold together with everything left
    uint256 public constant DUST = 1e12;

    IERC20 public immutable oldToken;
    /// @dev where the old token is sold: its Pons curve, a v3 pool, ...
    IVenue public immutable venue;
    IERC20 public immutable square;
    /// @dev where ETH becomes $SQUARE
    IBuyer public immutable buyer;
    address public immutable sink;

    uint64 public immutable start;
    uint64 public immutable epochLength;
    uint8 public immutable epochs;
    /// @dev credit rate falls by this many bps each epoch after the first
    uint16 public immutable decayBps;
    uint256 public immutable mandate;
    /// @dev per recovery trade, at most this share of what is still held
    uint16 public immutable sellCapBps;
    uint64 public immutable cooldown;
    /// @dev a recovery trade must return at least spot × (1 - maxImpactBps)
    uint16 public immutable maxImpactBps;
    uint64 public immutable recoverDeadline;
    uint64 public immutable vestLength;
    uint64 public immutable claimWindow;

    uint256 public totalDeposited;
    uint256 public totalCredits;
    uint256 public remaining; // old tokens still to sell
    uint256 public recovered; // ETH recovered so far
    uint256 public totalSquare; // $SQUARE bought at conversion
    uint64 public lastSell;
    uint64 public claimStart;
    bool public converted;
    bool public rescued;

    mapping(address => uint256) public deposited;
    mapping(address => uint256) public credits;
    mapping(address => uint256) public claimed;
    mapping(address => bool) public rescuedBy;

    event Deposited(address indexed who, uint256 amount, uint256 credit, uint8 epoch);
    event Recovered(uint256 sold, uint256 quoteOut, uint256 remaining);
    event Converted(uint256 quoteIn, uint256 squareOut);
    event Claimed(address indexed who, uint256 amount);
    event Rescued(address indexed who, uint256 oldOut, uint256 quoteOut);
    event Swept(uint256 amount);

    error DepositsClosed();
    error ZeroAmount();
    error NotYet();
    error MandateMissed();
    error Cooldown();
    error NothingToDo();
    error NotConverted();
    error NotFailed();
    error AlreadyRescued();
    error BadParams();

    struct Params {
        uint64 start;
        uint64 epochLength;
        uint8 epochs;
        uint16 decayBps;
        uint256 mandate;
        uint16 sellCapBps;
        uint64 cooldown;
        uint16 maxImpactBps;
        uint64 recoverWindow;
        uint64 vestLength;
        uint64 claimWindow;
    }

    constructor(IERC20 oldToken_, IVenue venue_, IERC20 square_, IBuyer buyer_, address sink_, Params memory p) {
        if (p.epochs == 0 || p.epochLength == 0 || p.sellCapBps == 0 || p.sellCapBps > BPS || p.maxImpactBps >= BPS) revert BadParams();
        if (uint256(p.decayBps) * (p.epochs - 1) >= BPS) revert BadParams();
        oldToken = oldToken_;
        venue = venue_;
        square = square_;
        buyer = buyer_;
        sink = sink_;
        start = p.start == 0 ? uint64(block.timestamp) : p.start;
        epochLength = p.epochLength;
        epochs = p.epochs;
        decayBps = p.decayBps;
        mandate = p.mandate;
        sellCapBps = p.sellCapBps;
        cooldown = p.cooldown;
        maxImpactBps = p.maxImpactBps;
        recoverDeadline = start + uint64(p.epochs) * p.epochLength + p.recoverWindow;
        vestLength = p.vestLength;
        claimWindow = p.claimWindow;
    }

    receive() external payable {}

    // ───────────────────────── 1. deposit ─────────────────────────

    /// @notice Which epoch `ts` falls in, or `epochs` once deposits are closed.
    function epochAt(uint256 ts) public view returns (uint8) {
        if (ts < start) return 0;
        uint256 e = (ts - start) / epochLength;
        return e >= epochs ? epochs : uint8(e);
    }

    /// @notice Credit per old token in `epoch`, in bps of one for one.
    function rateBps(uint8 epoch) public view returns (uint256) {
        return BPS - uint256(decayBps) * epoch;
    }

    function depositsOpen() public view returns (bool) {
        return block.timestamp >= start && epochAt(block.timestamp) < epochs && !converted && !rescued;
    }

    function deposit(uint256 amount) external nonReentrant {
        _deposit(msg.sender, msg.sender, amount);
    }

    /// @notice Deposit on behalf of `who`: the tokens come from the caller, the credit goes to `who`.
    ///         Lets a batcher scoop a whole wallet in one transaction.
    function depositFor(address who, uint256 amount) external nonReentrant {
        if (who == address(0)) revert ZeroAmount();
        _deposit(msg.sender, who, amount);
    }

    function _deposit(address from, address who, uint256 amount) internal {
        if (!depositsOpen()) revert DepositsClosed();
        if (amount == 0) revert ZeroAmount();
        uint256 before = oldToken.balanceOf(address(this));
        oldToken.safeTransferFrom(from, address(this), amount);
        uint256 got = oldToken.balanceOf(address(this)) - before;
        uint8 e = epochAt(block.timestamp);
        uint256 credit = got * rateBps(e) / BPS;
        deposited[who] += got;
        credits[who] += credit;
        totalDeposited += got;
        totalCredits += credit;
        remaining += got;
        emit Deposited(who, got, credit, e);
    }

    // ───────────────────────── 2 + 3. recover ─────────────────────────

    function firstEpochClosed() public view returns (bool) {
        return block.timestamp >= start + epochLength;
    }

    function canRecover() public view returns (bool) {
        return firstEpochClosed() && totalDeposited >= mandate && remaining != 0 && !converted && !rescued
            && block.timestamp <= recoverDeadline && block.timestamp >= lastSell + cooldown;
    }

    /// @notice Sell the next slice of the old token into its curve. Anyone may call.
    function recover() external nonReentrant {
        if (!firstEpochClosed()) revert NotYet();
        if (totalDeposited < mandate) revert MandateMissed();
        if (remaining == 0 || converted || rescued) revert NothingToDo();
        if (block.timestamp < lastSell + cooldown) revert Cooldown();
        if (block.timestamp > recoverDeadline) revert NotYet();

        uint256 slice = remaining * sellCapBps / BPS;
        uint256 spotPrice = venue.spot(address(oldToken));
        // the cap shrinks slices geometrically; once one is worth dust, finish in one go
        if (slice == 0 || slice * spotPrice / 1e18 < DUST) slice = remaining;
        // spot for the slice, then the impact allowance; the venue must clear it or revert
        uint256 minOut = slice * spotPrice / 1e18 * (BPS - maxImpactBps) / BPS;
        oldToken.forceApprove(address(venue), slice);
        uint256 before = address(this).balance;
        venue.sell(address(oldToken), slice, minOut);
        uint256 out = address(this).balance - before;
        if (out < minOut) revert BadParams();
        remaining -= slice;
        recovered += out;
        lastSell = uint64(block.timestamp);
        emit Recovered(slice, out, remaining);
    }

    // ───────────────────────── 4. convert ─────────────────────────

    /// @notice Buy $SQUARE with everything recovered. Anyone may call once recovery is complete.
    function convert(uint256 minSquareOut) external nonReentrant {
        if (converted || rescued) revert NothingToDo();
        if (remaining != 0 || totalDeposited == 0) revert NotYet();
        if (totalDeposited < mandate) revert MandateMissed();
        uint256 quoteIn = address(this).balance;
        uint256 before = square.balanceOf(address(this));
        buyer.buy{value: quoteIn}(minSquareOut);
        totalSquare = square.balanceOf(address(this)) - before;
        converted = true;
        claimStart = uint64(block.timestamp);
        emit Converted(quoteIn, totalSquare);
    }

    // ───────────────────────── 5. claim ─────────────────────────

    /// @notice $SQUARE `who` has vested so far, claimed or not.
    function vested(address who) public view returns (uint256) {
        if (!converted || totalCredits == 0) return 0;
        uint256 full = totalSquare * credits[who] / totalCredits;
        uint256 elapsed = block.timestamp - claimStart;
        if (vestLength == 0 || elapsed >= vestLength) return full;
        return full * elapsed / vestLength;
    }

    function claimable(address who) public view returns (uint256) {
        return vested(who) - claimed[who];
    }

    /// @dev Each claim is a $SQUARE reference: the k-th claim in a block pays the square.
    function claim() external nonReentrant returns (uint256 amount) {
        if (!converted) revert NotConverted();
        amount = claimable(msg.sender);
        if (amount == 0) revert ZeroAmount();
        claimed[msg.sender] += amount;
        square.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    /// @notice After the claim window, whatever is left goes to the sink, so $SQUARE stakers get it.
    function sweep() external nonReentrant {
        if (!converted) revert NotConverted();
        if (block.timestamp < claimStart + claimWindow) revert NotYet();
        uint256 bal = square.balanceOf(address(this));
        if (bal == 0) revert NothingToDo();
        square.safeTransfer(sink, bal);
        emit Swept(bal);
    }

    // ───────────────────────── R. rescue ─────────────────────────

    /// @notice Recovery failed: the mandate was missed once deposits closed, or the deadline
    ///         passed with old tokens unsold. Depositors take back their share of both.
    function failed() public view returns (bool) {
        if (converted) return false;
        bool closed = epochAt(block.timestamp) >= epochs;
        if (closed && totalDeposited < mandate) return true;
        return block.timestamp > recoverDeadline && remaining != 0;
    }

    function rescue() external nonReentrant {
        if (!failed()) revert NotFailed();
        if (rescuedBy[msg.sender]) revert AlreadyRescued();
        if (deposited[msg.sender] == 0) revert ZeroAmount();
        rescued = true;
        rescuedBy[msg.sender] = true;
        // pro rata to what they put in, over what is still held and what was recovered
        uint256 oldOut = remaining * deposited[msg.sender] / totalDeposited;
        uint256 quoteOut = recovered * deposited[msg.sender] / totalDeposited;
        // don't double-count as others rescue: shrink the pool as we go
        remaining -= oldOut;
        recovered -= quoteOut;
        totalDeposited -= deposited[msg.sender];
        deposited[msg.sender] = 0;
        if (oldOut != 0) oldToken.safeTransfer(msg.sender, oldOut);
        if (quoteOut != 0) {
            (bool ok,) = msg.sender.call{value: quoteOut}("");
            require(ok, "eth");
        }
        emit Rescued(msg.sender, oldOut, quoteOut);
    }
}
