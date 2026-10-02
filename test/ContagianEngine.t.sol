// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ContagianEngine} from "../contracts/src/square/contagian/ContagianEngine.sol";

contract EngineHarness {
    ContagianEngine.State public s;

    function decay(uint256 dt, uint256 halfLife) external pure returns (uint256) {
        return ContagianEngine.decay(dt, halfLife);
    }

    function step(uint256 spot, uint256 nav, uint256 nowTs) external {
        s = ContagianEngine.step(s, spot, nav, nowTs);
    }

    function rates() external view returns (uint256, uint256) {
        return ContagianEngine.rates(s);
    }
}

/// @dev The engine alone. The token, vault and launch are exercised with real transactions
///      against a fork: test/adversarial/attack.mjs.
contract ContagianEngineTest is Test {
    EngineHarness h;
    uint256 constant P = 1e24;

    function setUp() public {
        h = new EngineHarness();
    }

    function test_DecayIsTwoToTheMinusHalfLives() public view {
        assertEq(h.decay(0, 600), 1e18);
        assertApproxEqAbs(h.decay(600, 600), 0.5e18, 1);
        assertApproxEqRel(h.decay(300, 600), 0.707106781186547524e18, 1e10);
        assertApproxEqRel(h.decay(1500, 600), 0.176776695296636881e18, 1e10);
        assertEq(h.decay(600 * 64, 600), 0);
    }

    function test_APriceThatIsNotMovingChargesNothingWhereverItSits() public {
        h.step(P * 2, P, 1000);
        h.step(P * 2, P, 1000 + 1 days);
        (uint256 buyBps, uint256 sellBps) = h.rates();
        assertEq(buyBps + sellBps, 0, "100% over NAV and still: no tax");
    }

    function test_AGrowingPremiumChargesBuyersOnly() public {
        h.step(P, P, 1000);
        for (uint256 i = 1; i <= 10; i++) {
            h.step(P + (P * i) / 100, P, 1000 + i * 60);
        }
        (uint256 buyBps, uint256 sellBps) = h.rates();
        assertGt(buyBps, 100);
        assertEq(sellBps, 0);
    }

    function test_AGrowingDiscountChargesSellersOnly() public {
        h.step(P, P, 1000);
        for (uint256 i = 1; i <= 10; i++) {
            h.step(P - (P * i) / 100, P, 1000 + i * 60);
        }
        (uint256 buyBps, uint256 sellBps) = h.rates();
        assertEq(buyBps, 0);
        assertGt(sellBps, 100);
    }

    function test_APremiumThatIsShrinkingChargesNobody() public {
        h.step(P * 2, P, 1000);
        for (uint256 i = 1; i <= 10; i++) {
            h.step(P * 2 - (P * i) / 20, P, 1000 + i * 60);
        }
        (uint256 buyBps, uint256 sellBps) = h.rates();
        assertEq(buyBps + sellBps, 0, "moving back toward NAV is never taxed");
    }

    function test_ASampleInTheSameSecondHasNoWeight() public {
        h.step(P, P, 1000);
        h.step(P, P, 2000);
        (uint256 price,,,,,) = h.s();
        h.step(P * 50, P, 2000);
        (uint256 after_,,,,,) = h.s();
        assertEq(after_, price);
    }
}
