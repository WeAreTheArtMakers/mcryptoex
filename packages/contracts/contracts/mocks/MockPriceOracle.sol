// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from '@openzeppelin/contracts/access/AccessControl.sol';
import {IPriceOracle} from '../interfaces/IPriceOracle.sol';

contract MockPriceOracle is AccessControl, IPriceOracle {
    bytes32 public constant ORACLE_UPDATER_ROLE = keccak256('ORACLE_UPDATER_ROLE');

    struct PriceData {
        uint256 priceE18;
        uint256 updatedAt;
    }

    mapping(address => PriceData) private _prices;

    event PriceUpdated(address indexed token, uint256 priceE18, uint256 updatedAt);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ORACLE_UPDATER_ROLE, admin);
    }

    function setPrice(address token, uint256 priceE18) external onlyRole(ORACLE_UPDATER_ROLE) {
        _setPrice(token, priceE18, block.timestamp);
    }

    function setPriceWithTimestamp(
        address token,
        uint256 priceE18,
        uint256 updatedAt
    ) external onlyRole(ORACLE_UPDATER_ROLE) {
        _setPrice(token, priceE18, updatedAt);
    }

    function getPrice(address token) external view override returns (uint256 priceE18, uint256 updatedAt) {
        PriceData memory data = _prices[token];
        return (data.priceE18, data.updatedAt);
    }

    function _setPrice(address token, uint256 priceE18, uint256 updatedAt) internal {
        require(token != address(0), 'ORACLE_ZERO_TOKEN');
        require(priceE18 > 0, 'ORACLE_ZERO_PRICE');
        require(updatedAt > 0, 'ORACLE_ZERO_TIMESTAMP');
        _prices[token] = PriceData({priceE18: priceE18, updatedAt: updatedAt});
        emit PriceUpdated(token, priceE18, updatedAt);
    }
}
