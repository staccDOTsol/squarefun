// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SquareSink} from "../contracts/src/square/SquareSink.sol";
import {SquareStake} from "../contracts/src/square/SquareStake.sol";

/// @title DeploySquareStake: put the $SQUARE launch in front of the legacy sink.
/// @notice One broadcast, from the wallet that holds the placeholder supply:
///           1. deploy SquareStake bound to the real $SQUARE (0x0E2d…8Ee8)
///           2. unstake the placeholder the deployer staked in the legacy sink
///           3. send the entire placeholder supply to the pool and stake it upstream
///         env PRIVATE_KEY.
///         forge script script/DeploySquareStake.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast
contract DeploySquareStake is Script {
    address constant WIZARDS = 0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8;
    SquareSink constant LEGACY = SquareSink(0x2E1cf32C1A760bd1603de762D51Fb2A30F271C35);
    address constant FLAGSHIP = 0x0E2d71875adFFB2107Eb2c0094060651dFef8Ee8;

    function run() external {
        // PRIVATE_KEY to broadcast; without it, simulate as --sender
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        address owner = pk == 0 ? msg.sender : vm.addr(pk);
        IERC20 placeholder = LEGACY.square();

        if (pk == 0) vm.startBroadcast(owner);
        else vm.startBroadcast(pk);

        SquareStake pool = new SquareStake(WIZARDS, LEGACY);
        pool.setSquare(FLAGSHIP);

        uint256 stakedUpstream = LEGACY.staked(owner);
        if (stakedUpstream != 0) LEGACY.unstake(stakedUpstream);
        placeholder.transfer(address(pool), placeholder.balanceOf(owner));
        pool.stakeLegacy();

        vm.stopBroadcast();

        console.log("pool        ", address(pool));
        console.log("stake token ", address(pool.square()));
        console.log("legacy stake", LEGACY.staked(address(pool)));
        console.log("block       ", block.number);
    }
}
