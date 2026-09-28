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
import {Square} from "../contracts/src/square/Square.sol";
import {SquareSink} from "../contracts/src/square/SquareSink.sol";

/// @title DeploySquare: the whole launchpad on Robinhood Chain (4663), wired and enabled.
/// @notice env PRIVATE_KEY (deployer = owner of hook, vault, locker, factory).
///         forge script script/DeploySquare.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast
contract DeploySquare is Script {
    // canonical Uniswap v4 on Robinhood Chain (the same singletons Pons uses)
    IPoolManager constant POOL_MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    IPositionManager constant POSITION_MANAGER = IPositionManager(0x58daec3116aae6D93017bAAea7749052E8a04fA7);
    IAllowanceTransfer constant PERMIT2 = IAllowanceTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    // Stacc Wizards fee fanout on Robinhood Chain
    address constant WIZARDS = 0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8;
    // forge's default CREATE2 deployer, present on Robinhood
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    uint256 constant SQUARE_SUPPLY = 1_000_000_000 ether;
    uint256 constant WIZARDS_BPS = 2_000;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address owner = vm.addr(pk);

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

        vm.startBroadcast(pk);

        // 2. core
        PonsV2FeeEscrow escrow = new PonsV2FeeEscrow();
        require(address(escrow) == escrowAddr, "escrow address drift");
        PonsV2MemeHook hook = new PonsV2MemeHook{salt: salt}(POOL_MANAGER, IPonsV2FeeEscrow(address(escrow)), WIZARDS, owner);
        require(address(hook) == hookAddr, "hook address drift");
        PonsV2BuybackVault vault =
            new PonsV2BuybackVault(owner, IPonsV2FeePolicy(address(hook)), IPonsV2FeeEscrow(address(escrow)));
        PonsV2LaunchLocker locker = new PonsV2LaunchLocker(owner, address(POSITION_MANAGER));

        // 3. the pad token and its sink: every launch's reference beneficiary
        SquareSink sink = new SquareSink(WIZARDS, WIZARDS_BPS);
        Square square = new Square(address(sink), owner, SQUARE_SUPPLY);
        sink.setSquare(address(square));

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
            address(sink)
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
        console.log("sink     ", address(sink));
        console.log("square   ", address(square));
        console.log("factory  ", address(factory));
        console.log("executor ", address(executor));
        console.log("deployer ", address(deployer));
        console.log("guard    ", address(factory.graduationGuard()));

        string memory j = "d";
        vm.serializeUint(j, "chainId", block.chainid);
        vm.serializeAddress(j, "escrow", address(escrow));
        vm.serializeAddress(j, "hook", address(hook));
        vm.serializeAddress(j, "vault", address(vault));
        vm.serializeAddress(j, "locker", address(locker));
        vm.serializeAddress(j, "sink", address(sink));
        vm.serializeAddress(j, "square", address(square));
        vm.serializeAddress(j, "factory", address(factory));
        vm.serializeAddress(j, "executor", address(executor));
        vm.serializeAddress(j, "launchDeployer", address(deployer));
        vm.serializeAddress(j, "poolManager", address(POOL_MANAGER));
        vm.serializeAddress(j, "positionManager", address(POSITION_MANAGER));
        vm.serializeAddress(j, "permit2", address(PERMIT2));
        vm.serializeAddress(j, "wizards", WIZARDS);
        vm.serializeUint(j, "deployBlock", block.number);
        string memory out = vm.serializeAddress(j, "owner", owner);
        vm.writeJson(out, "./app/src/deployments/4663.json");
    }
}
