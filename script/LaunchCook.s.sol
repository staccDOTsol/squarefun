// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {NativeSettler, IWETH, IStakePool} from "../contracts/src/square/NativeSettler.sol";
import {IVenue} from "../contracts/src/square/venues/IVenue.sol";
import {PoolsVenue} from "../contracts/src/square/pools/PoolsVenue.sol";
import {TokenMetadata} from "../contracts/src/square/pools/SquarePoolsToken.sol";
import {SquarePoolsTokenFactory} from "../contracts/src/square/pools/SquarePoolsTokenFactory.sol";

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

/// @title LaunchCook: The Cook, launched through Uniswap's Liquidity Launcher (pools.xyz).
/// @notice Four transactions: the venue the settler sells through, the settler, the token
///         factory, and the launch. The launch creates the token and puts the whole supply into
///         a native-ETH Uniswap v4 pool in one call; the position is locked in Uniswap's fee
///         splitter. The token carries the Square rule and pays its fees to the settler, which
///         sells for ETH, sends half to the ownerless sink and half to $SQUARE stakers.
///         env PRIVATE_KEY (or --sender to simulate).
///         forge script script/LaunchCook.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast
///         To launch another token through a factory that is already deployed, set FACTORY.
contract LaunchCook is Script {
    // Uniswap's Liquidity Launcher v3.2.0 and its instant launch strategy on Robinhood Chain
    ILiquidityLauncher constant LAUNCHER = ILiquidityLauncher(0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0);
    address constant INSTANT = 0x23f8209572b4a1C2AD88A42749E830791Fb027f1;
    IPoolManager constant POOL_MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    // the $SQUARE stake pool and the ownerless sink every Square launch already pays
    address constant STAKE_POOL = 0x78CD5692961cd0dc9bC15327BF34cDc1bCdca41C;
    address payable constant NATIVE_SINK = payable(0x1c6fE80f37D97AaED55d9313a643b6dF0A59B3Dc);
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    uint128 constant SUPPLY = 1_000_000_000e18;

    function run() external {
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        address creator = pk == 0 ? msg.sender : vm.addr(pk);
        address existing = vm.envOr("FACTORY", address(0));

        string memory name = vm.envOr("TOKEN_NAME", string("The Cook"));
        string memory symbol = vm.envOr("TOKEN_SYMBOL", string("COOK"));
        bytes memory tokenData = abi.encode(
            TokenMetadata({
                description: vm.envOr(
                    "TOKEN_DESCRIPTION",
                    string(
                        "Waiting for the cook? He is in the kitchen. One plate is on the house. Come back for a third helping in the same block and you pay the chef. Nothing is burned, the kitchen stakes it. EIP-8429 v0."
                    )
                ),
                website: vm.envOr("TOKEN_WEBSITE", string("https://squarefun.xyz")),
                image: vm.envOr("TOKEN_IMAGE", string("https://squarefun.xyz/cook.png")),
                xProofTweetId: 0
            })
        );

        if (pk == 0) vm.startBroadcast();
        else vm.startBroadcast(pk);

        SquarePoolsTokenFactory factory;
        if (existing == address(0)) {
            PoolsVenue venue = new PoolsVenue(POOL_MANAGER);
            IVenue[] memory venues = new IVenue[](1);
            venues[0] = venue;
            NativeSettler settler = new NativeSettler(venues, IStakePool(STAKE_POOL), IWETH(WETH), NATIVE_SINK);
            factory = new SquarePoolsTokenFactory(address(settler));
            console.log("PoolsVenue        ", address(venue));
            console.log("NativeSettler     ", address(settler));
            console.log("TokenFactory      ", address(factory));
        } else {
            factory = SquarePoolsTokenFactory(existing);
        }

        address token = factory.getTokenAddress(
            name, symbol, SUPPLY, address(LAUNCHER), tokenData, address(LAUNCHER), LAUNCHER.getGraffiti(creator)
        );
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(
            ILiquidityLauncher.createToken, (address(factory), name, symbol, 18, SUPPLY, address(LAUNCHER), tokenData)
        );
        calls[1] = abi.encodeCall(
            ILiquidityLauncher.distributeToken,
            (token, Distribution({strategy: INSTANT, amount: SUPPLY, configData: abi.encode(creator)}), bytes32(0))
        );
        LAUNCHER.multicall(calls);
        vm.stopBroadcast();

        require(token.code.length != 0, "token not deployed");
        console.log("Token             ", token);
        console.log("Creator fees to   ", creator);
        console.log("https://pools.xyz/t/robinhood/", token);
    }
}
