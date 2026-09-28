// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {PonsV2FeeEscrow} from "../contracts/src/v2/PonsV2FeeEscrow.sol";
import {PonsV2MemeHook} from "../contracts/src/v2/hooks/PonsV2MemeHook.sol";
import {PonsV2BuybackVault} from "../contracts/src/v2/PonsV2BuybackVault.sol";
import {PonsV2LaunchLocker} from "../contracts/src/v2/PonsV2LaunchLocker.sol";
import {PonsV2LaunchFactory} from "../contracts/src/v2/PonsV2LaunchFactory.sol";
import {PonsV2GraduationExecutor} from "../contracts/src/v2/PonsV2GraduationExecutor.sol";
import {PonsV2LaunchDeployer} from "../contracts/src/v2/PonsV2LaunchDeployer.sol";
import {IPonsV2FeeEscrow, IPonsV2FeePolicy} from "../contracts/src/v2/interfaces/ILaunchpadV2.sol";
import {NativeSettler, IWETH, IStakePool} from "../contracts/src/square/NativeSettler.sol";
import {IVenue} from "../contracts/src/square/venues/IVenue.sol";
import {SquareVenue} from "../contracts/src/square/venues/SquareVenue.sol";

/// @title DeployPadV2: a second pad whose launches mint the two-ratchet token, feeding the same sink.
/// @notice The v1 factory's launch deployer is one-shot, so new launches need a new factory. Everything
///         is redeployed except the sink and the pool: every launch's reference beneficiary is the
///         legacy sink 0x2E1c…1C35, which SquareStake already drains. The v1 pad stays live for the
///         flagship and the launches it already made; the site reads both factories.
///         env PRIVATE_KEY (or --sender to simulate).
///         forge script script/DeployPadV2.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast
contract DeployPadV2 is Script {
    // canonical Uniswap v4 on Robinhood Chain (the same singletons Pons uses)
    IPoolManager constant POOL_MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    IPositionManager constant POSITION_MANAGER = IPositionManager(0x58daec3116aae6D93017bAAea7749052E8a04fA7);
    IAllowanceTransfer constant PERMIT2 = IAllowanceTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    // Stacc Wizards fee fanout on Robinhood Chain
    address constant WIZARDS = 0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8;
    // forge's default CREATE2 deployer, present on Robinhood
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    // the $SQUARE stake pool: the settler's staked half lands here as WETH
    address constant POOL = 0x78CD5692961cd0dc9bC15327BF34cDc1bCdca41C;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    // the scooper's venue adapters, in the order they are tried
    address constant PONS_CURVE_VENUE = 0xF1d2139F65887E9d569667e721A11a0095d4CA43;
    address constant V4_VENUE = 0x27Fa6fc87356935f4AF916B4189FC088968cDDa2;
    address constant UNIV3_VENUE = 0xB76aECc481ec4A52a9B3a2B0E45332c70d64F437;
    address constant UNIV2_VENUE = 0x21E13C4D490657bE203BB74590e32AfC56bf82b5;

    function run() external {
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        address owner = pk == 0 ? msg.sender : vm.addr(pk);

        // 1. mine a hook salt off-chain: beforeInitialize | afterSwap | afterSwapReturnDelta
        uint160 flags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        // the escrow has no constructor args, so its address is the deployer's next nonce: predict it
        address escrowAddr = vm.computeCreateAddress(owner, vm.getNonce(owner));
        bytes memory hookInit = abi.encodePacked(
            type(PonsV2MemeHook).creationCode, abi.encode(POOL_MANAGER, escrowAddr, WIZARDS, owner)
        );
        bytes32 initHash = keccak256(hookInit);
        bytes32 salt;
        address hookAddr;
        for (uint256 i = 0; i < 500_000; i++) {
            salt = bytes32(i);
            hookAddr = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, salt, initHash)))));
            if (uint160(hookAddr) & Hooks.ALL_HOOK_MASK == flags) break;
        }
        require(uint160(hookAddr) & Hooks.ALL_HOOK_MASK == flags, "no hook salt");
        console.log("hook salt", uint256(salt));

        if (pk == 0) vm.startBroadcast(owner);
        else vm.startBroadcast(pk);

        // 2. core
        PonsV2FeeEscrow escrow = new PonsV2FeeEscrow();
        require(address(escrow) == escrowAddr, "escrow address drift");
        PonsV2MemeHook hook = new PonsV2MemeHook{salt: salt}(POOL_MANAGER, IPonsV2FeeEscrow(address(escrow)), WIZARDS, owner);
        require(address(hook) == hookAddr, "hook address drift");
        PonsV2BuybackVault vault =
            new PonsV2BuybackVault(owner, IPonsV2FeePolicy(address(hook)), IPonsV2FeeEscrow(address(escrow)));
        PonsV2LaunchLocker locker = new PonsV2LaunchLocker(owner, address(POSITION_MANAGER));

        // 3. the settler: every launch's fee lands here in kind; anyone sells it, half burned, half to the pool
        IVenue[] memory venues = new IVenue[](5);
        venues[0] = new SquareVenue(POOL_MANAGER); // a Square launch, on its curve or in its pool
        venues[1] = IVenue(PONS_CURVE_VENUE);
        venues[2] = IVenue(V4_VENUE);
        venues[3] = IVenue(UNIV3_VENUE);
        venues[4] = IVenue(UNIV2_VENUE);
        NativeSettler settler = new NativeSettler(venues, IStakePool(POOL), IWETH(WETH));

        // 4. factory + helpers that need its address
        PonsV2LaunchFactory factory = new PonsV2LaunchFactory(
            owner,
            POOL_MANAGER,
            POSITION_MANAGER,
            PERMIT2,
            locker,
            hook,
            IPonsV2FeeEscrow(address(escrow)),
            vault,
            0, // no launch fee
            address(settler)
        );
        PonsV2GraduationExecutor executor =
            new PonsV2GraduationExecutor(POSITION_MANAGER, PERMIT2, locker, address(factory));
        PonsV2LaunchDeployer deployer = new PonsV2LaunchDeployer(address(factory));

        // 5. wiring
        hook.setFactory(address(factory));
        hook.setBuybackVault(vault);
        vault.setFactory(address(factory));
        locker.setFactory(address(factory));
        factory.setGraduationExecutor(executor);
        factory.setLaunchDeployer(deployer);
        // Pons's native launch economics: 1e27 supply, 1% curve fee, 1.68 ETH phantom, 4.2 ETH to graduate,
        // 0-fee v4 pool (the hook charges its own 1%), tick spacing 200
        factory.addLaunchConfig(
            PonsV2LaunchFactory.LaunchConfig({
                supply: 1_000_000_000 ether,
                curveFeeBps: 100,
                phantomQuote: 1.68 ether,
                graduationThreshold: 4.2 ether,
                poolFee: 0,
                tickSpacing: 200,
                enabled: true
            })
        );
        factory.setLaunchEnabled(true);

        vm.stopBroadcast();

        console.log("escrow   ", address(escrow));
        console.log("hook     ", address(hook));
        console.log("vault    ", address(vault));
        console.log("locker   ", address(locker));
        console.log("squareVenue", address(venues[0]));
        console.log("settler  ", address(settler));
        console.log("factory  ", address(factory));
        console.log("executor ", address(executor));
        console.log("deployer ", address(deployer));
        console.log("guard    ", address(factory.graduationGuard()));

        string memory j = "d";
        vm.serializeAddress(j, "escrow", address(escrow));
        vm.serializeAddress(j, "hook", address(hook));
        vm.serializeAddress(j, "vault", address(vault));
        vm.serializeAddress(j, "locker", address(locker));
        vm.serializeAddress(j, "squareVenue", address(venues[0]));
        vm.serializeAddress(j, "settler", address(settler));
        vm.serializeAddress(j, "factory", address(factory));
        vm.serializeAddress(j, "executor", address(executor));
        vm.serializeAddress(j, "launchDeployer", address(deployer));
        vm.serializeAddress(j, "tokenDeployer", address(deployer.tokenDeployer()));
        vm.serializeUint(j, "deployBlock", block.number);
        string memory out = vm.serializeAddress(j, "guard", address(factory.graduationGuard()));
        vm.writeJson(out, "./app/src/deployments/4663-v2.json");
    }
}
