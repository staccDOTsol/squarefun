// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IVenue, IBuyer} from "./IVenue.sol";

interface IPonsCurve {
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256);
    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) external returns (uint256);
    function getReserves() external view returns (uint256 quoteReserve, uint256 tokenReserve);
    function graduated() external view returns (bool);
    function readyToGraduate() external view returns (bool);
    function isNativeQuote() external view returns (bool);
}

interface IPonsFactory {
    struct Launch {
        address token;
        address curve;
        address deployer;
        address creatorFeeRecipient;
        address pairToken;
        uint256 graduationThreshold;
        uint24 poolFee;
        int24 tickSpacing;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        uint8 phase;
        uint256 sweptQuote;
        uint256 sweptTokens;
        uint256 sweptAt;
        bool exists;
    }

    function getLaunchedToken(address token) external view returns (Launch memory);
}

/// @title PonsCurveVenue: sell a Pons v2 (or Square) launch that is still on its curve.
/// @notice One instance per factory. The curve is looked up from the factory, so any token
///         it launched works without registration.
contract PonsCurveVenue is IVenue, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IPonsFactory public immutable factory;

    error NoCurve();
    error NotNative();

    constructor(IPonsFactory factory_) {
        factory = factory_;
    }

    receive() external payable {}

    function curveOf(address token) public view returns (IPonsCurve) {
        IPonsFactory.Launch memory l = factory.getLaunchedToken(token);
        if (!l.exists || l.curve == address(0)) return IPonsCurve(address(0));
        return IPonsCurve(l.curve);
    }

    function canSell(address token) external view returns (bool) {
        IPonsCurve c = curveOf(token);
        if (address(c) == address(0)) return false;
        if (!c.isNativeQuote()) return false;
        return !c.graduated() && !c.readyToGraduate();
    }

    function spot(address token) external view returns (uint256) {
        IPonsCurve c = curveOf(token);
        if (address(c) == address(0)) return 0;
        (uint256 q, uint256 t) = c.getReserves();
        return t == 0 ? 0 : q * 1e18 / t;
    }

    function sell(address token, uint256 amount, uint256 minOut) external nonReentrant returns (uint256 ethOut) {
        IPonsCurve c = curveOf(token);
        if (address(c) == address(0)) revert NoCurve();
        if (!c.isNativeQuote()) revert NotNative();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        IERC20(token).forceApprove(address(c), amount);
        uint256 before = address(this).balance;
        c.sell(amount, minOut, address(this));
        ethOut = address(this).balance - before;
        (bool ok,) = msg.sender.call{value: ethOut}("");
        require(ok, "eth");
    }
}

/// @title CurveBuyer: ETH into $SQUARE on the Square curve.
contract CurveBuyer is IBuyer {
    IPonsCurve public immutable curve;
    IERC20 public immutable square;

    constructor(IPonsCurve curve_, IERC20 square_) {
        curve = curve_;
        square = square_;
    }

    function buy(uint256 minOut) external payable returns (uint256) {
        return curve.buy{value: msg.value}(msg.value, minOut, msg.sender);
    }
}
