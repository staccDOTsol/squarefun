// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolsVenue} from "../contracts/src/square/pools/PoolsVenue.sol";
import {MoonJar, IOpenVRF} from "../contracts/src/square/moon/MoonJar.sol";
import {MoonTokenFactory} from "../contracts/src/square/moon/MoonTokenFactory.sol";

/// @dev Only what DeployMoon needs to say to the router; the owner authorizes consumers.
interface IOpenVRFRouter {
    function owner() external view returns (address);
    function setConsumerAuthorization(address consumer, bool authorized) external;
}

/// @title DeployMoon: the venue, the jar, and the one-token factory for a moon drop, on Robinhood.
/// @notice The OpenVRF router must exist first — deploy it from a clone of Robinhood-OSS/OpenVRF with
///         OWNER_ADDRESS=<steward or the deploy key> RELAYER_ADDRESS=<the moon keeper's wallet>
///         REQUEST_FEE_WEI=200000000000000 (0.0002 ether, pays the keeper per word):
///         forge script script/Deploy.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast
///         env PRIVATE_KEY (or --sender), VRF_ROUTER (required), PAYOUT (the card's deposit address,
///         required), optional STEWARD (default the sender), FORWARD_AT (default 0.017 ether, the card's
///         least credited deposit), PARCEL_COST (default 0.017 ether, one draw per parcel),
///         PARCELS (comma separated, default the registry's three), BUY_FEE_BPS (default 500).
///         If the sender owns the router the jar is authorized as its consumer here; otherwise the
///         cast command is printed for the owner to run before the first draw.
///         forge script script/DeployMoon.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast
contract DeployMoon is Script {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    function run() external {
        address router = vm.envAddress("VRF_ROUTER");
        address payable payout = payable(vm.envAddress("PAYOUT"));
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        address sender = pk == 0 ? msg.sender : vm.addr(pk);
        address steward = vm.envOr("STEWARD", sender);
        uint256 forwardAt = vm.envOr("FORWARD_AT", uint256(0.017 ether));
        uint256 parcelCost = vm.envOr("PARCEL_COST", uint256(0.017 ether));
        uint256 buyFeeBps = vm.envOr("BUY_FEE_BPS", uint256(500));
        string[] memory parcels = _parcels(
            vm.envOr(
                "PARCELS",
                string(
                    "Lake of Dreams (Lacus Somniorum),Sea of Tranquility (Mare Tranquillitatis),Bay of Rainbows (Sinus Iridum)"
                )
            )
        );

        if (pk == 0) vm.startBroadcast();
        else vm.startBroadcast(pk);
        PoolsVenue venue = new PoolsVenue(IPoolManager(POOL_MANAGER));
        MoonJar jar = new MoonJar(venue, IOpenVRF(router), steward, payout, forwardAt, parcelCost, parcels);
        MoonTokenFactory factory = new MoonTokenFactory(address(jar), POOL_MANAGER, buyFeeBps);
        address routerOwner = IOpenVRFRouter(router).owner();
        if (routerOwner == sender) IOpenVRFRouter(router).setConsumerAuthorization(address(jar), true);
        vm.stopBroadcast();

        require(address(venue).code.length != 0, "venue not deployed");
        console.log("PoolsVenue", address(venue));
        console.log("MoonJar", address(jar));
        console.log("MoonTokenFactory", address(factory));
        if (routerOwner != sender) {
            console.log("The router's owner must authorize the jar before the first draw:");
            console.log("cast send %s \"setConsumerAuthorization(address,bool)\" %s true --rpc-url https://rpc.mainnet.chain.robinhood.com", router, address(jar));
        }
    }

    /// "a,b,c" => ["a", "b", "c"]
    function _parcels(string memory s) internal pure returns (string[] memory out) {
        string[] memory parts = vm.split(s, ",");
        out = new string[](parts.length);
        for (uint256 i; i < parts.length; ++i) {
            out[i] = _trim(parts[i]);
        }
    }

    function _trim(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        uint256 lo;
        uint256 hi = b.length;
        while (lo < hi && (b[lo] == " " || b[lo] == "\n" || b[lo] == "\t")) ++lo;
        while (hi > lo && (b[hi - 1] == " " || b[hi - 1] == "\n" || b[hi - 1] == "\t")) --hi;
        bytes memory out = new bytes(hi - lo);
        for (uint256 i; i < out.length; ++i) out[i] = b[lo + i];
        return string(out);
    }
}
