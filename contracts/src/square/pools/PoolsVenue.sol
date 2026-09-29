// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IVenue} from "../venues/IVenue.sol";

/// @title PoolsVenue: sell into the pool an instant launch on Pools opens.
/// @notice Uniswap's InstantLaunchStrategy puts every token into one pool shape: native ETH
///         against the token, 0.25% fee, tick spacing 25, no hook. This venue sells into it.
///         The settler uses it to turn fees taken in kind into ETH.
contract PoolsVenue is IVenue, IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint24 public constant LP_FEE = 2_500;
    int24 public constant TICK_SPACING = 25;

    IPoolManager public immutable manager;

    error NotManager();
    error NoPool();

    constructor(IPoolManager manager_) {
        manager = manager_;
    }

    receive() external payable {}

    /// @dev ETH is currency0 (address zero sorts first); the token is currency1.
    function keyFor(address token) public pure returns (PoolKey memory) {
        return PoolKey({
            currency0: CurrencyLibrary.ADDRESS_ZERO,
            currency1: Currency.wrap(token),
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(0))
        });
    }

    function _sqrtPrice(address token) private view returns (uint160 sqrtP) {
        (sqrtP,,,) = manager.getSlot0(keyFor(token).toId());
    }

    function canSell(address token) external view returns (bool) {
        return _sqrtPrice(token) != 0;
    }

    /// @dev price = token1 per token0 = token per ETH, so ETH per token is the inverse.
    function spot(address token) external view returns (uint256) {
        uint160 sqrtP = _sqrtPrice(token);
        if (sqrtP == 0) return 0;
        uint256 ratio = Math.mulDiv(uint256(sqrtP), uint256(sqrtP), 1 << 96);
        return ratio == 0 ? 0 : Math.mulDiv(1e18, 1 << 96, ratio);
    }

    function sell(address token, uint256 amount, uint256 minOut) external nonReentrant returns (uint256 ethOut) {
        if (_sqrtPrice(token) == 0) revert NoPool();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 got = IERC20(token).balanceOf(address(this));
        uint256 before = address(this).balance;
        manager.unlock(abi.encode(token, got));
        ethOut = address(this).balance - before;
        require(ethOut >= minOut, "slip");
        // whatever the pool could not take goes back where it came from
        uint256 left = IERC20(token).balanceOf(address(this));
        if (left != 0) IERC20(token).safeTransfer(msg.sender, left);
        (bool sent,) = msg.sender.call{value: ethOut}("");
        require(sent, "eth");
    }

    /// @dev token to ETH is oneForZero. The token may take its fee on the way into the
    ///      manager, so the swap is sized to what the manager actually received.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(manager)) revert NotManager();
        (address token, uint256 amountIn) = abi.decode(data, (address, uint256));
        PoolKey memory key = keyFor(token);
        manager.sync(key.currency1);
        IERC20(token).safeTransfer(address(manager), amountIn);
        uint256 paid = manager.settle();
        BalanceDelta d = manager.swap(
            key,
            SwapParams({zeroForOne: false, amountSpecified: -int256(paid), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1}),
            ""
        );
        // a swap that stops at the price limit leaves part of what was paid unspent
        uint256 spent = uint256(uint128(-d.amount1()));
        if (paid > spent) manager.take(key.currency1, address(this), paid - spent);
        manager.take(key.currency0, address(this), uint256(uint128(d.amount0())));
        return "";
    }
}
