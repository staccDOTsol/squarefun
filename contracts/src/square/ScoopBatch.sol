// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MigrateFactory} from "./MigrateFactory.sol";
import {SquareMigrate} from "./SquareMigrate.sol";

/// @title ScoopBatch: a whole wallet onto the square in one transaction.
/// @notice For each token: reuse the newest takeover that is still taking deposits, or create
///         one with the given terms; pull the caller's tokens; deposit them in the caller's name.
///         Approvals are the only per-token signature left, and no chain can remove those.
///         Holds nothing between calls; anything stuck can be swept to its owner by anyone.
contract ScoopBatch is ReentrancyGuard {
    using SafeERC20 for IERC20;

    MigrateFactory public immutable factory;

    event Scooped(address indexed who, address indexed token, address indexed migrate, uint256 amount, bool created);

    error LengthMismatch();
    error Nothing();

    constructor(MigrateFactory factory_) {
        factory = factory_;
    }

    /// @notice Newest takeover of `token` still taking deposits, or zero.
    function openFor(address token) public view returns (SquareMigrate) {
        SquareMigrate[] memory ms = factory.byToken(token);
        for (uint256 i = ms.length; i > 0; i--) {
            if (ms[i - 1].depositsOpen()) return ms[i - 1];
        }
        return SquareMigrate(payable(address(0)));
    }

    /// @param tokens  what to scoop
    /// @param amounts how much of each; 0 means the caller's whole balance
    /// @param terms   used only for tokens that need a new takeover
    function scoop(address[] calldata tokens, uint256[] calldata amounts, SquareMigrate.Params calldata terms)
        external
        nonReentrant
        returns (address[] memory migrates)
    {
        if (tokens.length != amounts.length) revert LengthMismatch();
        if (tokens.length == 0) revert Nothing();
        migrates = new address[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            IERC20 t = IERC20(tokens[i]);
            uint256 amount = amounts[i] == 0 ? t.balanceOf(msg.sender) : amounts[i];
            if (amount == 0) continue;
            SquareMigrate m = openFor(tokens[i]);
            bool created;
            if (address(m) == address(0)) {
                m = factory.create(tokens[i], terms);
                created = true;
            }
            uint256 before = t.balanceOf(address(this));
            t.safeTransferFrom(msg.sender, address(this), amount);
            uint256 got = t.balanceOf(address(this)) - before;
            t.forceApprove(address(m), got);
            m.depositFor(msg.sender, got);
            migrates[i] = address(m);
            emit Scooped(msg.sender, tokens[i], address(m), got, created);
        }
    }

    /// @notice Which of `tokens` this batch could scoop right now, and whether each needs a new takeover.
    function preview(address[] calldata tokens) external view returns (bool[] memory ok, bool[] memory needsNew) {
        ok = new bool[](tokens.length);
        needsNew = new bool[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            SquareMigrate m = openFor(tokens[i]);
            if (address(m) != address(0)) {
                ok[i] = true;
            } else {
                ok[i] = address(factory.venueFor(tokens[i])) != address(0) && tokens[i] != address(factory.square());
                needsNew[i] = ok[i];
            }
        }
    }
}
