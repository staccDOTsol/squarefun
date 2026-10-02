// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SquarePoolsTokenV2} from "../pools/SquarePoolsTokenV2.sol";
import {TokenMetadata} from "../pools/SquarePoolsToken.sol";

interface IContagianVault {
    /// @notice Sample the market and return the depeg tax this transfer pays, in basis points.
    function poke(bool buy, bool sale, uint256 value) external returns (uint256 bps);
    /// @notice The token this vault is bound to. Zero until its launch has finished.
    function token() external view returns (address);
    /// @notice Enter a toll in the directory against the originator who paid it; returns its worth in the quote.
    function credit(address originator, uint256 amount) external returns (uint256 worth);
    /// @notice After a transfer that is not a sale: do one of the vault's chores and pay one bad beat.
    function chores() external;
    /// @notice Before and after any balance moves: holders are paid by balance, so the vault keeps up with them.
    function holderPre(address a, address b) external;
    function holderPost(address a, address b) external;
}

/// @title ContagianToken: the reference fee, and a tax that keeps a memecoin on its peg.
/// @notice A SquarePoolsTokenV2 whose settler is a ContagianVault. Launched through Uniswap's
///         Liquidity Launcher like every Square token, it carries the same two ratchets, and on
///         top of them the tax the vault prices against parity:
///
///           above parity   a buy pays, a sale does not
///           below parity   a sale pays, a buy does not
///           faster         more
///
///         A buy is any counted transfer out of the Uniswap v4 PoolManager, and pays in kind:
///         the buyer receives less. A sale is any transfer into it, and pays on top: a v4 pool
///         reverts when it receives less than it was owed, so the pool is paid in full and the
///         tax comes out of what the seller has left. (On the tokens before this one a fee on
///         that leg let two free transfers ahead of a sale in its block revert it, for the
///         cost of gas.) So while the sell tax is on, a whole balance cannot be sold: the tax
///         has to be left behind. A sale pays the weekly ratchet but not the per-block one,
///         because other people's transfers raise that. A transfer between anyone else pays
///         whichever side is being crowded.
///
///         What is taken goes to the vault in kind and is entered there against the originator
///         who paid it. Every transfer also gives the vault its sample of the market, after
///         balances have moved, and tells it whose balances moved, because holders are paid
///         by balance.
///
///         The launch moves the supply through the launcher, the strategy and the pool, and
///         those moves must arrive whole, so SquarePoolsTokenV2 counts nothing in the block
///         the token is born in. Here that stops when the launch does.
contract ContagianToken is SquarePoolsTokenV2 {
    /// @notice The depeg tax never takes more than this.
    uint256 public constant TAX_CAP = 5_000;
    /// @dev The most gas a transfer hands the vault for its chores.
    uint256 private constant CHORE_GAS = 900_000;

    /// @notice What a wallet is told every time it pays the tax.
    string public constant GOTCHYA = "Gotchya! You just paid the Contagian tax. "
        "BURN COST: the tokens taken, and their worth in the quote, are in the log beside this note. "
        "WHAT: this token tends to its peg. Push it away (buy over parity, dump under it, or trade like a machine) "
        "and up to half the trade is taken. "
        "HOW: the token took it, and its vault sells it on the way up, never down. "
        "PAYOFF: you are on the list now. Half of everything the tolls sell for is paid to the list, by how much "
        "each wallet was burned, in the quote. The other half goes to holders. "
        "WHEN: your entry starts earning one hour from now, and each sale is paid out over the hour after it. "
        "So you are paid by whoever gets burned after you: no later burns, no payoff. "
        "It is sent to you as it comes; claim() on the vault collects it sooner. Holding is free. "
        "We realign incentives as it is more palatable than redistributing wealth. "
        "x.com/staccoverflow sends his regards.";

    /// @notice The note to a wallet, every time it is burned: what it paid, and what that means.
    event Gotchya(address indexed to, uint256 tolls, uint256 worth, string message);

    /// @notice Uniswap v4's singleton: a transfer out of it is a buy, into it a sale.
    address public immutable poolManager;

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 supply_,
        address recipient_,
        address vault_,
        address creator_,
        bytes32 graffiti_,
        TokenMetadata memory metadata_,
        address poolManager_
    ) SquarePoolsTokenV2(name_, symbol_, supply_, recipient_, vault_, creator_, graffiti_, metadata_) {
        poolManager = poolManager_;
    }

    function _update(address from, address to, uint256 value) internal override {
        address vault = sink();
        IContagianVault(vault).holderPre(from, to);
        bool chore = _move(vault, from, to, value);
        IContagianVault(vault).holderPost(from, to);
        // The vault's chores ride along on transfers. Not on a sale: its payment to the pool
        // is in flight. And never at the transfer's expense: if a chore fails, it is skipped.
        if (chore) try IContagianVault(vault).chores{gas: CHORE_GAS}() {} catch {}
    }

    /// @dev Every toll is entered in the vault's directory, and its payer is told.
    function _burned(address vault, uint256 toll) private {
        uint256 worth = IContagianVault(vault).credit(tx.origin, toll);
        if (worth == 0) return;
        // in the logs, and as a call carrying the text. No gas goes with the call, so a plain
        // wallet receives it and nothing else can run on it.
        emit Gotchya(tx.origin, toll, worth, GOTCHYA);
        (bool delivered,) = tx.origin.call{gas: 0}(bytes(GOTCHYA));
        delivered;
    }

    /// @return chore whether this was a counted transfer that is not a sale
    function _move(address vault, address from, address to, uint256 value) private returns (bool chore) {
        // into the vault is a gift: not a reference
        if (to == vault) {
            ERC20._update(from, to, value);
            return false;
        }
        if (!_counted(from, to)) {
            // plumbing: mint, burn, the vault's own, and the launch until the vault is bound
            if (
                from == address(0) || to == address(0) || from == vault || _blockNumber() != birthBlock
                    || IContagianVault(vault).token() != address(this)
            ) {
                super._update(from, to, value);
                return false;
            }
        }
        if (to == poolManager) {
            (uint256 n,) = _reference(value);
            ERC20._update(from, to, value);
            uint256 rate = IContagianVault(vault).poke(false, true, value);
            uint256 slow = slowFeeBps(referencesThisWindowBy(tx.origin));
            if (slow > rate) rate = slow;
            if (rate > TAX_CAP) rate = TAX_CAP;
            uint256 fee = (value * rate) / BPS;
            if (fee != 0) {
                // on top: the pool has its full amount, the seller pays from what is left
                ERC20._update(from, vault, fee);
                _burned(vault, fee);
            }
            emit Reference(from, to, n, fee);
            return false;
        }
        uint256 before = balanceOf(to);
        uint256 held = balanceOf(vault);
        super._update(from, to, value);
        uint256 bps = IContagianVault(vault).poke(from == poolManager, false, value);
        if (bps > TAX_CAP) bps = TAX_CAP;
        // the ratchet may already have taken more; top up to the depeg tax, never add to it
        uint256 got = balanceOf(to) - before;
        uint256 keep = value - (value * bps) / BPS;
        if (got > keep) ERC20._update(to, vault, got - keep);
        // whoever originated the transaction paid it: the vault keeps the tally
        uint256 toll = balanceOf(vault) - held;
        if (toll != 0) _burned(vault, toll);
        return true;
    }
}

/// @title ContagianTokenFactory: every Contagian token, created through Uniswap's Liquidity Launcher.
/// @notice Implements Uniswap's `ITokenFactory`. The launcher passes the vault the token will
///         serve beside its metadata; a vault gets one token. Only launches that come through
///         the Contagian launcher are accepted (Uniswap's launcher tags each creation with its
///         caller), so nobody can take a vault by creating a token for it first.
contract ContagianTokenFactory {
    address public immutable uniswapLauncher;
    address public immutable poolManager;
    /// @dev Uniswap's tag for a creation made by the Contagian launcher, which deployed this factory.
    bytes32 public immutable graffiti;
    mapping(address vault => address) public madeFor;

    event TokenCreated(address tokenAddress, address vault, TokenMetadata metadata);

    error NotOurLaunch();
    error AlreadyMade();
    error BadToken();

    constructor(address uniswapLauncher_, address poolManager_) {
        uniswapLauncher = uniswapLauncher_;
        poolManager = poolManager_;
        graffiti = keccak256(abi.encode(msg.sender));
    }

    function getTokenAddress(
        string calldata name,
        string calldata symbol,
        uint256 initialSupply,
        address recipient,
        bytes calldata data
    ) external view returns (address) {
        (TokenMetadata memory metadata, address vault) = abi.decode(data, (TokenMetadata, address));
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(ContagianToken).creationCode,
                abi.encode(name, symbol, initialSupply, recipient, vault, uniswapLauncher, graffiti, metadata, poolManager)
            )
        );
        return address(
            uint160(
                uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), bytes32(uint256(uint160(vault))), initCodeHash)))
            )
        );
    }

    /// @notice Implements Uniswap's `ITokenFactory.createToken`.
    function createToken(
        string calldata name,
        string calldata symbol,
        uint8 decimals,
        uint256 initialSupply,
        address recipient,
        bytes calldata data,
        bytes32 graffiti_
    ) external returns (address tokenAddress) {
        if (msg.sender != uniswapLauncher || graffiti_ != graffiti) revert NotOurLaunch();
        if (recipient == address(0) || initialSupply == 0 || decimals != 18) revert BadToken();
        (TokenMetadata memory metadata, address vault) = abi.decode(data, (TokenMetadata, address));
        if (madeFor[vault] != address(0)) revert AlreadyMade();
        tokenAddress = address(
            new ContagianToken{salt: bytes32(uint256(uint160(vault)))}(
                name, symbol, initialSupply, recipient, vault, msg.sender, graffiti_, metadata, poolManager
            )
        );
        madeFor[vault] = tokenAddress;
        emit TokenCreated(tokenAddress, vault, metadata);
    }
}
