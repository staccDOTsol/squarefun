// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TokenMetadata} from "../pools/SquarePoolsToken.sol";
import {ContagianLaunchStrategy} from "./ContagianLaunchStrategy.sol";
import {ContagianTokenFactory} from "./ContagianToken.sol";
import {ContagianVault} from "./ContagianVault.sol";

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
}

/// @title ContagianLauncher: launch a Contagian token in one transaction.
/// @notice Contagian is the rule, not a token: a memecoin that tends to its peg. Whoever
///         launches one names two things.
///
///           the memequote  what the token trades against: the other side of its pool, and what
///                          its tolls are sold for and its holders are paid in
///           the peg        what it is trying to be worth one of
///
///         They can be the same (trade against USDG, peg is one USDG) or different (trade
///         against ETH, peg is one USDG). When they differ, parity follows the peg's price in
///         the memequote, read from the pool the launch names.
///
///         The whole supply opens in one position against the memequote, from the price the
///         launch names upward. Open it under parity: under parity sellers pay and buyers do
///         not, over it buyers pay and sellers do not.
///
///         A launch makes a vault (a clone), creates the token through Uniswap's Liquidity
///         Launcher, and hands the supply to the Contagian strategy. No owner, no fee, nothing
///         to configure afterwards.
contract ContagianLauncher {
    uint128 public constant SUPPLY = 1_000_000_000e18;
    int24 public constant TICK_SPACING = 25;

    ILiquidityLauncher public immutable uniswapLauncher;
    ContagianLaunchStrategy public immutable strategy;
    ContagianTokenFactory public immutable tokenFactory;
    /// @notice The vault every launch's vault is a clone of.
    address public immutable vaultImplementation;

    struct Params {
        string name;
        string symbol;
        TokenMetadata metadata;
        /// what the token trades against; address(0) is native ETH
        address quote;
        /// what the token is trying to be worth one of, and the hookless v4 pool of it against
        /// the quote that prices it (`refFee` zero when it is the quote, or a like token of it)
        ContagianVault.Partner peg;
        /// log base 1.0001 of the price the pool opens at and the price the supply runs to, in
        /// quote units per token unit: multiples of 25, the first below the second. Parity is
        /// wherever the peg puts it; open below it, and run the supply past it
        int24 openTick;
        int24 ceilingTick;
        /// what unsold tolls are also offered against. Fixed at launch
        ContagianVault.Partner[] partners;
    }

    struct Launch {
        address token;
        address vault;
        address creator;
        address quote;
        address peg;
        int24 openTick;
        int24 ceilingTick;
        uint64 launchedAt;
    }

    Launch[] public launches;
    mapping(address token => uint256) private _index;

    event Launched(
        address indexed token,
        address indexed vault,
        address indexed creator,
        address quote,
        address peg,
        int24 openTick,
        int24 ceilingTick
    );

    error BadTicks();

    constructor(ILiquidityLauncher uniswapLauncher_, address poolManager_, ContagianLaunchStrategy strategy_, address vault_) {
        uniswapLauncher = uniswapLauncher_;
        strategy = strategy_;
        vaultImplementation = vault_;
        tokenFactory = new ContagianTokenFactory(address(uniswapLauncher_), poolManager_);
    }

    function launch(Params calldata p) external returns (address token, address vault) {
        if (p.openTick >= p.ceilingTick || p.openTick % TICK_SPACING != 0 || p.ceilingTick % TICK_SPACING != 0) {
            revert BadTicks();
        }
        vault = _clone(vaultImplementation);
        ContagianVault(payable(vault)).initialize(p.peg, p.partners, address(tokenFactory));

        bytes memory data = abi.encode(p.metadata, vault);
        token = tokenFactory.getTokenAddress(p.name, p.symbol, SUPPLY, address(uniswapLauncher), data);
        // the pool's own ticks are currency1 per currency0: the other way up when the token sorts second
        bool tokenIs0 = token < p.quote;
        bytes memory config =
            abi.encode(p.quote, tokenIs0 ? p.openTick : -p.openTick, tokenIs0 ? p.ceilingTick : -p.ceilingTick);

        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(
            ILiquidityLauncher.createToken,
            (address(tokenFactory), p.name, p.symbol, 18, SUPPLY, address(uniswapLauncher), data)
        );
        calls[1] = abi.encodeCall(
            ILiquidityLauncher.distributeToken,
            (token, Distribution(address(strategy), SUPPLY, config), bytes32(launches.length))
        );
        uniswapLauncher.multicall(calls);

        _index[token] = launches.length + 1;
        launches.push(
            Launch(token, vault, msg.sender, p.quote, p.peg.asset, p.openTick, p.ceilingTick, uint64(block.timestamp))
        );
        emit Launched(token, vault, msg.sender, p.quote, p.peg.asset, p.openTick, p.ceilingTick);
    }

    /// @dev An EIP-1167 minimal proxy to `implementation`.
    function _clone(address implementation) private returns (address instance) {
        assembly ("memory-safe") {
            mstore(0x00, or(shr(0xe8, shl(0x60, implementation)), 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000))
            mstore(0x20, or(shl(0x78, implementation), 0x5af43d82803e903d91602b57fd5bf3))
            instance := create(0, 0x09, 0x37)
        }
        require(instance != address(0), "clone");
    }

    function count() external view returns (uint256) {
        return launches.length;
    }

    /// @notice The launch a token came from. Reverts for a token this launcher did not make.
    function launchOf(address token) external view returns (Launch memory) {
        return launches[_index[token] - 1];
    }
}
