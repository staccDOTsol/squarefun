// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SquareMigrate} from "./SquareMigrate.sol";
import {IVenue, IBuyer} from "./venues/IVenue.sol";

/// @title MigrateFactory: the pooper scooper. Anyone scoops any token with a market into $SQUARE.
/// @notice Venues are fixed at deployment so a takeover can never be pointed at a venue that
///         lies about its price. Terms are the creator's, within bounds, and shown on the site.
///         No owner: to add a venue, deploy another factory and list it beside this one.
contract MigrateFactory {
    IERC20 public immutable square;
    IBuyer public immutable buyer;
    address public immutable sink;
    IVenue[] public venues;
    SquareMigrate[] public all;
    mapping(address => SquareMigrate[]) private _byToken;

    uint64 public constant MIN_EPOCH = 10 minutes;
    uint64 public constant MIN_COOLDOWN = 30 seconds;
    uint64 public constant MIN_RECOVER_WINDOW = 1 hours;
    uint64 public constant MIN_CLAIM_WINDOW = 7 days;

    event MigrationCreated(address indexed migrate, address indexed oldToken, address indexed venue, address creator, uint256 index);

    error BadVenue();
    error NoMarket();
    error Terms();

    constructor(IERC20 square_, IBuyer buyer_, address sink_, IVenue[] memory venues_) {
        square = square_;
        buyer = buyer_;
        sink = sink_;
        for (uint256 i = 0; i < venues_.length; i++) {
            venues.push(venues_[i]);
        }
    }

    function venueCount() external view returns (uint256) {
        return venues.length;
    }

    function count() external view returns (uint256) {
        return all.length;
    }

    function byToken(address token) external view returns (SquareMigrate[] memory) {
        return _byToken[token];
    }

    /// @notice The first venue that can sell `token` right now, or the zero address.
    function venueFor(address token) public view returns (IVenue) {
        for (uint256 i = 0; i < venues.length; i++) {
            if (venues[i].canSell(token)) return venues[i];
        }
        return IVenue(address(0));
    }

    /// @notice Scoop `token`. Picks its venue, checks the terms, deploys the takeover.
    function create(address token, SquareMigrate.Params memory p) external returns (SquareMigrate m) {
        if (token == address(square)) revert BadVenue();
        IVenue v = venueFor(token);
        if (address(v) == address(0)) revert NoMarket();
        if (p.epochLength < MIN_EPOCH || p.cooldown < MIN_COOLDOWN || p.recoverWindow < MIN_RECOVER_WINDOW || p.claimWindow < MIN_CLAIM_WINDOW) {
            revert Terms();
        }
        m = new SquareMigrate(IERC20(token), v, square, buyer, sink, p);
        all.push(m);
        _byToken[token].push(m);
        emit MigrationCreated(address(m), token, address(v), msg.sender, all.length - 1);
    }
}
