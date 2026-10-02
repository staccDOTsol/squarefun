// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// @dev A second dollar, to stand in for a partner stable that does not exist on the chain yet.
contract Dollar is ERC20 {
    constructor() ERC20("Other Dollar", "USDX") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev A router and an attacker's toolbox against any pool of a Contagian token (0.25%, spacing 25, no hook).
///      `buy` and `sell` move tokens the way the universal router does: one transfer per swap,
///      payer straight to the manager. The rest is what an honest router would never do.
contract Router is IUnlockCallback {
    IPoolManager immutable manager;

    enum Op {
        Buy,
        Sell,
        SellPayFirst,
        InAndOut,
        Raw
    }

    constructor(IPoolManager m) {
        manager = m;
    }

    receive() external payable {}

    /// @notice A swap in any hookless pool, paid by the caller: for moving a reference pool.
    function swapIn(address c0, address c1, uint24 fee, int24 spacing, bool zeroForOne, uint256 amountIn)
        external
        payable
        returns (uint256)
    {
        return abi.decode(
            manager.unlock(abi.encode(Op.Raw, c0, c1, amountIn, address(uint160(uint256(fee) << 32 | uint24(spacing) << 8 | (zeroForOne ? 1 : 0))), msg.sender)),
            (uint256)
        );
    }

    function buy(address token, address quote, uint256 quoteIn, address to) external payable returns (uint256) {
        return abi.decode(manager.unlock(abi.encode(Op.Buy, token, quote, quoteIn, to, msg.sender)), (uint256));
    }

    /// @notice A sale larger than the pool can take spends only what it can, and carries the
    ///         pool's price on through the empty ticks below the launch position, for nothing.
    function sell(address token, address quote, uint256 amount) external returns (uint256) {
        return abi.decode(manager.unlock(abi.encode(Op.Sell, token, quote, amount, msg.sender, msg.sender)), (uint256));
    }

    /// @notice A sale that pays the pool before it swaps, so the token samples the price before the sale moves it.
    function sellPayFirst(address token, address quote, uint256 amount) external returns (uint256) {
        return
            abi.decode(manager.unlock(abi.encode(Op.SellPayFirst, token, quote, amount, msg.sender, msg.sender)), (uint256));
    }

    /// @notice Buy and sell back inside one unlock: the token never moves, only the price does, twice.
    function inAndOut(address token, address quote, uint256 quoteIn) external returns (uint256) {
        return abi.decode(manager.unlock(abi.encode(Op.InAndOut, token, quote, quoteIn, msg.sender, msg.sender)), (uint256));
    }

    function _swap(PoolKey memory key, bool zeroForOne, int256 amount, uint160 limit) private returns (BalanceDelta) {
        if (limit == 0) limit = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        return manager.swap(key, SwapParams(zeroForOne, amount, limit), "");
    }

    function _pay(address currency, address payer, uint256 amount) private {
        if (currency == address(0)) {
            manager.settle{value: amount}();
            return;
        }
        manager.sync(Currency.wrap(currency));
        IERC20(currency).transferFrom(payer, address(manager), amount);
        manager.settle();
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), "manager");
        (Op op, address token, address quote, uint256 amount, address to, address payer) =
            abi.decode(data, (Op, address, address, uint256, address, address));
        if (op == Op.Raw) {
            uint256 packed = uint256(uint160(to));
            PoolKey memory k = PoolKey(
                Currency.wrap(token), Currency.wrap(quote), uint24(packed >> 32), int24(uint24(packed >> 8)), IHooks(address(0))
            );
            bool zeroForOne = packed & 1 == 1;
            BalanceDelta r = _swap(k, zeroForOne, -int256(amount), 0);
            _pay(zeroForOne ? token : quote, payer, uint256(uint128(-(zeroForOne ? r.amount0() : r.amount1()))));
            uint256 gotRaw = uint256(uint128(zeroForOne ? r.amount1() : r.amount0()));
            manager.take(Currency.wrap(zeroForOne ? quote : token), payer, gotRaw);
            return abi.encode(gotRaw);
        }
        bool tokenIs0 = token < quote;
        PoolKey memory key = PoolKey(
            Currency.wrap(tokenIs0 ? token : quote), Currency.wrap(tokenIs0 ? quote : token), 2_500, 25, IHooks(address(0))
        );

        if (op == Op.Buy) {
            BalanceDelta d = _swap(key, !tokenIs0, -int256(amount), 0);
            uint256 out = uint256(uint128(tokenIs0 ? d.amount0() : d.amount1()));
            _pay(quote, payer, uint256(uint128(-(tokenIs0 ? d.amount1() : d.amount0()))));
            manager.take(Currency.wrap(token), to, out);
            return abi.encode(out);
        }
        if (op == Op.Sell || op == Op.SellPayFirst) {
            if (op == Op.SellPayFirst) _pay(token, payer, amount);
            BalanceDelta d = _swap(key, tokenIs0, -int256(amount), 0);
            uint256 spent = uint256(uint128(-(tokenIs0 ? d.amount0() : d.amount1())));
            if (op == Op.Sell) _pay(token, payer, spent);
            else if (amount > spent) manager.take(Currency.wrap(token), payer, amount - spent);
            uint256 out = uint256(uint128(tokenIs0 ? d.amount1() : d.amount0()));
            manager.take(Currency.wrap(quote), to, out);
            return abi.encode(out);
        }
        // InAndOut: the token leg nets to (nearly) nothing inside the unlock
        BalanceDelta b = _swap(key, !tokenIs0, -int256(amount), 0);
        uint256 got = uint256(uint128(tokenIs0 ? b.amount0() : b.amount1()));
        BalanceDelta s = _swap(key, tokenIs0, -int256(got), 0);
        uint256 back = uint256(uint128(tokenIs0 ? s.amount1() : s.amount0()));
        _pay(quote, payer, amount - back);
        return abi.encode(back);
    }
}
