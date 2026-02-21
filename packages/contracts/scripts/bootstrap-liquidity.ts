import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ethers, network } from 'hardhat';

type Registry = {
  contracts: {
    musd: string;
    stabilizer: string;
    oracle: string;
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
    pair?: string;
  }>;
  collateralToken?: string | null;
};

type ChainRegistryToken = {
  symbol?: string;
  address?: string;
  decimals?: number;
};

type ChainRegistryChain = {
  chain_id?: number;
  tokens?: ChainRegistryToken[];
};

type ChainRegistryPayload = {
  chains?: ChainRegistryChain[];
};

type CollateralConfig = {
  token: string;
  symbol?: string;
};

const WRAPPED_NATIVE_DEFAULTS: Record<number, string> = {
  97: '0xae13d989dac2f0debff460ac112a837c89baa7cd', // WBNB (BSC testnet)
  11155111: '0xfff9976782d46cc05630d1f6ebab18b2324d6b14' // WETH (Sepolia)
};

const DEFAULT_MAJOR_TARGET_SYMBOLS = ['WBTC', 'WETH', 'WSOL', 'WAVAX', 'MODX'];

const DEFAULT_TARGET_DECIMALS: Record<string, number> = {
  WBTC: 8,
  WETH: 18,
  WBNB: 18,
  WSOL: 9,
  WAVAX: 18,
  MODX: 18
};

const DEFAULT_TARGET_NAMES: Record<string, string> = {
  WBTC: 'Wrapped Bitcoin',
  WETH: 'Wrapped Ether',
  WBNB: 'Wrapped BNB',
  WSOL: 'Wrapped SOL',
  WAVAX: 'Wrapped AVAX',
  MODX: 'modX Token'
};

const WRAPPED_NATIVE_ABI = [
  'function deposit() payable',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)'
] as const;

const EXTERNAL_ROUTER_BY_CHAIN: Record<number, string> = {
  97: '0x9ac64cc6e4415144c455bd8e4837fea55603e5c3' // PancakeSwap Router (BSC testnet)
};

const EXTERNAL_ROUTER_ABI = [
  'function getAmountsOut(uint256,address[]) view returns (uint256[])',
  'function getAmountsIn(uint256,address[]) view returns (uint256[])',
  'function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])'
] as const;

const FACTORY_PAIRS_ABI = ['function allPairsLength() view returns (uint256)', 'function allPairs(uint256) view returns (address)'] as const;
const PAIR_TOKENS_ABI = ['function token0() view returns (address)', 'function token1() view returns (address)'] as const;

function registryPathForNetwork(): string {
  const explicit = process.env.ADDRESS_REGISTRY_PATH;
  if (explicit && explicit.trim().length > 0) {
    return explicit;
  }
  return join(__dirname, '..', 'deploy', `address-registry.${network.name}.json`);
}

function chainRegistryPath(): string {
  const explicit = process.env.CHAIN_REGISTRY_PATH;
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  return join(__dirname, '..', '..', 'sdk', 'data', 'chain-registry.generated.json');
}

function readRegistry(path: string): Registry {
  if (!existsSync(path)) {
    throw new Error(`registry file not found: ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Registry;
}

function readChainRegistry(path: string): ChainRegistryPayload | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ChainRegistryPayload;
    if (!Array.isArray(parsed.chains)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseCsv(input: string | undefined): string[] {
  if (!input) return [];
  return input
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function boolEnv(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (!value || !value.trim()) return defaultValue;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function normalizeSymbolEnvKey(symbol: string): string {
  return symbol.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function amountEnv(name: string, defaultValue: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) return defaultValue;
  return value.trim();
}

function bpsEnv(name: string, defaultValue: number): bigint {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return BigInt(defaultValue);
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) return BigInt(defaultValue);
  const clamped = Math.min(10_000, Math.max(0, parsed));
  return BigInt(clamped);
}

function applyMinBps(amount: bigint, minBps: bigint): bigint {
  if (minBps <= 0n) return 0n;
  if (minBps >= 10_000n) return amount;
  return (amount * minBps) / 10_000n;
}

function amountEnvForSymbol(prefix: string, symbol: string, fallbackKey: string, defaultValue: string): string {
  const key = `${prefix}_${normalizeSymbolEnvKey(symbol)}_AMOUNT`;
  return amountEnv(key, amountEnv(fallbackKey, defaultValue));
}

function tokenAddressEnvForSymbol(symbol: string): string {
  const value = process.env[`BOOTSTRAP_TOKEN_${normalizeSymbolEnvKey(symbol)}_ADDRESS`];
  if (!value) return '';
  return value.trim();
}

function tokenAddressLabel(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function parseExtraTokenAddresses(): string[] {
  return parseCsv(process.env.BOOTSTRAP_EXTRA_TOKEN_ADDRESSES)
    .map((token) => token.trim())
    .filter((token) => ethers.isAddress(token));
}

function loadChainRegistryTokenAddresses(chainId: number): string[] {
  const payload = readChainRegistry(chainRegistryPath());
  if (!payload || !Array.isArray(payload.chains)) return [];
  const chain = payload.chains.find((item) => Number(item?.chain_id || 0) === chainId);
  if (!chain || !Array.isArray(chain.tokens)) return [];

  const addresses: string[] = [];
  for (const token of chain.tokens) {
    const address = String(token?.address || '').trim();
    if (!ethers.isAddress(address)) continue;
    addresses.push(address);
  }
  return addresses;
}

function defaultLpTokenAmount(symbol: string, decimals: number): string {
  const key = normalizeSymbol(symbol);
  if (key === 'WBTC') return '0.05';
  if (key === 'WETH' || key === 'WBNB') return '0.5';
  if (key === 'WSOL') return '8';
  if (key === 'WAVAX') return '5';
  if (decimals <= 8) return '1';
  return '10';
}

function defaultLpMusdAmount(symbol: string): string {
  const key = normalizeSymbol(symbol);
  if (key === 'WBTC') return '40';
  if (key === 'WETH' || key === 'WBNB') return '40';
  if (key === 'WSOL') return '40';
  if (key === 'WAVAX') return '40';
  return '25';
}

function scaleAmount(amount: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (fromDecimals === toDecimals) return amount;
  if (toDecimals > fromDecimals) {
    return amount * 10n ** BigInt(toDecimals - fromDecimals);
  }
  const factor = 10n ** BigInt(fromDecimals - toDecimals);
  return amount / factor;
}

async function deployMockTargetToken(symbol: string, decimals: number, recipient: string): Promise<string> {
  const MockERC20 = await ethers.getContractFactory('MockERC20');
  const name = DEFAULT_TARGET_NAMES[normalizeSymbol(symbol)] || `${symbol} Token`;
  const token = await MockERC20.deploy(name, symbol, decimals);
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  try {
    const mintable = await ethers.getContractAt(['function mint(address,uint256) external'], tokenAddress);
    const seedAmount = ethers.parseUnits('1000', decimals);
    await (await mintable.mint(recipient, seedAmount)).wait();
  } catch {
    // Seed mint is best-effort; ensureTokenBalance handles follow-up mint attempts.
  }
  return tokenAddress;
}

function dedupeCollaterals(items: CollateralConfig[]): CollateralConfig[] {
  const seen = new Set<string>();
  const output: CollateralConfig[] = [];
  for (const item of items) {
    const token = item.token.trim();
    if (!ethers.isAddress(token)) continue;
    const lower = token.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    output.push({ token, symbol: item.symbol });
  }
  return output;
}

function persistTargetRegistry(
  registryPath: string,
  registry: Registry,
  createdPools: Array<{ symbol: string; token: string; pair: string; decimals?: number }>
): void {
  const writeTargets = boolEnv('BOOTSTRAP_WRITE_TARGETS_TO_REGISTRY', true);
  if (!writeTargets) return;

  const byToken = new Map<string, { symbol: string; token: string; pair?: string; decimals?: number }>();
  const existingTargets = Array.isArray(registry.targets) ? registry.targets : [];
  for (const item of existingTargets) {
    const token = String(item?.token || '').trim();
    if (!ethers.isAddress(token)) continue;
    const symbol = normalizeSymbol(String(item?.symbol || tokenAddressLabel(token)));
    const decimals = Number(item?.decimals);
    byToken.set(token.toLowerCase(), {
      symbol,
      token,
      pair: String(item?.pair || '').trim() || undefined,
      decimals: Number.isFinite(decimals) ? decimals : undefined
    });
  }

  for (const pool of createdPools) {
    const token = pool.token.trim();
    if (!ethers.isAddress(token)) continue;
    const symbol = normalizeSymbol(pool.symbol);
    if (symbol === 'MUSD') continue;
    byToken.set(token.toLowerCase(), {
      symbol,
      token,
      pair: pool.pair,
      decimals: Number.isFinite(Number(pool.decimals)) ? Number(pool.decimals) : undefined
    });
  }

  const targets = Array.from(byToken.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));
  const nextRegistry: Registry = { ...registry, targets };
  writeFileSync(registryPath, `${JSON.stringify(nextRegistry, null, 2)}\n`, 'utf8');
}

function resolveCollateralTargets(registry: Registry): CollateralConfig[] {
  const envMany = parseCsv(process.env.BOOTSTRAP_COLLATERAL_TOKENS).map((token) => ({ token }));
  const envSingle = process.env.BOOTSTRAP_COLLATERAL_TOKEN?.trim();

  const configured: CollateralConfig[] = [];
  if (Array.isArray(registry.collaterals) && registry.collaterals.length > 0) {
    for (const entry of registry.collaterals) {
      configured.push({ token: entry.token, symbol: entry.symbol });
    }
  }
  if (registry.collateralToken) {
    configured.push({ token: registry.collateralToken });
  }

  const merged: CollateralConfig[] = [];
  if (envMany.length > 0) {
    merged.push(...envMany);
  }
  if (envSingle && envSingle.length > 0) {
    merged.push({ token: envSingle });
  }
  if (merged.length === 0) {
    merged.push(...configured);
  }

  const deduped = dedupeCollaterals(merged);
  if (!deduped.length) {
    throw new Error('no collateral token found; set BOOTSTRAP_COLLATERAL_TOKENS or ensure registry.collaterals is populated');
  }
  return deduped;
}

async function maybeSetMockPrice(oracleAddress: string, tokenAddress: string, symbol: string): Promise<void> {
  if (!boolEnv('BOOTSTRAP_SET_MOCK_ORACLE_PRICE', true)) return;

  const specificPrice = process.env[`BOOTSTRAP_ORACLE_PRICE_${normalizeSymbolEnvKey(symbol)}_E18`];
  const priceE18 = specificPrice?.trim() || process.env.BOOTSTRAP_ORACLE_PRICE_E18 || ethers.parseEther('1').toString();
  try {
    const oracle = await ethers.getContractAt('MockPriceOracle', oracleAddress);
    await (await oracle.setPrice(tokenAddress, priceE18)).wait();
    console.log(`oracle price set: ${symbol}=${tokenAddress} priceE18=${priceE18}`);
  } catch (error) {
    console.log(`oracle.setPrice skipped for ${symbol} (non-mock oracle or missing role)`);
    console.log(String(error));
  }
}

async function tryMintErc20(tokenAddress: string, to: string, amount: bigint, symbol: string): Promise<boolean> {
  if (amount <= 0n) return true;

  try {
    const mintable = await ethers.getContractAt(['function mint(address,uint256) external'], tokenAddress);
    await (await mintable.mint(to, amount)).wait();
    console.log(`minted ${symbol}: +${amount.toString()} raw`);
    return true;
  } catch {
    return false;
  }
}

async function ensureTokenBalance(
  tokenAddress: string,
  owner: string,
  requiredRaw: bigint,
  symbol: string,
  decimals: number
): Promise<boolean> {
  if (requiredRaw <= 0n) return true;

  const token = await ethers.getContractAt('IERC20Metadata', tokenAddress);
  const current = await token.balanceOf(owner);
  if (current >= requiredRaw) return true;

  const deficit = requiredRaw - current;
  const minted = await tryMintErc20(tokenAddress, owner, deficit, symbol);
  if (!minted) {
    console.log(
      `insufficient ${symbol} for bootstrap. required=${ethers.formatUnits(requiredRaw, decimals)} available=${ethers.formatUnits(
        current,
        decimals
      )}`
    );
    return false;
  }

  const after = await token.balanceOf(owner);
  if (after < requiredRaw) {
    console.log(
      `still insufficient ${symbol} after mint attempt. required=${ethers.formatUnits(requiredRaw, decimals)} available=${ethers.formatUnits(
        after,
        decimals
      )}`
    );
    return false;
  }
  return true;
}

async function main(): Promise<void> {
  const registryPath = registryPathForNetwork();
  const registry = readRegistry(registryPath);

  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    throw new Error('no signer available; set PRIVATE_KEY in packages/contracts/.env');
  }
  const [deployer] = signers;

  const musd = await ethers.getContractAt('MUSDToken', registry.contracts.musd);
  const stabilizer = await ethers.getContractAt('Stabilizer', registry.contracts.stabilizer);
  const factory = await ethers.getContractAt('HarmonyFactory', registry.contracts.harmonyFactory);
  const router = await ethers.getContractAt('HarmonyRouter', registry.contracts.harmonyRouter);
  const minLiquidityBps = bpsEnv('BOOTSTRAP_MIN_LIQUIDITY_BPS', 9900);

  const collateralTargets = resolveCollateralTargets(registry);
  const deadline = Math.floor(Date.now() / 1000) + 1800;
  const createdPools: Array<{ symbol: string; token: string; pair: string; decimals?: number }> = [];
  const handledTokenAddresses = new Set<string>();
  const collateralBySymbol = new Map<string, { token: string; decimals: number }>();
  const mintSources: Array<{ token: string; symbol: string; decimals: number }> = [];
  const musdAddress = (await musd.getAddress()).toLowerCase();
  const chainId = Number(network.config.chainId || 0);
  const wrappedNativeTokenAddress =
    process.env.BOOTSTRAP_WRAPPED_NATIVE_TOKEN?.trim() || WRAPPED_NATIVE_DEFAULTS[chainId] || '';
  const externalRouterAddress =
    process.env.BOOTSTRAP_EXTERNAL_ROUTER_ADDRESS?.trim() || EXTERNAL_ROUTER_BY_CHAIN[chainId] || '';
  const externalSwapSlippageBps = bpsEnv('BOOTSTRAP_EXTERNAL_SWAP_SLIPPAGE_BPS', 1000);
  const externalSwapBufferBps = bpsEnv('BOOTSTRAP_EXTERNAL_SWAP_BUFFER_BPS', 1200);
  const externalSwapMaxWrapped = amountEnv('BOOTSTRAP_EXTERNAL_SWAP_MAX_WRAPPED_NATIVE', '2');
  const wrappedNativeDecimalsForSwap = network.name.includes('bsc') ? 18 : 18;
  const externalSwapMaxWrappedRaw = ethers.parseUnits(externalSwapMaxWrapped, wrappedNativeDecimalsForSwap);
  const existingTokenBySymbol = new Map<string, string>();
  const minterRole = ethers.keccak256(ethers.toUtf8Bytes('MINTER_ROLE'));
  const canDirectMintMusd = await musd.hasRole(minterRole, deployer.address).catch(() => false);

  try {
    const factoryPairs = await ethers.getContractAt(FACTORY_PAIRS_ABI, await factory.getAddress());
    const pairLength = Number(await factoryPairs.allPairsLength());
    for (let idx = 0; idx < pairLength; idx += 1) {
      const pairAddress = await factoryPairs.allPairs(idx);
      if (!ethers.isAddress(pairAddress)) continue;
      const pair = await ethers.getContractAt(PAIR_TOKENS_ABI, pairAddress);
      const token0 = (await pair.token0()).toLowerCase();
      const token1 = (await pair.token1()).toLowerCase();
      const tokenCandidates = [token0, token1].filter((token) => token !== musdAddress);
      for (const candidate of tokenCandidates) {
        if (!ethers.isAddress(candidate)) continue;
        const token = await ethers.getContractAt('IERC20Metadata', candidate);
        const symbol = normalizeSymbol(await token.symbol().catch(() => ''));
        if (!symbol || existingTokenBySymbol.has(symbol)) continue;
        existingTokenBySymbol.set(symbol, candidate);
      }
    }
  } catch (error) {
    console.log('pair symbol pre-scan skipped');
    console.log(String(error));
  }

  async function ensureMusdBalance(requiredMusdRaw: bigint): Promise<boolean> {
    let current = await musd.balanceOf(deployer.address);
    if (current >= requiredMusdRaw) return true;

    if (canDirectMintMusd) {
      const deficit = requiredMusdRaw - current;
      if (deficit > 0n) {
        await (await musd.mint(deployer.address, deficit)).wait();
        current = await musd.balanceOf(deployer.address);
        console.log(`mUSD topped up via direct mint: +${ethers.formatEther(deficit)} balance=${ethers.formatEther(current)}`);
      }
      if (current >= requiredMusdRaw) return true;
    }

    if (!mintSources.length) {
      console.log(
        `cannot top up mUSD: no collateral mint source available required=${ethers.formatEther(requiredMusdRaw)} available=${ethers.formatEther(
          current
        )}`
      );
      return false;
    }

    const prioritized = [...mintSources].sort((a, b) => {
      const aStable = a.symbol.toUpperCase() === 'USDC' || a.symbol.toUpperCase() === 'USDT';
      const bStable = b.symbol.toUpperCase() === 'USDC' || b.symbol.toUpperCase() === 'USDT';
      if (aStable === bStable) return 0;
      return aStable ? -1 : 1;
    });

    let available = current;
    for (const source of prioritized) {
      if (available >= requiredMusdRaw) break;
      const deficit = requiredMusdRaw - available;
      const collateralNeeded = scaleAmount(deficit, 18, source.decimals);
      const collateralWithBuffer = collateralNeeded + collateralNeeded / 3n + 1n; // +33% to absorb mint fees / oracle spread

      const canTopUp = await ensureTokenBalance(
        source.token,
        deployer.address,
        collateralWithBuffer,
        source.symbol,
        source.decimals
      );
      if (!canTopUp) {
        continue;
      }

      const sourceToken = await ethers.getContractAt('IERC20Metadata', source.token);
      try {
        await (await sourceToken.approve(await stabilizer.getAddress(), collateralWithBuffer)).wait();
        await (await stabilizer.mintWithCollateral(source.token, collateralWithBuffer, 0, deployer.address)).wait();
        available = await musd.balanceOf(deployer.address);
        console.log(
          `mUSD topped up via ${source.symbol}: collateral=${ethers.formatUnits(collateralWithBuffer, source.decimals)} balance=${ethers.formatEther(
            available
          )}`
        );
      } catch (error) {
        console.log(`mUSD top-up via ${source.symbol} collateral mint failed; trying fallback`);
        console.log(String(error));
        if (canDirectMintMusd) {
          const fallbackDeficit = requiredMusdRaw - available;
          if (fallbackDeficit > 0n) {
            await (await musd.mint(deployer.address, fallbackDeficit)).wait();
            available = await musd.balanceOf(deployer.address);
            console.log(`mUSD topped up via direct mint fallback: +${ethers.formatEther(fallbackDeficit)} balance=${ethers.formatEther(available)}`);
          }
        }
      }
    }

    if (available < requiredMusdRaw) {
      console.log(
        `mUSD top-up still insufficient required=${ethers.formatEther(requiredMusdRaw)} available=${ethers.formatEther(available)}`
      );
      return false;
    }
    return true;
  }

  async function addLiquidityWithFallback(params: {
    symbol: string;
    tokenAddress: string;
    desiredMusd: bigint;
    desiredToken: bigint;
    minMusd: bigint;
    minToken: bigint;
  }): Promise<boolean> {
    const routerAddress = await router.getAddress();
    const musdAddress = await musd.getAddress();
    try {
      await (
        await router.addLiquidity(
          musdAddress,
          params.tokenAddress,
          params.desiredMusd,
          params.desiredToken,
          params.minMusd,
          params.minToken,
          deployer.address,
          deadline
        )
      ).wait();
      return true;
    } catch (error) {
      console.log(`addLiquidity primary path failed for ${params.symbol}; retrying with relaxed minimums`);
      console.log(String(error));
    }

    try {
      await (
        await router.addLiquidity(
          musdAddress,
          params.tokenAddress,
          params.desiredMusd,
          params.desiredToken,
          0,
          0,
          deployer.address,
          deadline
        )
      ).wait();
      return true;
    } catch (error) {
      console.log(`addLiquidity fallback path failed for ${params.symbol}`);
      console.log(String(error));
      console.log(
        `skipping ${params.symbol} pool after retries router=${routerAddress} token=${params.tokenAddress}`
      );
      return false;
    }
  }

  async function tryAcquireTargetFromExternalRouter(
    tokenAddress: string,
    symbol: string,
    requiredRaw: bigint
  ): Promise<boolean> {
    if (!boolEnv('BOOTSTRAP_ENABLE_EXTERNAL_ROUTER_SWAP', true)) return false;
    if (!externalRouterAddress || !ethers.isAddress(externalRouterAddress)) return false;
    if (!wrappedNativeTokenAddress || !ethers.isAddress(wrappedNativeTokenAddress)) return false;
    if (tokenAddress.toLowerCase() === wrappedNativeTokenAddress.toLowerCase()) return false;

    const targetToken = await ethers.getContractAt('IERC20Metadata', tokenAddress);
    const wrapped = await ethers.getContractAt(WRAPPED_NATIVE_ABI, wrappedNativeTokenAddress);
    const externalRouter = await ethers.getContractAt(EXTERNAL_ROUTER_ABI, externalRouterAddress);

    const current = await targetToken.balanceOf(deployer.address);
    if (current >= requiredRaw) return true;
    const deficit = requiredRaw - current;
    if (deficit <= 0n) return true;

    let amountInQuoted = 0n;
    try {
      const amountsIn = (await externalRouter.getAmountsIn(deficit, [wrappedNativeTokenAddress, tokenAddress])) as bigint[];
      amountInQuoted = amountsIn[0];
    } catch (error) {
      console.log(`external router getAmountsIn unavailable for ${symbol}; trying fixed-size quote`);
      console.log(String(error));
      try {
        const amountsOut = (await externalRouter.getAmountsOut(
          externalSwapMaxWrappedRaw,
          [wrappedNativeTokenAddress, tokenAddress]
        )) as bigint[];
        const maxOut = amountsOut[amountsOut.length - 1];
        if (maxOut > 0n) {
          amountInQuoted = externalSwapMaxWrappedRaw;
        }
      } catch (innerError) {
        console.log(`external router fixed-size quote failed for ${symbol}`);
        console.log(String(innerError));
        return false;
      }
    }
    if (amountInQuoted <= 0n) return false;

    const bufferedIn = amountInQuoted + (amountInQuoted * externalSwapBufferBps) / 10_000n;
    const amountIn = bufferedIn > 0n ? bufferedIn : amountInQuoted;
    if (externalSwapMaxWrappedRaw > 0n && amountIn > externalSwapMaxWrappedRaw) {
      console.log(
        `external router swap skipped for ${symbol}: required wrapped native ${ethers.formatUnits(
          amountIn,
          wrappedNativeDecimalsForSwap
        )} exceeds max ${ethers.formatUnits(externalSwapMaxWrappedRaw, wrappedNativeDecimalsForSwap)}`
      );
      return false;
    }

    const wrappedBalance = await wrapped.balanceOf(deployer.address);
    if (wrappedBalance < amountIn) {
      const wrapDeficit = amountIn - wrappedBalance;
      const nativeBalance = await ethers.provider.getBalance(deployer.address);
      if (nativeBalance < wrapDeficit) {
        console.log(
          `external router swap skipped for ${symbol}: insufficient native for wrap required=${ethers.formatEther(
            wrapDeficit
          )} available=${ethers.formatEther(nativeBalance)}`
        );
        return false;
      }
      await (await wrapped.deposit({ value: wrapDeficit })).wait();
      console.log(`wrapped native for external swap ${symbol}: +${ethers.formatUnits(wrapDeficit, wrappedNativeDecimalsForSwap)}`);
    }

    const wrappedAsErc20 = await ethers.getContractAt('IERC20Metadata', wrappedNativeTokenAddress);
    await (await wrappedAsErc20.approve(externalRouterAddress, amountIn)).wait();

    let minOut = deficit;
    try {
      const amountsOut = (await externalRouter.getAmountsOut(amountIn, [wrappedNativeTokenAddress, tokenAddress])) as bigint[];
      const expectedOut = amountsOut[amountsOut.length - 1];
      minOut = applyMinBps(expectedOut, 10_000n - externalSwapSlippageBps);
    } catch {
      minOut = applyMinBps(deficit, 10_000n - externalSwapSlippageBps);
    }

    const swapDeadline = Math.floor(Date.now() / 1000) + 1800;
    try {
      await (
        await externalRouter.swapExactTokensForTokens(
          amountIn,
          minOut,
          [wrappedNativeTokenAddress, tokenAddress],
          deployer.address,
          swapDeadline
        )
      ).wait();
    } catch (error) {
      console.log(`external router swap failed for ${symbol}`);
      console.log(String(error));
      return false;
    }

    const after = await targetToken.balanceOf(deployer.address);
    if (after >= requiredRaw) {
      console.log(`acquired ${symbol} via external router: +${ethers.formatUnits(after - current, await targetToken.decimals())}`);
      return true;
    }
    console.log(`external router swap produced insufficient ${symbol} balance required=${requiredRaw.toString()} available=${after.toString()}`);
    return false;
  }

  for (const target of collateralTargets) {
    const tokenAddress = target.token;
    const collateral = await ethers.getContractAt('IERC20Metadata', tokenAddress);
    const symbol = normalizeSymbol(target.symbol || (await collateral.symbol()));
    const decimals = Number(await collateral.decimals());
    collateralBySymbol.set(symbol, { token: tokenAddress, decimals });
    mintSources.push({ token: tokenAddress, symbol, decimals });

    await maybeSetMockPrice(registry.contracts.oracle, tokenAddress, symbol);

    const mintAmount = amountEnvForSymbol('BOOTSTRAP_MINT', symbol, 'BOOTSTRAP_MINT_COLLATERAL_AMOUNT', '120');
    const mintRaw = ethers.parseUnits(mintAmount, decimals);
    const canMint = await ensureTokenBalance(tokenAddress, deployer.address, mintRaw, symbol, decimals);
    if (!canMint) {
      console.log(`skip collateral mint path for ${symbol}`);
      continue;
    }

    let collateralMinted = false;
    try {
      await (await collateral.approve(await stabilizer.getAddress(), mintRaw)).wait();
      await (await stabilizer.mintWithCollateral(tokenAddress, mintRaw, 0, deployer.address)).wait();
      collateralMinted = true;
    } catch (error) {
      console.log(`collateral mint path failed for ${symbol}; fallback mode engaged`);
      console.log(String(error));
    }

    const lpTokenAmount = amountEnvForSymbol('BOOTSTRAP_LP', symbol, 'BOOTSTRAP_LP_COLLATERAL_AMOUNT', '40');
    const lpMusdAmount = amountEnvForSymbol('BOOTSTRAP_LP_MUSD', symbol, 'BOOTSTRAP_LP_MUSD_AMOUNT', '40');

    const lpTokenRaw = ethers.parseUnits(lpTokenAmount, decimals);
    const lpMusdRaw = ethers.parseEther(lpMusdAmount);

    if (!collateralMinted && canDirectMintMusd) {
      const directMintAmount = lpMusdRaw + lpMusdRaw / 2n;
      if (directMintAmount > 0n) {
        await (await musd.mint(deployer.address, directMintAmount)).wait();
        console.log(`mUSD direct mint fallback for ${symbol}: +${ethers.formatEther(directMintAmount)}`);
      }
    }

    const canProvideLpToken = await ensureTokenBalance(tokenAddress, deployer.address, lpTokenRaw, symbol, decimals);
    if (!canProvideLpToken) {
      console.log(`skip LP for ${symbol}: collateral balance is insufficient`);
      continue;
    }

    const canTopUpMusd = await ensureMusdBalance(lpMusdRaw);
    const musdBalance = await musd.balanceOf(deployer.address);
    if (!canTopUpMusd || musdBalance < lpMusdRaw) {
      console.log(
        `skip LP for ${symbol}: mUSD balance insufficient required=${ethers.formatEther(lpMusdRaw)} available=${ethers.formatEther(
          musdBalance
        )}`
      );
      continue;
    }

    await (await collateral.approve(await router.getAddress(), lpTokenRaw)).wait();
    await (await musd.approve(await router.getAddress(), lpMusdRaw)).wait();

    const minMusd = applyMinBps(lpMusdRaw, minLiquidityBps);
    const minCollateral = applyMinBps(lpTokenRaw, minLiquidityBps);

    const collateralLpAdded = await addLiquidityWithFallback({
      symbol,
      tokenAddress,
      desiredMusd: lpMusdRaw,
      desiredToken: lpTokenRaw,
      minMusd,
      minToken: minCollateral
    });
    if (!collateralLpAdded) {
      continue;
    }

    const pair = await factory.getPair(await musd.getAddress(), tokenAddress);
    createdPools.push({ symbol, token: tokenAddress, pair, decimals });
    handledTokenAddresses.add(tokenAddress.toLowerCase());
    console.log(`added LP: ${symbol} pair=${pair}`);
  }

  if (boolEnv('BOOTSTRAP_ENABLE_WRAPPED_NATIVE_POOL', true)) {
    if (wrappedNativeTokenAddress && ethers.isAddress(wrappedNativeTokenAddress)) {
      const wrapped = await ethers.getContractAt(WRAPPED_NATIVE_ABI, wrappedNativeTokenAddress);
      const symbol = await wrapped.symbol().catch(() => (network.name.includes('bsc') ? 'WBNB' : 'WETH'));
      const decimals = Number(await wrapped.decimals().catch(() => 18));

      const wrappedAmount = amountEnv('BOOTSTRAP_LP_WRAPPED_NATIVE_AMOUNT', network.name.includes('bsc') ? '0.5' : '0.2');
      const wrappedRaw = ethers.parseUnits(wrappedAmount, decimals);
      const musdForWrapped = ethers.parseEther(amountEnv('BOOTSTRAP_LP_MUSD_WRAPPED_AMOUNT', '40'));

      const wrappedBalance = await wrapped.balanceOf(deployer.address);
      if (wrappedBalance < wrappedRaw) {
        const deficit = wrappedRaw - wrappedBalance;
        const nativeBalance = await ethers.provider.getBalance(deployer.address);
        if (nativeBalance >= deficit) {
          await (await wrapped.deposit({ value: deficit })).wait();
          console.log(`wrapped native into ${symbol}: +${ethers.formatUnits(deficit, decimals)}`);
        } else {
          console.log(
            `skip ${symbol} pool: insufficient native balance for wrapping required=${ethers.formatEther(deficit)} available=${ethers.formatEther(
              nativeBalance
            )}`
          );
        }
      }

      const wrappedBalanceAfter = await wrapped.balanceOf(deployer.address);
      const canTopUpMusd = await ensureMusdBalance(musdForWrapped);
      const musdBalance = await musd.balanceOf(deployer.address);
      if (wrappedBalanceAfter >= wrappedRaw && canTopUpMusd && musdBalance >= musdForWrapped) {
        await (await wrapped.approve(await router.getAddress(), wrappedRaw)).wait();
        await (await musd.approve(await router.getAddress(), musdForWrapped)).wait();

        const minWrapped = applyMinBps(wrappedRaw, minLiquidityBps);
        const minMusd = applyMinBps(musdForWrapped, minLiquidityBps);

        const wrappedLpAdded = await addLiquidityWithFallback({
          symbol,
          tokenAddress: wrappedNativeTokenAddress,
          desiredMusd: musdForWrapped,
          desiredToken: wrappedRaw,
          minMusd,
          minToken: minWrapped
        });
        if (!wrappedLpAdded) {
          console.log(`skip ${symbol} pool: addLiquidity failed after retries`);
        } else {
          const pair = await factory.getPair(await musd.getAddress(), wrappedNativeTokenAddress);
          createdPools.push({ symbol, token: wrappedNativeTokenAddress, pair, decimals });
          handledTokenAddresses.add(wrappedNativeTokenAddress.toLowerCase());
          console.log(`added LP: ${symbol} pair=${pair}`);
        }
      } else {
        console.log(
          `skip ${symbol} pool: balances insufficient mUSD=${ethers.formatEther(musdBalance)} ${symbol}=${ethers.formatUnits(
            wrappedBalanceAfter,
            decimals
          )}`
        );
      }
    }
  }

  if (boolEnv('BOOTSTRAP_ENABLE_MAJOR_POOLS', true)) {
    const targetSymbols = parseCsv(process.env.BOOTSTRAP_TARGET_SYMBOLS || DEFAULT_MAJOR_TARGET_SYMBOLS.join(','))
      .map(normalizeSymbol)
      .filter((symbol, index, all) => symbol.length > 0 && all.indexOf(symbol) === index);

    const deployMocks = boolEnv('BOOTSTRAP_DEPLOY_MOCK_TARGETS', true);
    const forceMockSymbols = new Set(
      parseCsv(process.env.BOOTSTRAP_FORCE_MOCK_SYMBOLS)
        .map(normalizeSymbol)
        .filter(Boolean)
    );
    const defaultWrappedSymbol = network.name.includes('bsc') ? 'WBNB' : 'WETH';

    for (const symbol of targetSymbols) {
      let tokenAddress = '';
      let decimals = DEFAULT_TARGET_DECIMALS[symbol] || 18;

      const forceMock = forceMockSymbols.has(symbol);

      const envAddress = tokenAddressEnvForSymbol(symbol);
      if (forceMock) {
        tokenAddress = '';
      } else if (envAddress && ethers.isAddress(envAddress)) {
        tokenAddress = envAddress;
      } else if (collateralBySymbol.has(symbol)) {
        const known = collateralBySymbol.get(symbol)!;
        tokenAddress = known.token;
        decimals = known.decimals;
      } else if (existingTokenBySymbol.has(symbol)) {
        tokenAddress = existingTokenBySymbol.get(symbol)!;
      } else if (
        wrappedNativeTokenAddress &&
        ethers.isAddress(wrappedNativeTokenAddress) &&
        symbol === defaultWrappedSymbol
      ) {
        tokenAddress = wrappedNativeTokenAddress;
      }

      if (!tokenAddress && deployMocks) {
        try {
          tokenAddress = await deployMockTargetToken(symbol, decimals, deployer.address);
          console.log(`deployed mock target token ${symbol}: ${tokenAddress}`);
        } catch (error) {
          console.log(`failed to deploy mock target token ${symbol}`);
          console.log(String(error));
          continue;
        }
      }

      if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
        console.log(`skip ${symbol}: token address is not configured`);
        continue;
      }
      if (tokenAddress.toLowerCase() === musdAddress) continue;
      if (handledTokenAddresses.has(tokenAddress.toLowerCase())) continue;

      const token = await ethers.getContractAt('IERC20Metadata', tokenAddress);
      decimals = Number(await token.decimals().catch(() => decimals));

      const lpTokenAmount = amountEnvForSymbol(
        'BOOTSTRAP_LP',
        symbol,
        'BOOTSTRAP_LP_TARGET_TOKEN_AMOUNT',
        defaultLpTokenAmount(symbol, decimals)
      );
      const lpMusdAmount = amountEnvForSymbol(
        'BOOTSTRAP_LP_MUSD',
        symbol,
        'BOOTSTRAP_LP_TARGET_MUSD_AMOUNT',
        defaultLpMusdAmount(symbol)
      );

      const lpTokenRaw = ethers.parseUnits(lpTokenAmount, decimals);
      const lpMusdRaw = ethers.parseEther(lpMusdAmount);

      let effectiveLpTokenRaw = lpTokenRaw;
      let effectiveLpMusdRaw = lpMusdRaw;
      let canProvideToken = await ensureTokenBalance(tokenAddress, deployer.address, effectiveLpTokenRaw, symbol, decimals);
      if (!canProvideToken) {
        await tryAcquireTargetFromExternalRouter(tokenAddress, symbol, effectiveLpTokenRaw);
        const tokenBalanceAfterAcquire = await token.balanceOf(deployer.address);
        if (tokenBalanceAfterAcquire <= 0n) {
          console.log(`skip LP for ${symbol}: token balance is insufficient`);
          continue;
        }
        if (boolEnv('BOOTSTRAP_ALLOW_PARTIAL_TARGET_LP', true)) {
          effectiveLpTokenRaw = tokenBalanceAfterAcquire < lpTokenRaw ? tokenBalanceAfterAcquire : lpTokenRaw;
          effectiveLpMusdRaw = (lpMusdRaw * effectiveLpTokenRaw) / lpTokenRaw;
          if (effectiveLpMusdRaw <= 0n) {
            effectiveLpMusdRaw = lpMusdRaw;
          }
          console.log(
            `using partial ${symbol} LP size token=${ethers.formatUnits(effectiveLpTokenRaw, decimals)} musd=${ethers.formatEther(
              effectiveLpMusdRaw
            )}`
          );
          canProvideToken = true;
        } else {
          canProvideToken = await ensureTokenBalance(tokenAddress, deployer.address, effectiveLpTokenRaw, symbol, decimals);
        }
      }
      if (!canProvideToken || effectiveLpTokenRaw <= 0n) {
        console.log(`skip LP for ${symbol}: token balance is insufficient`);
        continue;
      }

      const canTopUpMusd = await ensureMusdBalance(effectiveLpMusdRaw);
      const musdBalance = await musd.balanceOf(deployer.address);
      if (!canTopUpMusd || musdBalance < effectiveLpMusdRaw) {
        console.log(
          `skip LP for ${symbol}: mUSD balance insufficient required=${ethers.formatEther(effectiveLpMusdRaw)} available=${ethers.formatEther(
            musdBalance
          )}`
        );
        continue;
      }

      await (await token.approve(await router.getAddress(), effectiveLpTokenRaw)).wait();
      await (await musd.approve(await router.getAddress(), effectiveLpMusdRaw)).wait();

      const minToken = applyMinBps(effectiveLpTokenRaw, minLiquidityBps);
      const minMusd = applyMinBps(effectiveLpMusdRaw, minLiquidityBps);

      const majorLpAdded = await addLiquidityWithFallback({
        symbol,
        tokenAddress,
        desiredMusd: effectiveLpMusdRaw,
        desiredToken: effectiveLpTokenRaw,
        minMusd,
        minToken
      });
      if (!majorLpAdded) {
        continue;
      }

      const pair = await factory.getPair(await musd.getAddress(), tokenAddress);
      createdPools.push({ symbol, token: tokenAddress, pair, decimals });
      handledTokenAddresses.add(tokenAddress.toLowerCase());
      if (!existingTokenBySymbol.has(symbol)) {
        existingTokenBySymbol.set(symbol, tokenAddress.toLowerCase());
      }
      console.log(`added LP: ${symbol} pair=${pair}`);
    }
  }

  if (boolEnv('BOOTSTRAP_ENABLE_REGISTRY_TOKEN_POOLS', false)) {
    const includeRegistry = boolEnv('BOOTSTRAP_INCLUDE_CHAIN_REGISTRY_TOKENS', true);
    const registryLimit = Number.parseInt(process.env.BOOTSTRAP_REGISTRY_TOKEN_LIMIT || '200', 10);
    const maxTargets = Number.isFinite(registryLimit) && registryLimit > 0 ? registryLimit : 200;

    const tokenCandidates = new Set<string>();
    for (const address of parseExtraTokenAddresses()) tokenCandidates.add(normalizeAddress(address));
    if (includeRegistry) {
      for (const address of loadChainRegistryTokenAddresses(chainId)) {
        tokenCandidates.add(normalizeAddress(address));
      }
    }

    const tokenAddresses = Array.from(tokenCandidates)
      .filter((address) => ethers.isAddress(address))
      .slice(0, maxTargets);

    for (const tokenAddress of tokenAddresses) {
      if (tokenAddress === musdAddress) continue;
      if (handledTokenAddresses.has(tokenAddress)) continue;

      try {
        const token = await ethers.getContractAt('IERC20Metadata', tokenAddress);
        const symbol = normalizeSymbol(await token.symbol().catch(() => tokenAddressLabel(tokenAddress)));
        const decimals = Number(await token.decimals().catch(() => 18));

        const existingSymbolAddress = existingTokenBySymbol.get(symbol);
        if (existingSymbolAddress && normalizeAddress(existingSymbolAddress) !== tokenAddress) {
          console.log(
            `skip ${symbol}: existing symbol already mapped to ${existingSymbolAddress}, candidate=${tokenAddress}`
          );
          continue;
        }

        const lpTokenAmount = amountEnvForSymbol(
          'BOOTSTRAP_LP',
          symbol,
          'BOOTSTRAP_LP_TARGET_TOKEN_AMOUNT',
          defaultLpTokenAmount(symbol, decimals)
        );
        const lpMusdAmount = amountEnvForSymbol(
          'BOOTSTRAP_LP_MUSD',
          symbol,
          'BOOTSTRAP_LP_TARGET_MUSD_AMOUNT',
          defaultLpMusdAmount(symbol)
        );

        const lpTokenRaw = ethers.parseUnits(lpTokenAmount, decimals);
        const lpMusdRaw = ethers.parseEther(lpMusdAmount);

        const canProvideToken = await ensureTokenBalance(tokenAddress, deployer.address, lpTokenRaw, symbol, decimals);
        if (!canProvideToken) {
          console.log(`skip LP for ${symbol}: token balance is insufficient`);
          continue;
        }

        const canTopUpMusd = await ensureMusdBalance(lpMusdRaw);
        const musdBalance = await musd.balanceOf(deployer.address);
        if (!canTopUpMusd || musdBalance < lpMusdRaw) {
          console.log(
            `skip LP for ${symbol}: mUSD balance insufficient required=${ethers.formatEther(lpMusdRaw)} available=${ethers.formatEther(
              musdBalance
            )}`
          );
          continue;
        }

        await (await token.approve(await router.getAddress(), lpTokenRaw)).wait();
        await (await musd.approve(await router.getAddress(), lpMusdRaw)).wait();

        const minToken = applyMinBps(lpTokenRaw, minLiquidityBps);
        const minMusd = applyMinBps(lpMusdRaw, minLiquidityBps);

        const registryLpAdded = await addLiquidityWithFallback({
          symbol,
          tokenAddress,
          desiredMusd: lpMusdRaw,
          desiredToken: lpTokenRaw,
          minMusd,
          minToken
        });
        if (!registryLpAdded) {
          continue;
        }

        const pair = await factory.getPair(await musd.getAddress(), tokenAddress);
        createdPools.push({ symbol, token: tokenAddress, pair, decimals });
        handledTokenAddresses.add(tokenAddress);
        existingTokenBySymbol.set(symbol, tokenAddress);
        console.log(`added LP (registry-mode): ${symbol} pair=${pair}`);
      } catch (error) {
        console.log(`skip registry token ${tokenAddress}`);
        console.log(String(error));
      }
    }
  }

  persistTargetRegistry(registryPath, registry, createdPools);

  const musdBalance = await musd.balanceOf(deployer.address);

  console.log(`bootstrap complete network=${network.name}`);
  console.log(`deployer=${deployer.address}`);
  console.log(`pools_created=${createdPools.length}`);
  for (const pool of createdPools) {
    console.log(`pool ${pool.symbol}: token=${pool.token} pair=${pool.pair}`);
  }
  console.log(`deployer_musd_balance=${ethers.formatEther(musdBalance)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
