// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {SquareVenue} from "../contracts/src/square/venues/SquareVenue.sol";
import {IPonsCurve} from "../contracts/src/square/venues/PonsCurveVenue.sol";

/// @dev Live Robinhood: the flagship on its curve. forge test --match-path test/SquareVenueFork.t.sol --fork-url $RPC
contract SquareVenueForkTest is Test {
    address constant SQUARE = 0x0E2d71875adFFB2107Eb2c0094060651dFef8Ee8;
    address constant SQUARE_CURVE = 0xF207F7E7AABfd10F3BA4612Daf63d044814BBB29;
    IPoolManager constant PM = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);

    receive() external payable {}

    function test_sellsTheFlagshipOnItsCurve() public {
        if (block.chainid != 4663) return;
        SquareVenue v = new SquareVenue(PM);
        assertTrue(v.canSell(SQUARE), "flagship is on its curve");
        assertGt(v.spot(SQUARE), 0);
        vm.deal(address(this), 1 ether);
        IPonsCurve(SQUARE_CURVE).buy{value: 0.01 ether}(0.01 ether, 0, address(this));
        uint256 have = IERC20(SQUARE).balanceOf(address(this));
        IERC20(SQUARE).approve(address(v), have);
        uint256 expected = have * v.spot(SQUARE) / 1e18;
        vm.roll(vm.getBlockNumber() + 1);
        uint256 out = v.sell(SQUARE, have, expected * 90 / 100);
        assertGt(out, 0);
        emit log_named_uint("sold flagship for wei", out);
    }
}
