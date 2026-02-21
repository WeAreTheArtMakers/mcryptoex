import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ethers, network } from 'hardhat';

type Registry = {
  contracts: {
    musd: string;
    harmonyFactory: string;
    harmonyRouter: string;
  };
  collaterals?: Array<{
    token: string;
    symbol?: string;
    decimals?: number;
  }>;
  targets?: Array<{
    token: string;
    symbol?: string;
  }>;
};

function registryPathForNetwork(): string {
  const explicit = process.env.ADDRESS_REGISTRY_PATH?.trim();
  if (explicit) return explicit;
  return join(__dirname, '..', 'deploy', `address-registry.${network.name}.json`);
}

function readRegistry(path: string): Registry {
  if (!existsSync(path)) {
    throw new Error(`registry file not found: ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Registry;
}

function amountEnv(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

function bpsEnv(name: string, fallback: number): bigint {
  const value = process.env[name]?.trim();
  if (!value) return BigInt(fallback);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return BigInt(fallback);
  return BigInt(Math.max(1, Math.min(9_999, parsed)));
}

function normalizeSymbol(symbol: string): string {
  return String(symbol || '').trim().toUpperCase();
}

function applyBps(amount: bigint, bps: bigint): bigint {
  return (amount * bps) / 10_000n;
}

function scaleAmount(amount: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (fromDecimals === toDecimals) return amount;
  if (toDecimals > fromDecimals) {
    return amount * 10n ** BigInt(toDecimals - fromDecimals);
  }
  return amount / 10n ** BigInt(fromDecimals - toDecimals);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const registry = readRegistry(registryPathForNetwork());

  const targetSymbol = normalizeSymbol(process.env.DEEPEN_TARGET_SYMBOL || 'USDC');
  const targetAddressFromEnv = process.env.DEEPEN_TARGET_TOKEN_ADDRESS?.trim() || '';
  const musdMintAmount = ethers.parseEther(amountEnv('DEEPEN_MUSD_MINT_AMOUNT', '1200'));
  const useSwapForTarget = normalizeSymbol(amountEnv('DEEPEN_USE_SWAP_FOR_TARGET', 'false')) === 'TRUE';
  const forceBalanced = normalizeSymbol(amountEnv('DEEPEN_FORCE_BALANCED', 'false')) === 'TRUE';
  const targetAmountOverride = process.env.DEEPEN_TARGET_TOKEN_AMOUNT?.trim() || '';
  const swapSplitBps = bpsEnv('DEEPEN_SWAP_SPLIT_BPS', 5000);
  const maxReserveDrainBps = bpsEnv('DEEPEN_MAX_RESERVE_DRAIN_BPS', 200);
  const slippageBps = bpsEnv('DEEPEN_SLIPPAGE_BPS', 100);
  const minLiquidityBps = bpsEnv('DEEPEN_MIN_LIQUIDITY_BPS', 9800);
  const deadlineSec = BigInt(Number.parseInt(amountEnv('DEEPEN_DEADLINE_SEC', '1200'), 10));
  const allowTargetMint = normalizeSymbol(amountEnv('DEEPEN_ALLOW_TARGET_MINT', 'true')) === 'TRUE';

  const musd = await ethers.getContractAt('MUSDToken', registry.contracts.musd);
  const router = await ethers.getContractAt('HarmonyRouter', registry.contracts.harmonyRouter);
  const factory = await ethers.getContractAt('HarmonyFactory', registry.contracts.harmonyFactory);

  const targetAddress =
    targetAddressFromEnv ||
    registry.collaterals?.find((item) => normalizeSymbol(item.symbol || '') === targetSymbol)?.token ||
    registry.targets?.find((item) => normalizeSymbol(item.symbol || '') === targetSymbol)?.token ||
    '';

  if (!targetAddress || !ethers.isAddress(targetAddress)) {
    throw new Error(`target token address not found for symbol=${targetSymbol}`);
  }

  const musdAddress = await musd.getAddress();
  let pairAddress = await factory.getPair(musdAddress, targetAddress);
  if (pairAddress === ethers.ZeroAddress) {
    console.log(`pair not found for mUSD/${targetSymbol}, creating...`);
    await (await factory.createPair(musdAddress, targetAddress)).wait();
    pairAddress = await factory.getPair(musdAddress, targetAddress);
  }
  if (pairAddress === ethers.ZeroAddress) {
    throw new Error(`failed to resolve pair for mUSD/${targetSymbol}`);
  }

  const pair = await ethers.getContractAt('HarmonyPair', pairAddress);
  const targetToken = await ethers.getContractAt(
    ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function decimals() view returns (uint8)'],
    targetAddress
  );
  const targetDecimals = Number(await targetToken.decimals());

  const token0 = (await pair.token0()).toLowerCase();
  const targetIsToken0 = token0 === targetAddress.toLowerCase();

  const beforeReserves = await pair.getReserves();
  const beforeReserveMusd = targetIsToken0 ? beforeReserves[1] : beforeReserves[0];
  const beforeReserveTarget = targetIsToken0 ? beforeReserves[0] : beforeReserves[1];

  console.log(`network=${network.name} chainId=${network.config.chainId}`);
  console.log(`deployer=${deployer.address}`);
  console.log(`pair=${pairAddress} target=${targetAddress} symbol=${targetSymbol}`);
  console.log(
    `reserves_before musd=${ethers.formatEther(beforeReserveMusd)} ${targetSymbol}=${ethers.formatUnits(beforeReserveTarget, targetDecimals)}`
  );

  console.log(`minting mUSD direct to deployer: +${ethers.formatEther(musdMintAmount)}`);
  await (await musd.mint(deployer.address, musdMintAmount)).wait();

  const deadline = BigInt(Math.floor(Date.now() / 1000)) + deadlineSec;
  const reserveMusd = beforeReserveMusd;
  const reserveTarget = beforeReserveTarget;
  const balancedTargetAmount = scaleAmount(musdMintAmount, 18, targetDecimals);
  const defaultTargetAmount = balancedTargetAmount > 0n ? balancedTargetAmount : ethers.parseUnits('1', targetDecimals);
  const explicitTargetAmount = targetAmountOverride ? ethers.parseUnits(targetAmountOverride, targetDecimals) : null;
  let targetForLp = explicitTargetAmount ?? defaultTargetAmount;

  if (!explicitTargetAmount && !forceBalanced && reserveMusd > 0n && reserveTarget > 0n) {
    const ratioTargetAmount = (musdMintAmount * reserveTarget) / reserveMusd;
    if (ratioTargetAmount > 0n) {
      targetForLp = ratioTargetAmount;
    }
  }

  let targetBalance = await targetToken.balanceOf(deployer.address);

  if (targetBalance < targetForLp && allowTargetMint) {
    const needed = targetForLp - targetBalance;
    try {
      const mintable = await ethers.getContractAt(['function mint(address,uint256) external'], targetAddress);
      console.log(`minting target token for LP: +${ethers.formatUnits(needed, targetDecimals)} ${targetSymbol}`);
      await (await mintable.mint(deployer.address, needed)).wait();
      targetBalance = await targetToken.balanceOf(deployer.address);
    } catch {
      // Fallback to optional mUSD->target swap path.
    }
  }

  if (targetBalance < targetForLp && useSwapForTarget) {
    const theoreticalMaxSwap = reserveMusd > 0n && maxReserveDrainBps < 10_000n
      ? (reserveMusd * maxReserveDrainBps) / (10_000n - maxReserveDrainBps)
      : 0n;
    const plannedSwap = applyBps(musdMintAmount, swapSplitBps);
    const swapMusdAmount = plannedSwap < theoreticalMaxSwap ? plannedSwap : theoreticalMaxSwap;

    if (swapMusdAmount > 0n) {
      await (await musd.approve(await router.getAddress(), swapMusdAmount)).wait();
      const quote = await router.getAmountsOut(swapMusdAmount, [musdAddress, targetAddress]);
      const expectedOut = quote[quote.length - 1];
      const minOut = applyBps(expectedOut, 10_000n - slippageBps);
      console.log(
        `swap leg (capped) mUSD->${targetSymbol}: in=${ethers.formatEther(swapMusdAmount)} expected_out=${ethers.formatUnits(expectedOut, targetDecimals)}`
      );
      await (
        await router.swapExactTokensForTokens(
          swapMusdAmount,
          minOut,
          [musdAddress, targetAddress],
          deployer.address,
          deadline
        )
      ).wait();
      targetBalance = await targetToken.balanceOf(deployer.address);
    }
  }

  if (targetBalance <= 0n) {
    throw new Error(
      `target balance is zero for ${targetSymbol}; cannot deepen mUSD/${targetSymbol}. Set DEEPEN_ALLOW_TARGET_MINT=true or fund target token.`
    );
  }

  if (targetBalance < targetForLp) {
    targetForLp = targetBalance;
  }

  const lpMusdAmount = musdMintAmount;

  await (await targetToken.approve(await router.getAddress(), targetForLp)).wait();
  await (await musd.approve(await router.getAddress(), lpMusdAmount)).wait();
  const minMusd = applyBps(lpMusdAmount, minLiquidityBps);
  const minTarget = applyBps(targetForLp, minLiquidityBps);

  console.log(
    `addLiquidity leg mUSD/${targetSymbol}: musd=${ethers.formatEther(lpMusdAmount)} target_raw=${targetForLp.toString()}`
  );
  await (
    await router.addLiquidity(
      musdAddress,
      targetAddress,
      lpMusdAmount,
      targetForLp,
      minMusd,
      minTarget,
      deployer.address,
      deadline
    )
  ).wait();

  const afterReserves = await pair.getReserves();
  const afterReserveMusd = targetIsToken0 ? afterReserves[1] : afterReserves[0];
  const afterReserveTarget = targetIsToken0 ? afterReserves[0] : afterReserves[1];
  const deltaMusd = afterReserveMusd - beforeReserveMusd;
  const deltaTarget = afterReserveTarget - beforeReserveTarget;

  console.log(`reserves_after musd=${ethers.formatEther(afterReserveMusd)} ${targetSymbol}=${ethers.formatUnits(afterReserveTarget, targetDecimals)}`);
  console.log(`delta_reserve musd=+${ethers.formatEther(deltaMusd)} ${targetSymbol}=+${ethers.formatUnits(deltaTarget, targetDecimals)}`);
  console.log('deepen complete');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
