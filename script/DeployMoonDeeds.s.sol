// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {MoonDeeds} from "../contracts/src/square/moon/MoonDeeds.sol";

/// @title DeployMoonDeeds: the Ethereum side of a moon drop, where the registry's NFTs live.
/// @notice env PRIVATE_KEY (or --sender), optional STEWARD (default the sender). The steward wraps each
///         drop's NFT to its winner; a fresh, dedicated wallet works.
///         forge script script/DeployMoonDeeds.s.sol --rpc-url <an ethereum rpc> --broadcast
contract DeployMoonDeeds is Script {
    function run() external {
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        address steward = vm.envOr("STEWARD", pk == 0 ? msg.sender : vm.addr(pk));
        if (pk == 0) vm.startBroadcast();
        else vm.startBroadcast(pk);
        MoonDeeds deeds = new MoonDeeds(steward);
        vm.stopBroadcast();
        console.log("MoonDeeds", address(deeds));
    }
}
