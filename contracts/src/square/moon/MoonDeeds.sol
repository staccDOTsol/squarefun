// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC721Like {
    function transferFrom(address from, address to, uint256 id) external;
    function safeTransferFrom(address from, address to, uint256 id) external;
    function tokenURI(uint256 id) external view returns (string memory);
}

interface IERC1155Like {
    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external;
    function uri(uint256 id) external view returns (string memory);
}

interface IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4);
}

/// @title MoonDeeds: the Ethereum side. A wrapped lunar-registry NFT for every MoonJar drop.
/// @notice The steward buys the parcel a drop names, receives the registry's NFT (ERC-721 or
///         ERC-1155), and wraps it here to the drop's winner: deed id = drop id on Robinhood.
///         Each id can be wrapped once. The holder can unwrap at any time to take the registry's
///         NFT itself. A drop id with no deed here is a drop the steward has not delivered.
///
///         A registry deed is a novelty certificate; it confers no property right on the moon.
contract MoonDeeds {
    struct Wrapped {
        address collection;
        uint256 id;
        uint256 amount; // 0 = ERC-721
        string parcel;
    }

    string public constant name = "Moon Deed";
    string public constant symbol = "MOONDEED";

    address public steward;
    mapping(uint256 => Wrapped) public wrapped;
    /// @dev Set once a drop id has been wrapped, so an unwrapped id cannot be wrapped again.
    mapping(uint256 => bool) public delivered;

    mapping(uint256 => address) private _ownerOf;
    mapping(address => uint256) private _balanceOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    event Transfer(address indexed from, address indexed to, uint256 indexed id);
    event Approval(address indexed owner, address indexed spender, uint256 indexed id);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event Wrap(uint256 indexed dropId, address indexed winner, address collection, uint256 id, uint256 amount, string parcel);
    event Unwrap(uint256 indexed dropId, address indexed to);

    error NotSteward();
    error NotHolder();
    error Delivered();
    error NotMinted();
    error Unauthorized();
    error UnsafeRecipient();

    constructor(address steward_) {
        steward = steward_;
    }

    // ---- deeds ----

    /// @notice Wrap a registry NFT the steward holds to `winner` as deed `dropId`. amount 0 = ERC-721.
    function wrap(uint256 dropId, address winner, address collection, uint256 id, uint256 amount, string calldata parcel)
        external
    {
        if (msg.sender != steward) revert NotSteward();
        if (delivered[dropId]) revert Delivered();
        if (winner == address(0)) revert UnsafeRecipient();
        delivered[dropId] = true;
        wrapped[dropId] = Wrapped(collection, id, amount, parcel);
        if (amount == 0) IERC721Like(collection).transferFrom(msg.sender, address(this), id);
        else IERC1155Like(collection).safeTransferFrom(msg.sender, address(this), id, amount, "");
        _ownerOf[dropId] = winner;
        unchecked {
            _balanceOf[winner]++;
        }
        emit Transfer(address(0), winner, dropId);
        emit Wrap(dropId, winner, collection, id, amount, parcel);
    }

    /// @notice Burn the deed and take the registry's NFT.
    function unwrap(uint256 dropId, address to) external {
        if (_ownerOf[dropId] != msg.sender) revert NotHolder();
        Wrapped memory w = wrapped[dropId];
        delete wrapped[dropId];
        delete _ownerOf[dropId];
        delete getApproved[dropId];
        unchecked {
            _balanceOf[msg.sender]--;
        }
        emit Transfer(msg.sender, address(0), dropId);
        if (w.amount == 0) IERC721Like(w.collection).safeTransferFrom(address(this), to, w.id);
        else IERC1155Like(w.collection).safeTransferFrom(address(this), to, w.id, w.amount, "");
        emit Unwrap(dropId, to);
    }

    /// @notice The registry NFT's own metadata.
    function tokenURI(uint256 dropId) external view returns (string memory) {
        if (_ownerOf[dropId] == address(0)) revert NotMinted();
        Wrapped memory w = wrapped[dropId];
        if (w.amount == 0) return IERC721Like(w.collection).tokenURI(w.id);
        return IERC1155Like(w.collection).uri(w.id);
    }

    function handOver(address steward_) external {
        if (msg.sender != steward) revert NotSteward();
        steward = steward_;
    }

    // ---- ERC-721 ----

    function ownerOf(uint256 id) public view returns (address owner) {
        if ((owner = _ownerOf[id]) == address(0)) revert NotMinted();
    }

    function balanceOf(address owner) external view returns (uint256) {
        return _balanceOf[owner];
    }

    function approve(address spender, uint256 id) external {
        address owner = _ownerOf[id];
        if (msg.sender != owner && !isApprovedForAll[owner][msg.sender]) revert Unauthorized();
        getApproved[id] = spender;
        emit Approval(owner, spender, id);
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 id) public {
        if (from != _ownerOf[id]) revert Unauthorized();
        if (to == address(0)) revert UnsafeRecipient();
        if (msg.sender != from && !isApprovedForAll[from][msg.sender] && msg.sender != getApproved[id]) {
            revert Unauthorized();
        }
        unchecked {
            _balanceOf[from]--;
            _balanceOf[to]++;
        }
        _ownerOf[id] = to;
        delete getApproved[id];
        emit Transfer(from, to, id);
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        safeTransferFrom(from, to, id, "");
    }

    function safeTransferFrom(address from, address to, uint256 id, bytes memory data) public {
        transferFrom(from, to, id);
        if (
            to.code.length != 0
                && IERC721Receiver(to).onERC721Received(msg.sender, from, id, data) != IERC721Receiver.onERC721Received.selector
        ) revert UnsafeRecipient();
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 // ERC-165
            || interfaceId == 0x80ac58cd // ERC-721
            || interfaceId == 0x5b5e139f // ERC-721 metadata
            || interfaceId == 0x150b7a02 // ERC-721 receiver
            || interfaceId == 0x4e2312e0; // ERC-1155 receiver
    }

    // ---- receiving the registry's NFT ----

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC1155BatchReceived.selector;
    }
}
