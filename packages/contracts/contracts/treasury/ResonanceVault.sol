// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import {Ownable2Step} from '@openzeppelin/contracts/access/Ownable2Step.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {Pausable} from '@openzeppelin/contracts/utils/Pausable.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';

import {IHarmonyFactory} from '../harmony/interfaces/IHarmonyFactory.sol';
import {IHarmonyPair} from '../harmony/interfaces/IHarmonyPair.sol';

interface IHarmonyRouterLike {
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts);

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

contract ResonanceVault is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint16 public constant MAX_SLIPPAGE_BPS = 1_000;
    uint16 public constant MAX_HARVEST_INCENTIVE_BPS = 100;

    bytes32 public constant BUCKET_OPS = keccak256('BUCKET_OPS');
    bytes32 public constant BUCKET_LIQUIDITY = keccak256('BUCKET_LIQUIDITY');
    bytes32 public constant BUCKET_RESERVE = keccak256('BUCKET_RESERVE');

    address public immutable router;
    address public immutable musd;
    address public immutable factory;

    uint16 public maxSlippageBps;
    uint16 public harvestIncentiveBps;

    address public opsBudgetAddress;
    address public liquidityIncentivesAddress;
    address public reserveOrBuybackAddress;

    uint16 public opsBudgetBps;
    uint16 public liquidityIncentivesBps;
    uint16 public reserveOrBuybackBps;

    mapping(address => bool) public tokenAllowlist;
    mapping(address => uint256) public maxConvertAmountPerCall;

    event FeeReceived(address indexed token, uint256 amount, address indexed fromPair);
    event Converted(
        address indexed tokenIn,
        uint256 amountIn,
        uint256 minOut,
        uint256 musdOut,
        address[] path,
        address indexed caller
    );
    event DistributionExecuted(bytes32 indexed bucket, address indexed recipient, uint256 amount);
    event TokenAllowlistUpdated(address indexed token, bool allowed);
    event MaxConvertAmountUpdated(address indexed token, uint256 maxAmountPerCall);
    event SlippageLimitsUpdated(uint16 previousMaxSlippageBps, uint16 newMaxSlippageBps);
    event HarvestIncentiveUpdated(uint16 previousIncentiveBps, uint16 newIncentiveBps);
    event DistributionConfigUpdated(
        address indexed opsBudgetAddress,
        address indexed liquidityIncentivesAddress,
        address indexed reserveOrBuybackAddress,
        uint16 opsBudgetBps,
        uint16 liquidityIncentivesBps,
        uint16 reserveOrBuybackBps
    );

    error InvalidAddress();
    error InvalidBps();
    error TokenNotAllowed(address token);
    error InvalidPath();
    error InvalidAmount();
    error SlippageLimitExceeded(uint256 minOut, uint256 minAllowedOut);
    error UnknownPair(address pair);
    error DistributionNotConfigured();

    constructor(address routerAddress, address musdAddress, address factoryAddress, address initialOwner) Ownable(initialOwner) {
        if (routerAddress == address(0) || musdAddress == address(0) || factoryAddress == address(0)) {
            revert InvalidAddress();
        }
        router = routerAddress;
        musd = musdAddress;
        factory = factoryAddress;
        maxSlippageBps = 150;
        harvestIncentiveBps = 10;
        _setDistribution(initialOwner, initialOwner, initialOwner, 4_000, 4_000, 2_000);
    }

    function onProtocolFeeReceived(address token, uint256 amount, address fromPair) external {
        if (msg.sender != fromPair) revert UnknownPair(msg.sender);
        if (!_isKnownPair(fromPair)) revert UnknownPair(fromPair);
        emit FeeReceived(token, amount, fromPair);
    }

    function setTokenAllowlist(address token, bool allowed) external onlyOwner {
        if (token == address(0)) revert InvalidAddress();
        tokenAllowlist[token] = allowed;
        emit TokenAllowlistUpdated(token, allowed);
    }

    function setMaxConvertAmountPerCall(address token, uint256 maxAmount) external onlyOwner {
        if (token == address(0)) revert InvalidAddress();
        maxConvertAmountPerCall[token] = maxAmount;
        emit MaxConvertAmountUpdated(token, maxAmount);
    }

    function setSlippageLimits(uint16 newMaxSlippageBps) external onlyOwner {
        if (newMaxSlippageBps > MAX_SLIPPAGE_BPS) revert InvalidBps();
        uint16 previous = maxSlippageBps;
        maxSlippageBps = newMaxSlippageBps;
        emit SlippageLimitsUpdated(previous, newMaxSlippageBps);
    }

    function setHarvestIncentiveBps(uint16 newHarvestIncentiveBps) external onlyOwner {
        if (newHarvestIncentiveBps > MAX_HARVEST_INCENTIVE_BPS) revert InvalidBps();
        uint16 previous = harvestIncentiveBps;
        harvestIncentiveBps = newHarvestIncentiveBps;
        emit HarvestIncentiveUpdated(previous, newHarvestIncentiveBps);
    }

    function setDistributionConfig(
        address newOpsBudgetAddress,
        address newLiquidityIncentivesAddress,
        address newReserveOrBuybackAddress,
        uint16 newOpsBudgetBps,
        uint16 newLiquidityIncentivesBps,
        uint16 newReserveOrBuybackBps
    ) external onlyOwner {
        _setDistribution(
            newOpsBudgetAddress,
            newLiquidityIncentivesAddress,
            newReserveOrBuybackAddress,
            newOpsBudgetBps,
            newLiquidityIncentivesBps,
            newReserveOrBuybackBps
        );
    }

    function harvestAndConvert(
        address tokenIn,
        uint256 amountIn,
        uint256 minOut,
        uint256 deadline,
        address[] calldata path
    ) external whenNotPaused nonReentrant returns (uint256 musdOut, uint256 callerIncentiveOut) {
        if (!tokenAllowlist[tokenIn]) revert TokenNotAllowed(tokenIn);
        if (amountIn == 0) revert InvalidAmount();
        if (path.length < 2 || path[0] != tokenIn || path[path.length - 1] != musd) revert InvalidPath();

        uint256 maxAmountPerCall = maxConvertAmountPerCall[tokenIn];
        if (maxAmountPerCall > 0 && amountIn > maxAmountPerCall) revert InvalidAmount();

        uint256[] memory quoted = IHarmonyRouterLike(router).getAmountsOut(amountIn, path);
        uint256 quotedOut = quoted[quoted.length - 1];
        uint256 minAllowedOut = (quotedOut * (BPS - maxSlippageBps)) / BPS;
        if (minOut < minAllowedOut) revert SlippageLimitExceeded(minOut, minAllowedOut);

        IERC20(tokenIn).forceApprove(router, 0);
        IERC20(tokenIn).forceApprove(router, amountIn);

        uint256[] memory amounts = IHarmonyRouterLike(router).swapExactTokensForTokens(
            amountIn,
            minOut,
            path,
            address(this),
            deadline
        );
        musdOut = amounts[amounts.length - 1];
        emit Converted(tokenIn, amountIn, minOut, musdOut, path, msg.sender);

        if (harvestIncentiveBps > 0 && musdOut > 0) {
            callerIncentiveOut = (musdOut * harvestIncentiveBps) / BPS;
            if (callerIncentiveOut > 0) {
                IERC20(musd).safeTransfer(msg.sender, callerIncentiveOut);
            }
        }
    }

    function distributeMusd(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (
            opsBudgetAddress == address(0) ||
            liquidityIncentivesAddress == address(0) ||
            reserveOrBuybackAddress == address(0)
        ) {
            revert DistributionNotConfigured();
        }

        uint256 opsAmount = (amount * opsBudgetBps) / BPS;
        uint256 liquidityAmount = (amount * liquidityIncentivesBps) / BPS;
        uint256 reserveAmount = amount - opsAmount - liquidityAmount;

        if (opsAmount > 0) {
            IERC20(musd).safeTransfer(opsBudgetAddress, opsAmount);
            emit DistributionExecuted(BUCKET_OPS, opsBudgetAddress, opsAmount);
        }
        if (liquidityAmount > 0) {
            IERC20(musd).safeTransfer(liquidityIncentivesAddress, liquidityAmount);
            emit DistributionExecuted(BUCKET_LIQUIDITY, liquidityIncentivesAddress, liquidityAmount);
        }
        if (reserveAmount > 0) {
            IERC20(musd).safeTransfer(reserveOrBuybackAddress, reserveAmount);
            emit DistributionExecuted(BUCKET_RESERVE, reserveOrBuybackAddress, reserveAmount);
        }
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function _setDistribution(
        address newOpsBudgetAddress,
        address newLiquidityIncentivesAddress,
        address newReserveOrBuybackAddress,
        uint16 newOpsBudgetBps,
        uint16 newLiquidityIncentivesBps,
        uint16 newReserveOrBuybackBps
    ) internal {
        if (
            newOpsBudgetAddress == address(0) ||
            newLiquidityIncentivesAddress == address(0) ||
            newReserveOrBuybackAddress == address(0)
        ) {
            revert InvalidAddress();
        }
        uint16 total = newOpsBudgetBps + newLiquidityIncentivesBps + newReserveOrBuybackBps;
        if (total != BPS) revert InvalidBps();

        opsBudgetAddress = newOpsBudgetAddress;
        liquidityIncentivesAddress = newLiquidityIncentivesAddress;
        reserveOrBuybackAddress = newReserveOrBuybackAddress;
        opsBudgetBps = newOpsBudgetBps;
        liquidityIncentivesBps = newLiquidityIncentivesBps;
        reserveOrBuybackBps = newReserveOrBuybackBps;

        emit DistributionConfigUpdated(
            newOpsBudgetAddress,
            newLiquidityIncentivesAddress,
            newReserveOrBuybackAddress,
            newOpsBudgetBps,
            newLiquidityIncentivesBps,
            newReserveOrBuybackBps
        );
    }

    function _isKnownPair(address pair) internal view returns (bool) {
        address token0;
        address token1;
        try IHarmonyPair(pair).token0() returns (address _token0) {
            token0 = _token0;
        } catch {
            return false;
        }

        try IHarmonyPair(pair).token1() returns (address _token1) {
            token1 = _token1;
        } catch {
            return false;
        }

        address expectedPair = IHarmonyFactory(factory).getPair(token0, token1);
        return expectedPair == pair;
    }
}
