// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {TokenMetadata} from "../contracts/src/square/pools/SquarePoolsToken.sol";
import {BasketItem} from "../contracts/src/square/pools/MemeBasketToken.sol";
import {MemeBasketFactory} from "../contracts/src/square/pools/MemeBasketFactory.sol";

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

/// @title LaunchMemeBasket: stage NFTs and launch a basket token through pools.xyz, from the command line.
/// @notice env FACTORY, TOKEN_NAME, TOKEN_SYMBOL, ITEMS ("0xCollection:id,0xCollection:id,..."),
///         optional TOKEN_DESCRIPTION, TOKEN_WEBSITE, TOKEN_IMAGE, REDEEM_DELAY (seconds, default 1 day),
///         PICK_PREMIUM_BPS (default 2000), PRIVATE_KEY (or --sender to simulate).
///         Approves the factory on each collection, stages, then creates and distributes in one launcher call.
///         forge script script/LaunchMemeBasket.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast
contract LaunchMemeBasket is Script {
    ILiquidityLauncher constant LAUNCHER = ILiquidityLauncher(0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0);
    address constant INSTANT = 0x23f8209572b4a1C2AD88A42749E830791Fb027f1;
    uint128 constant SUPPLY = 1_000_000_000e18;

    function run() external {
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        address creator = pk == 0 ? msg.sender : vm.addr(pk);
        MemeBasketFactory factory = MemeBasketFactory(vm.envAddress("FACTORY"));
        string memory name = vm.envString("TOKEN_NAME");
        string memory symbol = vm.envString("TOKEN_SYMBOL");
        BasketItem[] memory items = _items(vm.envString("ITEMS"));
        bytes memory data = abi.encode(
            TokenMetadata({
                description: vm.envOr("TOKEN_DESCRIPTION", string("")),
                website: vm.envOr("TOKEN_WEBSITE", string("https://staccpad.fun")),
                image: vm.envOr("TOKEN_IMAGE", string("")),
                xProofTweetId: 0
            }),
            uint64(vm.envOr("REDEEM_DELAY", uint256(1 days))),
            uint16(vm.envOr("PICK_PREMIUM_BPS", uint256(2_000)))
        );

        if (pk == 0) vm.startBroadcast();
        else vm.startBroadcast(pk);
        for (uint256 i; i < items.length; ++i) {
            if (!IERC721(items[i].collection).isApprovedForAll(creator, address(factory))) {
                IERC721(items[i].collection).setApprovalForAll(address(factory), true);
            }
        }
        factory.stage(items);
        address token = factory.getTokenAddress(
            name, symbol, SUPPLY, address(LAUNCHER), data, address(LAUNCHER), LAUNCHER.getGraffiti(creator)
        );
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(
            ILiquidityLauncher.createToken, (address(factory), name, symbol, 18, SUPPLY, address(LAUNCHER), data)
        );
        calls[1] = abi.encodeCall(
            ILiquidityLauncher.distributeToken,
            (token, Distribution({strategy: INSTANT, amount: SUPPLY, configData: abi.encode(creator)}), bytes32(0))
        );
        LAUNCHER.multicall(calls);
        vm.stopBroadcast();

        require(token.code.length != 0, "token not deployed");
        console.log("Token", token);
        console.log("NFTs inside", items.length);
        console.log("https://pools.xyz/t/robinhood/", token);
    }

    /// "0xabc:1,0xdef:22" => items
    function _items(string memory s) internal pure returns (BasketItem[] memory out) {
        string[] memory parts = vm.split(s, ",");
        out = new BasketItem[](parts.length);
        for (uint256 i; i < parts.length; ++i) {
            string[] memory kv = vm.split(parts[i], ":");
            require(kv.length == 2, "ITEMS is 0xCollection:id,...");
            out[i] = BasketItem(vm.parseAddress(kv[0]), vm.parseUint(kv[1]));
        }
    }
}
