// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {PonsV2LaunchFactory} from "../contracts/src/v2/PonsV2LaunchFactory.sol";
import {PonsV2LaunchDeployer} from "../contracts/src/v2/PonsV2LaunchDeployer.sol";

/// @title DeployLauncherV2: every launch from here on mints the two-ratchet token.
/// @notice Deploys a new launch deployer (whose token deployer carries the v2 ReferenceFeeERC20:
///         fast global per-L2-block ratchet with two free, slow per-originator window ratchet) and
///         points the live factory at it. Existing launches are untouched; the factory, hook, sink,
///         pool and scooper all stay. Owner-only on the factory, so the owner key broadcasts.
contract DeployLauncherV2 is Script {
    PonsV2LaunchFactory constant FACTORY = PonsV2LaunchFactory(payable(0xAD45084cf5a542c2fF59b49c85B8a357355bF8Cf));

    function run() external {
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        if (pk == 0) vm.startBroadcast(msg.sender);
        else vm.startBroadcast(pk);
        PonsV2LaunchDeployer deployer = new PonsV2LaunchDeployer(address(FACTORY));
        FACTORY.setLaunchDeployer(deployer);
        vm.stopBroadcast();
        console.log("launchDeployer ", address(deployer));
        console.log("tokenDeployer  ", address(deployer.tokenDeployer()));
        console.log("factory now at ", address(FACTORY.launchDeployer()));
    }
}
