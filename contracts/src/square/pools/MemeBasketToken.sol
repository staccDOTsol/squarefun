// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ReferenceFeeERC20V2} from "./ReferenceFeeERC20V2.sol";
import {TokenMetadata} from "./SquarePoolsToken.sol";

/// @notice One NFT: a collection and an id.
struct BasketItem {
    address collection;
    uint256 id;
}

/// @title MemeBasketToken: a meme token with NFTs inside it.
/// @notice Somebody puts up a basket of NFTs, up to 64 from any collections, and launches a token
///         through Uniswap's Liquidity Launcher (pools.xyz). The whole supply goes single-sided into
///         the pool; the NFTs go into this contract. Every token is a share of the basket:
///         R = NFTs held, S = supply, and one NFT costs `unit() = S / R` tokens.
///
///         Once redemptions open, anyone holding a unit can take an NFT out:
///         - `pull`: a random one, at exactly a unit. The id comes from a block hash that does not
///           exist yet when the pull is made, and anyone can settle it a block later.
///         - `pick`: the one you want, at a unit plus a premium. The premium is a fee: it goes to the
///           settler, which sells it for native and stakes all of it, like every other fee.
///         Redeemed units are burned, so S and R fall together and a unit stays a unit.
///
///         An NFT that was in the launch basket can always come back: `deposit` mints a unit for it,
///         rounded down. Nothing else can come in, so the basket is only ever the launch set.
///
///         The token carries the reference fee (see ReferenceFeeERC20V2). Redeeming, depositing and
///         the escrow of a pull are the basket's own moves and are not references.
contract MemeBasketToken is ReferenceFeeERC20V2, ReentrancyGuard {
    uint256 public constant MAX_ITEMS = 64;
    uint256 public constant MAX_PICK_PREMIUM_BPS = 5_000;
    uint256 public constant MAX_REDEEM_DELAY = 30 days;

    /// @notice The chain block this token was created in. Transfers in it are not references: the launch
    ///         moves the supply several times and the venues that make those moves check exact amounts.
    uint64 public immutable birthBlock;
    /// @notice Who asked the factory for this token (the launcher).
    address public immutable creator;
    /// @notice The launcher's tag for the original creator.
    bytes32 public immutable graffiti;

    TokenMetadata public metadata;

    /// @notice When redemptions open. Deposits are open from launch.
    uint64 public immutable redeemOpensAt;
    /// @notice Extra share of a unit, in bps, to choose which NFT comes out.
    uint16 public immutable pickPremiumBps;
    /// @notice How many NFTs the basket was launched with.
    uint256 public immutable launchCount;

    BasketItem[] private _items;
    /// @dev keccak256(collection, id) => index in `_items` + 1, or 0 when not held
    mapping(bytes32 => uint256) private _slot;
    /// @notice Whether an NFT was in the launch basket, and so may be deposited.
    mapping(bytes32 => bool) public inLaunchBasket;
    /// @notice The unit when the basket last held something: what a deposit into an empty basket mints.
    uint256 public lastUnit;

    struct Pull {
        address owner;
        address receiver;
        uint64 commitBlock;
        bool settled;
        uint256 escrow;
    }

    mapping(uint256 => Pull) public pulls;
    uint256 public pullCount;
    uint256[] private _open;

    event Deposited(
        address indexed from, address indexed collection, uint256 indexed id, address receiver, uint256 minted
    );
    event Redeemed(
        address indexed from,
        address indexed collection,
        uint256 indexed id,
        address receiver,
        uint256 burned,
        uint256 premium
    );
    event Pulled(uint256 indexed pullId, address indexed owner, address receiver, uint256 escrow, uint256 commitBlock);
    event Revealed(uint256 indexed pullId, address indexed collection, uint256 indexed id, bool refunded);

    error BadBasket();
    error BadConfig();
    error NotInBasket();
    error NotInLaunchBasket();
    error AlreadyHeld();
    error Closed();
    error Empty();
    error NotYet();
    error AlreadySettled();
    error BadReceiver();

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 supply_,
        address recipient_,
        address settler_,
        address creator_,
        bytes32 graffiti_,
        TokenMetadata memory metadata_,
        BasketItem[] memory items_,
        uint64 redeemDelay_,
        uint16 pickPremiumBps_
    ) ERC20(name_, symbol_) ReferenceFeeERC20V2(settler_) {
        if (items_.length == 0 || items_.length > MAX_ITEMS) revert BadBasket();
        if (redeemDelay_ > MAX_REDEEM_DELAY || pickPremiumBps_ > MAX_PICK_PREMIUM_BPS) revert BadConfig();
        for (uint256 i; i < items_.length; ++i) {
            bytes32 k = _key(items_[i].collection, items_[i].id);
            if (inLaunchBasket[k]) revert BadBasket();
            inLaunchBasket[k] = true;
            _items.push(items_[i]);
            _slot[k] = _items.length;
        }
        birthBlock = _blockNumber();
        creator = creator_;
        graffiti = graffiti_;
        metadata = metadata_;
        _mint(recipient_, supply_);
        launchCount = items_.length;
        redeemOpensAt = uint64(block.timestamp) + redeemDelay_;
        pickPremiumBps = pickPremiumBps_;
        lastUnit = supply_ / items_.length;
    }

    // ------------------------------------------------------------------ views

    /// @notice NFTs in the basket now.
    function held() public view returns (uint256) {
        return _items.length;
    }

    function itemAt(uint256 index) external view returns (BasketItem memory) {
        return _items[index];
    }

    /// @notice Everything in the basket now, in no particular order.
    function items() external view returns (BasketItem[] memory) {
        return _items;
    }

    function holds(address collection, uint256 id) public view returns (bool) {
        return _slot[_key(collection, id)] != 0;
    }

    /// @notice Tokens one NFT costs to take out: S / R, rounded up.
    function unit() public view returns (uint256) {
        uint256 r = _items.length;
        if (r == 0) return lastUnit;
        return (totalSupply() + r - 1) / r;
    }

    /// @notice Tokens one NFT mints on the way in: S / R, rounded down, so a deposit never dilutes.
    function mintUnit() public view returns (uint256) {
        uint256 r = _items.length;
        if (r == 0) return lastUnit;
        return totalSupply() / r;
    }

    /// @notice What `pick` costs: a unit and the premium.
    function pickCost() public view returns (uint256 total, uint256 premium) {
        uint256 u = unit();
        premium = (u * pickPremiumBps) / 10_000;
        total = u + premium;
    }

    function openPulls() external view returns (uint256[] memory) {
        return _open;
    }

    // ------------------------------------------------------------------ in

    /// @notice Put an NFT from the launch basket back and receive a unit. Approve this contract on the collection first.
    function deposit(address collection, uint256 id, address receiver) external nonReentrant returns (uint256 minted) {
        if (receiver == address(0)) revert BadReceiver();
        _settleDue();
        bytes32 k = _key(collection, id);
        if (!inLaunchBasket[k]) revert NotInLaunchBasket();
        if (_slot[k] != 0) revert AlreadyHeld();
        minted = mintUnit();
        IERC721(collection).transferFrom(msg.sender, address(this), id);
        _items.push(BasketItem(collection, id));
        _slot[k] = _items.length;
        _mint(receiver, minted);
        emit Deposited(msg.sender, collection, id, receiver, minted);
    }

    // ------------------------------------------------------------------ out

    /// @notice Take the NFT you want: a unit is burned and the premium is paid to the settler.
    function pick(address collection, uint256 id, address receiver) external nonReentrant {
        if (receiver == address(0)) revert BadReceiver();
        if (block.timestamp < redeemOpensAt) revert Closed();
        _settleDue();
        bytes32 k = _key(collection, id);
        if (_slot[k] == 0) revert NotInBasket();
        (uint256 total, uint256 premium) = pickCost();
        uint256 burned = total - premium;
        _burn(msg.sender, burned);
        if (premium != 0) ERC20._update(msg.sender, beneficiary(), premium);
        _takeOut(k, collection, id, receiver);
        emit Redeemed(msg.sender, collection, id, receiver, burned, premium);
    }

    /// @notice Take a random NFT for exactly a unit. The unit is held here now; the NFT is chosen by the hash of
    ///         the next block, which nobody knows yet, and anyone can settle it once that block is behind us.
    function pull(address receiver) external nonReentrant returns (uint256 pullId) {
        if (receiver == address(0)) revert BadReceiver();
        if (block.timestamp < redeemOpensAt) revert Closed();
        _settleDue();
        if (_items.length <= _open.length) revert Empty();
        uint256 cost = unit();
        ERC20._update(msg.sender, address(this), cost);
        pullId = ++pullCount;
        pulls[pullId] = Pull(msg.sender, receiver, uint64(block.number), false, cost);
        _open.push(pullId);
        emit Pulled(pullId, msg.sender, receiver, cost, block.number);
    }

    /// @notice Settle a pull. Anyone may call, once the commit block's successor exists.
    function reveal(uint256 pullId) external nonReentrant {
        _reveal(pullId);
    }

    /// @dev Every entry point first settles pulls that are due, so nobody can leave a pull open waiting for a
    ///      block hash they like better: the next person to touch the basket closes it.
    function _settleDue() private {
        for (uint256 i; i < 4 && _open.length != 0; ++i) {
            uint256 id = _open[_open.length - 1];
            if (block.number <= uint256(pulls[id].commitBlock) + 1) break;
            _reveal(id);
        }
    }

    function _reveal(uint256 pullId) private {
        Pull storage p = pulls[pullId];
        if (p.owner == address(0) || p.settled) revert AlreadySettled();
        if (block.number <= uint256(p.commitBlock) + 1) revert NotYet();
        p.settled = true;
        _dropOpen(pullId);
        if (_items.length == 0) {
            ERC20._update(address(this), p.owner, p.escrow);
            emit Revealed(pullId, address(0), 0, true);
            return;
        }
        bytes32 h = blockhash(uint256(p.commitBlock) + 1);
        // more than 256 blocks late the hash is gone; the newest one stands in. Pulls are settled by the next
        // person to touch the basket and by the keeper, so this is the rare case, not a lever.
        if (h == bytes32(0)) h = blockhash(block.number - 1);
        BasketItem memory it = _items[uint256(keccak256(abi.encode(h, pullId, address(this)))) % _items.length];
        // S / R only rises between commit and reveal if someone deposited, and a deposit mints the floor, so the
        // unit can move by a rounding wei either way: burn what was escrowed, up to today's unit, refund the rest
        uint256 u = unit();
        uint256 burned = u < p.escrow ? u : p.escrow;
        _burn(address(this), burned);
        if (p.escrow > burned) ERC20._update(address(this), p.owner, p.escrow - burned);
        _takeOut(_key(it.collection, it.id), it.collection, it.id, p.receiver);
        emit Redeemed(p.owner, it.collection, it.id, p.receiver, burned, 0);
        emit Revealed(pullId, it.collection, it.id, false);
    }

    /// @dev Remove from the basket and send. Plain transferFrom: a receiver cannot make a settlement revert.
    function _takeOut(bytes32 k, address collection, uint256 id, address receiver) private {
        uint256 i = _slot[k] - 1;
        uint256 last = _items.length - 1;
        if (i != last) {
            BasketItem memory moved = _items[last];
            _items[i] = moved;
            _slot[_key(moved.collection, moved.id)] = i + 1;
        }
        _items.pop();
        delete _slot[k];
        if (_items.length != 0) lastUnit = totalSupply() / _items.length;
        IERC721(collection).transferFrom(address(this), receiver, id);
    }

    function _dropOpen(uint256 pullId) private {
        uint256 n = _open.length;
        for (uint256 i; i < n; ++i) {
            if (_open[i] == pullId) {
                _open[i] = _open[n - 1];
                _open.pop();
                return;
            }
        }
    }

    // ------------------------------------------------------------------ the rule

    /// @dev The basket's own moves (escrow and refund of a pull) are not references.
    function _counted(address from, address to) internal view override returns (bool) {
        return super._counted(from, to) && from != address(this) && to != address(this) && _blockNumber() != birthBlock;
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

    function _key(address collection, uint256 id) internal pure returns (bytes32) {
        return keccak256(abi.encode(collection, id));
    }
}
