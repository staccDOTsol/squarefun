// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SquareSink} from "./SquareSink.sol";

/// @title TwinPool: Square's fee flow, paid to the holders of a token launched elsewhere.
/// @notice The main pool pays whoever stakes $SQUARE. This pool stakes $SQUARE in the
///         main pool on behalf of a twin token (say, the $SQUARE launched on Pons) and
///         re-pays what it harvests to people who stake the twin here.
///
///           launch fees ─► legacy sink ─► main pool ─► (this pool's $SQUARE share) ─► twin stakers
///
///         The twin holders' share of every distribution is exactly the $SQUARE
///         committed here over all $SQUARE staked in the main pool. Anyone can
///         commit more. Nothing can be taken back out: there is no unstake from
///         the main pool, so a commitment is a commitment.
contract TwinPool is SquareSink {
    using SafeERC20 for IERC20;

    SquareSink public immutable main;
    IERC20 public immutable squareToken;

    event Committed(address indexed by, uint256 amount, uint256 totalCommitted);
    event Harvested(address indexed token, uint256 amount);

    constructor(address wizards_, SquareSink main_) SquareSink(wizards_, 0) {
        main = main_;
        squareToken = main_.square();
    }

    /// @notice Commit `amount` $SQUARE to the twin's holders, forever. Pulls from the caller
    ///         and stakes in the main pool under this contract.
    function commit(uint256 amount) external nonReentrant {
        squareToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 bal = squareToken.balanceOf(address(this));
        squareToken.forceApprove(address(main), bal);
        main.stake(bal);
        emit Committed(msg.sender, amount, main.staked(address(this)));
    }

    /// @notice $SQUARE staked in the main pool for the twin's holders.
    function committed() external view returns (uint256) {
        return main.staked(address(this));
    }

    /// @dev Harvest this pool's share of `token` from the main pool, then distribute it here.
    function _sync(address token) internal override returns (uint256 toWizards, uint256 toStakers) {
        uint256 got = main.claim(token, type(uint256).max);
        if (got != 0) emit Harvested(token, got);
        return super._sync(token);
    }
}
