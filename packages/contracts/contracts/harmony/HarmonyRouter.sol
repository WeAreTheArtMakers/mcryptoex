// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import {Ownable2Step} from '@openzeppelin/contracts/access/Ownable2Step.sol';
import {Pausable} from '@openzeppelin/contracts/utils/Pausable.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';

import {IHarmonyFactory} from './interfaces/IHarmonyFactory.sol';
import {IHarmonyPair} from './interfaces/IHarmonyPair.sol';
import {HarmonyLibrary} from './libraries/HarmonyLibrary.sol';
import {TransferHelper} from './libraries/TransferHelper.sol';

contract HarmonyRouter is Ownable2Step, Pausable, ReentrancyGuard {
    using HarmonyLibrary for address;

    uint8 public constant MAX_ALLOWED_PATH_LENGTH = 8;

    address public immutable factory;
    uint8 public maxPathLength;

    event NoteLiquidityAdded(
        address indexed sender,
        address indexed tokenA,
        address indexed tokenB,
        uint256 amountA,
        uint256 amountB,
        uint256 liquidity,
        address to
    );

    event NoteLiquidityRemoved(
        address indexed sender,
        address indexed tokenA,
        address indexed tokenB,
        uint256 amountA,
        uint256 amountB,
        uint256 liquidity,
        address to
    );

    event NoteSwap(
        address indexed sender,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address to
    );
    event MaxPathLengthUpdated(uint8 previousPathLength, uint8 newPathLength);

    error InvalidFactory();
    error Expired(uint256 deadline, uint256 blockTimestamp);
    error InsufficientAAmount(uint256 expectedMin, uint256 actual);
    error InsufficientBAmount(uint256 expectedMin, uint256 actual);
    error InsufficientOutput(uint256 expectedMin, uint256 actual);
    error InvalidPathLength(uint8 pathLength);

    modifier ensure(uint256 deadline) {
        if (deadline < block.timestamp) revert Expired(deadline, block.timestamp);
        _;
    }

    constructor(address factoryAddress) Ownable(msg.sender) {
        if (factoryAddress == address(0)) revert InvalidFactory();
        factory = factoryAddress;
        maxPathLength = 4;
    }

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external ensure(deadline) whenNotPaused nonReentrant returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        if (IHarmonyFactory(factory).getPair(tokenA, tokenB) == address(0)) {
            IHarmonyFactory(factory).createPair(tokenA, tokenB);
        }

        (amountA, amountB) = _calculateLiquidity(tokenA, tokenB, amountADesired, amountBDesired, amountAMin, amountBMin);

        address pair = HarmonyLibrary.pairFor(factory, tokenA, tokenB);
        TransferHelper.safeTransferFrom(tokenA, msg.sender, pair, amountA);
        TransferHelper.safeTransferFrom(tokenB, msg.sender, pair, amountB);

        liquidity = IHarmonyPair(pair).mint(to);

        emit NoteLiquidityAdded(msg.sender, tokenA, tokenB, amountA, amountB, liquidity, to);
    }

    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external ensure(deadline) whenNotPaused nonReentrant returns (uint256 amountA, uint256 amountB) {
        address pair = HarmonyLibrary.pairFor(factory, tokenA, tokenB);
        IHarmonyPair(pair).transferFrom(msg.sender, pair, liquidity);

        (uint256 amount0, uint256 amount1) = IHarmonyPair(pair).burn(to);
        (address token0, ) = HarmonyLibrary.sortTokens(tokenA, tokenB);
        (amountA, amountB) = tokenA == token0 ? (amount0, amount1) : (amount1, amount0);

        if (amountA < amountAMin) revert InsufficientAAmount(amountAMin, amountA);
        if (amountB < amountBMin) revert InsufficientBAmount(amountBMin, amountB);

        emit NoteLiquidityRemoved(msg.sender, tokenA, tokenB, amountA, amountB, liquidity, to);
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) whenNotPaused nonReentrant returns (uint256[] memory amounts) {
        if (path.length > maxPathLength || path.length < 2) revert InvalidPathLength(uint8(path.length));
        amounts = HarmonyLibrary.getAmountsOut(factory, amountIn, path);
        uint256 amountOut = amounts[amounts.length - 1];
        if (amountOut < amountOutMin) revert InsufficientOutput(amountOutMin, amountOut);

        TransferHelper.safeTransferFrom(
            path[0],
            msg.sender,
            HarmonyLibrary.pairFor(factory, path[0], path[1]),
            amounts[0]
        );

        _swap(amounts, path, to);

        emit NoteSwap(msg.sender, path[0], path[path.length - 1], amounts[0], amountOut, to);
    }

    function setMaxPathLength(uint8 newPathLength) external onlyOwner {
        if (newPathLength < 2 || newPathLength > MAX_ALLOWED_PATH_LENGTH) {
            revert InvalidPathLength(newPathLength);
        }
        uint8 previous = maxPathLength;
        maxPathLength = newPathLength;
        emit MaxPathLengthUpdated(previous, newPathLength);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts) {
        amounts = HarmonyLibrary.getAmountsOut(factory, amountIn, path);
    }

    function _swap(uint256[] memory amounts, address[] calldata path, address _to) internal {
        for (uint256 i = 0; i < path.length - 1; i++) {
            (address input, address output) = (path[i], path[i + 1]);
            (address token0, ) = HarmonyLibrary.sortTokens(input, output);

            uint256 amountOut = amounts[i + 1];
            (uint256 amount0Out, uint256 amount1Out) = input == token0
                ? (uint256(0), amountOut)
                : (amountOut, uint256(0));

            address to = i < path.length - 2
                ? HarmonyLibrary.pairFor(factory, output, path[i + 2])
                : _to;

            IHarmonyPair(HarmonyLibrary.pairFor(factory, input, output)).swap(amount0Out, amount1Out, to);
        }
    }

    function _calculateLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin
    ) internal view returns (uint256 amountA, uint256 amountB) {
        (uint256 reserveA, uint256 reserveB) = HarmonyLibrary.getReserves(factory, tokenA, tokenB);
        if (reserveA == 0 && reserveB == 0) {
            (amountA, amountB) = (amountADesired, amountBDesired);
        } else {
            uint256 amountBOptimal = HarmonyLibrary.quote(amountADesired, reserveA, reserveB);
            if (amountBOptimal <= amountBDesired) {
                if (amountBOptimal < amountBMin) revert InsufficientBAmount(amountBMin, amountBOptimal);
                (amountA, amountB) = (amountADesired, amountBOptimal);
            } else {
                uint256 amountAOptimal = HarmonyLibrary.quote(amountBDesired, reserveB, reserveA);
                if (amountAOptimal < amountAMin) revert InsufficientAAmount(amountAMin, amountAOptimal);
                (amountA, amountB) = (amountAOptimal, amountBDesired);
            }
        }
    }
}
