// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IHarmonyFactory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);

    function createPair(address tokenA, address tokenB) external returns (address pair);

    function swapFeeBps() external view returns (uint16);

    function protocolFeeBps() external view returns (uint16);

    function treasury() external view returns (address);

    function paused() external view returns (bool);
}
