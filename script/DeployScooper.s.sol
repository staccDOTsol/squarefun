// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {MigrateFactory} from "../contracts/src/square/MigrateFactory.sol";
import {ScoopBatch} from "../contracts/src/square/ScoopBatch.sol";
import {IVenue} from "../contracts/src/square/venues/IVenue.sol";
import {PonsCurveVenue, CurveBuyer, IPonsCurve, IPonsFactory} from "../contracts/src/square/venues/PonsCurveVenue.sol";
import {V4Venue} from "../contracts/src/square/venues/V4Venue.sol";
import {UniV3Venue, IUniV3Factory, ISwapRouter02} from "../contracts/src/square/venues/UniV3Venue.sol";
import {UniV2Venue, IUniV2Factory, IUniV2Router} from "../contracts/src/square/venues/UniV2Venue.sol";

/// @title DeployScooper: the migrate factory and every venue it can sell into, on Robinhood Chain.
/// @notice Venues, in the order the factory tries them:
///           1. Pons v2 curve (token still bonding)
///           2. Pons v2 graduated v4 pool (under the Pons meme hook)
///           3. Uniswap v3 WETH pool (Pons v1 and everything else)
///           4. Uniswap v2 WETH pair
///         env PRIVATE_KEY, or --sender to simulate.
contract DeployScooper is Script {
    // $SQUARE and its curve on Square
    address constant SQUARE = 0x0E2d71875adFFB2107Eb2c0094060651dFef8Ee8;
    address constant SQUARE_CURVE = 0xF207F7E7AABfd10F3BA4612Daf63d044814BBB29;
    address constant LEGACY_SINK = 0x2E1cf32C1A760bd1603de762D51Fb2A30F271C35;
    // Pons v2 on Robinhood
    address constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant PONS_HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;
    // Uniswap on Robinhood
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant ROUTER02 = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant V2_FACTORY = 0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f;
    address constant V2_ROUTER = 0x89e5DB8B5aA49aA85AC63f691524311AEB649eba;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    function run() external {
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        if (pk == 0) vm.startBroadcast(msg.sender);
        else vm.startBroadcast(pk);

        IVenue[] memory venues = new IVenue[](4);
        venues[0] = new PonsCurveVenue(IPonsFactory(PONS_FACTORY));
        venues[1] = new V4Venue(IPoolManager(POOL_MANAGER), IPonsFactory(PONS_FACTORY), IHooks(PONS_HOOK));
        venues[2] = new UniV3Venue(IUniV3Factory(V3_FACTORY), ISwapRouter02(ROUTER02), WETH);
        venues[3] = new UniV2Venue(IUniV2Factory(V2_FACTORY), IUniV2Router(V2_ROUTER), WETH);
        CurveBuyer buyer = new CurveBuyer(IPonsCurve(SQUARE_CURVE), IERC20(SQUARE));
        MigrateFactory factory = new MigrateFactory(IERC20(SQUARE), buyer, LEGACY_SINK, venues);
        ScoopBatch batch = new ScoopBatch(factory);

        vm.stopBroadcast();

        console.log("scoopBatch    ", address(batch));
        console.log("migrateFactory", address(factory));
        console.log("ponsCurveVenue", address(venues[0]));
        console.log("v4Venue       ", address(venues[1]));
        console.log("uniV3Venue    ", address(venues[2]));
        console.log("uniV2Venue    ", address(venues[3]));
        console.log("buyer         ", address(buyer));
        console.log("block         ", block.number);
    }
}
