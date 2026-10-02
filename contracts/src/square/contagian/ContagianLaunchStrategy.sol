// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";

interface IBindable {
    function sink() external view returns (address);
}

interface IContagianBinder {
    function bind(address token, address quote) external;
}

/// @title ContagianLaunchStrategy: a launch through Uniswap's Liquidity Launcher, quoted in anything.
/// @notice Uniswap's instant strategy opens every token against native ETH. The launcher itself
///         takes any strategy, and this one opens the token against the quote the launch names
///         (a dollar, for a token whose target is a dollar), between two prices the launch
///         names: where it opens, and its ceiling. A token whose moon is parity opens below
///         one to one and its ceiling is one to one.
///
///         The whole supply goes into one position between those prices, in the pool shape
///         Pools uses (0.25% fee, tick spacing 25, no hook). Nothing sits below the opening
///         price, so the pool cannot trade under it; the supply runs out at the ceiling, so it
///         cannot trade over it either; and every unit of quote a buyer pays stays in the
///         position until a seller takes it back out. The position is the curve and the
///         reserve at once. It belongs to this contract for good. There is no function that
///         removes it or collects from it.
contract ContagianLaunchStrategy is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant SUPPLY = 1_000_000_000e18;
    uint24 public constant LP_FEE = 2_500;
    int24 public constant TICK_SPACING = 25;
    /// @dev The widest tick aligned to the spacing.
    int24 public constant EDGE_TICK = 887_250;

    IPoolManager public immutable manager;
    address public immutable launcher;

    struct Launch {
        address quote;
        int24 lower;
        int24 upper;
        uint128 liquidity;
    }

    mapping(address token => Launch) public launches;

    /// @dev Uniswap's IStrategy event.
    event DistributionInitialized(address indexed distributor, address indexed token, uint256 totalSupply);
    event TokenLaunched(address indexed token, address indexed quote, int24 opening, int24 ceiling, uint128 liquidity);

    error OnlyLauncher();
    error NotManager();
    error BadLaunch();

    constructor(IPoolManager manager_, address launcher_) {
        require(address(manager_).code.length != 0 && launcher_.code.length != 0, "address");
        manager = manager_;
        launcher = launcher_;
    }

    function keyOf(address token) public view returns (PoolKey memory) {
        address quote = launches[token].quote;
        (address a, address b) = token < quote ? (token, quote) : (quote, token);
        return PoolKey(Currency.wrap(a), Currency.wrap(b), LP_FEE, TICK_SPACING, IHooks(address(0)));
    }

    /// @notice Implements Uniswap's `IStrategy.initializeDistribution`.
    /// @param configData abi.encode(quote, opening tick, ceiling tick). Ticks are in the pool's
    ///        own terms (currency1 per currency0), so their order depends on which side the
    ///        token sorts to: opening below ceiling when the token is currency0, above otherwise.
    function initializeDistribution(address token, uint256 totalSupply, bytes calldata configData, bytes32)
        external
        nonReentrant
    {
        if (msg.sender != launcher) revert OnlyLauncher();
        (address quote, int24 opening, int24 ceiling) = abi.decode(configData, (address, int24, int24));
        bool tokenIs0 = token < quote;
        (int24 lower, int24 upper) = tokenIs0 ? (opening, ceiling) : (ceiling, opening);
        if (
            launches[token].liquidity != 0 || quote == token || totalSupply != SUPPLY
                || IERC20(token).totalSupply() != SUPPLY || IERC20Metadata(token).decimals() != 18
                || lower % TICK_SPACING != 0 || upper % TICK_SPACING != 0 || lower < -EDGE_TICK || upper > EDGE_TICK
                || lower >= upper
        ) revert BadLaunch();

        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), totalSupply);
        if (IERC20(token).balanceOf(address(this)) - before != totalSupply) revert BadLaunch();

        uint160 a = TickMath.getSqrtPriceAtTick(lower);
        uint160 b = TickMath.getSqrtPriceAtTick(upper);
        uint256 raw = tokenIs0
            ? FullMath.mulDiv(totalSupply, FullMath.mulDiv(a, b, 1 << 96), uint256(b) - a)
            : FullMath.mulDiv(totalSupply, 1 << 96, uint256(b) - a);
        if (raw <= 1 || raw > type(uint128).max) revert BadLaunch();
        launches[token] = Launch(quote, lower, upper, uint128(raw - 1));

        manager.initialize(keyOf(token), TickMath.getSqrtPriceAtTick(opening));
        manager.unlock(abi.encode(token));

        // what rounding left behind goes where the token's fees go
        address vault = IBindable(token).sink();
        uint256 dust = IERC20(token).balanceOf(address(this)) - before;
        if (dust != 0) IERC20(token).safeTransfer(vault, dust);
        IContagianBinder(vault).bind(token, quote);

        emit TokenLaunched(token, quote, opening, ceiling, uint128(raw - 1));
        emit DistributionInitialized(address(this), token, totalSupply);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(manager)) revert NotManager();
        address token = abi.decode(data, (address));
        Launch memory l = launches[token];
        PoolKey memory key = keyOf(token);
        (BalanceDelta delta,) = manager.modifyLiquidity(
            key, ModifyLiquidityParams(l.lower, l.upper, int256(uint256(l.liquidity)), bytes32(0)), ""
        );
        bool tokenIs0 = Currency.unwrap(key.currency0) == token;
        int128 tokenDelta = tokenIs0 ? delta.amount0() : delta.amount1();
        int128 quoteDelta = tokenIs0 ? delta.amount1() : delta.amount0();
        require(tokenDelta < 0 && quoteDelta == 0, "single sided");
        uint256 owed = uint256(uint128(-tokenDelta));
        manager.sync(Currency.wrap(token));
        IERC20(token).safeTransfer(address(manager), owed);
        require(manager.settle() == owed, "settle");
        return "";
    }
}
