// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import {Ownable2Step} from '@openzeppelin/contracts/access/Ownable2Step.sol';
import {Pausable} from '@openzeppelin/contracts/utils/Pausable.sol';

import {HarmonyPair} from './HarmonyPair.sol';

contract HarmonyFactory is Ownable2Step, Pausable {
    uint16 public constant MAX_SWAP_FEE_BPS = 1_000;
    uint16 public constant MAX_PROTOCOL_FEE_BPS = 30;

    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    uint16 public swapFeeBps;
    uint16 public protocolFeeBps;
    address public treasury;

    event PairCreated(address indexed token0, address indexed token1, address pair, uint256 pairIndex);
    event SwapFeeUpdated(uint16 previousFeeBps, uint16 newFeeBps);
    event ProtocolFeeUpdated(uint16 previousProtocolFeeBps, uint16 newProtocolFeeBps);
    event FeeUpdated(uint16 previousSwapFeeBps, uint16 newSwapFeeBps, uint16 previousProtocolFeeBps, uint16 newProtocolFeeBps);
    event TreasuryAddressUpdated(address indexed previousTreasury, address indexed newTreasury);

    error IdenticalAddresses();
    error ZeroAddress();
    error PairAlreadyExists();
    error InvalidFee();
    error InvalidProtocolFee();
    error InvalidTreasury();

    constructor(address initialOwner) Ownable(initialOwner) {
        swapFeeBps = 30;
        protocolFeeBps = 5;
    }

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    function createPair(address tokenA, address tokenB) external whenNotPaused returns (address pair) {
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
        if (newSwapFeeBps > MAX_SWAP_FEE_BPS || newSwapFeeBps < protocolFeeBps) revert InvalidFee();
        uint16 previous = swapFeeBps;
        swapFeeBps = newSwapFeeBps;
        emit SwapFeeUpdated(previous, newSwapFeeBps);
    }

    function setProtocolFeeBps(uint16 newProtocolFeeBps) external onlyOwner {
        if (newProtocolFeeBps > MAX_PROTOCOL_FEE_BPS || newProtocolFeeBps > swapFeeBps) revert InvalidProtocolFee();
        uint16 previous = protocolFeeBps;
        protocolFeeBps = newProtocolFeeBps;
        emit ProtocolFeeUpdated(previous, newProtocolFeeBps);
    }

    function setFeeParams(uint16 newSwapFeeBps, uint16 newProtocolFeeBps) external onlyOwner {
        if (newSwapFeeBps > MAX_SWAP_FEE_BPS) revert InvalidFee();
        if (newProtocolFeeBps > MAX_PROTOCOL_FEE_BPS || newProtocolFeeBps > newSwapFeeBps) {
            revert InvalidProtocolFee();
        }
        uint16 previousSwap = swapFeeBps;
        uint16 previousProtocol = protocolFeeBps;
        swapFeeBps = newSwapFeeBps;
        protocolFeeBps = newProtocolFeeBps;
        emit FeeUpdated(previousSwap, newSwapFeeBps, previousProtocol, newProtocolFeeBps);
        emit SwapFeeUpdated(previousSwap, newSwapFeeBps);
        emit ProtocolFeeUpdated(previousProtocol, newProtocolFeeBps);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert InvalidTreasury();
        address previous = treasury;
        treasury = newTreasury;
        emit TreasuryAddressUpdated(previous, newTreasury);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
