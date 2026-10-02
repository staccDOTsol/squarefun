// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ContagianEngine: how fast a token is leaving its NAV, and what that costs.
/// @notice The tax a Contagian token charges is a funding rate. It prices speed, not position: a
///         token sitting 5% over its NAV and not moving charges nothing, a token moving away
///         from its NAV at 5% an hour charges 5%, and whoever is on the side doing the pushing
///         pays it. Buyers pay while a premium is growing, sellers pay while a discount is
///         growing, and a trade that moves the price back toward NAV never pays.
///
///         Everything is measured off time-weighted averages. The price and the NAV are each an
///         exponential average of the value that held between two samples, weighted by how long
///         it held, so a price printed and unwound inside one second has no weight at all and
///         one held for a block has the weight of a block. The deviation is the ratio of the two
///         averages, and its rate of change is averaged again. The library does not know where
///         its samples come from; choosing honest ones is the caller's job (see ContagianVault).
library ContagianEngine {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    /// @dev Half-life of the price and NAV averages, in seconds.
    uint256 internal constant HL_PRICE = 600;
    /// @dev Half-life of the velocity average: how long a burst of depeg keeps being charged.
    uint256 internal constant HL_VEL = 1800;
    /// @dev The tax is the deviation the token would gain over this many seconds at its current speed.
    uint256 internal constant HORIZON = 3600;
    uint256 private constant LN2 = 693147180559945309;

    struct State {
        uint256 price; // average spot, in the market's price scale
        uint256 nav; // average expected NAV, same scale
        int256 dev; // price / nav - 1 at the last sample, WAD
        int256 vel; // average of d(dev)/dt, WAD per second
        uint256 absVel; // average of |d(dev)/dt|: whether the average is still moving at all
        uint64 t; // last sample
    }

    /// @notice 2^(-dt / halfLife), WAD.
    function decay(uint256 dt, uint256 halfLife) internal pure returns (uint256 w) {
        uint256 halvings = dt / halfLife;
        if (halvings >= 64) return 0;
        // e^(-y) for y in [0, ln 2): alternating series, nine terms, error under 1e-9.
        uint256 y = ((dt % halfLife) * LN2) / halfLife;
        uint256 term = WAD;
        w = WAD;
        for (uint256 i = 1; i < 10; i++) {
            term = (term * y) / (WAD * i);
            w = i % 2 == 1 ? w - term : w + term;
        }
        w >>= halvings;
    }

    function deviation(uint256 price, uint256 nav) internal pure returns (int256) {
        return int256((price * WAD) / nav) - int256(WAD);
    }

    /// @notice Advance the state to `nowTs`, given the spot and NAV that held since the last sample.
    function step(State memory s, uint256 spot, uint256 nav, uint256 nowTs) internal pure returns (State memory) {
        if (s.t == 0) {
            s.price = spot;
            s.nav = nav;
            s.dev = deviation(spot, nav);
            s.t = uint64(nowTs);
            return s;
        }
        uint256 dt = nowTs - s.t;
        if (dt == 0) return s;
        uint256 w = decay(dt, HL_PRICE);
        s.price = (s.price * w + spot * (WAD - w)) / WAD;
        s.nav = (s.nav * w + nav * (WAD - w)) / WAD;
        int256 dev = deviation(s.price, s.nav);
        int256 inst = (dev - s.dev) / int256(dt);
        w = decay(dt, HL_VEL);
        s.vel = (s.vel * int256(w) + inst * int256(WAD - w)) / int256(WAD);
        s.absVel = (s.absVel * w + (inst < 0 ? uint256(-inst) : uint256(inst)) * (WAD - w)) / WAD;
        s.dev = dev;
        s.t = uint64(nowTs);
        return s;
    }

    /// @notice What each side pays, in basis points. At most one of the two is non-zero.
    function rates(State memory s) internal pure returns (uint256 buyBps, uint256 sellBps) {
        if (s.dev > 0 && s.vel > 0) buyBps = (uint256(s.vel) * HORIZON * BPS) / WAD;
        else if (s.dev < 0 && s.vel < 0) sellBps = (uint256(-s.vel) * HORIZON * BPS) / WAD;
    }
}
