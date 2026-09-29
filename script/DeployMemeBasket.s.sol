// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {MemeBasketFactory} from "../contracts/src/square/pools/MemeBasketFactory.sol";

/// @title DeployMemeBasket: the factory that launches a meme token with NFTs inside it through pools.xyz.
/// @notice One transaction. The settler is the one every Pools launch pays: its venue sells into the
///         instant-launch pool shape, so basket tokens settle through it too.
///         env PRIVATE_KEY (or --sender to simulate).
///         forge script script/DeployMemeBasket.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast
contract DeployMemeBasket is Script {
    address constant LAUNCHER = 0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0;
    address constant SETTLER = 0x45866DE9E1b1dFcCE288454D14F23E15ef76B77A;

    function run() external {
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        if (pk == 0) vm.startBroadcast();
        else vm.startBroadcast(pk);
        MemeBasketFactory factory = new MemeBasketFactory(LAUNCHER, SETTLER);
        vm.stopBroadcast();
        console.log("MemeBasketFactory", address(factory));
    }
}
