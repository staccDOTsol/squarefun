// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SquarePoolsToken, TokenMetadata} from "./SquarePoolsToken.sol";

/// @title SquarePoolsTokenFactory: a token factory the Liquidity Launcher can call.
/// @notice Uniswap's launcher creates tokens through any factory that answers `createToken`.
///         This one answers with a reference-fee token. Same arguments, same event, same
///         metadata as the UERC20 factory; the settler is fixed here, so every token this
///         factory makes pays its fees to the same place.
contract SquarePoolsTokenFactory {
    /// @notice Where every token made here sends its fees.
    address public immutable settler;

    event TokenCreated(address tokenAddress, TokenMetadata metadata);

    error RecipientCannotBeZeroAddress();
    error TotalSupplyCannotBeZero();
    error DecimalsMustBe18();

    constructor(address settler_) {
        require(settler_ != address(0) && settler_.code.length != 0, "settler");
        settler = settler_;
    }

    function _salt(string memory name, string memory symbol, address creator, bytes32 graffiti)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(name, symbol, uint8(18), creator, graffiti));
    }

    /// @notice The address `createToken` will deploy to for these arguments, called by `creator`
    ///         (the launcher, when the token is created through it).
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
                type(SquarePoolsToken).creationCode,
                abi.encode(name, symbol, initialSupply, recipient, settler, creator, graffiti, metadata)
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

    /// @notice Implements Uniswap's `ITokenFactory.createToken`.
    /// @param data abi-encoded `TokenMetadata` (description, website, image, xProofTweetId)
    function createToken(
        string calldata name,
        string calldata symbol,
        uint8 decimals,
        uint256 initialSupply,
        address recipient,
        bytes calldata data,
        bytes32 graffiti
    ) external returns (address tokenAddress) {
        if (recipient == address(0)) revert RecipientCannotBeZeroAddress();
        if (initialSupply == 0) revert TotalSupplyCannotBeZero();
        if (decimals != 18) revert DecimalsMustBe18();
        TokenMetadata memory metadata = abi.decode(data, (TokenMetadata));
        tokenAddress = address(
            new SquarePoolsToken{salt: _salt(name, symbol, msg.sender, graffiti)}(
                name, symbol, initialSupply, recipient, settler, msg.sender, graffiti, metadata
            )
        );
        emit TokenCreated(tokenAddress, metadata);
    }
}
