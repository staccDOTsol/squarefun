// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {TokenMetadata} from "../contracts/src/square/pools/SquarePoolsToken.sol";
import {MoonJar} from "../contracts/src/square/moon/MoonJar.sol";
import {MoonTokenFactory} from "../contracts/src/square/moon/MoonTokenFactory.sol";

struct Distribution {
    address strategy;
    uint128 amount;
    bytes configData;
}

interface ILiquidityLauncher {
    function createToken(
        address factory,
        string calldata name,
        string calldata symbol,
        uint8 decimals,
        uint128 initialSupply,
        address recipient,
        bytes calldata tokenData
    ) external returns (address);
    function distributeToken(address token, Distribution calldata distribution, bytes32 salt) external;
    function multicall(bytes[] calldata data) external returns (bytes[] memory);
    function getGraffiti(address originalCreator) external pure returns (bytes32);
}

/// @title LaunchMoon: launch the moon token through pools.xyz and bind its jar. Run with the steward's key.
/// @notice env FACTORY (from DeployMoon), TOKEN_NAME, TOKEN_SYMBOL, PRIVATE_KEY (the steward's),
///         optional TOKEN_DESCRIPTION, TOKEN_WEBSITE (default https://staccpad.fun), TOKEN_IMAGE.
///         One transaction through the launcher, then the bind. The jar's steward is whoever deployed
///         it, so this must be the same key.
///         forge script script/LaunchMoon.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast
contract LaunchMoon is Script {
    ILiquidityLauncher constant LAUNCHER = ILiquidityLauncher(0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0);
    address constant INSTANT = 0x23f8209572b4a1C2AD88A42749E830791Fb027f1;
    uint128 constant SUPPLY = 1_000_000_000e18;

    function run() external {
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        address steward = pk == 0 ? msg.sender : vm.addr(pk);
        MoonTokenFactory factory = MoonTokenFactory(vm.envAddress("FACTORY"));
        string memory name = vm.envString("TOKEN_NAME");
        string memory symbol = vm.envString("TOKEN_SYMBOL");
        bytes memory data = abi.encode(
            TokenMetadata({
                description: vm.envOr("TOKEN_DESCRIPTION", string("fees buy moon: every buy fee is tickets for a lunar parcel")),
                website: vm.envOr("TOKEN_WEBSITE", string("https://staccpad.fun")),
                image: vm.envOr("TOKEN_IMAGE", string("")),
                xProofTweetId: 0
            })
        );

        address predicted = factory.getTokenAddress(
            name, symbol, SUPPLY, address(LAUNCHER), data, address(LAUNCHER), LAUNCHER.getGraffiti(steward)
        );
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(
            ILiquidityLauncher.createToken, (address(factory), name, symbol, 18, SUPPLY, address(LAUNCHER), data)
        );
        calls[1] = abi.encodeCall(
            ILiquidityLauncher.distributeToken,
            (predicted, Distribution({strategy: INSTANT, amount: SUPPLY, configData: abi.encode(steward)}), bytes32(0))
        );

        if (pk == 0) vm.startBroadcast();
        else vm.startBroadcast(pk);
        LAUNCHER.multicall(calls);
        MoonJar(payable(factory.jar())).bind(predicted);
        vm.stopBroadcast();

        require(predicted.code.length != 0, "token not deployed");
        console.log("Token", predicted);
        console.log("https://pools.xyz/t/robinhood/", predicted);
        console.log("Moon keeper env: MOON_JAR=%s", factory.jar());
    }
}
