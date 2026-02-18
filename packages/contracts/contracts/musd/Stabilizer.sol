// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from '@openzeppelin/contracts/access/AccessControl.sol';
import {IERC20Metadata} from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {Pausable} from '@openzeppelin/contracts/utils/Pausable.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';

import {IPriceOracle} from '../interfaces/IPriceOracle.sol';
import {MUSDToken} from './MUSDToken.sol';

contract Stabilizer is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20Metadata;
    using SafeERC20 for MUSDToken;

    uint256 public constant BPS = 10_000;

    bytes32 public constant GOVERNOR_ROLE = keccak256('GOVERNOR_ROLE');
    bytes32 public constant OPERATOR_ROLE = keccak256('OPERATOR_ROLE');
    bytes32 public constant PAUSER_ROLE = keccak256('PAUSER_ROLE');

    struct CollateralConfig {
        bool enabled;
        uint8 decimals;
        uint256 minOraclePriceE18;
        uint256 maxOraclePriceE18;
        bool exists;
    }

    MUSDToken public immutable musd;
    IPriceOracle public oracle;

    uint256 public maxMintPerBlock;
    uint256 public oracleStalenessThreshold;
    uint256 public minCollateralRatioBps;
    uint256 public emergencyCollateralRatioBps;

    bool public circuitBreakerTripped;

    mapping(address => CollateralConfig) public collateralConfig;
    mapping(address => uint256) public collateralBalance;
    mapping(uint256 => uint256) public mintedPerBlock;

    address[] private _collateralTokens;

    event CollateralConfigured(
        address indexed token,
        bool enabled,
        uint8 decimals,
        uint256 minOraclePriceE18,
        uint256 maxOraclePriceE18
    );
    event OracleUpdated(address indexed previousOracle, address indexed newOracle);
    event OracleStalenessUpdated(uint256 previousThreshold, uint256 newThreshold);
    event CollateralRatiosUpdated(uint256 minRatioBps, uint256 emergencyRatioBps);
    event MaxMintPerBlockUpdated(uint256 previousLimit, uint256 newLimit);

    event NoteMinted(
        address indexed user,
        address indexed token,
        uint256 collateralIn,
        uint256 musdOut,
        uint256 priceE18,
        address recipient
    );
    event NoteBurned(
        address indexed user,
        address indexed token,
        uint256 musdIn,
        uint256 collateralOut,
        uint256 priceE18,
        address recipient
    );
    event ReserveDeposited(address indexed token, uint256 amount, address indexed sender);
    event ReserveWithdrawn(address indexed token, uint256 amount, address indexed recipient, address indexed operator);
    event CircuitBreakerTripped(uint256 collateralRatioBps, uint256 emergencyThresholdBps);
    event CircuitBreakerReset(uint256 collateralRatioBps);

    error InvalidAddress();
    error InvalidAmount();
    error CollateralNotEnabled(address token);
    error OraclePriceOutOfBounds(address token, uint256 priceE18);
    error OracleDataStale(address token, uint256 updatedAt);
    error SlippageExceeded(uint256 expected, uint256 actual);
    error MintLimitExceeded(uint256 attempted, uint256 allowed);
    error CircuitBreakerActive();
    error CollateralRatioUnsafe(uint256 ratioBps, uint256 requiredBps);

    constructor(address musdAddress, address oracleAddress, address admin) {
        if (musdAddress == address(0) || oracleAddress == address(0) || admin == address(0)) revert InvalidAddress();

        musd = MUSDToken(musdAddress);
        oracle = IPriceOracle(oracleAddress);

        maxMintPerBlock = 1_000_000 ether;
        oracleStalenessThreshold = 1 hours;
        minCollateralRatioBps = 11_000;
        emergencyCollateralRatioBps = 10_300;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNOR_ROLE, admin);
        _grantRole(OPERATOR_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    function configureCollateral(
        address token,
        bool enabled,
        uint256 minOraclePriceE18,
        uint256 maxOraclePriceE18
    ) external onlyRole(GOVERNOR_ROLE) {
        if (token == address(0)) revert InvalidAddress();
        if (minOraclePriceE18 == 0 || maxOraclePriceE18 < minOraclePriceE18) revert InvalidAmount();

        CollateralConfig storage config = collateralConfig[token];
        if (!config.exists) {
            config.decimals = IERC20Metadata(token).decimals();
            config.exists = true;
            _collateralTokens.push(token);
        }

        config.enabled = enabled;
        config.minOraclePriceE18 = minOraclePriceE18;
        config.maxOraclePriceE18 = maxOraclePriceE18;

        emit CollateralConfigured(
            token,
            enabled,
            config.decimals,
            minOraclePriceE18,
            maxOraclePriceE18
        );
    }

    function setOracle(address newOracle) external onlyRole(GOVERNOR_ROLE) {
        if (newOracle == address(0)) revert InvalidAddress();
        address previous = address(oracle);
        oracle = IPriceOracle(newOracle);
        emit OracleUpdated(previous, newOracle);
    }

    function setOracleStalenessThreshold(uint256 newThreshold) external onlyRole(GOVERNOR_ROLE) {
        if (newThreshold == 0) revert InvalidAmount();
        uint256 previous = oracleStalenessThreshold;
        oracleStalenessThreshold = newThreshold;
        emit OracleStalenessUpdated(previous, newThreshold);
    }

    function setCollateralRatios(
        uint256 newMinCollateralRatioBps,
        uint256 newEmergencyCollateralRatioBps
    ) external onlyRole(GOVERNOR_ROLE) {
        if (
            newMinCollateralRatioBps < BPS ||
            newEmergencyCollateralRatioBps < BPS ||
            newEmergencyCollateralRatioBps > newMinCollateralRatioBps
        ) {
            revert InvalidAmount();
        }

        minCollateralRatioBps = newMinCollateralRatioBps;
        emergencyCollateralRatioBps = newEmergencyCollateralRatioBps;
        emit CollateralRatiosUpdated(newMinCollateralRatioBps, newEmergencyCollateralRatioBps);
    }

    function setMaxMintPerBlock(uint256 newMaxMintPerBlock) external onlyRole(GOVERNOR_ROLE) {
        if (newMaxMintPerBlock == 0) revert InvalidAmount();
        uint256 previous = maxMintPerBlock;
        maxMintPerBlock = newMaxMintPerBlock;
        emit MaxMintPerBlockUpdated(previous, newMaxMintPerBlock);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        if (circuitBreakerTripped) revert CircuitBreakerActive();
        _unpause();
    }

    function mintWithCollateral(
        address token,
        uint256 collateralAmount,
        uint256 minMusdOut,
        address recipient
    ) external nonReentrant whenNotPaused returns (uint256 musdOut) {
        if (recipient == address(0)) revert InvalidAddress();
        if (collateralAmount == 0) revert InvalidAmount();

        CollateralConfig memory config = _requireEnabledCollateral(token);
        uint256 priceE18 = _readCheckedOraclePrice(token, config);

        IERC20Metadata(token).safeTransferFrom(msg.sender, address(this), collateralAmount);
        collateralBalance[token] += collateralAmount;

        uint256 usdValueE18 = _toUsdE18(collateralAmount, config.decimals, priceE18);
        musdOut = (usdValueE18 * BPS) / minCollateralRatioBps;
        if (musdOut == 0) revert InvalidAmount();
        if (musdOut < minMusdOut) revert SlippageExceeded(minMusdOut, musdOut);

        uint256 minted = mintedPerBlock[block.number] + musdOut;
        if (minted > maxMintPerBlock) revert MintLimitExceeded(minted, maxMintPerBlock);
        mintedPerBlock[block.number] = minted;

        musd.mint(recipient, musdOut);

        emit NoteMinted(msg.sender, token, collateralAmount, musdOut, priceE18, recipient);
        _tripCircuitBreakerIfNeeded();
    }

    function burnForCollateral(
        address token,
        uint256 musdAmount,
        uint256 minCollateralOut,
        address recipient
    ) external nonReentrant whenNotPaused returns (uint256 collateralOut) {
        if (recipient == address(0)) revert InvalidAddress();
        if (musdAmount == 0) revert InvalidAmount();

        CollateralConfig memory config = _requireEnabledCollateral(token);
        uint256 priceE18 = _readCheckedOraclePrice(token, config);

        musd.safeTransferFrom(msg.sender, address(this), musdAmount);
        musd.burn(musdAmount);

        collateralOut = _fromUsdE18(musdAmount, config.decimals, priceE18);
        if (collateralOut == 0 || collateralOut > collateralBalance[token]) revert InvalidAmount();
        if (collateralOut < minCollateralOut) revert SlippageExceeded(minCollateralOut, collateralOut);

        collateralBalance[token] -= collateralOut;
        IERC20Metadata(token).safeTransfer(recipient, collateralOut);

        emit NoteBurned(msg.sender, token, musdAmount, collateralOut, priceE18, recipient);
        _tripCircuitBreakerIfNeeded();
    }

    function depositReserve(address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        _requireEnabledCollateral(token);

        IERC20Metadata(token).safeTransferFrom(msg.sender, address(this), amount);
        collateralBalance[token] += amount;
        emit ReserveDeposited(token, amount, msg.sender);
    }

    function withdrawReserve(
        address token,
        uint256 amount,
        address recipient
    ) external onlyRole(OPERATOR_ROLE) nonReentrant {
        if (recipient == address(0)) revert InvalidAddress();
        if (amount == 0 || amount > collateralBalance[token]) revert InvalidAmount();
        _requireEnabledCollateral(token);

        collateralBalance[token] -= amount;
        if (musd.totalSupply() > 0) {
            uint256 ratioBps = getCollateralRatioBps();
            if (ratioBps < minCollateralRatioBps) revert CollateralRatioUnsafe(ratioBps, minCollateralRatioBps);
        }

        IERC20Metadata(token).safeTransfer(recipient, amount);
        emit ReserveWithdrawn(token, amount, recipient, msg.sender);
        _tripCircuitBreakerIfNeeded();
    }

    function checkAndTripCircuitBreaker() external returns (uint256 ratioBps) {
        ratioBps = getCollateralRatioBps();
        if (ratioBps < emergencyCollateralRatioBps && !circuitBreakerTripped) {
            circuitBreakerTripped = true;
            _pause();
            emit CircuitBreakerTripped(ratioBps, emergencyCollateralRatioBps);
        }
    }

    function resetCircuitBreaker() external onlyRole(GOVERNOR_ROLE) {
        if (!circuitBreakerTripped) revert InvalidAmount();
        uint256 ratioBps = getCollateralRatioBps();
        if (ratioBps < minCollateralRatioBps) revert CollateralRatioUnsafe(ratioBps, minCollateralRatioBps);

        circuitBreakerTripped = false;
        _unpause();
        emit CircuitBreakerReset(ratioBps);
    }

    function previewMint(address token, uint256 collateralAmount) external view returns (uint256 musdOut) {
        CollateralConfig memory config = _requireEnabledCollateral(token);
        (uint256 priceE18, ) = oracle.getPrice(token);
        uint256 usdValueE18 = _toUsdE18(collateralAmount, config.decimals, priceE18);
        musdOut = (usdValueE18 * BPS) / minCollateralRatioBps;
    }

    function previewBurn(address token, uint256 musdAmount) external view returns (uint256 collateralOut) {
        CollateralConfig memory config = _requireEnabledCollateral(token);
        (uint256 priceE18, ) = oracle.getPrice(token);
        collateralOut = _fromUsdE18(musdAmount, config.decimals, priceE18);
    }

    function collateralTokens() external view returns (address[] memory) {
        return _collateralTokens;
    }

    function totalReserveUsdE18() public view returns (uint256 totalUsdE18) {
        uint256 length = _collateralTokens.length;
        for (uint256 i = 0; i < length; i++) {
            address token = _collateralTokens[i];
            CollateralConfig memory config = collateralConfig[token];
            if (!config.enabled) continue;

            uint256 amount = collateralBalance[token];
            if (amount == 0) continue;

            uint256 priceE18 = _readCheckedOraclePrice(token, config);
            totalUsdE18 += _toUsdE18(amount, config.decimals, priceE18);
        }
    }

    function getCollateralRatioBps() public view returns (uint256 ratioBps) {
        uint256 supply = musd.totalSupply();
        if (supply == 0) {
            return type(uint256).max;
        }
        ratioBps = (totalReserveUsdE18() * BPS) / supply;
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view override(AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    function _tripCircuitBreakerIfNeeded() internal {
        if (circuitBreakerTripped || musd.totalSupply() == 0) {
            return;
        }

        uint256 ratioBps = getCollateralRatioBps();
        if (ratioBps < emergencyCollateralRatioBps) {
            circuitBreakerTripped = true;
            _pause();
            emit CircuitBreakerTripped(ratioBps, emergencyCollateralRatioBps);
        }
    }

    function _readCheckedOraclePrice(
        address token,
        CollateralConfig memory config
    ) internal view returns (uint256 priceE18) {
        uint256 updatedAt;
        (priceE18, updatedAt) = oracle.getPrice(token);
        if (priceE18 < config.minOraclePriceE18 || priceE18 > config.maxOraclePriceE18) {
            revert OraclePriceOutOfBounds(token, priceE18);
        }
        if (updatedAt + oracleStalenessThreshold < block.timestamp) {
            revert OracleDataStale(token, updatedAt);
        }
    }

    function _requireEnabledCollateral(address token) internal view returns (CollateralConfig memory config) {
        config = collateralConfig[token];
        if (!config.enabled) {
            revert CollateralNotEnabled(token);
        }
    }

    function _toUsdE18(uint256 amount, uint8 decimals, uint256 priceE18) internal pure returns (uint256 usdValueE18) {
        usdValueE18 = (amount * priceE18) / (10 ** decimals);
    }

    function _fromUsdE18(
        uint256 usdAmountE18,
        uint8 decimals,
        uint256 priceE18
    ) internal pure returns (uint256 amount) {
        amount = (usdAmountE18 * (10 ** decimals)) / priceE18;
    }
}
