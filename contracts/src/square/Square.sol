// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ReferenceFeeERC20} from "../v2/ReferenceFeeERC20.sol";

/// @title SQUARE: the launchpad's token.
/// @notice An IERC12384 token like every launch it hosts. Its own reference fees
///         flow to the same SquareSink the launches feed, so the people staking
///         SQUARE are paid by every machine that walks any token on the pad,
///         including one that walks SQUARE.
///
///         Fixed supply, minted once to the deployer for distribution. No mint
///         function, no owner, no pause.
contract Square is ReferenceFeeERC20 {
    constructor(address sink_, address recipient_, uint256 supply_)
        ERC20("Square", "SQUARE")
        ReferenceFeeERC20(sink_)
    {
        _mint(recipient_, supply_);
    }
}
