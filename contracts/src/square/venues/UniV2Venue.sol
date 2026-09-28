// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IVenue} from "./IVenue.sol";

interface IUniV2Factory {
    function getPair(address a, address b) external view returns (address);
}

interface IUniV2Pair {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112 r0, uint112 r1, uint32 t);
}

interface IUniV2Router {
    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

/// @title UniV2Venue: sell any token with a Uniswap v2 pair against WETH.
contract UniV2Venue is IVenue, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IUniV2Factory public immutable factory;
    IUniV2Router public immutable router;
    address public immutable weth;

    error NoPair();

    constructor(IUniV2Factory factory_, IUniV2Router router_, address weth_) {
        factory = factory_;
        router = router_;
        weth = weth_;
    }

    receive() external payable {}

    function pairOf(address token) public view returns (IUniV2Pair) {
        return IUniV2Pair(factory.getPair(token, weth));
    }

    function canSell(address token) external view returns (bool) {
        IUniV2Pair p = pairOf(token);
        if (address(p) == address(0)) return false;
        (uint112 r0, uint112 r1,) = p.getReserves();
        return r0 != 0 && r1 != 0;
    }

    function spot(address token) external view returns (uint256) {
        IUniV2Pair p = pairOf(token);
        if (address(p) == address(0)) return 0;
        (uint112 r0, uint112 r1,) = p.getReserves();
        (uint256 rt, uint256 rw) = p.token0() == token ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        return rt == 0 ? 0 : rw * 1e18 / rt;
    }

    function sell(address token, uint256 amount, uint256 minOut) external nonReentrant returns (uint256 ethOut) {
        if (address(pairOf(token)) == address(0)) revert NoPair();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 got = IERC20(token).balanceOf(address(this));
        IERC20(token).forceApprove(address(router), got);
        address[] memory path = new address[](2);
        path[0] = token;
        path[1] = weth;
        uint256 before = address(this).balance;
        router.swapExactTokensForETHSupportingFeeOnTransferTokens(got, minOut, path, address(this), block.timestamp);
        ethOut = address(this).balance - before;
        (bool ok,) = msg.sender.call{value: ethOut}("");
        require(ok, "eth");
    }
}
