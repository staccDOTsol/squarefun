// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TokenMetadata} from "../pools/SquarePoolsToken.sol";
import {MoonToken} from "./MoonToken.sol";

/// @title MoonTokenFactory: one MoonToken for one MoonJar, created through Uniswap's Liquidity Launcher.
/// @notice Same `createToken` / `getTokenAddress` as SquarePoolsTokenFactoryV2, but it makes exactly one
///         token, so a jar never serves two.
contract MoonTokenFactory {
    address public immutable jar;
    address public immutable poolManager;
    uint256 public immutable buyFeeBps;
    address public made;

    event TokenCreated(address tokenAddress, TokenMetadata metadata);

    error AlreadyMade();
    error RecipientCannotBeZeroAddress();
    error TotalSupplyCannotBeZero();
    error DecimalsMustBe18();

    constructor(address jar_, address poolManager_, uint256 buyFeeBps_) {
        require(jar_ != address(0) && jar_.code.length != 0, "jar");
        require(poolManager_.code.length != 0, "manager");
        jar = jar_;
        poolManager = poolManager_;
        buyFeeBps = buyFeeBps_;
    }

    function _salt(string memory name, string memory symbol, address creator, bytes32 graffiti)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(name, symbol, uint8(18), creator, graffiti));
    }

    function getTokenAddress(
        string calldata name,
        string calldata symbol,
        uint256 initialSupply,
        address recipient,
        bytes calldata data,
        address creator,
        bytes32 graffiti
    ) external view returns (address) {
        TokenMetadata memory metadata = abi.decode(data, (TokenMetadata));
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(MoonToken).creationCode,
                abi.encode(name, symbol, initialSupply, recipient, jar, creator, graffiti, metadata, poolManager, buyFeeBps)
            )
        );
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(bytes1(0xff), address(this), _salt(name, symbol, creator, graffiti), initCodeHash)
                    )
                )
            )
        );
    }

    /// @notice Implements Uniswap's `ITokenFactory.createToken`. Once.
    function createToken(
        string calldata name,
        string calldata symbol,
        uint8 decimals,
        uint256 initialSupply,
        address recipient,
        bytes calldata data,
        bytes32 graffiti
    ) external returns (address tokenAddress) {
        if (made != address(0)) revert AlreadyMade();
        if (recipient == address(0)) revert RecipientCannotBeZeroAddress();
        if (initialSupply == 0) revert TotalSupplyCannotBeZero();
        if (decimals != 18) revert DecimalsMustBe18();
        TokenMetadata memory metadata = abi.decode(data, (TokenMetadata));
        tokenAddress = address(
            new MoonToken{salt: _salt(name, symbol, msg.sender, graffiti)}(
                name, symbol, initialSupply, recipient, jar, msg.sender, graffiti, metadata, poolManager, buyFeeBps
            )
        );
        made = tokenAddress;
        emit TokenCreated(tokenAddress, metadata);
    }
}
