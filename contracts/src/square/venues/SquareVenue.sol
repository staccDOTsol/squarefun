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
import {IVenue} from "./IVenue.sol";
import {IPonsCurve, IPonsFactory} from "./PonsCurveVenue.sol";

/// @dev What a Square launch token tells about itself.
interface ISquareToken {
    function curve() external view returns (address);
    function launchFactory() external view returns (address);
    function memeHook() external view returns (address);
}

/// @title SquareVenue: sell a Square launch wherever it is, on its curve or in its v4 pool.
/// @notice Square tokens carry their own curve, factory and hook, so no factory binding is
///         needed: one venue serves every launch from every Square factory, past and future.
contract SquareVenue is IVenue, IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager public immutable manager;

    error NotManager();
    error NoMarket();

    constructor(IPoolManager manager_) {
        manager = manager_;
    }

    receive() external payable {}

    function _curve(address token) internal view returns (IPonsCurve c) {
        try ISquareToken(token).curve() returns (address a) {
            c = IPonsCurve(a);
        } catch {}
    }

    function _key(address token) internal view returns (PoolKey memory key, bool ok) {
        try ISquareToken(token).launchFactory() returns (address f) {
            IPonsFactory.Launch memory l = IPonsFactory(f).getLaunchedToken(token);
            if (!l.exists || l.pairToken != address(0)) return (key, false);
            key = PoolKey({
                currency0: CurrencyLibrary.ADDRESS_ZERO,
                currency1: Currency.wrap(token),
                fee: l.poolFee,
                tickSpacing: l.tickSpacing,
                hooks: IHooks(ISquareToken(token).memeHook())
            });
            (uint160 sqrtP,,,) = manager.getSlot0(key.toId());
            ok = sqrtP != 0;
        } catch {}
    }

    function _onCurve(address token) internal view returns (bool) {
        IPonsCurve c = _curve(token);
        if (address(c) == address(0)) return false;
        try c.graduated() returns (bool g) {
            if (g) return false;
        } catch {
            return false;
        }
        return !c.readyToGraduate();
    }

    function canSell(address token) external view returns (bool) {
        if (_onCurve(token)) return true;
        (, bool ok) = _key(token);
        return ok;
    }

    function spot(address token) external view returns (uint256) {
        if (_onCurve(token)) {
            (uint256 q, uint256 t) = _curve(token).getReserves();
            return t == 0 ? 0 : q * 1e18 / t;
        }
        (PoolKey memory key, bool ok) = _key(token);
        if (!ok) return 0;
        (uint160 sqrtP,,,) = manager.getSlot0(key.toId());
        uint256 ratio = Math.mulDiv(uint256(sqrtP), uint256(sqrtP), 1 << 96);
        return ratio == 0 ? 0 : Math.mulDiv(1e18, 1 << 96, ratio);
    }

    function sell(address token, uint256 amount, uint256 minOut) external nonReentrant returns (uint256 ethOut) {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 got = IERC20(token).balanceOf(address(this));
        uint256 before = address(this).balance;
        if (_onCurve(token)) {
            IPonsCurve c = _curve(token);
            IERC20(token).forceApprove(address(c), got);
            c.sell(got, minOut, address(this));
        } else {
            (PoolKey memory key, bool ok) = _key(token);
            if (!ok) revert NoMarket();
            manager.unlock(abi.encode(key, got));
        }
        ethOut = address(this).balance - before;
        require(ethOut >= minOut, "slip");
        (bool sent,) = msg.sender.call{value: ethOut}("");
        require(sent, "eth");
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(manager)) revert NotManager();
        (PoolKey memory key, uint256 amountIn) = abi.decode(data, (PoolKey, uint256));
        BalanceDelta d = manager.swap(
            key,
            SwapParams({zeroForOne: false, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1}),
            ""
        );
        uint256 owe = uint256(uint128(-d.amount1()));
        manager.sync(key.currency1);
        IERC20(Currency.unwrap(key.currency1)).safeTransfer(address(manager), owe);
        manager.settle();
        manager.take(key.currency0, address(this), uint256(uint128(d.amount0())));
        return "";
    }
}
