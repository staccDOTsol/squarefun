// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {ContagianEngine} from "./ContagianEngine.sol";
import {ContagianLaunchStrategy} from "./ContagianLaunchStrategy.sol";

interface IMade {
    function madeFor(address vault) external view returns (address);
}

interface ISquareStake {
    function sync(address token) external returns (uint256, uint256);
}

interface IWrapped {
    function deposit() external payable;
}

interface INote {
    function GOTCHYA() external view returns (string memory);
}

/// @title ContagianVault: a memecoin that tends to its peg, and who gets paid for it.
/// @notice The settler of one ContagianToken. The rules, measured against parity (one of the
///         peg per token, in the quote the token trades against):
///
///           above parity   buyers pay, sellers don't
///           below parity   sellers pay, buyers don't
///           at parity      move it either way and you pay for the move
///           faster         more
///
///         So chasing the price away from the peg always costs, and anything that moves it
///         back is free. FOMO and FUD both pay for the peg; holding is the move that costs
///         nothing and is paid.
///
///         What a trade pays is the larger of the speed the token has been leaving parity at
///         (ContagianEngine, off time-weighted averages) and half of the gap the trade itself
///         leaves between the price and its average on the wrong side of parity, capped at
///         half. The token takes it: in kind from a buy, on top from a sale.
///
///         Honest samples without an oracle or a hook: the price is read clamped to the range
///         the launch position covers (a swap can slide a pool's price through empty ticks
///         for nothing); and between two samples the engine is given whichever of two readings
///         is nearer its own average, the one the last transfer left or the price as it stood
///         before this trade. To move the average a price has to be there at both ends.
///
///         What the tolls do. They arrive as tokens, and they are never sold in a way that
///         pushes the price away from the peg:
///
///           `offer`    puts a tranche on sale above the price, in the launch pool. Buyers on
///                      the way up take it; nothing is pushed down.
///           `settle`   sells outright only while the price is over parity, and only down to it.
///           `deepen`   offers a tranche against a partner asset in that asset's own pool with
///                      the token: the token alone, over its price, so none of the partner is
///                      ever at risk. A dollar is priced one for one with a dollar quote;
///                      anything else by its own pool against the quote, the dearer of two
///                      readings a period apart.
///           `harvest`  collects what those offers sold for and what they earned in fees.
///
///         Who is paid. Everything the tolls sell for is split in two:
///
///           half to the bad beats   the vault is a directory of who paid the tax, each toll
///                                   entered against the transaction's originator at its worth
///                                   in the quote. An entry starts earning an hour after it is
///                                   made, so nobody is paid back their own toll: you are paid
///                                   by whoever is burned after you.
///           half to the holders     by balance, whoever holds the token outside a pool.
///
///         Both are released evenly over the hour after they arrive, in the quote, never in
///         the token. The trading fees the vault's offers earn are split a quarter to the
///         Stacc Wizards, a quarter to the people staking SQUARE, half to the bad beats.
///
///         Nobody has to do any of it by hand. On every transfer that is not a sale the token
///         asks the vault to do one chore (offer, settle, harvest a range, deepen a partner, in
///         turn) and to pay one bad beat what they are owed, and it pays the two wallets in the
///         transfer what they are owed as holders. A sale is left alone: its own payment to the
///         pool is in flight. All of it is also open to anyone to call, and calling twice adds
///         nothing. The bad beats paid in turn are the ones whose entry is at least three
///         tenths of the average; the small tail can still call `claim`.
contract ContagianVault is IUnlockCallback {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    /// @notice No tax takes more than this.
    uint256 public constant TAX_CAP = 5_000;
    /// @notice A trade pays this share of the gap it leaves between the price and its average, on the wrong side of parity.
    uint256 public constant IMPACT_BPS = 5_000;
    /// @notice Paid to whoever calls `settle`, out of what it brings in.
    uint256 public constant TIP_BPS = 50;
    /// @notice Of the fees the vault's offers earn: this much to the Wizards, this much to SQUARE stakers, the rest to the bad beats.
    uint256 public constant WIZARDS_BPS = 2_500;
    uint256 public constant STAKERS_BPS = 2_500;
    /// @notice What is owed is released evenly over this long, and a directory entry waits this long before it earns.
    uint256 public constant DRIP = 1 hours;
    /// @notice The vault's ranges start on multiples of this many ticks, so they repeat and can be listed.
    int24 public constant GRID = 500;
    /// @notice How far over the price a tranche reaches, in ticks (about 65%).
    int24 public constant ASK_TICKS = 5_000;
    /// @notice A tranche is this share of the tolls held, at most once a period for each pool.
    uint256 public constant TRANCHE_BPS = 500;
    uint256 public constant PERIOD = 1 hours;
    /// @dev The launch pool's LP fee, in hundredths of a basis point: that part of a sale is not swapped.
    uint256 private constant LP_FEE = 2_500;
    uint24 private constant POOL_FEE = 2_500;
    int24 private constant TICK_SPACING = 25;
    int24 private constant EDGE_TICK = 887_250;
    /// @dev Prices are quote units per token unit, times this.
    uint256 private constant PRICE = 1e36;
    uint256 private constant Q96 = 1 << 96;
    uint256 private constant ACC = 1e36;

    enum Op {
        Settle,
        Offer,
        Harvest
    }

    /// @param asset address(0) is native ETH
    /// @param refFee the fee of the hookless v4 pool of `asset` against the quote that prices
    ///        it; zero for a like token of the quote, priced one for one
    struct Partner {
        address asset;
        uint24 refFee;
        int24 refSpacing;
    }

    /// @dev A price read for a pool, and when.
    struct Seen {
        uint256 price;
        uint64 at;
    }

    /// @dev A range the vault has put tolls on offer in: against `other`, between two ticks.
    struct Range {
        address other;
        int24 lower;
        int24 upper;
    }

    /// @dev Something being released evenly: `rate` per second (times 1e18) until `ends`,
    ///      and how much each unit of the thing it is shared by has been released so far.
    struct Stream {
        uint256 rate;
        uint64 ends;
        uint64 at;
        uint256 acc;
    }

    IPoolManager public immutable manager;
    ContagianLaunchStrategy public immutable strategy;
    /// @notice The Stacc Wizards fanout, the SQUARE stake pool, and the wrapper a native quote is paid to them in.
    address public immutable wizards;
    ISquareStake public immutable stakePool;
    IWrapped public immutable wrapped;

    /// @notice The only factory whose token this vault will bind to. Set once, at `initialize`.
    address public factory;
    address public token;
    address public quote;
    /// @notice What the token is trying to be worth one of, and how it is priced in the quote.
    Partner public peg;
    PoolId public poolId;
    bool public tokenIs0;
    uint128 public liquidity;
    uint160 private _sqrtLower;
    uint160 private _sqrtUpper;
    uint8 private _quoteDecimals;
    uint8 private _pegDecimals;

    /// @notice What the tolls are also offered against. Fixed at launch.
    Partner[] public partners;
    mapping(address pool => Seen) public seen;
    /// @notice Every range the vault has tolls on offer in.
    Range[] public ranges;
    mapping(bytes32 => bool) private _known;
    /// @dev Liquidity the vault holds in each launch-pool range, to take out once it has sold.
    mapping(bytes32 => uint128) private _asked;

    /// @notice Tolls paid by each originator and now earning, in quote units at the average price when paid.
    mapping(address => uint256) public paidBy;
    uint256 public totalPaid;
    /// @notice Tolls paid by each originator that are not earning yet, and when they will.
    mapping(address => uint256) public pendingBy;
    mapping(address => uint256) public maturesAt;

    Stream private _toPayers;
    Stream private _toHolders;
    mapping(address => uint256) private _payerAt;
    mapping(address => uint256) private _holderDebt;
    mapping(address => uint256) private _owed;

    /// @notice Every wallet that has paid the tax, in the order they first did.
    address[] public payers;
    uint64 private _turn;
    uint64 private _payAt;
    uint64 private _harvestAt;
    uint64 private _deepenAt;
    /// @dev The least worth sending on its own: a hundredth of a unit of the quote.
    uint256 private _minPay;

    ContagianEngine.State private _engine;
    uint256 private _lastSpot;
    uint256 private _lastParity;
    uint256 private transient _locked;

    /// @dev Where Uniswap's pool manager keeps, for the length of a transaction, whether it is
    ///      unlocked and which currency a payment is being counted in.
    bytes32 private constant UNLOCKED_SLOT = bytes32(uint256(keccak256("Unlocked")) - 1);
    bytes32 private constant SYNCED_SLOT = bytes32(uint256(keccak256("Currency")) - 1);

    event Bound(address indexed token, address indexed quote);
    event Settled(address indexed caller, uint256 tolls, uint256 quoteIn, uint256 tip);
    event Offered(address indexed other, uint256 tolls, int24 lower, int24 upper);
    event Harvested(address indexed other, uint256 tokens, uint256 otherAmount, bool sold);
    event Reflected(uint256 toPayers, uint256 toHolders);
    event Yield(uint256 toWizards, uint256 toStakers, uint256 toPayers);
    event Paid(address indexed originator, uint256 tolls, uint256 worth);
    event Claimed(address indexed who, uint256 amount);

    error Bad();

    modifier lock() {
        if (_locked != 0) revert Bad();
        _locked = 1;
        _;
        _locked = 0;
    }

    /// @dev Vaults are clones of one deployment: the pool manager, the strategy and where the
    ///      fees go are the same for all of them, everything else arrives through `initialize`.
    constructor(
        IPoolManager manager_,
        ContagianLaunchStrategy strategy_,
        address wizards_,
        ISquareStake stakePool_,
        IWrapped wrapped_
    ) {
        manager = manager_;
        strategy = strategy_;
        wizards = wizards_;
        stakePool = stakePool_;
        wrapped = wrapped_;
        factory = address(0xdead); // the deployment itself is never a vault
    }

    /// @notice Give a new clone its peg, its partners and the factory whose token it will serve. Once.
    function initialize(Partner calldata peg_, Partner[] calldata partners_, address factory_) external {
        if (factory != address(0) || factory_ == address(0)) revert Bad();
        factory = factory_;
        peg = peg_;
        for (uint256 i = 0; i < partners_.length; i++) {
            partners.push(partners_[i]);
        }
    }

    function partnerCount() external view returns (uint256) {
        return partners.length;
    }

    function rangeCount() external view returns (uint256) {
        return ranges.length;
    }

    function payerCount() external view returns (uint256) {
        return payers.length;
    }

    /// @notice The note the token sends a wallet every time it pays the tax.
    function GOTCHYA() external view returns (string memory) {
        return INote(token).GOTCHYA();
    }

    /// @dev A swept pool can hand back a unit of native ETH.
    receive() external payable {}

    /// @notice Called by the strategy in the launch transaction, once.
    function bind(address token_, address quote_) external {
        if (msg.sender != address(strategy) || token != address(0) || IMade(factory).madeFor(address(this)) != token_) {
            revert Bad();
        }
        token = token_;
        quote = quote_;
        _quoteDecimals = _decimals(quote_);
        _minPay = 10 ** _quoteDecimals / 100;
        _pegDecimals = _decimals(peg.asset);
        tokenIs0 = token_ < quote_;
        poolId = _key(quote_).toId();
        (, int24 lower, int24 upper, uint128 liquidity_) = strategy.launches(token_);
        liquidity = liquidity_;
        _sqrtLower = TickMath.getSqrtPriceAtTick(lower);
        _sqrtUpper = TickMath.getSqrtPriceAtTick(upper);
        // the averages start from the opening price, not from whoever transfers first
        uint160 sqrtNow = _sqrtPrice();
        _sample(sqrtNow, sqrtNow);
        emit Bound(token_, quote_);
    }

    function _decimals(address asset) private view returns (uint8) {
        return asset == address(0) ? 18 : IERC20Metadata(asset).decimals();
    }

    // ─── price and parity ────────────────────────────────────────────────────

    /// @dev The pool's price, held inside the range the launch position covers.
    function _sqrtPrice() private view returns (uint160 sqrtP) {
        (sqrtP,,,) = manager.getSlot0(poolId);
        if (sqrtP < _sqrtLower) sqrtP = _sqrtLower;
        if (sqrtP > _sqrtUpper) sqrtP = _sqrtUpper;
    }

    function _spot(uint160 sqrtP) private view returns (uint256) {
        uint256 ratio = Math.mulDiv(sqrtP, sqrtP, Q96);
        return tokenIs0 ? Math.mulDiv(ratio, PRICE, Q96) : Math.mulDiv(PRICE, Q96, ratio);
    }

    /// @dev The pool's price after `amount` tokens go into the launch position (a sale) or come
    ///      out of it (a buy), from `sqrtP`, held inside the position's range.
    function _moved(uint160 sqrtP, uint256 amount, bool tokensIn) private view returns (uint160) {
        uint256 next;
        if (tokenIs0) {
            uint256 scaled = Math.mulDiv(amount, sqrtP, Q96);
            if (tokensIn) next = Math.mulDiv(liquidity, sqrtP, liquidity + scaled);
            else next = scaled >= liquidity ? _sqrtUpper : Math.mulDiv(liquidity, sqrtP, liquidity - scaled);
        } else {
            uint256 step = Math.mulDiv(amount, Q96, liquidity);
            if (tokensIn) next = step >= _sqrtUpper - sqrtP ? _sqrtUpper : sqrtP + step;
            else next = step >= sqrtP - _sqrtLower ? _sqrtLower : sqrtP - step;
        }
        if (next < _sqrtLower) next = _sqrtLower;
        if (next > _sqrtUpper) next = _sqrtUpper;
        return uint160(next);
    }

    /// @dev `asset`'s price in the quote (quote units per asset unit, times 1e36), read from its
    ///      own hookless pool against the quote. Zero if there is no such pool or it is empty.
    function _inQuote(Partner memory p) private view returns (uint256) {
        bool assetIs0 = p.asset < quote;
        PoolKey memory ref = PoolKey(
            Currency.wrap(assetIs0 ? p.asset : quote),
            Currency.wrap(assetIs0 ? quote : p.asset),
            p.refFee,
            p.refSpacing,
            IHooks(address(0))
        );
        (uint160 sqrtP,,,) = manager.getSlot0(ref.toId());
        if (sqrtP == 0 || manager.getLiquidity(ref.toId()) == 0) return 0;
        uint256 ratio = Math.mulDiv(sqrtP, sqrtP, Q96);
        return assetIs0 ? Math.mulDiv(ratio, PRICE, Q96) : Math.mulDiv(PRICE, Q96, ratio);
    }

    /// @notice Parity: one of the peg per token, in quote units per token unit, times 1e36.
    function parity() public view returns (uint256 p) {
        Partner memory g = peg;
        if (g.asset == quote || g.refFee == 0) {
            // the peg is the quote, or a like token of it: one for one in whole units
            return (PRICE * 10 ** _quoteDecimals) / 1e18;
        }
        p = Math.mulDiv(_inQuote(g), 10 ** _pegDecimals, 1e18);
        // a peg that cannot be priced just now holds where it was last read
        if (p == 0) p = _lastParity;
    }

    /// @notice Quote per token, times 1e36.
    function spot() external view returns (uint256) {
        return _spot(_sqrtPrice());
    }

    /// @notice Tolls held: every token the vault has.
    function tolls() public view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    /// @notice Tokens that are neither in a pool nor held here as tolls: what the holders hold.
    function circulating() public view returns (uint256) {
        IERC20 t = IERC20(token);
        return t.totalSupply() - t.balanceOf(address(manager)) - t.balanceOf(address(this));
    }

    // ─── how fast it is leaving ──────────────────────────────────────────────

    /// @dev `spotHeld` is the price this caller says held since the last sample.
    function _advance(ContagianEngine.State memory s, uint256 spotHeld, uint256 parityNow)
        private
        view
        returns (ContagianEngine.State memory)
    {
        uint256 parityHeld = parityNow;
        if (s.t != 0 && block.timestamp > s.t) {
            // of the reading the last sample left and the one offered now, the one nearer the average
            uint256 a = _lastSpot > s.price ? _lastSpot - s.price : s.price - _lastSpot;
            uint256 b = spotHeld > s.price ? spotHeld - s.price : s.price - spotHeld;
            if (a < b) spotHeld = _lastSpot;
            a = _lastParity > s.nav ? _lastParity - s.nav : s.nav - _lastParity;
            b = parityNow > s.nav ? parityNow - s.nav : s.nav - parityNow;
            if (a < b) parityHeld = _lastParity;
        }
        return ContagianEngine.step(s, spotHeld, parityHeld, block.timestamp);
    }

    /// @dev `sqrtPre` is the pool as it stood before this transfer's trade.
    function _sample(uint160 sqrtNow, uint160 sqrtPre) private returns (ContagianEngine.State memory s, uint256 spotNow) {
        spotNow = _spot(sqrtNow);
        uint256 parityNow = parity();
        s = _advance(_engine, _spot(sqrtPre), parityNow);
        _engine = s;
        _lastSpot = spotNow;
        _lastParity = parityNow;
    }

    /// @notice Sample the market. Anyone may; it costs the caller gas and moves no funds.
    function poke() external {
        if (token == address(0)) revert Bad();
        uint160 sqrtNow = _sqrtPrice();
        _sample(sqrtNow, sqrtNow);
    }

    /// @notice The token's call on every counted transfer, once balances have moved: sample, and
    ///         say what it pays: a buy, a sale, or a transfer that is neither.
    function poke(bool buy, bool sale, uint256 value) external returns (uint256 bps) {
        if (msg.sender != token) revert Bad();
        uint160 sqrtNow = _sqrtPrice();
        uint160 sqrtPre = sqrtNow;
        if (buy) sqrtPre = _moved(sqrtNow, value, true);
        else if (sale) sqrtPre = _moved(sqrtNow, value - (value * LP_FEE) / 1e6, false);
        (ContagianEngine.State memory s, uint256 spotNow) = _sample(sqrtNow, sqrtPre);
        (uint256 buyBps, uint256 sellBps) = ContagianEngine.rates(s);
        // s.nav is parity, averaged. A buy only pays over it, a sale only under it. Each pays for
        // the move it made, measured from the price it found or the average, whichever is
        // further: a sale into a pump pays for its own push, a sale into a slide for the slide.
        uint256 base = _spot(sqrtPre);
        if (buy) {
            if (spotNow <= s.nav) return 0;
            if (s.price < base) base = s.price;
            if (base < s.nav) base = s.nav;
            if (spotNow > base) bps = Math.mulDiv(spotNow - base, IMPACT_BPS, base);
            if (buyBps > bps) bps = buyBps;
        } else if (sale) {
            if (spotNow >= s.nav) return 0;
            if (s.price > base) base = s.price;
            if (base > s.nav) base = s.nav;
            if (spotNow < base) bps = Math.mulDiv(base - spotNow, IMPACT_BPS, base);
            if (sellBps > bps) bps = sellBps;
        } else {
            bps = buyBps > sellBps ? buyBps : sellBps;
        }
        if (bps > TAX_CAP) bps = TAX_CAP;
    }

    /// @notice The measured state, advanced to now. `nav` is parity, averaged.
    function engine() public view returns (ContagianEngine.State memory) {
        return _advance(_engine, _spot(_sqrtPrice()), parity());
    }

    /// @notice The lagging tax each side would pay now. A trade also pays for its own push.
    function taxBps() external view returns (uint256 buyBps, uint256 sellBps) {
        (buyBps, sellBps) = ContagianEngine.rates(engine());
        if (buyBps > TAX_CAP) buyBps = TAX_CAP;
        if (sellBps > TAX_CAP) sellBps = TAX_CAP;
    }

    // ─── what the tolls do ───────────────────────────────────────────────────

    /// @notice While the price is over parity: sell tolls into the launch pool, down to parity
    ///         (or to the price's average, if that is higher) and no further.
    function settle() external lock returns (uint256 sold, uint256 quoteIn) {
        return _settleNow(msg.sender);
    }

    /// @notice Put a tranche of tolls on sale above the price in the launch pool. At most once a period.
    function offer() external lock returns (uint256 placed) {
        return _offerNow();
    }

    /// @notice Offer a tranche of tolls against partner `i`, over the token's price in that
    ///         partner, in the partner's pool with the token. At most once a period for each
    ///         partner, and the first call for a partner only takes a reading.
    function deepen(uint256 i) external lock returns (uint256 placed) {
        return _deepenNow(i);
    }

    /// @notice Collect from ranges `from` to `from + n`: what an offer that has sold through
    ///         sold for (split between the bad beats and the holders), and what the others
    ///         have earned in fees (Wizards, SQUARE stakers, bad beats). The token side joins
    ///         the tolls. A partner asset stays in custody here.
    function harvest(uint256 from, uint256 n) external lock returns (uint256 proceeds, uint256 fees) {
        return _harvestNow(from, n);
    }

    /// @notice The token's call after a transfer that is not a sale: one chore, one bad beat paid.
    function chores() external {
        if (msg.sender != token || _locked != 0) return;
        // somebody's payment to the pool manager is being counted: leave the manager alone
        if (manager.exttload(SYNCED_SLOT) != bytes32(0)) return;
        _locked = 1;
        uint256 turn = _turn++ % 4;
        if (turn == 0) {
            _offerNow();
        } else if (turn == 1) {
            _settleNow(address(this));
        } else if (turn == 2) {
            if (ranges.length != 0) _harvestNow(_harvestAt++ % ranges.length, 1);
        } else if (partners.length != 0) {
            _deepenNow(_deepenAt++ % partners.length);
        }
        uint256 n = payers.length;
        if (n != 0) {
            address who = payers[_payAt++ % n];
            _mature(who);
            // the ones worth the gas: an entry at least three tenths of the average
            if (paidBy[who] * n * 10 >= totalPaid * 3) _payout(who);
        }
        _locked = 0;
    }

    function _settleNow(address tipTo) private returns (uint256 sold, uint256 quoteIn) {
        if (token == address(0)) revert Bad();
        uint160 sqrtNow = _sqrtPrice();
        (ContagianEngine.State memory s,) = _sample(sqrtNow, sqrtNow);
        uint256 amount = tolls();
        uint160 limit = _sqrtFor(s.price > s.nav ? s.price : s.nav, tokenIs0);
        // selling the token lowers the pool's own price when the token is currency0, raises it otherwise
        if (amount == 0 || (tokenIs0 ? limit >= sqrtNow : limit <= sqrtNow)) return (0, 0);
        (sold, quoteIn) = abi.decode(_run(Op.Settle, address(0), amount, uint256(limit)), (uint256, uint256));
        if (quoteIn != 0) {
            // a chore run by the token itself tips nobody
            uint256 tip = tipTo == address(this) ? 0 : (quoteIn * TIP_BPS) / 10_000;
            _reflect(quoteIn - tip);
            _send(quote, tipTo, tip);
            emit Settled(tipTo, sold, quoteIn, tip);
        }
        _lastSpot = _spot(_sqrtPrice());
    }

    function _offerNow() private returns (uint256 placed) {
        if (token == address(0) || block.timestamp < uint256(seen[quote].at) + PERIOD) return 0;
        uint160 sqrtNow = _sqrtPrice();
        (ContagianEngine.State memory s, uint256 spotNow) = _sample(sqrtNow, sqrtNow);
        uint256 amount = (tolls() * TRANCHE_BPS) / 10_000;
        // less than a whole token is dust: it would place nothing and still use up the period
        if (amount < 1e18) return 0;
        // never under the price, nor under its average
        uint256 price = spotNow > s.price ? spotNow : s.price;
        seen[quote] = Seen(price, uint64(block.timestamp));
        placed = abi.decode(_run(Op.Offer, quote, amount, price), (uint256));
    }

    function _deepenNow(uint256 i) private returns (uint256 placed) {
        Partner memory p = partners[i];
        Seen memory last = seen[p.asset];
        if (token == address(0) || p.asset == quote || (last.at != 0 && block.timestamp < uint256(last.at) + PERIOD)) {
            return 0;
        }
        uint160 sqrtNow = _sqrtPrice();
        (ContagianEngine.State memory s, uint256 spotNow) = _sample(sqrtNow, sqrtNow);
        uint256 inQuote = spotNow > s.price ? spotNow : s.price;
        uint256 price;
        if (p.refFee == 0) {
            price = Math.mulDiv(inQuote, 10 ** _decimals(p.asset), 10 ** _quoteDecimals);
        } else {
            uint256 assetInQuote = _inQuote(p);
            if (assetInQuote != 0) price = Math.mulDiv(inQuote, PRICE, assetInQuote);
        }
        if (price == 0) return 0;
        seen[p.asset] = Seen(price, uint64(block.timestamp));
        uint256 amount = (tolls() * TRANCHE_BPS) / 10_000;
        if (last.at == 0 || amount == 0) return 0;
        // the dearer of this reading and the last: a price pushed down for one call is not used
        if (last.price > price) price = last.price;
        placed = abi.decode(_run(Op.Offer, p.asset, amount, price), (uint256));
    }

    function _harvestNow(uint256 from, uint256 n) private returns (uint256 proceeds, uint256 fees) {
        uint256 end = from + n > ranges.length ? ranges.length : from + n;
        if (from >= end) return (0, 0);
        (proceeds, fees) = abi.decode(_run(Op.Harvest, address(0), from, end), (uint256, uint256));
        _reflect(proceeds);
        _share(fees);
    }

    /// @dev Do it inside the pool manager: through its lock, or directly when whoever is
    ///      transferring the token already holds it open (a buy, mid-swap).
    function _run(Op op, address other, uint256 amount, uint256 x) private returns (bytes memory) {
        if (manager.exttload(UNLOCKED_SLOT) != bytes32(0)) return _dispatch(op, other, amount, x);
        return manager.unlock(abi.encode(op, other, amount, x));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(manager)) revert Bad();
        (Op op, address other, uint256 amount, uint256 x) = abi.decode(data, (Op, address, uint256, uint256));
        return _dispatch(op, other, amount, x);
    }

    function _dispatch(Op op, address other, uint256 amount, uint256 x) private returns (bytes memory) {
        if (op == Op.Settle) return _settle(amount, uint160(x));
        if (op == Op.Offer) return _offer(other, amount, x);
        return _harvest(amount, x);
    }

    function _settle(uint256 amount, uint160 limit) private returns (bytes memory) {
        BalanceDelta d = manager.swap(_key(quote), SwapParams(tokenIs0, -int256(amount), limit), "");
        uint256 sold = uint256(uint128(-(tokenIs0 ? d.amount0() : d.amount1())));
        uint256 quoteIn = uint256(uint128(tokenIs0 ? d.amount1() : d.amount0()));
        if (sold != 0) _pay(sold);
        if (quoteIn != 0) manager.take(Currency.wrap(quote), address(this), quoteIn);
        return abi.encode(sold, quoteIn);
    }

    /// @dev Tolls alone, in a range over `price`, in the token's pool with `other`.
    function _offer(address other, uint256 amount, uint256 price) private returns (bytes memory) {
        PoolKey memory key = _key(other);
        bool is0 = token < other;
        uint160 sqrtRef = _sqrtFor(price, is0);
        PoolId id = key.toId();
        (uint160 sqrtP, int24 tick,,) = manager.getSlot0(id);
        if (sqrtP == 0) {
            manager.initialize(key, sqrtRef);
            tick = TickMath.getTickAtSqrtPrice(sqrtRef);
        }
        // the token's side of the reference price: over it when the token is currency0, under it otherwise
        int24 edge = _floor(TickMath.getTickAtSqrtPrice(sqrtRef));
        (int24 lower, int24 upper) = is0 ? (edge + GRID, edge + GRID + ASK_TICKS) : (edge - ASK_TICKS, edge);
        if (lower < -EDGE_TICK || upper > EDGE_TICK) return abi.encode(uint256(0));
        if (is0 ? tick >= lower : tick < upper) {
            // The pool prices the token over the reference. Through empty ticks one unit of
            // token carries the price back; through anything else it does not, and then either
            // someone is bidding over the market or the partner has lost value since.
            BalanceDelta m = manager.swap(key, SwapParams(is0, -1, sqrtRef), "");
            int128 owed = is0 ? m.amount0() : m.amount1();
            int128 back = is0 ? m.amount1() : m.amount0();
            if (owed < 0) _pay(uint256(uint128(-owed)));
            if (back > 0) manager.take(Currency.wrap(other), address(this), uint256(uint128(back)));
            (, tick,,) = manager.getSlot0(id);
            if (is0 ? tick >= lower : tick < upper) return abi.encode(uint256(0));
        }
        uint160 a = TickMath.getSqrtPriceAtTick(lower);
        uint160 b = TickMath.getSqrtPriceAtTick(upper);
        uint256 l = is0 ? Math.mulDiv(amount, Math.mulDiv(a, b, Q96), uint256(b) - a) : Math.mulDiv(amount, Q96, uint256(b) - a);
        if (l == 0 || l > type(uint128).max / 2) return abi.encode(uint256(0));
        (BalanceDelta d,) = manager.modifyLiquidity(key, ModifyLiquidityParams(lower, upper, int256(l), bytes32(0)), "");
        if ((is0 ? d.amount1() : d.amount0()) != 0) revert Bad();
        uint256 placed = uint256(uint128(-(is0 ? d.amount0() : d.amount1())));
        _pay(placed);
        bytes32 rid = keccak256(abi.encode(other, lower, upper));
        if (!_known[rid]) {
            _known[rid] = true;
            ranges.push(Range(other, lower, upper));
        }
        if (other == quote) _asked[rid] += uint128(l);
        emit Offered(other, placed, lower, upper);
        return abi.encode(placed);
    }

    function _harvest(uint256 from, uint256 end) private returns (bytes memory) {
        uint256 proceeds;
        uint256 fees;
        (, int24 tick,,) = manager.getSlot0(poolId);
        for (uint256 i = from; i < end; i++) {
            Range memory r = ranges[i];
            bool is0 = token < r.other;
            bytes32 rid = keccak256(abi.encode(r.other, r.lower, r.upper));
            // a launch-pool offer the price has gone all the way through is all quote now: take it out
            uint128 l = _asked[rid];
            bool sold = l != 0 && (is0 ? tick >= r.upper : tick < r.lower);
            if (sold) _asked[rid] = 0;
            (BalanceDelta d,) = manager.modifyLiquidity(
                _key(r.other), ModifyLiquidityParams(r.lower, r.upper, sold ? -int256(uint256(l)) : int256(0), bytes32(0)), ""
            );
            uint256 tokens = uint256(uint128(is0 ? d.amount0() : d.amount1()));
            uint256 other = uint256(uint128(is0 ? d.amount1() : d.amount0()));
            if (tokens != 0) manager.take(Currency.wrap(token), address(this), tokens);
            if (other != 0) manager.take(Currency.wrap(r.other), address(this), other);
            if (r.other == quote) {
                if (sold) proceeds += other;
                else fees += other;
            }
            if (tokens != 0 || other != 0) emit Harvested(r.other, tokens, other, sold);
        }
        return abi.encode(proceeds, fees);
    }

    function _pay(uint256 amount) private {
        manager.sync(Currency.wrap(token));
        IERC20(token).safeTransfer(address(manager), amount);
        manager.settle();
    }

    function _key(address other) private view returns (PoolKey memory) {
        (address a, address b) = token < other ? (token, other) : (other, token);
        return PoolKey(Currency.wrap(a), Currency.wrap(b), POOL_FEE, TICK_SPACING, IHooks(address(0)));
    }

    /// @dev The grid line at or below a tick.
    function _floor(int24 tick) private pure returns (int24) {
        int24 compressed = tick / GRID;
        if (tick < 0 && tick % GRID != 0) compressed--;
        return compressed * GRID;
    }

    function _send(address currency, address to, uint256 amount) private {
        if (amount == 0) return;
        if (currency == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert Bad();
        } else {
            IERC20(currency).safeTransfer(to, amount);
        }
    }

    /// @dev The pool price for `price` (other per token, times 1e36), in the pool's own terms.
    function _sqrtFor(uint256 price, bool is0) private pure returns (uint160) {
        uint256 root = Math.sqrt(price * 1e20);
        uint256 sqrtP = is0 ? Math.mulDiv(root, Q96, 1e28) : Math.mulDiv(Q96, 1e28, root);
        if (sqrtP <= TickMath.MIN_SQRT_PRICE) sqrtP = TickMath.MIN_SQRT_PRICE + 1;
        if (sqrtP >= TickMath.MAX_SQRT_PRICE) sqrtP = TickMath.MAX_SQRT_PRICE - 1;
        return uint160(sqrtP);
    }

    // ─── who is paid ─────────────────────────────────────────────────────────

    /// @notice The token's entry for a toll just paid: `amount` tokens, by `originator`.
    /// @return worth what it was entered at, in the quote
    function credit(address originator, uint256 amount) external returns (uint256 worth) {
        if (msg.sender != token) revert Bad();
        worth = Math.mulDiv(amount, _engine.price, PRICE);
        if (worth == 0) return 0;
        if (paidBy[originator] == 0 && pendingBy[originator] == 0) payers.push(originator);
        _mature(originator);
        // one waiting entry per originator: paying again before it counts starts its hour again
        pendingBy[originator] += worth;
        maturesAt[originator] = block.timestamp + DRIP;
        emit Paid(originator, amount, worth);
    }

    /// @notice Start `who`'s waiting entry earning, if its hour is up. Anyone may call.
    function activate(address who) external {
        _mature(who);
    }

    function _mature(address who) private {
        uint256 waiting = pendingBy[who];
        if (waiting == 0 || block.timestamp < maturesAt[who]) return;
        _payerSettle(who);
        pendingBy[who] = 0;
        paidBy[who] += waiting;
        totalPaid += waiting;
    }

    /// @notice The token's call before any balance moves: bring both holders up to date.
    function holderPre(address a, address b) external {
        if (msg.sender != token) return;
        _roll(_toHolders, circulating());
        _holderSettle(a);
        _holderSettle(b);
    }

    /// @notice The token's call after balances have moved: both start again from where they
    ///         stand, and each is sent what it is owed if that is worth sending.
    function holderPost(address a, address b) external {
        if (msg.sender != token) return;
        _holderMark(a);
        _holderMark(b);
        if (_locked != 0) return;
        _locked = 1;
        if (_holds(a) && _owed[a] >= _minPay) _push(a);
        if (_holds(b) && _owed[b] >= _minPay) _push(b);
        _locked = 0;
    }

    /// @notice Send `who` what has been released to them so far. Anyone may call.
    function payout(address who) external lock {
        _mature(who);
        _payout(who);
    }

    function _payout(address who) private {
        _payerSettle(who);
        _roll(_toHolders, circulating());
        _holderSettle(who);
        if (_owed[who] >= _minPay) _push(who);
    }

    /// @dev Pay `who` what they are owed. If the payment will not go through, it stays owed.
    function _push(address who) private {
        uint256 amount = _owed[who];
        _owed[who] = 0;
        bool ok;
        if (quote == address(0)) {
            (ok,) = who.call{value: amount, gas: 30_000}("");
        } else {
            bytes memory ret;
            (ok, ret) = quote.call(abi.encodeCall(IERC20.transfer, (who, amount)));
            ok = ok && (ret.length == 0 || abi.decode(ret, (bool)));
        }
        if (ok) emit Claimed(who, amount);
        else _owed[who] = amount;
    }

    /// @dev A holder is anyone but the zero address, the pools and this vault.
    function _holds(address who) private view returns (bool) {
        return who != address(0) && who != address(manager) && who != address(this);
    }

    function _holderSettle(address who) private {
        if (!_holds(who)) return;
        uint256 due = (IERC20(token).balanceOf(who) * _toHolders.acc) / ACC;
        if (due > _holderDebt[who]) _owed[who] += due - _holderDebt[who];
        _holderDebt[who] = due;
    }

    function _holderMark(address who) private {
        if (_holds(who)) _holderDebt[who] = (IERC20(token).balanceOf(who) * _toHolders.acc) / ACC;
    }

    function _payerSettle(address who) private {
        _roll(_toPayers, totalPaid);
        _owed[who] += (paidBy[who] * (_toPayers.acc - _payerAt[who])) / ACC;
        _payerAt[who] = _toPayers.acc;
    }

    /// @notice Collect what has been released to the caller so far, as a bad beat and as a holder, in the quote.
    function claim() external lock returns (uint256 amount) {
        _mature(msg.sender);
        _payerSettle(msg.sender);
        _roll(_toHolders, circulating());
        _holderSettle(msg.sender);
        amount = _owed[msg.sender];
        if (amount == 0) return 0;
        _owed[msg.sender] = 0;
        _send(quote, msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    /// @notice What `who` could claim now: as a bad beat, and as a holder.
    function claimable(address who) external view returns (uint256 asPayer, uint256 asHolder) {
        asPayer = (paidBy[who] * (_accNow(_toPayers, totalPaid) - _payerAt[who])) / ACC;
        if (_holds(who)) {
            uint256 due = (IERC20(token).balanceOf(who) * _accNow(_toHolders, circulating())) / ACC;
            if (due > _holderDebt[who]) asHolder = due - _holderDebt[who];
        }
        // what was settled earlier and not collected is reported with the bad-beat share
        asPayer += _owed[who];
    }

    /// @notice `who`'s share of the directory, in basis points.
    function shareBps(address who) external view returns (uint256) {
        return totalPaid == 0 ? 0 : (paidBy[who] * 10_000) / totalPaid;
    }

    /// @dev Everything a toll sold for: half to the bad beats, half to the holders. With
    ///      nobody on one side yet, the other side has it all.
    function _reflect(uint256 amount) private {
        if (amount == 0) return;
        uint256 supply = circulating();
        uint256 toPayers = totalPaid == 0 ? 0 : supply == 0 ? amount : amount / 2;
        uint256 toHolders = supply == 0 ? 0 : amount - toPayers;
        _fund(_toPayers, totalPaid, toPayers);
        _fund(_toHolders, supply, toHolders);
        emit Reflected(toPayers, toHolders);
    }

    /// @dev What the offers earned in fees, in the quote: a quarter to the Wizards, a quarter to
    ///      SQUARE stakers, the rest released to the bad beats. A native quote reaches the first two wrapped.
    function _share(uint256 amount) private {
        if (amount == 0) return;
        uint256 toWizards = (amount * WIZARDS_BPS) / 10_000;
        uint256 toStakers = (amount * STAKERS_BPS) / 10_000;
        // with nobody in the directory earning yet, their half is split between the other two
        if (totalPaid == 0) {
            toWizards = amount / 2;
            toStakers = amount - toWizards;
        }
        address paidIn = quote;
        if (paidIn == address(0)) {
            paidIn = address(wrapped);
            wrapped.deposit{value: toWizards + toStakers}();
        }
        IERC20(paidIn).safeTransfer(wizards, toWizards);
        IERC20(paidIn).safeTransfer(address(stakePool), toStakers);
        // the pool shares out what it finds; if it cannot just now, its next sync does
        try stakePool.sync(paidIn) {} catch {}
        _fund(_toPayers, totalPaid, amount - toWizards - toStakers);
        emit Yield(toWizards, toStakers, amount - toWizards - toStakers);
    }

    function _accNow(Stream storage st, uint256 sharedBy) private view returns (uint256 acc) {
        acc = st.acc;
        uint256 until = block.timestamp < st.ends ? block.timestamp : st.ends;
        if (sharedBy != 0 && until > st.at) acc += Math.mulDiv((until - st.at) * st.rate, ACC, 1e18 * sharedBy);
    }

    function _roll(Stream storage st, uint256 sharedBy) private {
        st.acc = _accNow(st, sharedBy);
        st.at = uint64(block.timestamp < st.ends ? block.timestamp : st.ends);
    }

    /// @dev Add `amount` of quote to what is being released, and start the hour again.
    function _fund(Stream storage st, uint256 sharedBy, uint256 amount) private {
        if (amount == 0) return;
        _roll(st, sharedBy);
        uint256 left = block.timestamp < st.ends ? (st.ends - block.timestamp) * st.rate : 0;
        st.rate = (amount * 1e18 + left) / DRIP;
        st.ends = uint64(block.timestamp + DRIP);
        st.at = uint64(block.timestamp);
    }
}
