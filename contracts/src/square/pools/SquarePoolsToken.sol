// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ReferenceFeeERC20} from "../../v2/ReferenceFeeERC20.sol";

/// @dev The metadata Uniswap's UERC20 carries, field for field, so that anything reading a
///      token launched through the Liquidity Launcher reads this one the same way.
struct TokenMetadata {
    string description;
    string website;
    string image;
    uint256 xProofTweetId;
}

/// @title SquarePoolsToken: a reference-fee token for Uniswap's Liquidity Launcher.
/// @notice Fixed supply, no owner, no mint, no switch. The rule is the one every Square launch
///         carries (two ratchets, fee in kind to a settler that sells for ETH and stakes all of
///         it). The token is born inside a launch: the launcher creates it, hands the supply to a
///         strategy, the strategy hands it to the position manager and the position manager to
///         the pool manager, all in one transaction. Those moves are the token's plumbing, not
///         references, and the venues that make them check that they received exactly what was
///         sent. So nothing counts in the block the token is born in. From the next block on
///         everything does.
contract SquarePoolsToken is ReferenceFeeERC20 {
    /// @notice The chain block this token was created in. Transfers in it are not references.
    uint64 public immutable birthBlock;
    /// @notice Who asked the factory for this token.
    address public immutable creator;
    /// @notice The launcher's tag for the original creator, as UERC20 exposes it.
    bytes32 public immutable graffiti;

    TokenMetadata public metadata;

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 supply_,
        address recipient_,
        address settler_,
        address creator_,
        bytes32 graffiti_,
        TokenMetadata memory metadata_
    ) ERC20(name_, symbol_) ReferenceFeeERC20(settler_) {
        birthBlock = _blockNumber();
        creator = creator_;
        graffiti = graffiti_;
        metadata = metadata_;
        _mint(recipient_, supply_);
    }

    function _counted(address from, address to) internal view override returns (bool) {
        return super._counted(from, to) && _blockNumber() != birthBlock;
    }

    /// @notice The metadata as a base64 JSON data URI, in UERC20's format.
    function tokenURI() external view returns (string memory) {
        TokenMetadata memory m = metadata;
        bytes memory json = "{";
        bool any;
        if (bytes(m.description).length != 0) {
            json = abi.encodePacked(json, '"description":"', _escape(m.description), '"');
            any = true;
        }
        if (bytes(m.website).length != 0) {
            json = abi.encodePacked(json, any ? ", " : "", '"website":"', _escape(m.website), '"');
            any = true;
        }
        if (bytes(m.image).length != 0) {
            json = abi.encodePacked(json, any ? ", " : "", '"image":"', _escape(m.image), '"');
        }
        return string(abi.encodePacked("data:application/json;base64,", _base64(abi.encodePacked(json, "}"))));
    }

    /// @dev Escape what JSON requires inside a string: quote, backslash and control characters.
    function _escape(string memory s) private pure returns (bytes memory out) {
        bytes memory b = bytes(s);
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            if (c == '"' || c == "\\") out = abi.encodePacked(out, "\\", c);
            else if (c == "\n") out = abi.encodePacked(out, "\\n");
            else if (uint8(c) < 0x20) out = abi.encodePacked(out, " ");
            else out = abi.encodePacked(out, c);
        }
    }

    bytes private constant TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    function _base64(bytes memory data) private pure returns (bytes memory out) {
        bytes memory table = TABLE;
        uint256 len = data.length;
        out = new bytes(4 * ((len + 2) / 3));
        uint256 j;
        for (uint256 i = 0; i < len; i += 3) {
            uint256 a = uint8(data[i]);
            uint256 b = i + 1 < len ? uint8(data[i + 1]) : 0;
            uint256 c = i + 2 < len ? uint8(data[i + 2]) : 0;
            uint256 n = (a << 16) | (b << 8) | c;
            out[j++] = table[(n >> 18) & 63];
            out[j++] = table[(n >> 12) & 63];
            out[j++] = i + 1 < len ? table[(n >> 6) & 63] : bytes1("=");
            out[j++] = i + 2 < len ? table[n & 63] : bytes1("=");
        }
    }
}
