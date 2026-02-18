// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import {Ownable2Step} from '@openzeppelin/contracts/access/Ownable2Step.sol';

import {HarmonyPair} from './HarmonyPair.sol';

contract HarmonyFactory is Ownable2Step {
    uint16 public constant MAX_SWAP_FEE_BPS = 1_000;

    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    uint16 public swapFeeBps;

    event PairCreated(address indexed token0, address indexed token1, address pair, uint256 pairIndex);
    event SwapFeeUpdated(uint16 previousFeeBps, uint16 newFeeBps);

    error IdenticalAddresses();
    error ZeroAddress();
    error PairAlreadyExists();
    error InvalidFee();

    constructor(address initialOwner) Ownable(initialOwner) {
        swapFeeBps = 30;
    }

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        if (tokenA == tokenB) revert IdenticalAddresses();

        (address token0, address token1) = tokenA < tokenB
            ? (tokenA, tokenB)
            : (tokenB, tokenA);
        if (token0 == address(0)) revert ZeroAddress();
        if (getPair[token0][token1] != address(0)) revert PairAlreadyExists();

        HarmonyPair newPair = new HarmonyPair();
        newPair.initialize(token0, token1);
        pair = address(newPair);

        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair;
        allPairs.push(pair);

        emit PairCreated(token0, token1, pair, allPairs.length);
    }

    function setSwapFeeBps(uint16 newSwapFeeBps) external onlyOwner {
        if (newSwapFeeBps > MAX_SWAP_FEE_BPS) revert InvalidFee();
        uint16 previous = swapFeeBps;
        swapFeeBps = newSwapFeeBps;
        emit SwapFeeUpdated(previous, newSwapFeeBps);
    }
}
