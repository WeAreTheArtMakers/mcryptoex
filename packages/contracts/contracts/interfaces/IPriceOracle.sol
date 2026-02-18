// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPriceOracle {
    /// @notice Returns price in 1e18 and last update timestamp.
    function getPrice(address token) external view returns (uint256 priceE18, uint256 updatedAt);
}
