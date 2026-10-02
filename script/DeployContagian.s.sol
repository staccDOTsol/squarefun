// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {ContagianLaunchStrategy} from "../contracts/src/square/contagian/ContagianLaunchStrategy.sol";
import {ContagianVault, ISquareStake, IWrapped} from "../contracts/src/square/contagian/ContagianVault.sol";
import {ContagianLauncher, ILiquidityLauncher} from "../contracts/src/square/contagian/ContagianLauncher.sol";

/// @title DeployContagian: the strategy, the vault every launch clones, and the launcher.
/// @notice Three transactions, no launch. After this runs, set `contagian.launcher` in
///         app/src/deployments/4663.json and redeploy the site; its Contagian page then launches
///         through it.
///         env PRIVATE_KEY (or --sender to simulate).
///         forge script script/DeployContagian.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast
contract DeployContagian is Script {
    address constant UNISWAP_LAUNCHER = 0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant WIZARDS = 0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8;
    address constant STAKE_POOL = 0x78CD5692961cd0dc9bC15327BF34cDc1bCdca41C;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    function run() external {
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        if (pk == 0) vm.startBroadcast();
        else vm.startBroadcast(pk);
        ContagianLaunchStrategy strategy = new ContagianLaunchStrategy(IPoolManager(POOL_MANAGER), UNISWAP_LAUNCHER);
        ContagianVault vault =
            new ContagianVault(IPoolManager(POOL_MANAGER), strategy, WIZARDS, ISquareStake(STAKE_POOL), IWrapped(WETH));
        ContagianLauncher launcher =
            new ContagianLauncher(ILiquidityLauncher(UNISWAP_LAUNCHER), POOL_MANAGER, strategy, address(vault));
        vm.stopBroadcast();
        console.log("ContagianLaunchStrategy", address(strategy));
        console.log("ContagianVault (implementation)", address(vault));
        console.log("ContagianLauncher", address(launcher));
        console.log("ContagianTokenFactory", address(launcher.tokenFactory()));
    }
}
