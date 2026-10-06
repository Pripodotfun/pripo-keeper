// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Market} from "pripo/Market.sol";
import {MarketState as S} from "pripo/market/MarketState.sol";
import {MarketFundingCapacity as Capacity} from "pripo/market/MarketFundingCapacity.sol";

/// @dev LOCAL TEST ONLY. Injects historical loss; all liquidation/ADL transitions remain production code.
contract RecoveryMarket is Market {
    function testSetCollateral(address user, int256 target) external {
        S.Data storage s = S.load();
        int256 before = s.vault.locked(user, address(this));
        s.vault.settleFunding(user, before - target);
        Capacity.refresh(s, user);
    }
}
