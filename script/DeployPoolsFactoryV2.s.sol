// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {SquarePoolsTokenFactoryV2} from "../contracts/src/square/pools/SquarePoolsTokenFactoryV2.sol";

/// @title DeployPoolsFactoryV2: the token factory for the second version of the reference fee.
/// @notice One transaction. The settler is the one The Cook already pays: its only venue sells into
///         the instant-launch pool shape, which every token launched this way shares, so new tokens
///         settle through it too. After this runs, set `pools.tokenFactoryV2` in
///         app/src/deployments/4663.json and redeploy the site; the launch page then uses it.
///         env PRIVATE_KEY (or --sender to simulate).
///         forge script script/DeployPoolsFactoryV2.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast
contract DeployPoolsFactoryV2 is Script {
    address constant SETTLER = 0x45866DE9E1b1dFcCE288454D14F23E15ef76B77A;

    function run() external {
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        if (pk == 0) vm.startBroadcast();
        else vm.startBroadcast(pk);
        SquarePoolsTokenFactoryV2 factory = new SquarePoolsTokenFactoryV2(SETTLER);
        vm.stopBroadcast();
        console.log("SquarePoolsTokenFactoryV2", address(factory));
    }
}
