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
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IVenue} from "./IVenue.sol";
import {IPonsFactory} from "./PonsCurveVenue.sol";

/// @title V4Venue: sell a graduated Pons v2 launch into its Uniswap v4 pool.
/// @notice Pons graduates every curve into an ETH pool under its meme hook, keyed by the
///         launch's snapshotted fee and tick spacing. This venue rebuilds that key from
///         the Pons factory and swaps against the PoolManager directly.
contract V4Venue is IVenue, IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager public immutable manager;
    IPonsFactory public immutable factory;
    IHooks public immutable hook;

    error NotManager();
    error NoPool();

    constructor(IPoolManager manager_, IPonsFactory factory_, IHooks hook_) {
        manager = manager_;
        factory = factory_;
        hook = hook_;
    }

    receive() external payable {}

    /// @dev ETH is currency0 (address zero sorts first); the token is currency1.
    function keyFor(address token) public view returns (PoolKey memory key, bool ok) {
        IPonsFactory.Launch memory l = factory.getLaunchedToken(token);
        if (!l.exists || l.pairToken != address(0)) return (key, false);
        key = PoolKey({
            currency0: CurrencyLibrary.ADDRESS_ZERO,
            currency1: Currency.wrap(token),
            fee: l.poolFee,
            tickSpacing: l.tickSpacing,
            hooks: hook
        });
        (uint160 sqrtP,,,) = manager.getSlot0(key.toId());
        ok = sqrtP != 0;
    }

    function canSell(address token) external view returns (bool) {
        (, bool ok) = keyFor(token);
        return ok;
    }

    /// @dev price = token1 per token0 = token per ETH, so ETH per token is the inverse.
    function spot(address token) external view returns (uint256) {
        (PoolKey memory key, bool ok) = keyFor(token);
        if (!ok) return 0;
        (uint160 sqrtP,,,) = manager.getSlot0(key.toId());
        uint256 ratio = Math.mulDiv(uint256(sqrtP), uint256(sqrtP), 1 << 96);
        return ratio == 0 ? 0 : Math.mulDiv(1e18, 1 << 96, ratio);
    }

    function sell(address token, uint256 amount, uint256 minOut) external nonReentrant returns (uint256 ethOut) {
        (PoolKey memory key, bool ok) = keyFor(token);
        if (!ok) revert NoPool();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 got = IERC20(token).balanceOf(address(this));
        uint256 before = address(this).balance;
        manager.unlock(abi.encode(key, got));
        ethOut = address(this).balance - before;
        require(ethOut >= minOut, "slip");
        (bool sent,) = msg.sender.call{value: ethOut}("");
        require(sent, "eth");
    }

    /// @dev token → ETH is oneForZero: sell currency1, take currency0.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(manager)) revert NotManager();
        (PoolKey memory key, uint256 amountIn) = abi.decode(data, (PoolKey, uint256));
        BalanceDelta d = manager.swap(
            key,
            SwapParams({zeroForOne: false, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1}),
            ""
        );
        // pay the token in
        uint256 owe = uint256(uint128(-d.amount1()));
        manager.sync(key.currency1);
        IERC20(Currency.unwrap(key.currency1)).safeTransfer(address(manager), owe);
        manager.settle();
        // take the ETH out
        uint256 outAmt = uint256(uint128(d.amount0()));
        manager.take(key.currency0, address(this), outAmt);
        return "";
    }
}
