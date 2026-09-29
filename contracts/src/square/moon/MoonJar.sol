// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IVenue} from "../venues/IVenue.sol";

interface IMoonToken {
    function sink() external view returns (address);
    function closeRound() external returns (bool closed, uint256 round);
    function totalTickets(uint256 round) external view returns (uint256);
    function holderOf(uint256 round, uint256 x) external view returns (address);
}

/// @dev Robinhood's OpenVRF router (github.com/Robinhood-OSS/OpenVRF): drand-backed, the
///      threshold signature is verified on chain, a relayer can deliver but not choose.
interface IOpenVRF {
    function requestFee() external view returns (uint256);
    function requestRandomness(uint32 callbackGasLimit) external payable returns (uint256 id);
}

/// @title MoonJar: the settler for a MoonToken. Fees become ETH, ETH becomes moon.
/// @notice Every fee the token takes lands here in kind. Anyone settles: the jar sells it for ETH
///         through the token's pool and forwards its ETH to `payout` (the steward's card
///         deposit address), but only once it holds at least `forwardAt`, because the card does
///         not credit small deposits. Each `parcelCost` forwarded pays for one draw. A draw closes
///         the token's ticket round and asks OpenVRF for a word; the router's callback picks the
///         holder of ticket `word % tickets`, weighted by fees paid, and files the drop with its
///         parcel. The steward buys that parcel off chain and wraps its NFT to the winner on
///         Ethereum (MoonDeeds, same drop id).
///
///         Trust: custodial past the forward; the ETH leaves for a card the steward holds, and a
///         MoonDeeds deed per drop id is the proof it was spent. Randomness: the drand round is
///         fixed when the request is made, after the round's tickets are closed. If no word
///         arrives within REQUEST_TIMEOUT, anyone may ask again for the same round; only a
///         relayer that withholds can cause that, and it gets one new drand round, not a choice.
contract MoonJar is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    /// @notice A settlement must clear spot less this much, or it waits for a better block.
    uint256 public constant MAX_IMPACT_BPS = 500;
    uint32 public constant CALLBACK_GAS = 300_000;
    uint256 public constant REQUEST_TIMEOUT = 1 days;

    struct Drop {
        address winner;
        uint64 round;
        uint32 parcel;
        uint256 word;
    }

    IVenue public immutable venue;
    IOpenVRF public immutable vrf;
    address public token;
    address public steward;
    address payable public payout;
    /// @notice The least ETH the jar will send in one go.
    uint256 public forwardAt;
    /// @notice ETH forwarded per draw.
    uint256 public parcelCost;
    /// @notice ETH forwarded and not yet counted toward a draw.
    uint256 public credit;
    uint256 public forwarded;
    /// @notice Draws paid for and not yet requested.
    uint256 public owed;

    /// @notice The request in flight (0 = none, so this stores id + 1).
    uint256 public pending;
    uint256 public pendingRound;
    uint256 public requestedAt;

    string[] public parcels;
    Drop[] public drops;

    event Bound(address indexed token);
    event Settled(uint256 sold, uint256 ethOut);
    event Forwarded(address indexed payout, uint256 amount, uint256 owed);
    event Requested(uint256 indexed requestId, uint256 indexed round, uint256 tickets);
    event Dropped(uint256 indexed id, address indexed winner, uint256 round, uint256 parcel, string name, uint256 word);
    event Retuned(address payout, uint256 forwardAt, uint256 parcelCost);

    error NotSteward();
    error NotRouter();
    error Bad();
    error NotYet();

    modifier onlySteward() {
        if (msg.sender != steward) revert NotSteward();
        _;
    }

    constructor(
        IVenue venue_,
        IOpenVRF vrf_,
        address steward_,
        address payable payout_,
        uint256 forwardAt_,
        uint256 parcelCost_,
        string[] memory parcels_
    ) {
        if (steward_ == address(0) || parcels_.length == 0 || address(vrf_).code.length == 0) revert Bad();
        venue = venue_;
        vrf = vrf_;
        steward = steward_;
        for (uint256 i = 0; i < parcels_.length; i++) {
            parcels.push(parcels_[i]);
        }
        _retune(payout_, forwardAt_, parcelCost_);
    }

    receive() external payable {}

    /// @notice Tie the jar to its token, once. The token must already pay its fees here.
    function bind(address token_) external onlySteward {
        if (token != address(0) || IMoonToken(token_).sink() != address(this)) revert Bad();
        token = token_;
        emit Bound(token_);
    }

    function parcelCount() external view returns (uint256) {
        return parcels.length;
    }

    function dropCount() external view returns (uint256) {
        return drops.length;
    }

    /// @notice Sell up to `amount` of the fees held (0 = all), forward, and start a paid-for draw. Anyone may call.
    function settle(uint256 amount) external nonReentrant returns (uint256 ethOut) {
        address t = token;
        if (t == address(0)) revert Bad();
        uint256 held = IERC20(t).balanceOf(address(this));
        if (amount == 0 || amount > held) amount = held;
        if (amount != 0 && venue.canSell(t)) {
            uint256 minOut = amount * venue.spot(t) / 1e18 * (BPS - MAX_IMPACT_BPS) / BPS;
            IERC20(t).forceApprove(address(venue), amount);
            uint256 before = address(this).balance;
            venue.sell(t, amount, minOut);
            ethOut = address(this).balance - before;
            require(ethOut >= minOut, "slip");
            emit Settled(amount, ethOut);
        }
        _forward();
        _request();
    }

    /// @notice Forward if the jar has reached `forwardAt`, and start a paid-for draw. Anyone may call.
    function forward() external nonReentrant {
        _forward();
        _request();
    }

    /// @notice Ask again for the round in flight if no word came back in time. Anyone may call.
    function rerequest() external nonReentrant {
        if (pending == 0 || block.timestamp < requestedAt + REQUEST_TIMEOUT) revert NotYet();
        _ask(pendingRound);
    }

    function _forward() private {
        uint256 fee = token == address(0) ? 0 : vrf.requestFee();
        uint256 bal = address(this).balance;
        // keep enough for the next randomness request
        if (bal <= fee || bal - fee < forwardAt) return;
        uint256 amt = bal - fee;
        forwarded += amt;
        uint256 c = credit + amt;
        uint256 cost = parcelCost;
        owed += c / cost;
        credit = c % cost;
        (bool ok,) = payout.call{value: amt}("");
        require(ok, "payout");
        emit Forwarded(payout, amt, owed);
    }

    function _request() private {
        if (owed == 0 || pending != 0 || token == address(0)) return;
        (bool closed, uint256 r) = IMoonToken(token).closeRound();
        if (!closed) return; // nobody holds a ticket yet; the next settle tries again
        owed -= 1;
        _ask(r);
    }

    function _ask(uint256 r) private {
        uint256 id = vrf.requestRandomness{value: vrf.requestFee()}(CALLBACK_GAS);
        pending = id + 1;
        pendingRound = r;
        requestedAt = block.timestamp;
        emit Requested(id, r, IMoonToken(token).totalTickets(r));
    }

    /// @notice OpenVRF's callback. Only the word for the request in flight counts.
    function rawFulfillRandomness(uint256 id, uint256 word) external {
        if (msg.sender != address(vrf)) revert NotRouter();
        if (pending != id + 1) return; // superseded by a rerequest
        pending = 0;
        uint256 r = pendingRound;
        address winner = IMoonToken(token).holderOf(r, word % IMoonToken(token).totalTickets(r));
        uint256 parcel = uint256(keccak256(abi.encode(word, "parcel"))) % parcels.length;
        uint256 dropId = drops.length;
        drops.push(Drop({winner: winner, round: uint64(r), parcel: uint32(parcel), word: word}));
        emit Dropped(dropId, winner, r, parcel, parcels[parcel], word);
    }

    // ---- steward ----

    function retune(address payable payout_, uint256 forwardAt_, uint256 parcelCost_) external onlySteward {
        _retune(payout_, forwardAt_, parcelCost_);
    }

    function _retune(address payable payout_, uint256 forwardAt_, uint256 parcelCost_) private {
        if (payout_ == address(0) || forwardAt_ == 0 || parcelCost_ == 0) revert Bad();
        payout = payout_;
        forwardAt = forwardAt_;
        parcelCost = parcelCost_;
        emit Retuned(payout_, forwardAt_, parcelCost_);
    }

    function addParcel(string calldata name) external onlySteward {
        parcels.push(name);
    }

    function handOver(address steward_) external onlySteward {
        if (steward_ == address(0)) revert Bad();
        steward = steward_;
    }
}
