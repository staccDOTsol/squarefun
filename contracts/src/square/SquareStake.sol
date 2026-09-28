// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SquareSink} from "./SquareSink.sol";

/// @title SquareStake: the SQUARE staking pool, fed by the launchpad's fee sink.
/// @notice The first sink on Robinhood was bound to a placeholder token instead of
///         the $SQUARE launch itself. That sink, the factory and every launch's fee
///         beneficiary are immutable, so this contract stands in front of it:
///
///           launch fees ─► legacy sink ─► (its staker share) ─► here ─► $SQUARE stakers
///
///         It holds the placeholder's entire supply, staked in the legacy sink, so
///         100% of the legacy staker share is its income. `sync(token)` pulls that
///         income first and then distributes it exactly as SquareSink does. The
///         wizards already take their cut upstream, so this pool's own cut is zero.
///         Nothing is retired; nobody sees the placeholder again.
contract SquareStake is SquareSink {
    using SafeERC20 for IERC20;

    SquareSink public immutable legacy;
    IERC20 public immutable placeholder;

    event Pulled(address indexed token, uint256 amount);

    constructor(address wizards_, SquareSink legacy_) SquareSink(wizards_, 0) {
        legacy = legacy_;
        placeholder = legacy_.square();
    }

    /// @notice Stake whatever placeholder balance this contract holds into the legacy sink.
    ///         Anyone may call; the deployer sends the placeholder here first.
    function stakeLegacy() external {
        uint256 bal = placeholder.balanceOf(address(this));
        placeholder.forceApprove(address(legacy), bal);
        legacy.stake(bal);
    }

    /// @dev Pull `token` from the legacy sink, then run the normal distribution here.
    function _sync(address token) internal override returns (uint256 toWizards, uint256 toStakers) {
        if (token != address(placeholder)) {
            legacy.sync(token);
            uint256 got = legacy.claim(token, type(uint256).max);
            if (got != 0) emit Pulled(token, got);
        }
        return super._sync(token);
    }
}
