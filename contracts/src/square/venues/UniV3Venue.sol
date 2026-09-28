// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IVenue} from "./IVenue.sol";

interface IUniV3Factory {
    function getPool(address a, address b, uint24 fee) external view returns (address);
}

interface IUniV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function liquidity() external view returns (uint128);
    function slot0()
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint16 a, uint16 b, uint16 c, uint8 d, bool unlocked);
}

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 amountOut);
}

interface IWETH {
    function withdraw(uint256) external;
}

/// @title UniV3Venue: sell any token with a Uniswap v3 pool against WETH.
/// @notice The Pons v1 graveyard lives here: fixed supply, liquidity locked in v3 forever.
///         Picks the deepest of the standard fee tiers.
contract UniV3Venue is IVenue, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IUniV3Factory public immutable factory;
    ISwapRouter02 public immutable router;
    address public immutable weth;

    error NoPool();

    constructor(IUniV3Factory factory_, ISwapRouter02 router_, address weth_) {
        factory = factory_;
        router = router_;
        weth = weth_;
    }

    receive() external payable {}

    function _fees() internal pure returns (uint24[4] memory f) {
        f = [uint24(100), uint24(500), uint24(3000), uint24(10000)];
    }

    /// @notice The WETH pool for `token` holding the most WETH, and its fee tier.
    /// @dev Measured by WETH balance, not in-range liquidity: a one-sided locked position
    ///      (the Pons v1 shape) reports zero in-range liquidity while still being sellable into.
    function bestPool(address token) public view returns (IUniV3Pool pool, uint24 fee) {
        uint256 best;
        uint24[4] memory fs = _fees();
        for (uint256 i = 0; i < fs.length; i++) {
            address p = factory.getPool(token, weth, fs[i]);
            if (p == address(0)) continue;
            uint256 depth = IERC20(weth).balanceOf(p);
            if (depth > best) {
                best = depth;
                pool = IUniV3Pool(p);
                fee = fs[i];
            }
        }
    }

    function canSell(address token) external view returns (bool) {
        (IUniV3Pool p,) = bestPool(token);
        return address(p) != address(0);
    }

    /// @dev sqrtPriceX96² / 2^192 is token1 per token0.
    function spot(address token) external view returns (uint256) {
        (IUniV3Pool p,) = bestPool(token);
        if (address(p) == address(0)) return 0;
        (uint160 sqrtP,,,,,,) = p.slot0();
        uint256 ratio = Math.mulDiv(uint256(sqrtP), uint256(sqrtP), 1 << 96); // price × 2^96
        if (p.token0() == token) {
            // weth per token = ratio / 2^96
            return Math.mulDiv(ratio, 1e18, 1 << 96);
        }
        // token per weth = ratio / 2^96  →  weth per token = 2^96 / ratio
        return ratio == 0 ? 0 : Math.mulDiv(1e18, 1 << 96, ratio);
    }

    function sell(address token, uint256 amount, uint256 minOut) external nonReentrant returns (uint256 ethOut) {
        (IUniV3Pool p, uint24 fee) = bestPool(token);
        if (address(p) == address(0)) revert NoPool();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 got = IERC20(token).balanceOf(address(this)); // fee-on-transfer safe
        IERC20(token).forceApprove(address(router), got);
        uint256 out = router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: token,
                tokenOut: weth,
                fee: fee,
                recipient: address(this),
                amountIn: got,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
        IWETH(weth).withdraw(out);
        ethOut = out;
        (bool ok,) = msg.sender.call{value: ethOut}("");
        require(ok, "eth");
    }
}
