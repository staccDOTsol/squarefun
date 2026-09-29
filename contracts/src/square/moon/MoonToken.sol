// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SquarePoolsTokenV2} from "../pools/SquarePoolsTokenV2.sol";
import {TokenMetadata} from "../pools/SquarePoolsToken.sol";

/// @title MoonToken: the reference fee, and the fees buy moon.
/// @notice A SquarePoolsTokenV2 whose settler is a MoonJar. Every fee a transaction pays here,
///         ratchet or buy fee, is also that many tickets for its originator (tx.origin, the
///         same actor the ratchets key on) in the current round. Splitting across wallets buys
///         no odds: tickets are fees, not wallets. The jar closes a round when a parcel is paid
///         for and draws it with verifiable randomness (MoonJar, OpenVRF); this contract only
///         keeps the tickets and answers who holds a given one.
///
///         Buys pay at least `buyFeeBps`. A buy is any counted transfer out of the Uniswap v4
///         PoolManager, so every v4 pool of this token pays it, whatever its pair or LP fee.
///         Sells never pay it: a v4 pool reverts when it receives less than it was owed. The
///         higher of the buy fee and the ratchet applies, never both. Removing v4 liquidity also
///         counts as a buy.
contract MoonToken is SquarePoolsTokenV2 {
    uint256 public constant MAX_BUY_FEE_BPS = 1_000;

    /// @notice Least fee on a buy, in basis points.
    uint256 public immutable buyFeeBps;
    /// @notice Uniswap v4's singleton: a transfer out of it is a buy.
    address public immutable poolManager;

    /// @dev One slot: who, and the round's running total of tickets up to and including them.
    struct Ticket {
        address who;
        uint96 upTo;
    }

    /// @notice The round tickets are going into now.
    uint256 public round;
    mapping(uint256 => Ticket[]) private _tickets;
    /// @notice Tickets per originator per round.
    mapping(uint256 => mapping(address => uint256)) public ticketsOf;

    event RoundClosed(uint256 indexed round, uint256 tickets);

    error NotJar();

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 supply_,
        address recipient_,
        address jar_,
        address creator_,
        bytes32 graffiti_,
        TokenMetadata memory metadata_,
        address poolManager_,
        uint256 buyFeeBps_
    ) SquarePoolsTokenV2(name_, symbol_, supply_, recipient_, jar_, creator_, graffiti_, metadata_) {
        require(buyFeeBps_ <= MAX_BUY_FEE_BPS, "buy fee");
        poolManager = poolManager_;
        buyFeeBps = buyFeeBps_;
    }

    // ---- tickets ----

    function ticketCount(uint256 r) external view returns (uint256) {
        return _tickets[r].length;
    }

    function ticketAt(uint256 r, uint256 i) external view returns (address who, uint256 upTo) {
        Ticket memory t = _tickets[r][i];
        return (t.who, t.upTo);
    }

    /// @notice All tickets in round `r`.
    function totalTickets(uint256 r) public view returns (uint256) {
        uint256 n = _tickets[r].length;
        return n == 0 ? 0 : _tickets[r][n - 1].upTo;
    }

    /// @notice Close the current round for a draw. Only the jar; false if nobody holds a ticket yet.
    function closeRound() external returns (bool closed, uint256 r) {
        if (msg.sender != sink()) revert NotJar();
        r = round;
        if (_tickets[r].length == 0) return (false, r);
        round = r + 1;
        emit RoundClosed(r, totalTickets(r));
        return (true, r);
    }

    /// @notice The holder of ticket `x` (0-based, below totalTickets(r)) in round `r`.
    function holderOf(uint256 r, uint256 x) public view returns (address) {
        Ticket[] storage ts = _tickets[r];
        uint256 lo;
        uint256 hi = ts.length - 1;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (ts[mid].upTo > x) hi = mid;
            else lo = mid + 1;
        }
        return ts[lo].who;
    }

    // ---- transfers ----

    function _update(address from, address to, uint256 value) internal override {
        if (!_counted(from, to)) {
            super._update(from, to, value);
            return;
        }
        address jar = sink();
        uint256 jarBefore = balanceOf(jar);
        if (from == poolManager && to != from && to != jar && buyFeeBps != 0) {
            // the ratchet may already have taken more; top up to the buy fee, never add to it
            uint256 before = balanceOf(to);
            super._update(from, to, value);
            uint256 got = balanceOf(to) - before;
            uint256 keep = value - value * buyFeeBps / BPS;
            if (got > keep) ERC20._update(to, jar, got - keep);
        } else {
            super._update(from, to, value);
        }
        uint256 fee = balanceOf(jar) - jarBefore;
        if (fee != 0) _ticket(tx.origin, fee);
    }

    function _ticket(address who, uint256 fee) private {
        uint256 r = round;
        Ticket[] storage ts = _tickets[r];
        uint256 n = ts.length;
        uint96 upTo = uint96((n == 0 ? 0 : ts[n - 1].upTo) + fee);
        if (n != 0 && ts[n - 1].who == who) ts[n - 1].upTo = upTo;
        else ts.push(Ticket({who: who, upTo: upTo}));
        ticketsOf[r][who] += fee;
    }
}
