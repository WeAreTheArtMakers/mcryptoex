import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ethers, network } from 'hardhat';

type Registry = {
  contracts: {
    musd: string;
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
    decimals?: number;
  }>;
};

const WRAPPED_NATIVE_DEFAULTS: Record<number, { symbol: string; address: string }> = {
  97: { symbol: 'WBNB', address: '0xae13d989dac2f0debff460ac112a837c89baa7cd' },
  11155111: { symbol: 'WETH', address: '0xfff9976782d46cc05630d1f6ebab18b2324d6b14' }
};

const ROUTER_ABI = [
  'function getAmountsOut(uint256,address[]) view returns (uint256[])',
  'function getAmountsIn(uint256,address[]) view returns (uint256[])',
  'function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])'
] as const;

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function mint(address,uint256) external'
] as const;

const WRAPPED_NATIVE_ABI = ['function deposit() payable'] as const;

function registryPathForNetwork(): string {
  const explicit = process.env.ADDRESS_REGISTRY_PATH;
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  return join(__dirname, '..', 'deploy', `address-registry.${network.name}.json`);
}

function readRegistry(path: string): Registry {
  if (!existsSync(path)) {
    throw new Error(`registry file not found: ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Registry;
}

function normalizeSymbol(value: string): string {
  return String(value || '').trim().toUpperCase();
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => normalizeSymbol(item))
    .filter((item) => item.length > 0);
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function amountEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.trim() ? raw.trim() : fallback;
}

function bpsEnv(name: string, fallback: number): bigint {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return BigInt(fallback);
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) return BigInt(fallback);
  return BigInt(Math.max(0, Math.min(9_000, parsed)));
}

function defaultSeedAmount(symbol: string): string {
  const upper = normalizeSymbol(symbol);
  if (upper === 'WBTC') return '0.003';
  if (upper === 'WETH' || upper === 'WBNB') return '0.03';
  if (upper === 'WSOL') return '0.7';
  if (upper === 'WAVAX') return '1';
  if (upper === 'USDC' || upper === 'USDT') return '25';
  return '5';
}

function defaultReverseAmount(): string {
  return '4';
}

function resolveTokenAddress(registry: Registry, symbol: string, wrappedNativeAddress: string): string {
  const upper = normalizeSymbol(symbol);
  if (upper === 'MUSD') return registry.contracts.musd;

  const fromEnv = process.env[`OHLC_SEED_TOKEN_${upper}_ADDRESS`];
  if (fromEnv && ethers.isAddress(fromEnv.trim())) {
    return fromEnv.trim();
  }

  for (const item of registry.targets || []) {
    if (normalizeSymbol(item.symbol || '') === upper && ethers.isAddress(item.token)) {
      return item.token;
    }
  }
  for (const item of registry.collaterals || []) {
    if (normalizeSymbol(item.symbol || '') === upper && ethers.isAddress(item.token)) {
      return item.token;
    }
  }

  if ((upper === 'WBNB' || upper === 'WETH') && ethers.isAddress(wrappedNativeAddress)) {
    return wrappedNativeAddress;
  }
  return '';
}

function collectSymbols(registry: Registry, wrappedNativeSymbol: string): string[] {
  const explicit = parseCsv(process.env.OHLC_SEED_SYMBOLS);
  const fallback = new Set<string>([
    wrappedNativeSymbol,
    'USDC',
    'USDT',
    'WBTC',
    'WETH',
    'WSOL',
    'WAVAX',
    ...((registry.targets || []).map((item) => normalizeSymbol(item.symbol || ''))),
    ...((registry.collaterals || []).map((item) => normalizeSymbol(item.symbol || '')))
  ]);
  const symbols = explicit.length ? explicit : Array.from(fallback.values());
  return symbols.filter((symbol) => symbol && symbol !== 'MUSD');
}

async function ensureBalance(params: {
  tokenAddress: string;
  tokenSymbol: string;
  owner: string;
  required: bigint;
  wrappedNativeAddress: string;
  signer: Awaited<ReturnType<typeof ethers.getSigners>>[number];
}): Promise<void> {
  const { tokenAddress, tokenSymbol, owner, required, wrappedNativeAddress, signer } = params;
  const token = await ethers.getContractAt(ERC20_ABI, tokenAddress);
  const current = (await token.balanceOf(owner)) as bigint;
  if (current >= required) return;
  const deficit = required - current;

  if (tokenAddress.toLowerCase() === wrappedNativeAddress.toLowerCase()) {
    const native = await ethers.provider.getBalance(owner);
    if (native >= deficit) {
      const wrapped = await ethers.getContractAt(WRAPPED_NATIVE_ABI, tokenAddress);
      await (await wrapped.deposit({ value: deficit })).wait();
      const afterWrap = (await token.balanceOf(owner)) as bigint;
      if (afterWrap >= required) return;
    }
  }

  try {
    await (await token.mint(owner, deficit)).wait();
  } catch {
    throw new Error(
      `insufficient ${tokenSymbol}. required=${required.toString()} current=${current.toString()} and mint failed`
    );
  }
}

async function ensureApproval(tokenAddress: string, owner: string, spender: string, required: bigint): Promise<void> {
  const token = await ethers.getContractAt(ERC20_ABI, tokenAddress);
  const allowance = (await token.allowance(owner, spender)) as bigint;
  if (allowance >= required) return;
  await (await token.approve(spender, ethers.MaxUint256)).wait();
}

async function swapOnce(params: {
  routerAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  slippageBps: bigint;
  recipient: string;
}): Promise<{ txHash: string; amountOut: bigint }> {
  const router = await ethers.getContractAt(ROUTER_ABI, params.routerAddress);
  const path = [params.tokenIn, params.tokenOut];
  const quoted = (await router.getAmountsOut(params.amountIn, path)) as bigint[];
  const expectedOut = quoted[quoted.length - 1];
  if (expectedOut <= 0n) {
    throw new Error('quote returned zero output');
  }
  const minOut = (expectedOut * (10_000n - params.slippageBps)) / 10_000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1_200);
  const tx = await router.swapExactTokensForTokens(params.amountIn, minOut, path, params.recipient, deadline);
  await tx.wait();
  return { txHash: tx.hash, amountOut: expectedOut };
}

async function quoteAmountOut(
  router: Awaited<ReturnType<typeof ethers.getContractAt<typeof ROUTER_ABI>>>,
  amountIn: bigint,
  path: string[]
): Promise<bigint | null> {
  if (amountIn <= 0n) return 0n;
  try {
    const quoted = (await router.getAmountsOut(amountIn, path)) as bigint[];
    return quoted[quoted.length - 1];
  } catch {
    return null;
  }
}

async function estimateInputForTargetOut(params: {
  router: Awaited<ReturnType<typeof ethers.getContractAt<typeof ROUTER_ABI>>>;
  path: string[];
  targetOut: bigint;
  maxInput: bigint;
}): Promise<bigint | null> {
  const { router, path, targetOut, maxInput } = params;
  if (targetOut <= 0n || maxInput <= 0n) return null;
  const maxOut = await quoteAmountOut(router, maxInput, path);
  if (maxOut === null || maxOut < targetOut) return null;

  let low = 1n;
  let high = maxInput;
  while (low < high) {
    const mid = low + (high - low) / 2n;
    const out = await quoteAmountOut(router, mid, path);
    if (out === null) return null;
    if (out >= targetOut) {
      high = mid;
    } else {
      low = mid + 1n;
    }
  }
  return low;
}

async function tokenMeta(tokenAddress: string): Promise<{ symbol: string; decimals: number }> {
  const token = await ethers.getContractAt(ERC20_ABI, tokenAddress);
  const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
  return {
    symbol: normalizeSymbol(symbol),
    decimals: Number(decimals)
  };
}

async function acquireTokenWithMusd(params: {
  routerAddress: string;
  musdAddress: string;
  targetTokenAddress: string;
  targetTokenSymbol: string;
  owner: string;
  requiredTargetAmount: bigint;
  wrappedNativeAddress: string;
  signer: Awaited<ReturnType<typeof ethers.getSigners>>[number];
  slippageBps: bigint;
  bufferBps: bigint;
  musdSymbol: string;
  musdDecimals: number;
}): Promise<bigint> {
  const {
    routerAddress,
    musdAddress,
    targetTokenAddress,
    targetTokenSymbol,
    owner,
    requiredTargetAmount,
    wrappedNativeAddress,
    signer,
    slippageBps,
    bufferBps,
    musdSymbol,
    musdDecimals
  } = params;

  if (targetTokenAddress.toLowerCase() === musdAddress.toLowerCase()) return requiredTargetAmount;

  const targetToken = await ethers.getContractAt(ERC20_ABI, targetTokenAddress);
  const current = (await targetToken.balanceOf(owner)) as bigint;
  if (current >= requiredTargetAmount) return current;

  const deficit = requiredTargetAmount - current;
  const router = await ethers.getContractAt(ROUTER_ABI, routerAddress);
  const path = [musdAddress, targetTokenAddress];
  let amountsIn: bigint[];
  try {
    amountsIn = (await router.getAmountsIn(deficit, path)) as bigint[];
  } catch (getAmountsInError) {
    const maxMusdInText = amountEnv('OHLC_SEED_ACQUIRE_MAX_MUSD_IN', '1500');
    let maxMusdIn: bigint;
    try {
      maxMusdIn = ethers.parseUnits(maxMusdInText, musdDecimals);
    } catch {
      maxMusdIn = ethers.parseUnits('1500', musdDecimals);
    }
    const estimatedIn = await estimateInputForTargetOut({
      router,
      path,
      targetOut: deficit,
      maxInput: maxMusdIn
    });
    if (!estimatedIn || estimatedIn <= 0n) {
      console.log(
        `skip acquire ${targetTokenSymbol}: router getAmountsIn unavailable and fallback estimate failed (${getAmountsInError instanceof Error ? getAmountsInError.message : 'no reason'})`
      );
      return current;
    }
    amountsIn = [estimatedIn, deficit];
    console.log(
      `fallback acquire quote ${musdSymbol}->${targetTokenSymbol}: targetOut=${deficit.toString()} estimatedIn=${estimatedIn.toString()}`
    );
  }

  const quotedMusdIn = amountsIn[0];
  const bufferedMusdIn = (quotedMusdIn * (10_000n + bufferBps)) / 10_000n;
  if (bufferedMusdIn <= 0n) return current;

  await ensureBalance({
    tokenAddress: musdAddress,
    tokenSymbol: musdSymbol,
    owner,
    required: bufferedMusdIn,
    wrappedNativeAddress,
    signer
  });
  await ensureApproval(musdAddress, owner, routerAddress, bufferedMusdIn);
  await swapOnce({
    routerAddress,
    tokenIn: musdAddress,
    tokenOut: targetTokenAddress,
    amountIn: bufferedMusdIn,
    slippageBps,
    recipient: owner
  });

  const after = (await targetToken.balanceOf(owner)) as bigint;
  if (after >= requiredTargetAmount) {
    console.log(
      `acquired ${targetTokenSymbol} via ${musdSymbol}->${targetTokenSymbol} before seed (required=${requiredTargetAmount.toString()})`
    );
    return after;
  }
  if (after > current) {
    console.log(
      `partial acquire ${targetTokenSymbol} via ${musdSymbol}->${targetTokenSymbol}: before=${current.toString()} after=${after.toString()} required=${requiredTargetAmount.toString()}`
    );
  }
  return after;
}

async function main(): Promise<void> {
  const signers = await ethers.getSigners();
  if (!signers.length) {
    throw new Error('no signer available; set PRIVATE_KEY in packages/contracts/.env');
  }
  const [deployer] = signers;
  const registry = readRegistry(registryPathForNetwork());
  if (!ethers.isAddress(registry.contracts.musd)) {
    throw new Error(`invalid mUSD address in registry: ${registry.contracts.musd}`);
  }
  if (!ethers.isAddress(registry.contracts.harmonyRouter)) {
    throw new Error(`invalid harmony router in registry: ${registry.contracts.harmonyRouter}`);
  }

  const chainId = Number(network.config.chainId || 0);
  const wrappedNativeDefault = WRAPPED_NATIVE_DEFAULTS[chainId] || { symbol: 'WETH', address: '' };
  const wrappedNativeSymbol = normalizeSymbol(process.env.OHLC_SEED_WRAPPED_NATIVE_SYMBOL || wrappedNativeDefault.symbol);
  const wrappedNativeAddress = (
    process.env.OHLC_SEED_WRAPPED_NATIVE_ADDRESS ||
    wrappedNativeDefault.address ||
    ''
  ).trim();

  const symbols = collectSymbols(registry, wrappedNativeSymbol);
  const rounds = Math.max(1, Number.parseInt(process.env.OHLC_SEED_ROUNDS || '1', 10) || 1);
  const includeReverse = boolEnv('OHLC_SEED_INCLUDE_REVERSE', true);
  const acquireWithMusd = boolEnv('OHLC_SEED_ACQUIRE_WITH_MUSD', true);
  const acquireBufferBps = bpsEnv('OHLC_SEED_ACQUIRE_BUFFER_BPS', 500);
  const slippageBps = bpsEnv('OHLC_SEED_SLIPPAGE_BPS', 500);
  const reverseMusdAmountText = amountEnv('OHLC_SEED_REVERSE_MUSD_AMOUNT', defaultReverseAmount());
  const strict = boolEnv('OHLC_SEED_STRICT', false);

  const musdMeta = await tokenMeta(registry.contracts.musd);
  let successCount = 0;
  const skipped: string[] = [];

  console.log(`seeding ohlc trades network=${network.name} chainId=${chainId} deployer=${deployer.address}`);
  console.log(`symbols=${symbols.join(',')} rounds=${rounds} includeReverse=${includeReverse}`);

  for (let round = 1; round <= rounds; round += 1) {
    for (const symbol of symbols) {
      const tokenAddress = resolveTokenAddress(registry, symbol, wrappedNativeAddress);
      if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
        skipped.push(`${symbol}:missing-address`);
        continue;
      }
      if (tokenAddress.toLowerCase() === registry.contracts.musd.toLowerCase()) {
        continue;
      }

      const { symbol: resolvedSymbol, decimals } = await tokenMeta(tokenAddress);
      const amountText = amountEnv(`OHLC_SEED_AMOUNT_${resolvedSymbol}`, defaultSeedAmount(resolvedSymbol));
      let amountIn: bigint;
      try {
        amountIn = ethers.parseUnits(amountText, decimals);
      } catch {
        skipped.push(`${resolvedSymbol}:invalid-amount`);
        continue;
      }
      if (amountIn <= 0n) continue;

      try {
        try {
          await ensureBalance({
            tokenAddress,
            tokenSymbol: resolvedSymbol,
            owner: deployer.address,
            required: amountIn,
            wrappedNativeAddress,
            signer: deployer
          });
        } catch (ensureError) {
          if (!acquireWithMusd) throw ensureError;
          const balanceAfterAcquire = await acquireTokenWithMusd({
            routerAddress: registry.contracts.harmonyRouter,
            musdAddress: registry.contracts.musd,
            targetTokenAddress: tokenAddress,
            targetTokenSymbol: resolvedSymbol,
            owner: deployer.address,
            requiredTargetAmount: amountIn,
            wrappedNativeAddress,
            signer: deployer,
            slippageBps,
            bufferBps: acquireBufferBps,
            musdSymbol: musdMeta.symbol,
            musdDecimals: musdMeta.decimals
          });
          if (balanceAfterAcquire <= 0n) throw ensureError;
          if (balanceAfterAcquire < amountIn) {
            console.log(
              `reduced seed amount for ${resolvedSymbol}: requested=${amountIn.toString()} available=${balanceAfterAcquire.toString()}`
            );
            amountIn = balanceAfterAcquire;
          }
        }
        await ensureApproval(tokenAddress, deployer.address, registry.contracts.harmonyRouter, amountIn);
        const forward = await swapOnce({
          routerAddress: registry.contracts.harmonyRouter,
          tokenIn: tokenAddress,
          tokenOut: registry.contracts.musd,
          amountIn,
          slippageBps,
          recipient: deployer.address
        });
        successCount += 1;
        console.log(
          `round=${round} ${resolvedSymbol}->${musdMeta.symbol} tx=${forward.txHash} in=${amountText} out=${ethers.formatUnits(
            forward.amountOut,
            musdMeta.decimals
          )}`
        );

        if (includeReverse) {
          const targetMusdRaw = ethers.parseUnits(reverseMusdAmountText, musdMeta.decimals);
          const reverseAmount = forward.amountOut > targetMusdRaw ? targetMusdRaw : forward.amountOut;
          if (reverseAmount > 0n) {
            await ensureBalance({
              tokenAddress: registry.contracts.musd,
              tokenSymbol: musdMeta.symbol,
              owner: deployer.address,
              required: reverseAmount,
              wrappedNativeAddress,
              signer: deployer
            });
            await ensureApproval(registry.contracts.musd, deployer.address, registry.contracts.harmonyRouter, reverseAmount);
            const reverse = await swapOnce({
              routerAddress: registry.contracts.harmonyRouter,
              tokenIn: registry.contracts.musd,
              tokenOut: tokenAddress,
              amountIn: reverseAmount,
              slippageBps,
              recipient: deployer.address
            });
            successCount += 1;
            console.log(
              `round=${round} ${musdMeta.symbol}->${resolvedSymbol} tx=${reverse.txHash} in=${ethers.formatUnits(
                reverseAmount,
                musdMeta.decimals
              )}`
            );
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'swap failed';
        const label = `${resolvedSymbol}:${message}`;
        if (strict) {
          throw new Error(label);
        }
        skipped.push(label);
      }
    }
  }

  if (successCount === 0) {
    throw new Error(`no seed swaps executed. skipped=${skipped.join('; ')}`);
  }
  console.log(`ohlc seed complete network=${network.name} swaps=${successCount}`);
  if (skipped.length) {
    console.log(`skipped=${skipped.join(' | ')}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
