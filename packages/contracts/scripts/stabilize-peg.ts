import { existsSync, readFileSync } from 'node:fs';
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
    decimals?: number;
  }>;
};

type PairTokenState = {
  symbol: string;
  tokenAddress: string;
  pairAddress: string;
  tokenDecimals: number;
  musdDecimals: number;
  tokenReserveRaw: bigint;
  musdReserveRaw: bigint;
  priceE18: bigint;
  deviationBps: bigint;
};

type StabilizeDirection = 'sellTokenForMusd' | 'sellMusdForToken';

type StabilizeAction = {
  state: PairTokenState;
  direction: StabilizeDirection;
  inputRaw: bigint;
  expectedOutRaw: bigint;
  minOutRaw: bigint;
  path: [string, string];
};

const ONE_E18 = 10n ** 18n;
const BPS = 10_000n;
const NO_DEADLINE_WINDOW_SEC = 1_200n;

const ROUTER_ABI = [
  'function getAmountsOut(uint256,address[]) view returns (uint256[])',
  'function getAmountsIn(uint256,address[]) view returns (uint256[])',
  'function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])'
] as const;

const FACTORY_ABI = ['function getPair(address,address) view returns (address)'] as const;

const PAIR_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)'
] as const;

const STABILIZER_ABI = [
  'function minCollateralRatioBps() view returns (uint256)',
  'function oracle() view returns (address)',
  'function collateralConfig(address) view returns (bool enabled,uint8 decimals,uint256 minOraclePriceE18,uint256 maxOraclePriceE18,bool exists)',
  'function mintWithCollateral(address token,uint256 collateralAmount,uint256 minMusdOut,address recipient) returns (uint256)',
  'function burnForCollateral(address token,uint256 musdAmount,uint256 minCollateralOut,address recipient) returns (uint256)'
] as const;

const ORACLE_ABI = ['function getPrice(address token) view returns (uint256 priceE18, uint256 updatedAt)'] as const;

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)'
] as const;

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

function amountEnv(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

function intEnv(name: string, fallback: number, min: number, max: number): bigint {
  const value = process.env[name]?.trim();
  if (!value) return BigInt(fallback);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return BigInt(fallback);
  const clamped = Math.max(min, Math.min(max, parsed));
  return BigInt(clamped);
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function applyBps(value: bigint, bps: bigint): bigint {
  return (value * bps) / BPS;
}

function toE18(raw: bigint, decimals: number): bigint {
  if (decimals === 18) return raw;
  if (decimals < 18) return raw * 10n ** BigInt(18 - decimals);
  return raw / 10n ** BigInt(decimals - 18);
}

function fromE18(rawE18: bigint, decimals: number): bigint {
  if (decimals === 18) return rawE18;
  if (decimals < 18) return rawE18 / 10n ** BigInt(18 - decimals);
  return rawE18 * 10n ** BigInt(decimals - 18);
}

function sqrt(value: bigint): bigint {
  if (value <= 1n) return value;
  let x = value;
  let y = (x + value / x) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

function formatToken(raw: bigint, decimals: number): string {
  return ethers.formatUnits(raw, decimals);
}

function formatBpsSigned(value: bigint): string {
  const sign = value < 0n ? '-' : '+';
  const abs = absBigInt(value);
  const whole = abs / 100n;
  const frac = abs % 100n;
  return `${sign}${whole.toString()}.${frac.toString().padStart(2, '0')}%`;
}

async function readPairState(params: {
  symbol: string;
  tokenAddress: string;
  pairAddress: string;
  musdAddress: string;
  musdDecimals: number;
  targetPriceE18: bigint;
}): Promise<PairTokenState | null> {
  const { symbol, tokenAddress, pairAddress, musdAddress, musdDecimals, targetPriceE18 } = params;
  if (!ethers.isAddress(pairAddress)) return null;

  const pair = await ethers.getContractAt(PAIR_ABI, pairAddress);
  const token = await ethers.getContractAt(ERC20_ABI, tokenAddress);
  const tokenDecimals = Number(await token.decimals());
  const token0 = (await pair.token0()).toLowerCase();
  const reserves = await pair.getReserves();

  let tokenReserveRaw = 0n;
  let musdReserveRaw = 0n;
  if (token0 === tokenAddress.toLowerCase()) {
    tokenReserveRaw = reserves[0];
    musdReserveRaw = reserves[1];
  } else {
    tokenReserveRaw = reserves[1];
    musdReserveRaw = reserves[0];
  }

  if (tokenReserveRaw <= 0n || musdReserveRaw <= 0n) return null;

  const tokenReserveE18 = toE18(tokenReserveRaw, tokenDecimals);
  const musdReserveE18 = toE18(musdReserveRaw, musdDecimals);
  if (tokenReserveE18 <= 0n || musdReserveE18 <= 0n) return null;

  const priceE18 = (musdReserveE18 * ONE_E18) / tokenReserveE18;
  const deviationBps = ((priceE18 - targetPriceE18) * BPS) / targetPriceE18;

  return {
    symbol,
    tokenAddress,
    pairAddress,
    tokenDecimals,
    musdDecimals,
    tokenReserveRaw,
    musdReserveRaw,
    priceE18,
    deviationBps
  };
}

function computeInputToMoveTowardPeg(params: {
  state: PairTokenState;
  targetPriceE18: bigint;
  correctionFractionBps: bigint;
  swapFeeBps: bigint;
}): { direction: StabilizeDirection; inputRaw: bigint } | null {
  const { state, targetPriceE18, correctionFractionBps, swapFeeBps } = params;
  const tokenReserveE18 = toE18(state.tokenReserveRaw, state.tokenDecimals);
  const musdReserveE18 = toE18(state.musdReserveRaw, state.musdDecimals);
  const invariant = tokenReserveE18 * musdReserveE18;
  if (invariant <= 0n) return null;

  const feeDenominator = BPS - swapFeeBps;
  if (feeDenominator <= 0n) return null;

  if (state.priceE18 > targetPriceE18) {
    const desiredTokenReserveE18 = sqrt((invariant * ONE_E18) / targetPriceE18);
    if (desiredTokenReserveE18 <= tokenReserveE18) return null;
    const effectiveTokenInE18 = desiredTokenReserveE18 - tokenReserveE18;
    let rawIn = fromE18(effectiveTokenInE18, state.tokenDecimals);
    rawIn = (rawIn * BPS) / feeDenominator;
    rawIn = applyBps(rawIn, correctionFractionBps);
    if (rawIn <= 0n) return null;
    return { direction: 'sellTokenForMusd', inputRaw: rawIn };
  }

  if (state.priceE18 < targetPriceE18) {
    const desiredMusdReserveE18 = sqrt((invariant * targetPriceE18) / ONE_E18);
    if (desiredMusdReserveE18 <= musdReserveE18) return null;
    const effectiveMusdInE18 = desiredMusdReserveE18 - musdReserveE18;
    let rawIn = fromE18(effectiveMusdInE18, state.musdDecimals);
    rawIn = (rawIn * BPS) / feeDenominator;
    rawIn = applyBps(rawIn, correctionFractionBps);
    if (rawIn <= 0n) return null;
    return { direction: 'sellMusdForToken', inputRaw: rawIn };
  }

  return null;
}

async function ensureApproval(
  tokenAddress: string,
  owner: string,
  spender: string,
  required: bigint
): Promise<void> {
  if (required <= 0n) return;
  const token = await ethers.getContractAt(ERC20_ABI, tokenAddress);
  const allowance = (await token.allowance(owner, spender)) as bigint;
  if (allowance >= required) return;
  if (allowance > 0n) {
    await (await token.approve(spender, 0n)).wait();
  }
  await (await token.approve(spender, required)).wait();
}

async function quoteOut(
  routerAddress: string,
  amountIn: bigint,
  path: [string, string]
): Promise<bigint | null> {
  if (amountIn <= 0n) return 0n;
  try {
    const router = await ethers.getContractAt(ROUTER_ABI, routerAddress);
    const amounts = (await router.getAmountsOut(amountIn, path)) as bigint[];
    return amounts[amounts.length - 1];
  } catch {
    return null;
  }
}

async function quoteInForOut(
  routerAddress: string,
  amountOut: bigint,
  path: [string, string]
): Promise<bigint | null> {
  if (amountOut <= 0n) return 0n;
  try {
    const router = await ethers.getContractAt(ROUTER_ABI, routerAddress);
    const amounts = (await router.getAmountsIn(amountOut, path)) as bigint[];
    return amounts[0];
  } catch {
    return null;
  }
}

async function isCollateralEnabled(stabilizerAddress: string, token: string): Promise<boolean> {
  try {
    const stabilizer = await ethers.getContractAt(STABILIZER_ABI, stabilizerAddress);
    const info = await stabilizer.collateralConfig(token);
    return Boolean(info[0]);
  } catch {
    return false;
  }
}

async function readOraclePriceE18(stabilizerAddress: string, token: string): Promise<bigint | null> {
  try {
    const stabilizer = await ethers.getContractAt(STABILIZER_ABI, stabilizerAddress);
    const oracleAddress = (await stabilizer.oracle()) as string;
    if (!ethers.isAddress(oracleAddress)) return null;
    const oracle = await ethers.getContractAt(ORACLE_ABI, oracleAddress);
    const result = await oracle.getPrice(token);
    const price = result[0] as bigint;
    if (price <= 0n) return null;
    return price;
  } catch {
    return null;
  }
}

async function mintMusdFromCollateral(params: {
  registry: Registry;
  stabilizerAddress: string;
  musdAddress: string;
  musdDecimals: number;
  wallet: string;
  requiredMusdRaw: bigint;
  preferredSymbols: string[];
  mintBufferBps: bigint;
  dryRun: boolean;
}): Promise<bigint> {
  const {
    registry,
    stabilizerAddress,
    musdAddress,
    musdDecimals,
    wallet,
    requiredMusdRaw,
    preferredSymbols,
    mintBufferBps,
    dryRun
  } = params;

  if (requiredMusdRaw <= 0n) return 0n;

  const stabilizer = await ethers.getContractAt(STABILIZER_ABI, stabilizerAddress);
  const minCollateralRatioBps = (await stabilizer.minCollateralRatioBps()) as bigint;
  const musd = await ethers.getContractAt(ERC20_ABI, musdAddress);

  const symbolSet = new Set<string>();
  const orderedSymbols: string[] = [];
  for (const symbol of preferredSymbols) {
    const normalized = normalizeSymbol(symbol);
    if (!normalized || symbolSet.has(normalized)) continue;
    symbolSet.add(normalized);
    orderedSymbols.push(normalized);
  }
  for (const collateral of registry.collaterals || []) {
    const normalized = normalizeSymbol(collateral.symbol || '');
    if (!normalized || symbolSet.has(normalized)) continue;
    symbolSet.add(normalized);
    orderedSymbols.push(normalized);
  }

  let mintedTotal = 0n;
  const requiredWithBuffer = applyBps(requiredMusdRaw, BPS + mintBufferBps);

  for (const symbol of orderedSymbols) {
    if (mintedTotal >= requiredMusdRaw) break;
    const collateral = (registry.collaterals || []).find(
      (item) => normalizeSymbol(item.symbol || '') === symbol && ethers.isAddress(item.token)
    );
    if (!collateral) continue;

    const tokenAddress = collateral.token;
    if (!(await isCollateralEnabled(stabilizerAddress, tokenAddress))) continue;

    const token = await ethers.getContractAt(ERC20_ABI, tokenAddress);
    const tokenDecimals = Number(await token.decimals());
    const balance = (await token.balanceOf(wallet)) as bigint;
    if (balance <= 0n) continue;

    const priceE18 = await readOraclePriceE18(stabilizerAddress, tokenAddress);
    if (!priceE18 || priceE18 <= 0n) continue;

    const missing = requiredWithBuffer > mintedTotal ? requiredWithBuffer - mintedTotal : 0n;
    if (missing <= 0n) break;

    const missingE18 = toE18(missing, musdDecimals);
    const usdNeededE18 = (missingE18 * minCollateralRatioBps) / BPS;
    const collateralNeededE18 = (usdNeededE18 * ONE_E18) / priceE18;
    const collateralNeededRaw = maxBigInt(1n, fromE18(collateralNeededE18, tokenDecimals));
    const collateralToUse = minBigInt(collateralNeededRaw, balance);
    if (collateralToUse <= 0n) continue;

    if (dryRun) {
      const collateralE18 = toE18(collateralToUse, tokenDecimals);
      const usdValueE18 = (collateralE18 * priceE18) / ONE_E18;
      const musdOutE18 = (usdValueE18 * BPS) / minCollateralRatioBps;
      mintedTotal += fromE18(musdOutE18, musdDecimals);
      continue;
    }

    const before = (await musd.balanceOf(wallet)) as bigint;
    await ensureApproval(tokenAddress, wallet, stabilizerAddress, collateralToUse);
    const tx = await stabilizer.mintWithCollateral(tokenAddress, collateralToUse, 0n, wallet);
    await tx.wait();
    const after = (await musd.balanceOf(wallet)) as bigint;
    const minted = after > before ? after - before : 0n;
    mintedTotal += minted;
    console.log(
      `[peg] minted mUSD with ${symbol}: collateral=${formatToken(collateralToUse, tokenDecimals)} minted=${formatToken(minted, musdDecimals)} tx=${tx.hash}`
    );
  }

  return mintedTotal;
}

async function acquireTokenByBurningMusd(params: {
  stabilizerAddress: string;
  musdAddress: string;
  musdDecimals: number;
  tokenAddress: string;
  tokenDecimals: number;
  wallet: string;
  requiredTokenRaw: bigint;
  burnBufferBps: bigint;
  allowMintIfNeeded: boolean;
  registry: Registry;
  dryRun: boolean;
}): Promise<bigint> {
  const {
    stabilizerAddress,
    musdAddress,
    musdDecimals,
    tokenAddress,
    tokenDecimals,
    wallet,
    requiredTokenRaw,
    burnBufferBps,
    allowMintIfNeeded,
    registry,
    dryRun
  } = params;
  if (requiredTokenRaw <= 0n) return 0n;
  if (!(await isCollateralEnabled(stabilizerAddress, tokenAddress))) return 0n;

  const priceE18 = await readOraclePriceE18(stabilizerAddress, tokenAddress);
  if (!priceE18 || priceE18 <= 0n) return 0n;

  const tokenE18 = toE18(requiredTokenRaw, tokenDecimals);
  const musdNeededE18 = (tokenE18 * priceE18) / ONE_E18;
  let musdNeededRaw = fromE18(musdNeededE18, musdDecimals);
  musdNeededRaw = applyBps(musdNeededRaw, BPS + burnBufferBps);
  musdNeededRaw = maxBigInt(1n, musdNeededRaw);

  const musd = await ethers.getContractAt(ERC20_ABI, musdAddress);
  let musdBalance = (await musd.balanceOf(wallet)) as bigint;

  if (musdBalance < musdNeededRaw && allowMintIfNeeded) {
    const deficit = musdNeededRaw - musdBalance;
    await mintMusdFromCollateral({
      registry,
      stabilizerAddress,
      musdAddress,
      musdDecimals,
      wallet,
      requiredMusdRaw: deficit,
      preferredSymbols: ['USDC', 'USDT'],
      mintBufferBps: 300n,
      dryRun
    });
    musdBalance = (await musd.balanceOf(wallet)) as bigint;
  }

  const burnAmount = minBigInt(musdBalance, musdNeededRaw);
  if (burnAmount <= 0n) return 0n;

  if (dryRun) {
    return requiredTokenRaw;
  }

  const token = await ethers.getContractAt(ERC20_ABI, tokenAddress);
  const before = (await token.balanceOf(wallet)) as bigint;

  await ensureApproval(musdAddress, wallet, stabilizerAddress, burnAmount);
  const stabilizer = await ethers.getContractAt(STABILIZER_ABI, stabilizerAddress);
  const tx = await stabilizer.burnForCollateral(tokenAddress, burnAmount, 0n, wallet);
  await tx.wait();

  const after = (await token.balanceOf(wallet)) as bigint;
  const gained = after > before ? after - before : 0n;
  console.log(
    `[peg] burned mUSD for collateral: token=${tokenAddress} burned=${formatToken(burnAmount, musdDecimals)} gained=${formatToken(gained, tokenDecimals)} tx=${tx.hash}`
  );
  return gained;
}

async function buildAction(params: {
  state: PairTokenState;
  routerAddress: string;
  musdAddress: string;
  triggerBps: bigint;
  slippageBps: bigint;
  targetPriceE18: bigint;
  correctionFractionBps: bigint;
  swapFeeBps: bigint;
  maxActionMusdRaw: bigint;
  minActionMusdRaw: bigint;
}): Promise<StabilizeAction | null> {
  const {
    state,
    routerAddress,
    musdAddress,
    triggerBps,
    slippageBps,
    targetPriceE18,
    correctionFractionBps,
    swapFeeBps,
    maxActionMusdRaw,
    minActionMusdRaw
  } = params;

  if (absBigInt(state.deviationBps) < triggerBps) return null;

  const base = computeInputToMoveTowardPeg({
    state,
    targetPriceE18,
    correctionFractionBps,
    swapFeeBps
  });
  if (!base || base.inputRaw <= 0n) return null;

  let inputRaw = base.inputRaw;
  let path: [string, string];
  if (base.direction === 'sellTokenForMusd') {
    path = [state.tokenAddress, musdAddress];
    const quoteRaw = await quoteOut(routerAddress, inputRaw, path);
    if (!quoteRaw || quoteRaw <= 0n) return null;
    if (quoteRaw > maxActionMusdRaw) {
      let cappedIn = await quoteInForOut(routerAddress, maxActionMusdRaw, path);
      if (!cappedIn || cappedIn <= 0n) {
        const reserveApprox = state.musdReserveRaw > 0n
          ? (maxActionMusdRaw * state.tokenReserveRaw) / state.musdReserveRaw
          : 0n;
        cappedIn = reserveApprox > 0n ? reserveApprox : null;
      }
      if (!cappedIn || cappedIn <= 0n) return null;
      inputRaw = cappedIn;
    }
    const recalcOut = await quoteOut(routerAddress, inputRaw, path);
    if (!recalcOut || recalcOut < minActionMusdRaw) return null;
    const minOutRaw = applyBps(recalcOut, BPS - slippageBps);
    return {
      state,
      direction: base.direction,
      inputRaw,
      expectedOutRaw: recalcOut,
      minOutRaw,
      path
    };
  }

  path = [musdAddress, state.tokenAddress];
  inputRaw = minBigInt(inputRaw, maxActionMusdRaw);
  if (inputRaw < minActionMusdRaw) return null;
  const outRaw = await quoteOut(routerAddress, inputRaw, path);
  if (!outRaw || outRaw <= 0n) return null;
  const minOutRaw = applyBps(outRaw, BPS - slippageBps);
  return {
    state,
    direction: base.direction,
    inputRaw,
    expectedOutRaw: outRaw,
    minOutRaw,
    path
  };
}

async function executeAction(params: {
  action: StabilizeAction;
  registry: Registry;
  routerAddress: string;
  stabilizerAddress: string;
  wallet: string;
  musdAddress: string;
  musdDecimals: number;
  allowMint: boolean;
  allowBurn: boolean;
  mintBufferBps: bigint;
  burnBufferBps: bigint;
  dryRun: boolean;
}): Promise<boolean> {
  const {
    action,
    registry,
    routerAddress,
    stabilizerAddress,
    wallet,
    musdAddress,
    musdDecimals,
    allowMint,
    allowBurn,
    mintBufferBps,
    burnBufferBps,
    dryRun
  } = params;
  const token = await ethers.getContractAt(ERC20_ABI, action.state.tokenAddress);
  const tokenSymbol = String(await token.symbol());
  const tokenDecimals = action.state.tokenDecimals;
  const musd = await ethers.getContractAt(ERC20_ABI, musdAddress);

  if (action.direction === 'sellMusdForToken') {
    const current = (await musd.balanceOf(wallet)) as bigint;
    if (current < action.inputRaw) {
      if (!allowMint) {
        console.log(
          `[peg] skip ${action.state.symbol}: insufficient mUSD (${formatToken(current, musdDecimals)} < ${formatToken(action.inputRaw, musdDecimals)}), mint disabled`
        );
        return false;
      }
      const preferred = [action.state.symbol, 'USDC', 'USDT'];
      await mintMusdFromCollateral({
        registry,
        stabilizerAddress,
        musdAddress,
        musdDecimals,
        wallet,
        requiredMusdRaw: action.inputRaw - current,
        preferredSymbols: preferred,
        mintBufferBps,
        dryRun
      });
      const refreshed = (await musd.balanceOf(wallet)) as bigint;
      if (refreshed < action.inputRaw) {
        console.log(
          `[peg] skip ${action.state.symbol}: still insufficient mUSD after mint attempt (${formatToken(refreshed, musdDecimals)}).`
        );
        return false;
      }
    }
  } else {
    const current = (await token.balanceOf(wallet)) as bigint;
    if (current < action.inputRaw) {
      if (!allowBurn) {
        console.log(
          `[peg] skip ${action.state.symbol}: insufficient ${tokenSymbol} (${formatToken(current, tokenDecimals)} < ${formatToken(action.inputRaw, tokenDecimals)}), burn disabled`
        );
        return false;
      }

      await acquireTokenByBurningMusd({
        stabilizerAddress,
        musdAddress,
        musdDecimals,
        tokenAddress: action.state.tokenAddress,
        tokenDecimals,
        wallet,
        requiredTokenRaw: action.inputRaw - current,
        burnBufferBps,
        allowMintIfNeeded: allowMint,
        registry,
        dryRun
      });
      const refreshed = (await token.balanceOf(wallet)) as bigint;
      if (refreshed < action.inputRaw) {
        console.log(
          `[peg] skip ${action.state.symbol}: still insufficient ${tokenSymbol} after burn/mint attempt (${formatToken(refreshed, tokenDecimals)}).`
        );
        return false;
      }
    }
  }

  const tokenInAddress = action.path[0];
  const tokenInDecimals = tokenInAddress.toLowerCase() === musdAddress.toLowerCase() ? musdDecimals : tokenDecimals;
  const tokenOutDecimals = tokenInAddress.toLowerCase() === musdAddress.toLowerCase() ? tokenDecimals : musdDecimals;

  if (dryRun) {
    console.log(
      `[peg] dry-run ${action.state.symbol}: direction=${action.direction} in=${formatToken(action.inputRaw, tokenInDecimals)} out~=${formatToken(action.expectedOutRaw, tokenOutDecimals)}`
    );
    return true;
  }

  await ensureApproval(tokenInAddress, wallet, routerAddress, action.inputRaw);
  const router = await ethers.getContractAt(ROUTER_ABI, routerAddress);
  const deadline = BigInt(Math.floor(Date.now() / 1000)) + NO_DEADLINE_WINDOW_SEC;
  const tx = await router.swapExactTokensForTokens(
    action.inputRaw,
    action.minOutRaw,
    [action.path[0], action.path[1]],
    wallet,
    deadline
  );
  await tx.wait();
  console.log(
    `[peg] executed ${action.state.symbol}: direction=${action.direction} in=${formatToken(action.inputRaw, tokenInDecimals)} minOut=${formatToken(action.minOutRaw, tokenOutDecimals)} tx=${tx.hash}`
  );
  return true;
}

async function main(): Promise<void> {
  const [signer] = await ethers.getSigners();
  const wallet = await signer.getAddress();
  const registry = readRegistry(registryPathForNetwork());

  const musdAddress = registry.contracts.musd;
  const routerAddress = registry.contracts.harmonyRouter;
  const factoryAddress = registry.contracts.harmonyFactory;
  const stabilizerAddress = registry.contracts.stabilizer;

  if (!ethers.isAddress(musdAddress) || !ethers.isAddress(routerAddress) || !ethers.isAddress(factoryAddress) || !ethers.isAddress(stabilizerAddress)) {
    throw new Error('registry missing one of musd/harmonyRouter/harmonyFactory/stabilizer addresses');
  }

  const musd = await ethers.getContractAt(ERC20_ABI, musdAddress);
  const musdDecimals = Number(await musd.decimals());

  const strict = boolEnv('PEG_STRICT', false);
  const dryRun = boolEnv('PEG_DRY_RUN', false);
  const allowMint = boolEnv('PEG_ALLOW_MINT', true);
  const allowBurn = boolEnv('PEG_ALLOW_BURN', true);
  const symbols = parseCsv(process.env.PEG_SYMBOLS).length
    ? parseCsv(process.env.PEG_SYMBOLS)
    : ['USDC', 'USDT'];

  const triggerBps = intEnv('PEG_TRIGGER_BPS', 80, 1, 5_000);
  const slippageBps = intEnv('PEG_SLIPPAGE_BPS', 120, 1, 2_000);
  const correctionFractionBps = intEnv('PEG_CORRECTION_FRACTION_BPS', 4_000, 100, 10_000);
  const swapFeeBps = intEnv('PEG_SWAP_FEE_BPS', 30, 0, 2_000);
  const mintBufferBps = intEnv('PEG_MINT_BUFFER_BPS', 300, 0, 3_000);
  const burnBufferBps = intEnv('PEG_BURN_BUFFER_BPS', 200, 0, 3_000);
  const targetPriceE18 = ethers.parseUnits(amountEnv('PEG_TARGET_PRICE', '1'), 18);
  const maxActionMusdRaw = ethers.parseUnits(amountEnv('PEG_MAX_ACTION_MUSD', '600'), musdDecimals);
  const minActionMusdRaw = ethers.parseUnits(amountEnv('PEG_MIN_ACTION_MUSD', '5'), musdDecimals);

  console.log(
    `[peg] start network=${network.name} wallet=${wallet} symbols=${symbols.join(',')} trigger_bps=${triggerBps.toString()} dry_run=${dryRun} allow_mint=${allowMint} allow_burn=${allowBurn}`
  );

  const factory = await ethers.getContractAt(FACTORY_ABI, factoryAddress);
  const targetsBySymbol = new Map<string, { token: string; pair?: string }>();
  for (const target of registry.targets || []) {
    const symbol = normalizeSymbol(target.symbol || '');
    if (!symbol || !ethers.isAddress(target.token)) continue;
    targetsBySymbol.set(symbol, { token: target.token, pair: target.pair });
  }

  let actionsAttempted = 0;
  let actionsExecuted = 0;
  const failures: string[] = [];

  for (const symbol of symbols) {
    try {
      const target = targetsBySymbol.get(symbol);
      if (!target) {
        const message = `symbol ${symbol} not found in registry targets`;
        if (strict) throw new Error(message);
        console.log(`[peg] skip ${symbol}: ${message}`);
        continue;
      }

      let pairAddress = target.pair || '';
      if (!ethers.isAddress(pairAddress)) {
        pairAddress = await factory.getPair(musdAddress, target.token);
      }
      if (!ethers.isAddress(pairAddress) || pairAddress === ethers.ZeroAddress) {
        const message = `pair not found for ${symbol}/mUSD`;
        if (strict) throw new Error(message);
        console.log(`[peg] skip ${symbol}: ${message}`);
        continue;
      }

      const state = await readPairState({
        symbol,
        tokenAddress: target.token,
        pairAddress,
        musdAddress,
        musdDecimals,
        targetPriceE18
      });
      if (!state) {
        const message = `pair state unavailable (no reserves)`;
        if (strict) throw new Error(message);
        console.log(`[peg] skip ${symbol}: ${message}`);
        continue;
      }

      console.log(
        `[peg] ${symbol}/mUSD price=${ethers.formatUnits(state.priceE18, 18)} deviation=${formatBpsSigned(state.deviationBps)} reserves token=${formatToken(state.tokenReserveRaw, state.tokenDecimals)} musd=${formatToken(state.musdReserveRaw, musdDecimals)}`
      );

      const action = await buildAction({
        state,
        routerAddress,
        musdAddress,
        triggerBps,
        slippageBps,
        targetPriceE18,
        correctionFractionBps,
        swapFeeBps,
        maxActionMusdRaw,
        minActionMusdRaw
      });

      if (!action) continue;
      actionsAttempted += 1;

      const executed = await executeAction({
        action,
        registry,
        routerAddress,
        stabilizerAddress,
        wallet,
        musdAddress,
        musdDecimals,
        allowMint,
        allowBurn,
        mintBufferBps,
        burnBufferBps,
        dryRun
      });
      if (executed) actionsExecuted += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${symbol}: ${message}`);
      console.log(`[peg] error ${symbol}: ${message}`);
      if (strict) {
        throw error;
      }
    }
  }

  console.log(
    `[peg] done network=${network.name} attempted=${actionsAttempted} executed=${actionsExecuted} failures=${failures.length}`
  );
  if (failures.length > 0) {
    for (const failure of failures) {
      console.log(`[peg] failure: ${failure}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
