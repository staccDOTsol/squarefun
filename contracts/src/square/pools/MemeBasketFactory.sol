// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {TokenMetadata} from "./SquarePoolsToken.sol";
import {MemeBasketToken, BasketItem} from "./MemeBasketToken.sol";

interface ILauncherGraffiti {
    function getGraffiti(address originalCreator) external pure returns (bytes32);
}

/// @title MemeBasketFactory: launch a meme token with your NFTs inside it, through pools.xyz.
/// @notice Two steps. `stage` holds your NFTs here, filed under the tag Uniswap's Liquidity Launcher gives you.
///         Then you call the launcher's multicall yourself: `createToken` with this factory, and
///         `distributeToken` to its instant strategy. The launcher calls `createToken` here with your tag; the
///         token is born with your staged NFTs inside it and the whole supply goes into the pool. Nobody else
///         can launch with your NFTs, because nobody else gets your tag, and `unstage` gives them back any
///         time before you launch.
contract MemeBasketFactory is ReentrancyGuard {
    /// @notice Uniswap's Liquidity Launcher: the only caller of `createToken`.
    address public immutable launcher;
    /// @notice Where every token made here sends its fees.
    address public immutable settler;

    mapping(bytes32 => BasketItem[]) private _staged;

    event Staged(address indexed owner, bytes32 indexed graffiti, address indexed collection, uint256 id);
    event Unstaged(address indexed owner, bytes32 indexed graffiti, uint256 count);
    event TokenCreated(address tokenAddress, TokenMetadata metadata);
    event BasketLaunched(
        address indexed token, bytes32 indexed graffiti, uint256 count, uint64 redeemOpensAt, uint16 pickPremiumBps
    );

    error OnlyLauncher();
    error NothingStaged();
    error TooMany();
    error RecipientCannotBeZeroAddress();
    error TotalSupplyCannotBeZero();
    error DecimalsMustBe18();

    constructor(address launcher_, address settler_) {
        require(launcher_.code.length != 0 && settler_.code.length != 0, "addr");
        launcher = launcher_;
        settler = settler_;
    }

    /// @notice The tag the launcher will give `owner`.
    function graffitiOf(address owner) public view returns (bytes32) {
        return ILauncherGraffiti(launcher).getGraffiti(owner);
    }

    /// @notice What `owner` has staged.
    function stagedBy(address owner) external view returns (BasketItem[] memory) {
        return _staged[graffitiOf(owner)];
    }

    /// @notice Hold these NFTs for your launch. Approve this factory on each collection first. Can be called
    ///         more than once; the basket is everything staged when you launch, at most 64.
    function stage(BasketItem[] calldata items) external nonReentrant {
        bytes32 g = graffitiOf(msg.sender);
        BasketItem[] storage s = _staged[g];
        if (s.length + items.length > 64) revert TooMany();
        for (uint256 i; i < items.length; ++i) {
            IERC721(items[i].collection).transferFrom(msg.sender, address(this), items[i].id);
            s.push(items[i]);
            emit Staged(msg.sender, g, items[i].collection, items[i].id);
        }
    }

    /// @notice Give back everything you staged.
    function unstage() external nonReentrant {
        bytes32 g = graffitiOf(msg.sender);
        BasketItem[] memory s = _staged[g];
        delete _staged[g];
        for (uint256 i; i < s.length; ++i) {
            IERC721(s[i].collection).transferFrom(address(this), msg.sender, s[i].id);
        }
        emit Unstaged(msg.sender, g, s.length);
    }

    /// @notice abi.encode(TokenMetadata, uint64 redeemDelay, uint16 pickPremiumBps)
    function decodeData(bytes calldata data) public pure returns (TokenMetadata memory, uint64, uint16) {
        return abi.decode(data, (TokenMetadata, uint64, uint16));
    }

    function _salt(string memory name, string memory symbol, address creator, bytes32 graffiti)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(name, symbol, uint8(18), creator, graffiti));
    }

    function _initCode(
        string memory name,
        string memory symbol,
        uint256 initialSupply,
        address recipient,
        address creator,
        bytes32 graffiti,
        TokenMetadata memory metadata,
        BasketItem[] memory items,
        uint64 delay,
        uint16 premium
    ) private view returns (bytes memory) {
        return abi.encodePacked(
            type(MemeBasketToken).creationCode,
            abi.encode(
                name, symbol, initialSupply, recipient, settler, creator, graffiti, metadata, items, delay, premium
            )
        );
    }

    /// @notice The address `createToken` will deploy to, for the basket staged under `graffiti` right now.
    function getTokenAddress(
        string calldata name,
        string calldata symbol,
        uint256 initialSupply,
        address recipient,
        bytes calldata data,
        address creator,
        bytes32 graffiti
    ) external view returns (address) {
        (TokenMetadata memory metadata, uint64 delay, uint16 premium) = decodeData(data);
        bytes32 h = keccak256(
            _initCode(
                name, symbol, initialSupply, recipient, creator, graffiti, metadata, _staged[graffiti], delay, premium
            )
        );
        return address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), address(this), _salt(name, symbol, creator, graffiti), h))
                )
            )
        );
    }

    /// @notice Implements Uniswap's `ITokenFactory.createToken`. Only the launcher calls it, with the caller's tag.
    function createToken(
        string calldata name,
        string calldata symbol,
        uint8 decimals,
        uint256 initialSupply,
        address recipient,
        bytes calldata data,
        bytes32 graffiti
    ) external nonReentrant returns (address tokenAddress) {
        if (msg.sender != launcher) revert OnlyLauncher();
        if (recipient == address(0)) revert RecipientCannotBeZeroAddress();
        if (initialSupply == 0) revert TotalSupplyCannotBeZero();
        if (decimals != 18) revert DecimalsMustBe18();
        BasketItem[] memory items = _staged[graffiti];
        if (items.length == 0) revert NothingStaged();
        delete _staged[graffiti];
        (TokenMetadata memory metadata, uint64 delay, uint16 premium) = decodeData(data);
        bytes memory code =
            _initCode(name, symbol, initialSupply, recipient, msg.sender, graffiti, metadata, items, delay, premium);
        bytes32 salt = _salt(name, symbol, msg.sender, graffiti);
        assembly ("memory-safe") {
            tokenAddress := create2(0, add(code, 0x20), mload(code), salt)
        }
        require(tokenAddress != address(0), "create2");
        for (uint256 i; i < items.length; ++i) {
            IERC721(items[i].collection).transferFrom(address(this), tokenAddress, items[i].id);
        }
        emit TokenCreated(tokenAddress, metadata);
        MemeBasketToken t = MemeBasketToken(tokenAddress);
        emit BasketLaunched(tokenAddress, graffiti, items.length, t.redeemOpensAt(), t.pickPremiumBps());
    }
}
