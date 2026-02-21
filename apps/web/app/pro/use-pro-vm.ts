'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Address,
  erc20Abi,
  formatUnits,
  isAddress,
  keccak256,
  maxUint256,
  parseAbiItem,
  parseUnits,
  stringToHex,
  zeroAddress
} from 'viem';
import { useAccount, usePublicClient, useWalletClient } from 'wagmi';
import {
  PairInput,
  PairStatsItem,
  TokenRegistryItem,
  buildTokenRegistry,
  buildVenueMarkets,
  pairId as registryPairId
} from './markets.config';
import { MUSD_SYMBOL, defaultMarketPair, staticChainTokens } from './tokens.config';
import { RoutePlan, buildRoutePlan } from './route-builder';

const API_BASE = process.env.NEXT_PUBLIC_TEMPO_API_BASE || 'http://localhost:8500';
const LOCAL_CHAIN_ENABLED = process.env.NEXT_PUBLIC_ENABLE_LOCAL_CHAIN === 'true';
const ENV_DEFAULT_CHAIN_ID = Number(process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID || (LOCAL_CHAIN_ENABLED ? '31337' : '97'));
export const DEFAULT_CHAIN_ID = Number.isFinite(ENV_DEFAULT_CHAIN_ID) ? ENV_DEFAULT_CHAIN_ID : LOCAL_CHAIN_ENABLED ? 31337 : 97;
export const REQUIRE_MUSD_QUOTE = process.env.NEXT_PUBLIC_REQUIRE_MUSD_QUOTE !== 'false';
export const ENABLE_ADMIN_MINT_UI = process.env.NEXT_PUBLIC_ENABLE_ADMIN_MINT_UI === 'true';

const DEFAULT_SWAP_GAS_BY_CHAIN: Record<number, bigint> = {
  97: 900_000n,
  11155111: 1_200_000n,
  31337: 1_200_000n
};
const SWAP_GAS_SOFT_CAP = 3_000_000n;
const SWAP_GAS_FLOOR = 250_000n;
const LEDGER_RECENT_MAX_LIMIT = 1200;
const ANALYTICS_MAX_MINUTES = 10080;
const QUOTE_STALE_MS = Math.max(5_000, Number(process.env.NEXT_PUBLIC_QUOTE_STALE_MS || '30000'));
const FETCH_RETRY_ATTEMPTS = Math.max(1, Number(process.env.NEXT_PUBLIC_FETCH_RETRY_ATTEMPTS || '4'));
const FETCH_RETRY_BASE_DELAY_MS = Math.max(150, Number(process.env.NEXT_PUBLIC_FETCH_RETRY_BASE_DELAY_MS || '400'));
const FETCH_RETRY_MAX_DELAY_MS = Math.max(FETCH_RETRY_BASE_DELAY_MS, Number(process.env.NEXT_PUBLIC_FETCH_RETRY_MAX_DELAY_MS || '5000'));
const HEALTH_POLL_MS = Math.max(1500, Number(process.env.NEXT_PUBLIC_PRO_HEALTH_POLL_MS || '7000'));
const HEALTH_TIMEOUT_MS = Math.max(800, Number(process.env.NEXT_PUBLIC_PRO_HEALTH_TIMEOUT_MS || '3500'));
const BALANCE_POLL_MS = Math.max(2500, Number(process.env.NEXT_PUBLIC_BALANCE_POLL_MS || '7000'));
const EXECUTION_DISABLE_DEPTH_MUSD = Math.max(
  0,
  Number(process.env.NEXT_PUBLIC_EXECUTION_DISABLE_DEPTH_MUSD || '50')
);
const LIQUIDITY_TRADE_CAP_MULTIPLIER = Math.max(
  0.001,
  Number(process.env.NEXT_PUBLIC_LIQUIDITY_TRADE_CAP_MULTIPLIER || '1')
);
const EXECUTION_GUARD_MAX_DEVIATION_BPS = Math.max(
  1,
  Number(
    process.env.NEXT_PUBLIC_EXECUTION_GUARD_MAX_DEVIATION_BPS ||
      process.env.NEXT_PUBLIC_QUOTE_SANITY_MAX_DEVIATION_BPS ||
      '50'
  )
);
const QUOTE_SANITY_LIQUIDITY_DIVISOR_MUSD = Math.max(
  1,
  Number(process.env.NEXT_PUBLIC_QUOTE_SANITY_LIQUIDITY_DIVISOR_MUSD || '25000')
);
const CHAIN_EXPOSURE_CAP_MUSD = Math.max(
  0,
  Number(process.env.NEXT_PUBLIC_CHAIN_EXPOSURE_CAP_MUSD || '2500000')
);
const MINT_DAILY_CAP_MUSD = Math.max(0, Number(process.env.NEXT_PUBLIC_MINT_DAILY_CAP_MUSD || '500000'));
const MINT_CHAIN_CAP_MUSD = Math.max(0, Number(process.env.NEXT_PUBLIC_MINT_CHAIN_CAP_MUSD || '5000000'));
const MINT_REQUIRE_GOVERNANCE = process.env.NEXT_PUBLIC_MINT_REQUIRE_GOVERNANCE !== 'false';
const MINTER_MULTISIG_ADDRESS = String(process.env.NEXT_PUBLIC_MINTER_MULTISIG_ADDRESS || '').trim();
const MINTER_TIMELOCK_ADDRESS = String(process.env.NEXT_PUBLIC_MINTER_TIMELOCK_ADDRESS || '').trim();
const MINTER_TIMELOCK_MIN_DELAY_SEC = Math.max(
  0,
  Number(process.env.NEXT_PUBLIC_MINTER_TIMELOCK_MIN_DELAY_SEC || '0')
);
const APPROVAL_MODE = String(process.env.NEXT_PUBLIC_APPROVAL_MODE || 'finite').toLowerCase() === 'unlimited'
  ? 'unlimited'
  : 'finite';
const FINITE_APPROVAL_BUFFER_BPS = Math.max(
  0,
  Math.min(5000, Number(process.env.NEXT_PUBLIC_FINITE_APPROVAL_BUFFER_BPS || '300'))
);
const DEFAULT_BRIDGE_ALLOWLIST = ['WBNB', 'WETH', 'WBTC', 'WSOL', 'WAVAX', 'WZIL', 'USDC', 'USDT', 'MUSD', 'MODX'];
const DEFAULT_CHAIN_BLOCKS_PER_DAY: Record<number, bigint> = {
  97: 28_800n,
  11155111: 7_200n,
  31337: 10_000n
};
const STABLE_MUSD_RAIL_SYMBOLS = new Set(['USDC', 'USDT']);

const harmonyRouterAbi = [
  {
    inputs: [
      { internalType: 'uint256', name: 'amountIn', type: 'uint256' },
      { internalType: 'uint256', name: 'amountOutMin', type: 'uint256' },
      { internalType: 'address[]', name: 'path', type: 'address[]' },
      { internalType: 'address', name: 'to', type: 'address' },
      { internalType: 'uint256', name: 'deadline', type: 'uint256' }
    ],
    name: 'swapExactTokensForTokens',
    outputs: [{ internalType: 'uint256[]', name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'nonpayable',
    type: 'function'
  }
] as const;

const wrappedNativeAbi = [
  {
    inputs: [],
    name: 'deposit',
    outputs: [],
    stateMutability: 'payable',
    type: 'function'
  }
] as const;

const accessControlAbi = [
  {
    inputs: [
      { internalType: 'bytes32', name: 'role', type: 'bytes32' },
      { internalType: 'address', name: 'account', type: 'address' }
    ],
    name: 'hasRole',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function'
  }
] as const;

const mintableTokenAbi = [
  {
    inputs: [
      { internalType: 'address', name: 'to', type: 'address' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' }
    ],
    name: 'mint',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  }
] as const;

const pausableAbi = [
  {
    inputs: [],
    name: 'paused',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function'
  }
] as const;

const ownableAbi = [
  {
    inputs: [],
    name: 'owner',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function'
  }
] as const;

const timelockAbi = [
  {
    inputs: [],
    name: 'getMinDelay',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  }
] as const;

const transferEventAbi = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

export type TokenItem = {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  source?: string;
  is_wrapped?: boolean;
  underlying_symbol?: string;
};

export type NetworkItem = {
  chain_id: number;
  chain_key: string;
  name: string;
  router_address?: string;
  musd_address?: string;
  swap_fee_bps?: number;
  protocol_fee_bps?: number;
  pair_count?: number;
};

type TokensResponse = {
  chains: Record<string, TokenItem[]>;
  networks?: NetworkItem[];
};

type PairsResponse = {
  rows: PairInput[];
};

type AnalyticsBucket = {
  bucket: string;
  chain_id: number | string;
  asset?: string;
  volume?: string;
  revenue_usd?: string;
};

type AnalyticsResponse = {
  minutes: number;
  volume_by_chain_token: AnalyticsBucket[];
  fee_revenue: AnalyticsBucket[];
};

type LedgerEntry = {
  tx_hash: string;
  chain_id: number;
  pool_address?: string | null;
  entry_type: string;
  side: string;
  asset: string;
  amount: string;
  fee_usd?: string;
  gas_cost_usd?: string;
  occurred_at: string;
};

type LedgerResponse = {
  rows: LedgerEntry[];
};

export type MarketRow = {
  id: string;
  chainId: number;
  pair: string;
  displayPair: string;
  baseSymbol: string;
  quoteSymbol: string;
  baseDisplaySymbol: string;
  quoteDisplaySymbol: string;
  last: number | null;
  change24h: number | null;
  volume24h: number;
  poolAddress: string;
  hasPool: boolean;
  lowLiquidity: boolean;
  warnings: string[];
  routeHint: string;
  maxTradeNotionalMusd: number;
  swaps: number;
  reserveBase: number;
  reserveQuote: number;
  totalFeeUsd: number;
  lastSwapAt?: string | null;
  tickSize: number;
  stepSize: number;
  minOrder: number;
  uiPrecisionPrice: number;
  uiPrecisionSize: number;
};

export type TradeRow = {
  txHash: string;
  poolAddress: string;
  at: string;
  side: 'buy' | 'sell';
  baseToken: string;
  quoteToken: string;
  baseAmount: number;
  quoteAmount: number;
  price: number;
  feeUsd: number;
  gasUsd: number;
};

export type OrderbookLevel = {
  price: number;
  size: number;
  total: number;
};

export type QuoteResponse = RoutePlan;

export type ChartPoint = {
  label: string;
  price: number | null;
  volume: number;
  fees: number;
};

export type OhlcCandle = {
  bucket: number;
  label: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  fees: number;
  tradeCount: number;
};

export type Timeframe = '1m' | '5m' | '1h' | '1d';

export type LimitDraft = {
  id: string;
  chain_id: number;
  side: 'buy' | 'sell';
  token_in: string;
  token_out: string;
  amount: string;
  limit_price: string;
  created_at: string;
};

export type AdminMintEvent = {
  txHash: string;
  recipient: string;
  amount: string;
  blockNumber: bigint;
};

export type EndpointHealthItem = {
  endpoint: string;
  latencyMs: number | null;
  ok: boolean;
  switched: boolean;
  checkedAt: string;
  reason: string;
};

function n(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeEndpoint(value: string): string {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '');
}

function parseApiCandidates(): string[] {
  const explicit = String(process.env.NEXT_PUBLIC_TEMPO_API_BASE_CANDIDATES || '');
  const merged = [API_BASE, ...explicit.split(',')].map(normalizeEndpoint).filter(Boolean);
  return Array.from(new Set(merged));
}

async function pingEndpoint(endpoint: string, timeoutMs: number): Promise<number> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(`${normalizeEndpoint(endpoint)}/health/ready`, {
      cache: 'no-store',
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`status ${response.status}`);
    }
    return Math.max(1, Math.round(performance.now() - started));
  } finally {
    window.clearTimeout(timeout);
  }
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function normalizePoolAddress(poolAddress: string): string {
  return String(poolAddress || '').trim().toLowerCase();
}

export function shortAmount(value: string | number): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return String(value);
  if (parsed === 0) return '0';
  if (parsed < 0.000001) return parsed.toExponential(2);
  return parsed.toFixed(6).replace(/\.?0+$/, '');
}

function clampAmountPrecision(value: string, decimals: number): string {
  const [wholeRaw, fractionRaw = ''] = value.split('.');
  const whole = wholeRaw || '0';
  if (decimals <= 0) return whole;
  const fraction = fractionRaw.slice(0, decimals);
  return fraction.length ? `${whole}.${fraction}` : whole;
}

function resolveSwapGasLimit(chainId: number, estimatedGas: bigint, chainGasCap: bigint): bigint {
  const fallback = DEFAULT_SWAP_GAS_BY_CHAIN[chainId] ?? 900_000n;
  let gas = (estimatedGas * 120n) / 100n;
  if (gas > SWAP_GAS_SOFT_CAP) gas = fallback;
  if (gas > chainGasCap) gas = chainGasCap;
  if (gas < SWAP_GAS_FLOOR) gas = SWAP_GAS_FLOOR;
  return gas;
}

class ApiRequestError extends Error {
  status: number;
  retriable: boolean;

  constructor(message: string, status = 0, retriable = false) {
    super(message);
    this.status = status;
    this.retriable = retriable;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function shouldRetryApiError(error: unknown): boolean {
  if (error instanceof ApiRequestError) {
    return error.retriable;
  }
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('failed to fetch') ||
    message.includes('networkerror') ||
    message.includes('network request failed') ||
    message.includes('err_connection') ||
    message.includes('request timeout')
  );
}

async function fetchJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { cache: 'no-store' });
  } catch (error) {
    throw new ApiRequestError(error instanceof Error ? error.message : 'network request failed', 0, true);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    let detailMessage = '';
    if (body && typeof body === 'object') {
      const detail = (body as { detail?: unknown }).detail;
      if (typeof detail === 'string' && detail.trim()) {
        detailMessage = detail.trim();
      }
    }
    const status = res.status;
    const retriable = status === 408 || status === 425 || status === 429 || status >= 500;
    throw new ApiRequestError(detailMessage || `request failed: ${status}`, status, retriable);
  }
  return body as T;
}

async function fetchJsonWithRetry<T>(
  path: string,
  options?: {
    attempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    onRetry?: (ctx: { attempt: number; attempts: number; delayMs: number; reason: string }) => void;
  }
): Promise<T> {
  const attempts = Math.max(1, options?.attempts ?? FETCH_RETRY_ATTEMPTS);
  const initialDelay = Math.max(100, options?.initialDelayMs ?? FETCH_RETRY_BASE_DELAY_MS);
  const maxDelay = Math.max(initialDelay, options?.maxDelayMs ?? FETCH_RETRY_MAX_DELAY_MS);

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchJson<T>(path);
    } catch (error) {
      lastError = error;
      const canRetry = attempt < attempts && shouldRetryApiError(error);
      if (!canRetry) break;

      const backoff = Math.min(maxDelay, Math.round(initialDelay * 2 ** (attempt - 1)));
      const jitter = Math.floor(Math.random() * Math.max(60, Math.round(backoff * 0.25)));
      const delayMs = backoff + jitter;
      options?.onRetry?.({
        attempt,
        attempts,
        delayMs,
        reason: error instanceof Error ? error.message : 'request failed'
      });
      await sleep(delayMs);
    }
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error('request failed');
}

async function fetchLedgerRecentWithFallback(chainId: number, preferredLimit: number): Promise<LedgerResponse> {
  const candidates = Array.from(
    new Set([preferredLimit, 1000, 800, 500, 300, 200].filter((value) => Number.isFinite(value) && value > 0))
  );
  let lastError: Error | null = null;

  for (const limit of candidates) {
    try {
      return await fetchJsonWithRetry<LedgerResponse>(`/ledger/recent?chain_id=${chainId}&limit=${limit}`);
    } catch (err) {
      if (err instanceof Error) {
        lastError = err;
        if (!(err.message.includes('422') || (err instanceof ApiRequestError && err.status === 422))) {
          throw err;
        }
      } else {
        throw err;
      }
    }
  }

  throw lastError || new Error('ledger endpoint unavailable');
}

async function fetchAnalyticsWithFallback(preferredMinutes: number): Promise<AnalyticsResponse> {
  const candidates = Array.from(
    new Set(
      [preferredMinutes, 4320, 2880, 1440, 720, 360, 180]
        .map((value) => Math.max(1, Math.min(ANALYTICS_MAX_MINUTES, Math.floor(value))))
        .filter((value) => Number.isFinite(value) && value > 0)
    )
  );
  let lastError: Error | null = null;

  for (const minutes of candidates) {
    try {
      return await fetchJsonWithRetry<AnalyticsResponse>(`/analytics?minutes=${minutes}`);
    } catch (err) {
      if (err instanceof Error) {
        lastError = err;
        if (!(err.message.includes('422') || (err instanceof ApiRequestError && err.status === 422))) {
          throw err;
        }
      } else {
        throw err;
      }
    }
  }

  throw lastError || new Error('analytics endpoint unavailable');
}

function roundBucket(date: Date, timeframe: Timeframe): number {
  const ts = date.getTime();
  const minute = 60_000;
  if (timeframe === '1m') return Math.floor(ts / minute) * minute;
  if (timeframe === '5m') return Math.floor(ts / (5 * minute)) * 5 * minute;
  if (timeframe === '1h') return Math.floor(ts / (60 * minute)) * 60 * minute;
  return Math.floor(ts / (24 * 60 * minute)) * 24 * 60 * minute;
}

function formatBucket(bucket: number, timeframe: Timeframe): string {
  const d = new Date(bucket);
  if (timeframe === '1d') {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  if (timeframe === '1h') {
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit' });
  }
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function timeframeWindowMinutes(timeframe: Timeframe): number {
  if (timeframe === '1m') return 180;
  if (timeframe === '5m') return 1440;
  if (timeframe === '1h') return 10080;
  return ANALYTICS_MAX_MINUTES;
}

type SwapExecution = {
  txHash: string;
  poolAddress: string;
  at: string;
  inAsset?: string;
  outAsset?: string;
  inAmount: number;
  outAmount: number;
  feeUsd: number;
  gasUsd: number;
  amounts: Record<string, number>;
};

function parseSwapExecutions(rows: LedgerEntry[]): SwapExecution[] {
  const grouped = new Map<
    string,
    {
      txHash: string;
      poolAddress: string;
      at: string;
      inAsset?: string;
      outAsset?: string;
      inAmount: number;
      outAmount: number;
      feeUsd: number;
      gasUsd: number;
      amounts: Record<string, number>;
    }
  >();

  for (const row of rows) {
    if (!row.tx_hash || !row.entry_type.startsWith('swap_notional_')) continue;
    const poolAddress = String(row.pool_address || '').toLowerCase();
    if (!poolAddress) continue;
    const key = `${row.tx_hash.toLowerCase()}::${poolAddress}`;

    const current = grouped.get(key) || {
      txHash: row.tx_hash.toLowerCase(),
      poolAddress,
      at: row.occurred_at,
      inAmount: 0,
      outAmount: 0,
      feeUsd: 0,
      gasUsd: 0,
      amounts: {}
    };

    const asset = normalizeSymbol(row.asset || '');
    const amount = Math.abs(n(row.amount));
    if (asset) {
      current.amounts[asset] = Math.max(current.amounts[asset] || 0, amount);
    }

    current.feeUsd = Math.max(current.feeUsd, n(row.fee_usd));
    current.gasUsd = Math.max(current.gasUsd, n(row.gas_cost_usd));
    if (new Date(row.occurred_at).getTime() > new Date(current.at).getTime()) {
      current.at = row.occurred_at;
    }

    if (row.entry_type === 'swap_notional_in' && amount > current.inAmount) {
      current.inAmount = amount;
      current.inAsset = asset;
    }
    if (row.entry_type === 'swap_notional_out' && amount > current.outAmount) {
      current.outAmount = amount;
      current.outAsset = asset;
    }

    grouped.set(key, current);
  }

  return Array.from(grouped.values()).sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

function computePairStatsMap(pairs: PairInput[], chainId: number, ledgerRows: LedgerEntry[]): Map<string, PairStatsItem> {
  const filteredPairs = pairs.filter((pair) => Number(pair.chain_id) === chainId);
  const pairByPool = new Map<
    string,
    {
      id: string;
      token0: string;
      token1: string;
      reserve0: number;
      reserve1: number;
      fallbackVolume: number;
      fallbackLastSwapAt: string | null;
    }
  >();

  for (const pair of filteredPairs) {
    const id = registryPairId(pair.chain_id, pair.pool_address);
    pairByPool.set(normalizePoolAddress(pair.pool_address), {
      id,
      token0: normalizeSymbol(pair.token0_symbol),
      token1: normalizeSymbol(pair.token1_symbol),
      reserve0: n(pair.reserve0_decimal),
      reserve1: n(pair.reserve1_decimal),
      fallbackVolume: n(pair.total_amount_in),
      fallbackLastSwapAt: pair.last_swap_at || null
    });
  }

  const historyByPair = new Map<
    string,
    Array<{
      at: number;
      price: number;
      quoteVolume: number;
    }>
  >();

  const executions = parseSwapExecutions(ledgerRows);
  for (const execution of executions) {
    const pair = pairByPool.get(execution.poolAddress);
    if (!pair) continue;

    const amountBase = execution.amounts[pair.token0] || 0;
    const amountQuote = execution.amounts[pair.token1] || 0;
    if (amountBase <= 0 || amountQuote <= 0) continue;

    const price = amountQuote / amountBase;
    if (!Number.isFinite(price) || price <= 0) continue;

    const at = new Date(execution.at).getTime();
    const history = historyByPair.get(pair.id) || [];
    history.push({
      at: Number.isFinite(at) ? at : 0,
      price,
      quoteVolume: amountQuote
    });
    historyByPair.set(pair.id, history);
  }

  const since24h = Date.now() - 24 * 60 * 60 * 1000;
  const stats = new Map<string, PairStatsItem>();

  for (const pair of pairByPool.values()) {
    const history = (historyByPair.get(pair.id) || []).sort((a, b) => a.at - b.at);
    const reservePrice = pair.reserve0 > 0 ? pair.reserve1 / pair.reserve0 : null;

    if (!history.length) {
      stats.set(pair.id, {
        lastPrice: reservePrice,
        change24h: null,
        volume24h: pair.fallbackVolume,
        lastSwapAt: pair.fallbackLastSwapAt
      });
      continue;
    }

    const last = history[history.length - 1];
    const last24h = history.filter((item) => item.at >= since24h);
    const first24h = last24h.length ? last24h[0] : null;
    const final24h = last24h.length ? last24h[last24h.length - 1] : null;
    const change24h =
      first24h && final24h && first24h.price > 0 ? ((final24h.price - first24h.price) / first24h.price) * 100 : null;
    const volume24h = last24h.reduce((sum, item) => sum + item.quoteVolume, 0);

    stats.set(pair.id, {
      lastPrice: last.price,
      change24h,
      volume24h,
      lastSwapAt: new Date(last.at).toISOString()
    });
  }

  return stats;
}

function parseMarketRows(
  pairs: PairInput[],
  chainId: number,
  pairStats: Map<string, PairStatsItem>,
  tokenRegistry: ReturnType<typeof buildTokenRegistry>
): MarketRow[] {
  const rows = buildVenueMarkets({
    chainId,
    registry: tokenRegistry,
    pairs,
    pairStatsById: pairStats
  });

  return rows
    .map((row) => ({
      id: row.id,
      chainId: row.chainId,
      pair: row.pair,
      displayPair: row.displayPair,
      baseSymbol: row.baseSymbol,
      quoteSymbol: row.quoteSymbol,
      baseDisplaySymbol: row.baseDisplaySymbol,
      quoteDisplaySymbol: row.quoteDisplaySymbol,
      last: row.last,
      change24h: row.change24h,
      volume24h: row.volume24h,
      poolAddress: row.poolAddress,
      hasPool: row.hasPool,
      lowLiquidity: row.lowLiquidity,
      warnings: row.warnings,
      routeHint: row.routeHint,
      maxTradeNotionalMusd: row.maxTradeNotionalMusd,
      swaps: row.swaps,
      reserveBase: row.reserveBase,
      reserveQuote: row.reserveQuote,
      totalFeeUsd: row.totalFeeUsd,
      lastSwapAt: row.lastSwapAt,
      tickSize: row.tickSize,
      stepSize: row.stepSize,
      minOrder: row.minOrder,
      uiPrecisionPrice: row.uiPrecisionPrice,
      uiPrecisionSize: row.uiPrecisionSize
    }))
    .sort((a, b) => {
      if (a.hasPool !== b.hasPool) return a.hasPool ? -1 : 1;
      if (a.lowLiquidity !== b.lowLiquidity) return a.lowLiquidity ? 1 : -1;
      if (b.volume24h !== a.volume24h) return b.volume24h - a.volume24h;
      return a.pair.localeCompare(b.pair);
    });
}

function parseTrades(rows: LedgerEntry[], selectedPair?: MarketRow | null): TradeRow[] {
  if (!selectedPair || !selectedPair.poolAddress) return [];
  const executions = parseSwapExecutions(rows);
  const trades: TradeRow[] = [];

  const selectedPoolAddress = selectedPair.poolAddress.toLowerCase();
  const base = normalizeSymbol(selectedPair.baseSymbol);
  const quote = normalizeSymbol(selectedPair.quoteSymbol);

  for (const item of executions) {
    if (item.poolAddress !== selectedPoolAddress) continue;

    const baseAmountFromAssets = item.amounts[base] || 0;
    const quoteAmountFromAssets = item.amounts[quote] || 0;
    if (baseAmountFromAssets <= 0 || quoteAmountFromAssets <= 0) continue;

    let side: 'buy' | 'sell' = 'buy';
    if (item.inAsset === base && item.outAsset === quote) {
      side = 'sell';
    } else if (item.inAsset === quote && item.outAsset === base) {
      side = 'buy';
    } else if (item.outAsset === quote) {
      side = 'sell';
    } else if (item.outAsset === base) {
      side = 'buy';
    }

    const price = quoteAmountFromAssets / baseAmountFromAssets;
    trades.push({
      txHash: item.txHash,
      poolAddress: item.poolAddress,
      at: item.at,
      side,
      baseToken: base,
      quoteToken: quote,
      baseAmount: baseAmountFromAssets,
      quoteAmount: quoteAmountFromAssets,
      price,
      feeUsd: item.feeUsd,
      gasUsd: item.gasUsd
    });
  }

  return trades.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

function computeOhlcCandles(trades: TradeRow[], timeframe: Timeframe): OhlcCandle[] {
  const buckets = new Map<number, OhlcCandle>();
  const ascending = [...trades].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  for (const trade of ascending) {
    if (!Number.isFinite(trade.price) || trade.price <= 0) continue;
    const bucket = roundBucket(new Date(trade.at), timeframe);
    const current = buckets.get(bucket) || {
      bucket,
      label: formatBucket(bucket, timeframe),
      open: trade.price,
      high: trade.price,
      low: trade.price,
      close: trade.price,
      volume: 0,
      fees: 0,
      tradeCount: 0
    };

    current.high = Math.max(current.high, trade.price);
    current.low = Math.min(current.low, trade.price);
    current.close = trade.price;
    current.volume += trade.quoteAmount;
    current.fees += trade.feeUsd;
    current.tradeCount += 1;
    buckets.set(bucket, current);
  }

  return Array.from(buckets.values())
    .sort((a, b) => a.bucket - b.bucket)
    .slice(-180);
}

function computeChartPoints(candles: OhlcCandle[]): ChartPoint[] {
  return candles.map((candle) => ({
    label: candle.label,
    price: candle.close,
    volume: candle.volume,
    fees: candle.fees
  }));
}

export function useMarketListVM(
  chainId: number,
  searchQuery: string,
  filter: 'all' | 'favorites' | 'spot',
  favorites: string[],
  refreshNonce = 0
) {
  const [pairs, setPairs] = useState<PairInput[]>([]);
  const [ledgerRows, setLedgerRows] = useState<LedgerEntry[]>([]);
  const [tokensByChain, setTokensByChain] = useState<Record<string, TokenItem[]>>({});
  const [networks, setNetworks] = useState<NetworkItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let failureCount = 0;
    const marketPollMs = Math.max(1500, Number(process.env.NEXT_PUBLIC_PRO_MARKET_POLL_MS || '5000'));

    async function load() {
      setLoading(true);
      setError('');
      try {
        const [pairsPayload, tokensPayloadData, ledgerPayload] = await Promise.all([
          fetchJsonWithRetry<PairsResponse>(`/pairs?chain_id=${chainId}&limit=250&include_external=false`),
          fetchJsonWithRetry<TokensResponse>('/tokens'),
          fetchLedgerRecentWithFallback(chainId, LEDGER_RECENT_MAX_LIMIT)
        ]);
        if (!active) return;
        setPairs(pairsPayload.rows || []);
        setTokensByChain(tokensPayloadData.chains || {});
        setNetworks(tokensPayloadData.networks || []);
        setLedgerRows(ledgerPayload.rows || []);
        failureCount = 0;
      } catch (err) {
        if (!active) return;
        const message = err instanceof Error ? err.message : 'failed to load markets';
        setError(message);
        failureCount = Math.min(failureCount + 1, 6);
      } finally {
        if (active) {
          setLoading(false);
          const backoffMs = Math.min(60_000, marketPollMs * 2 ** failureCount);
          timer = window.setTimeout(load, failureCount > 0 ? backoffMs : marketPollMs);
        }
      }
    }

    void load();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [chainId, refreshNonce]);

  const chainTokensRaw = useMemo(() => {
    const dynamic = tokensByChain[String(chainId)] || [];
    const statics = staticChainTokens(chainId);
    const merged = [...dynamic, ...statics];
    const dedupedBySymbol = new Map<string, TokenItem>();
    for (const token of merged) {
      const symbol = normalizeSymbol(token.symbol || '');
      if (!symbol) continue;
      const current = dedupedBySymbol.get(symbol);
      if (!current) {
        dedupedBySymbol.set(symbol, token);
        continue;
      }
      if (isAddress(token.address) && !isAddress(current.address)) {
        dedupedBySymbol.set(symbol, token);
      }
    }
    return Array.from(dedupedBySymbol.values()).filter((token) => isAddress(token.address));
  }, [tokensByChain, chainId]);
  const tokenRegistry = useMemo(() => buildTokenRegistry(chainId, chainTokensRaw), [chainId, chainTokensRaw]);
  const pairStats = useMemo(() => computePairStatsMap(pairs, chainId, ledgerRows), [chainId, ledgerRows, pairs]);
  const marketRows = useMemo(
    () => parseMarketRows(pairs, chainId, pairStats, tokenRegistry),
    [pairs, chainId, pairStats, tokenRegistry]
  );

  const filteredRows = useMemo(() => {
    const query = searchQuery.trim().toUpperCase();
    return marketRows.filter((row) => {
      if (filter === 'favorites' && !favorites.includes(row.id)) return false;
      if (filter === 'spot' && normalizeSymbol(row.quoteSymbol) !== MUSD_SYMBOL) {
        return false;
      }
      if (!query) return true;
      return (
        row.pair.includes(query) ||
        row.displayPair.toUpperCase().includes(query) ||
        row.baseSymbol.includes(query) ||
        row.quoteSymbol.includes(query)
      );
    });
  }, [favorites, filter, marketRows, searchQuery]);

  const chainTokens = tokenRegistry.tokens;
  const tokenMap = tokenRegistry.tokenBySymbol;

  const selectedNetwork = useMemo(
    () => networks.find((network) => Number(network.chain_id) === chainId) || null,
    [networks, chainId]
  );

  return {
    loading,
    error,
    rows: filteredRows,
    allRows: marketRows,
    chainTokens,
    tokenMap,
    quoteSymbol: tokenRegistry.quoteSymbol,
    networks,
    selectedNetwork
  };
}

export function useTradesVM(chainId: number, selectedPair: MarketRow | null, refreshNonce = 0) {
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let failureCount = 0;
    const tradesPollMs = Math.max(500, Number(process.env.NEXT_PUBLIC_PRO_TRADES_POLL_MS || '3000'));

    async function load() {
      setLoading(true);
      setError('');
      try {
        const payload = await fetchLedgerRecentWithFallback(chainId, LEDGER_RECENT_MAX_LIMIT);
        if (!active) return;
        setTrades(parseTrades(payload.rows || [], selectedPair));
        failureCount = 0;
      } catch (err) {
        if (!active) return;
        const message = err instanceof Error ? err.message : 'failed to load trades';
        setError(message);
        failureCount = Math.min(failureCount + 1, 6);
      } finally {
        if (active) {
          setLoading(false);
          const backoffMs = Math.min(60_000, tradesPollMs * 2 ** failureCount);
          timer = window.setTimeout(load, failureCount > 0 ? backoffMs : tradesPollMs);
        }
      }
    }

    void load();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [chainId, refreshNonce, selectedPair?.id]);

  return { trades, loading, error };
}

export function usePairVM(params: {
  chainId: number;
  selectedPair: MarketRow | null;
  trades: TradeRow[];
  timeframe: Timeframe;
  refreshNonce?: number;
}) {
  const { chainId, selectedPair, trades, timeframe, refreshNonce = 0 } = params;
  const [analytics, setAnalytics] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    const minutes = Math.min(ANALYTICS_MAX_MINUTES, timeframeWindowMinutes(timeframe));
    let timer: number | undefined;
    let failureCount = 0;
    const analyticsPollMs = Math.max(1500, Number(process.env.NEXT_PUBLIC_PRO_ANALYTICS_POLL_MS || '8000'));

    async function load() {
      setLoading(true);
      setError('');
      try {
        const payload = await fetchAnalyticsWithFallback(minutes);
        if (!active) return;
        setAnalytics(payload);
        failureCount = 0;
      } catch (err) {
        if (!active) return;
        const message = err instanceof Error ? err.message : 'failed to load analytics';
        setError(message);
        failureCount = Math.min(failureCount + 1, 6);
      } finally {
        if (active) {
          setLoading(false);
          const backoffMs = Math.min(60_000, analyticsPollMs * 2 ** failureCount);
          timer = window.setTimeout(load, failureCount > 0 ? backoffMs : analyticsPollMs);
        }
      }
    }

    void load();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [chainId, refreshNonce, timeframe]);

  const ohlcCandles = useMemo(() => computeOhlcCandles(trades, timeframe), [timeframe, trades]);
  const chartPoints = useMemo(
    () => computeChartPoints(ohlcCandles),
    [ohlcCandles]
  );

  const metrics = useMemo(() => {
    const lastTrade = trades[0] || null;
    const lastPrice = lastTrade?.price || ohlcCandles[ohlcCandles.length - 1]?.close || selectedPair?.last || 0;

    const since = Date.now() - 24 * 60 * 60 * 1000;
    const trades24h = trades.filter((trade) => new Date(trade.at).getTime() >= since);
    const volume24h = trades24h.reduce((sum, trade) => sum + trade.quoteAmount, 0);
    const fees24h = trades24h.reduce((sum, trade) => sum + trade.feeUsd, 0);

    const oldest = trades24h.length ? trades24h[trades24h.length - 1] : null;
    const change24h =
      oldest && oldest.price > 0
        ? ((lastPrice - oldest.price) / oldest.price) * 100
        : selectedPair?.change24h ?? null;

    let fallbackVolume24h = volume24h;
    if (fallbackVolume24h <= 0 && analytics) {
      fallbackVolume24h = analytics.volume_by_chain_token
        .filter((row) => Number(row.chain_id) === chainId)
        .reduce((sum, row) => sum + n(row.volume), 0);
    }

    let fallbackFees24h = fees24h;
    if (fallbackFees24h <= 0 && analytics) {
      fallbackFees24h = analytics.fee_revenue
        .filter((row) => Number(row.chain_id) === chainId)
        .reduce((sum, row) => sum + n(row.revenue_usd), 0);
    }

    return {
      lastPrice,
      change24h,
      volume24h: fallbackVolume24h,
      fees24h: fallbackFees24h
    };
  }, [analytics, chainId, ohlcCandles, selectedPair, trades]);

  return {
    loading,
    error,
    ohlcCandles,
    chartPoints,
    metrics
  };
}

export function useEndpointHealthVM(refreshNonce = 0) {
  const candidates = useMemo(parseApiCandidates, []);
  const [activeEndpoint, setActiveEndpoint] = useState<string>(candidates[0] || normalizeEndpoint(API_BASE));
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [status, setStatus] = useState<'healthy' | 'degraded' | 'down'>(candidates.length ? 'degraded' : 'down');
  const [history, setHistory] = useState<EndpointHealthItem[]>([]);
  const [lastCheckedAt, setLastCheckedAt] = useState<string>('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let startIndex = 0;

    async function run() {
      if (!candidates.length) {
        if (!active) return;
        setStatus('down');
        setError('No API endpoint configured');
        timer = window.setTimeout(run, HEALTH_POLL_MS);
        return;
      }

      let successfulEndpoint = '';
      let successfulLatency: number | null = null;
      let lastReason = 'unreachable';

      for (let offset = 0; offset < candidates.length; offset += 1) {
        const index = (startIndex + offset) % candidates.length;
        const endpoint = candidates[index];
        try {
          const measuredLatency = await pingEndpoint(endpoint, HEALTH_TIMEOUT_MS);
          successfulEndpoint = endpoint;
          successfulLatency = measuredLatency;
          startIndex = index;
          break;
        } catch (err) {
          lastReason = err instanceof Error ? err.message : 'health check failed';
        }
      }

      if (!active) return;

      const nowIso = new Date().toISOString();
      setLastCheckedAt(nowIso);

      if (successfulEndpoint) {
        const previous = activeEndpoint;
        const switched = Boolean(previous && previous !== successfulEndpoint);
        setActiveEndpoint(successfulEndpoint);
        setLatencyMs(successfulLatency);
        setStatus(switched ? 'degraded' : 'healthy');
        setError('');
        if (switched) {
          setHistory((current) =>
            [
              {
                endpoint: successfulEndpoint,
                latencyMs: successfulLatency,
                ok: true,
                switched: true,
                checkedAt: nowIso,
                reason: previous ? `failover ${previous} -> ${successfulEndpoint}` : 'failover'
              },
              ...current
            ].slice(0, 20)
          );
        }
      } else {
        setStatus('down');
        setLatencyMs(null);
        setError(lastReason);
        setHistory((current) =>
          [
            {
              endpoint: activeEndpoint || candidates[0],
              latencyMs: null,
              ok: false,
              switched: false,
              checkedAt: nowIso,
              reason: lastReason
            },
            ...current
          ].slice(0, 20)
        );
        startIndex = (startIndex + 1) % candidates.length;
      }

      timer = window.setTimeout(run, HEALTH_POLL_MS);
    }

    void run();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [activeEndpoint, candidates, refreshNonce]);

  return {
    activeEndpoint,
    latencyMs,
    status,
    history,
    lastCheckedAt,
    error,
    candidateCount: candidates.length
  };
}

export function useOrderbookVM(selectedPair: MarketRow | null, lastPrice: number) {
  const orderbook = useMemo(() => {
    if (!selectedPair) {
      return { bids: [] as OrderbookLevel[], asks: [] as OrderbookLevel[], spread: 0 };
    }

    const mid = lastPrice > 0 ? lastPrice : selectedPair.last || 0;
    if (mid <= 0) {
      return { bids: [] as OrderbookLevel[], asks: [] as OrderbookLevel[], spread: 0 };
    }

    const baseDepth = Math.max(selectedPair.reserveBase * 0.02, 0.01);
    const asks: OrderbookLevel[] = [];
    const bids: OrderbookLevel[] = [];

    for (let i = 1; i <= 14; i += 1) {
      const spreadFactor = 0.0008 * i;
      const askPrice = mid * (1 + spreadFactor);
      const bidPrice = mid * (1 - spreadFactor);
      const size = baseDepth / (1 + i * 0.55);
      asks.push({ price: askPrice, size, total: askPrice * size });
      bids.push({ price: bidPrice, size, total: bidPrice * size });
    }

    asks.sort((a, b) => a.price - b.price);
    bids.sort((a, b) => b.price - a.price);

    const spread = asks.length && bids.length ? asks[0].price - bids[0].price : 0;
    return { asks, bids, spread };
  }, [lastPrice, selectedPair]);

  return orderbook;
}

function parseAdminAllowlist(): Set<string> {
  const raw = String(process.env.NEXT_PUBLIC_ADMIN_MINT_ALLOWLIST || '').trim();
  if (!raw) return new Set<string>();
  return new Set(
    raw
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter((item) => /^0x[a-f0-9]{40}$/.test(item))
  );
}

function parseSymbolAllowlist(rawValue: string, defaults: string[] = []): Set<string> {
  const source = String(rawValue || '')
    .split(',')
    .map((item) => normalizeSymbol(item))
    .filter(Boolean);
  return new Set([...defaults.map((item) => normalizeSymbol(item)), ...source]);
}

function parseAddressAllowlist(rawValue: string): Set<string> {
  return new Set(
    String(rawValue || '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter((item) => /^0x[a-f0-9]{40}$/.test(item))
  );
}

function parseOptionalAddress(rawValue: string): string {
  const value = String(rawValue || '').trim();
  return /^0x[a-fA-F0-9]{40}$/.test(value) ? value : '';
}

function chainBlocksPerDay(chainId: number): bigint {
  const envRaw = String(process.env.NEXT_PUBLIC_CHAIN_BLOCKS_PER_DAY || '').trim();
  if (envRaw) {
    const envValue = Number(envRaw);
    if (Number.isFinite(envValue) && envValue > 0) {
      return BigInt(Math.floor(envValue));
    }
  }
  return DEFAULT_CHAIN_BLOCKS_PER_DAY[chainId] || 8_000n;
}

function parseMusdValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function extractQuoteMusdNotional(quote: QuoteResponse | null, musdSymbol: string): number {
  if (!quote) return 0;
  const musd = normalizeSymbol(musdSymbol);
  const quoteIn = normalizeSymbol(quote.token_in || '');
  const quoteOut = normalizeSymbol(quote.token_out || '');

  if (quote.plan === 'via-musd' && Array.isArray(quote.legs) && quote.legs.length) {
    const firstLeg = quote.legs[0];
    if (normalizeSymbol(firstLeg.token_out || '') === musd) return parseMusdValue(firstLeg.expected_out);
    if (normalizeSymbol(firstLeg.token_in || '') === musd) return parseMusdValue(firstLeg.amount_in);
  }

  if (quoteIn === musd) return parseMusdValue(quote.amount_in);
  if (quoteOut === musd) return parseMusdValue(quote.expected_out);
  return 0;
}

function computeQuoteImpliedPriceMusd(params: {
  quote: QuoteResponse | null;
  side: 'buy' | 'sell';
  amount: string;
  tokenInSymbol: string;
  tokenOutSymbol: string;
  baseSymbol: string;
  musdSymbol: string;
}): number {
  const { quote, side, amount, tokenInSymbol, tokenOutSymbol, baseSymbol, musdSymbol } = params;
  const base = normalizeSymbol(baseSymbol);
  const musd = normalizeSymbol(musdSymbol);
  const tokenIn = normalizeSymbol(tokenInSymbol);
  const tokenOut = normalizeSymbol(tokenOutSymbol);

  const musdNotionalFromQuote = extractQuoteMusdNotional(quote, musdSymbol);
  const fallbackAmount = parseMusdValue(amount);

  if (side === 'buy') {
    let baseOut = quote ? parseMusdValue(quote.expected_out) : 0;
    if (tokenOut !== base) baseOut = 0;
    const musdSpent =
      musdNotionalFromQuote > 0
        ? musdNotionalFromQuote
        : tokenIn === musd
        ? fallbackAmount
        : 0;
    if (baseOut <= 0 || musdSpent <= 0) return 0;
    return musdSpent / baseOut;
  }

  const baseIn = tokenIn === base ? parseMusdValue(quote?.amount_in || amount) : 0;
  const musdOut =
    musdNotionalFromQuote > 0
      ? musdNotionalFromQuote
      : tokenOut === musd
      ? parseMusdValue(quote?.expected_out)
      : 0;
  if (baseIn <= 0 || musdOut <= 0) return 0;
  return musdOut / baseIn;
}

export function useOrderEntryVM(params: {
  chainId: number;
  selectedPair: MarketRow | null;
  tokenMap: Map<string, TokenRegistryItem>;
  selectedNetwork: NetworkItem | null;
  quoteSymbol?: string;
  marketRows?: MarketRow[];
  globalFairPriceMusd?: number | null;
}) {
  const {
    chainId,
    selectedPair,
    tokenMap,
    selectedNetwork,
    quoteSymbol,
    marketRows = [],
    globalFairPriceMusd = null
  } = params;

  const [entryMode, setEntryMode] = useState<'market' | 'limit'>('market');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('0.1');
  const [limitPrice, setLimitPrice] = useState('1');
  const [slippageBps, setSlippageBps] = useState(50);
  const [autoWrapNative, setAutoWrapNative] = useState(true);
  const [buyFundingSymbol, setBuyFundingSymbol] = useState<string>('');
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [quoteAt, setQuoteAt] = useState<number | null>(null);
  const [quoteLockedContext, setQuoteLockedContext] = useState('');
  const [nowTickMs, setNowTickMs] = useState(0);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [nativeBalance, setNativeBalance] = useState('0');
  const [walletBalances, setWalletBalances] = useState<Record<string, string>>({});
  const [limitDrafts, setLimitDrafts] = useState<LimitDraft[]>([]);
  const [nonce, setNonce] = useState(0);
  const [adminMinterReady, setAdminMinterReady] = useState(false);
  const [adminMintEvents, setAdminMintEvents] = useState<AdminMintEvent[]>([]);
  const [adminMintLoading, setAdminMintLoading] = useState(false);
  const [adminMintAmount, setAdminMintAmount] = useState('0');
  const [adminMintRecipient, setAdminMintRecipient] = useState('');
  const [adminMinting, setAdminMinting] = useState(false);
  const [adminMintStatus, setAdminMintStatus] = useState('');
  const [adminMintError, setAdminMintError] = useState('');
  const [adminGovernanceReady, setAdminGovernanceReady] = useState(false);
  const [adminGovernanceNotice, setAdminGovernanceNotice] = useState('');
  const [adminGovernanceOwner, setAdminGovernanceOwner] = useState('');
  const [adminTimelockDelaySec, setAdminTimelockDelaySec] = useState<number | null>(null);
  const [adminTimelockDelayOk, setAdminTimelockDelayOk] = useState(false);
  const [adminMultisigProposerOk, setAdminMultisigProposerOk] = useState(false);
  const [adminDailyMintedMusd, setAdminDailyMintedMusd] = useState(0);
  const [adminChainSupplyMusd, setAdminChainSupplyMusd] = useState(0);
  const [protocolPaused, setProtocolPaused] = useState(false);
  const [protocolPauseReason, setProtocolPauseReason] = useState('');
  const [lastExecutionTxHash, setLastExecutionTxHash] = useState('');
  const [lastExecutionAt, setLastExecutionAt] = useState<number | null>(null);
  const routeAutoRefreshKeyRef = useRef('');

  const { address, isConnected, chainId: walletChainId } = useAccount();
  const publicClient = usePublicClient({ chainId });
  const { data: walletClient } = useWalletClient({ chainId });

  const resolvedQuoteSymbol = useMemo(() => {
    if (quoteSymbol && tokenMap.has(normalizeSymbol(quoteSymbol))) {
      return tokenMap.get(normalizeSymbol(quoteSymbol))!.symbol;
    }
    if (selectedPair?.quoteSymbol && tokenMap.has(normalizeSymbol(selectedPair.quoteSymbol))) {
      return tokenMap.get(normalizeSymbol(selectedPair.quoteSymbol))!.symbol;
    }
    const musdToken = tokenMap.get(MUSD_SYMBOL);
    if (musdToken) return musdToken.symbol;
    return 'mUSD';
  }, [quoteSymbol, selectedPair?.quoteSymbol, tokenMap]);

  const baseSymbol = selectedPair?.baseSymbol || 'WBNB';
  const tokenInSymbol = side === 'buy' ? buyFundingSymbol || resolvedQuoteSymbol : baseSymbol;
  const tokenOutSymbol = side === 'buy' ? baseSymbol : resolvedQuoteSymbol;
  const tokenInInfo = tokenMap.get(normalizeSymbol(tokenInSymbol)) || null;
  const tokenOutInfo = tokenMap.get(normalizeSymbol(tokenOutSymbol)) || null;

  const routeContextKey = useMemo(() => {
    const pairId = selectedPair?.id || 'none';
    const tokenInKey = normalizeSymbol(tokenInSymbol || '');
    const tokenOutKey = normalizeSymbol(tokenOutSymbol || '');
    const normalizedAmount = clampAmountPrecision(String(amount || '0'), Math.min(12, tokenInInfo?.decimals ?? 18));
    return [
      String(chainId),
      pairId,
      entryMode,
      side,
      tokenInKey,
      tokenOutKey,
      normalizedAmount,
      String(slippageBps),
      autoWrapNative ? 'wrap:on' : 'wrap:off'
    ].join('|');
  }, [amount, autoWrapNative, chainId, entryMode, selectedPair?.id, side, slippageBps, tokenInInfo?.decimals, tokenInSymbol, tokenOutSymbol]);

  const wrappedNativeSymbol = useMemo(() => {
    const maybeWbnb = tokenMap.get('WBNB');
    if (maybeWbnb) return 'WBNB';
    const maybeWeth = tokenMap.get('WETH');
    if (maybeWeth) return 'WETH';
    return chainId === 97 ? 'WBNB' : 'WETH';
  }, [chainId, tokenMap]);
  const wrappedNativeToken = tokenMap.get(wrappedNativeSymbol) || null;
  const adminAllowlist = useMemo(parseAdminAllowlist, []);
  const governanceAllowlist = useMemo(
    () => parseAddressAllowlist(String(process.env.NEXT_PUBLIC_MINTER_GOVERNANCE_ADDRESSES || '')),
    []
  );
  const bridgeAllowlistSymbols = useMemo(
    () =>
      parseSymbolAllowlist(
        String(process.env.NEXT_PUBLIC_BRIDGE_ALLOWLIST_SYMBOLS || ''),
        DEFAULT_BRIDGE_ALLOWLIST
      ),
    []
  );
  const canAccessAdminMint =
    ENABLE_ADMIN_MINT_UI &&
    Boolean(address) &&
    Boolean(adminAllowlist.size) &&
    adminAllowlist.has(String(address || '').toLowerCase());
  const minterRoleHash = useMemo(() => keccak256(stringToHex('MINTER_ROLE')), []);
  const proposerRoleHash = useMemo(() => keccak256(stringToHex('PROPOSER_ROLE')), []);
  const configuredMinterMultisig = useMemo(() => parseOptionalAddress(MINTER_MULTISIG_ADDRESS), []);
  const configuredMinterTimelock = useMemo(() => parseOptionalAddress(MINTER_TIMELOCK_ADDRESS), []);

  const buyFundingOptions = useMemo(() => {
    const tokens = Array.from(tokenMap.values())
      .filter((token) => token.isEvmAddress)
      .filter((token) => normalizeSymbol(token.symbol) !== normalizeSymbol(baseSymbol));

    const withBalance = tokens.map((token) => ({
      token,
      balance: n(walletBalances[token.symbol] || '0')
    }));

    withBalance.sort((a, b) => {
      if (normalizeSymbol(a.token.symbol) === normalizeSymbol(resolvedQuoteSymbol)) return -1;
      if (normalizeSymbol(b.token.symbol) === normalizeSymbol(resolvedQuoteSymbol)) return 1;
      if (b.balance !== a.balance) return b.balance - a.balance;
      return a.token.symbol.localeCompare(b.token.symbol);
    });

    return withBalance.map((item) => item.token.symbol);
  }, [baseSymbol, resolvedQuoteSymbol, tokenMap, walletBalances]);

  const musdTokenForAdmin = tokenMap.get(normalizeSymbol(resolvedQuoteSymbol)) || tokenMap.get(MUSD_SYMBOL) || null;
  const musdAddressForAdmin = useMemo(() => {
    const fromNetwork = selectedNetwork?.musd_address;
    if (fromNetwork && isAddress(fromNetwork)) return fromNetwork;
    if (musdTokenForAdmin && isAddress(musdTokenForAdmin.address)) return musdTokenForAdmin.address;
    return '';
  }, [musdTokenForAdmin, selectedNetwork?.musd_address]);

  const limitStorageKey = `mcryptoex.pro.limit-orders.v1.${chainId}`;

  const reserveSpotPrice = useMemo(() => {
    if (!selectedPair) return 0;
    const isStableRail =
      STABLE_MUSD_RAIL_SYMBOLS.has(normalizeSymbol(selectedPair.baseSymbol || '')) &&
      normalizeSymbol(selectedPair.quoteSymbol || '') === MUSD_SYMBOL;
    if (isStableRail) return 1;
    if (selectedPair.reserveBase > 0 && selectedPair.reserveQuote > 0) {
      return selectedPair.reserveQuote / selectedPair.reserveBase;
    }
    return selectedPair.last && selectedPair.last > 0 ? selectedPair.last : 0;
  }, [selectedPair]);

  const twapProxyPrice = useMemo(() => {
    if (!selectedPair) return 0;
    const last = selectedPair.last && selectedPair.last > 0 ? selectedPair.last : 0;
    if (!last) return reserveSpotPrice;
    const change = selectedPair.change24h;
    if (typeof change === 'number' && Number.isFinite(change)) {
      const denom = 1 + change / 100;
      if (Math.abs(denom) > 0.0001) {
        const reconstructed = last / denom;
        if (Number.isFinite(reconstructed) && reconstructed > 0) return reconstructed;
      }
    }
    return reserveSpotPrice || last;
  }, [reserveSpotPrice, selectedPair]);

  const liquidityWeight = useMemo(() => {
    const depth = Math.max(0, selectedPair?.reserveQuote || 0);
    const normalized = Math.min(1, depth / QUOTE_SANITY_LIQUIDITY_DIVISOR_MUSD);
    return Math.min(0.9, Math.max(0.25, normalized));
  }, [selectedPair?.reserveQuote]);

  const quoteReferencePriceLocal = useMemo(() => {
    if (reserveSpotPrice > 0 && twapProxyPrice > 0) {
      return reserveSpotPrice * liquidityWeight + twapProxyPrice * (1 - liquidityWeight);
    }
    return reserveSpotPrice || twapProxyPrice || 0;
  }, [liquidityWeight, reserveSpotPrice, twapProxyPrice]);

  const quoteReferencePrice = useMemo(() => {
    const global = Number(globalFairPriceMusd || 0);
    if (global > 0 && Number.isFinite(global)) {
      return global;
    }
    return quoteReferencePriceLocal;
  }, [globalFairPriceMusd, quoteReferencePriceLocal]);

  const isStableMusdRailPair = useMemo(() => {
    if (!selectedPair) return false;
    return (
      STABLE_MUSD_RAIL_SYMBOLS.has(normalizeSymbol(selectedPair.baseSymbol || '')) &&
      normalizeSymbol(selectedPair.quoteSymbol || '') === MUSD_SYMBOL
    );
  }, [selectedPair]);

  const tradeNotionalMusd = useMemo(() => {
    const directNotional = extractQuoteMusdNotional(quote, resolvedQuoteSymbol);
    if (directNotional > 0) return directNotional;
    const fallbackAmount = parseMusdValue(amount);
    if (normalizeSymbol(tokenInSymbol) === MUSD_SYMBOL) return fallbackAmount;
    if (quoteReferencePrice > 0 && normalizeSymbol(tokenInSymbol) === normalizeSymbol(baseSymbol)) {
      return fallbackAmount * quoteReferencePrice;
    }
    return 0;
  }, [amount, baseSymbol, quote, quoteReferencePrice, resolvedQuoteSymbol, tokenInSymbol]);

  const tradeSizeCapMusd = useMemo(() => {
    const marketCap = Math.max(0, selectedPair?.maxTradeNotionalMusd || 0);
    return marketCap * LIQUIDITY_TRADE_CAP_MULTIPLIER;
  }, [selectedPair?.maxTradeNotionalMusd]);

  const tradeDepthMusd = Math.max(0, selectedPair?.reserveQuote || 0);
  const chainReserveExposureMusd = useMemo(
    () =>
      marketRows
        .filter((row) => row.chainId === chainId)
        .reduce((sum, row) => sum + Math.max(0, row.reserveQuote || 0), 0),
    [chainId, marketRows]
  );
  const executionDisabledByDepth =
    Boolean(selectedPair) &&
    (tradeDepthMusd <= EXECUTION_DISABLE_DEPTH_MUSD || !selectedPair?.hasPool);
  const tradeCapExceeded = Boolean(tradeSizeCapMusd > 0 && tradeNotionalMusd > tradeSizeCapMusd);

  const quoteImpliedPrice = useMemo(
    () =>
      computeQuoteImpliedPriceMusd({
        quote,
        side,
        amount,
        tokenInSymbol,
        tokenOutSymbol,
        baseSymbol,
        musdSymbol: resolvedQuoteSymbol
      }),
    [amount, baseSymbol, quote, resolvedQuoteSymbol, side, tokenInSymbol, tokenOutSymbol]
  );

  const quoteSanityThresholdBps = useMemo(() => {
    if (isStableMusdRailPair) {
      return Math.min(50, EXECUTION_GUARD_MAX_DEVIATION_BPS);
    }
    return Math.round(
      EXECUTION_GUARD_MAX_DEVIATION_BPS * (selectedPair?.lowLiquidity ? 1.5 : 1)
    );
  }, [isStableMusdRailPair, selectedPair?.lowLiquidity]);
  const quoteSanityDeviationBps = useMemo(() => {
    if (!(quoteImpliedPrice > 0 && quoteReferencePrice > 0)) return 0;
    return Math.abs((quoteImpliedPrice - quoteReferencePrice) / quoteReferencePrice) * 10_000;
  }, [quoteImpliedPrice, quoteReferencePrice]);
  const quoteSanityFailed = Boolean(
    quote &&
      quoteReferencePrice > 0 &&
      quoteImpliedPrice > 0 &&
      quoteSanityDeviationBps > quoteSanityThresholdBps
  );

  const bridgePolicy = useMemo(() => {
    const warnings: string[] = [];
    let blockedReason = '';
    const tracked = [tokenInInfo, tokenOutInfo, selectedPair ? tokenMap.get(normalizeSymbol(selectedPair.baseSymbol)) || null : null];
    for (const token of tracked) {
      if (!token) continue;
      const symbolUpper = normalizeSymbol(token.symbol);
      const hasWrappedRisk = token.riskFlags.includes('wrapped');
      const hasExperimentalRisk = token.riskFlags.includes('experimental');
      const isBridgeSource = String(token.source || '').toLowerCase().startsWith('bridge-');

      if (hasWrappedRisk && !bridgeAllowlistSymbols.has(symbolUpper)) {
        blockedReason = blockedReason || `${token.symbol} is wrapped and not in bridge allowlist.`;
      }
      if (isBridgeSource && !bridgeAllowlistSymbols.has(symbolUpper)) {
        blockedReason = blockedReason || `${token.symbol} bridge source is not allowlisted.`;
      }
      if (hasWrappedRisk) warnings.push(`${token.symbol}: wrapped asset`);
      if (hasExperimentalRisk) warnings.push(`${token.symbol}: experimental liquidity`);
      if (isBridgeSource) warnings.push(`${token.symbol}: bridge sourced`);
    }

    if (
      CHAIN_EXPOSURE_CAP_MUSD > 0 &&
      selectedPair &&
      chainReserveExposureMusd + tradeNotionalMusd > CHAIN_EXPOSURE_CAP_MUSD
    ) {
      blockedReason =
        blockedReason ||
        `Chain exposure cap exceeded (${shortAmount(chainReserveExposureMusd + tradeNotionalMusd)} / ${shortAmount(
          CHAIN_EXPOSURE_CAP_MUSD
        )} mUSD).`;
    }

    return {
      warnings: Array.from(new Set(warnings)),
      blockedReason,
      blocked: Boolean(blockedReason),
      chainExposureMusd: chainReserveExposureMusd
    };
  }, [
    bridgeAllowlistSymbols,
    chainReserveExposureMusd,
    selectedPair,
    tokenInInfo,
    tokenMap,
    tokenOutInfo,
    tradeNotionalMusd
  ]);

  useEffect(() => {
    setNowTickMs(Date.now());
    const timer = window.setInterval(() => setNowTickMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(limitStorageKey);
      if (!raw) {
        setLimitDrafts([]);
        return;
      }
      const parsed = JSON.parse(raw) as LimitDraft[];
      setLimitDrafts(Array.isArray(parsed) ? parsed.slice(0, 40) : []);
    } catch {
      setLimitDrafts([]);
    }
  }, [limitStorageKey]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(limitStorageKey, JSON.stringify(limitDrafts.slice(0, 40)));
  }, [limitDrafts, limitStorageKey]);

  useEffect(() => {
    if (!selectedPair) return;
    if (side !== 'buy') return;

    const currentUpper = normalizeSymbol(buyFundingSymbol);
    const baseUpper = normalizeSymbol(baseSymbol);
    if (currentUpper && tokenMap.has(currentUpper) && currentUpper !== baseUpper) {
      return;
    }

    const preferredUpper = [
      normalizeSymbol(resolvedQuoteSymbol),
      normalizeSymbol(wrappedNativeSymbol),
      'USDC',
      'USDT',
      'WETH',
      'WBTC',
      'WSOL',
      'WAVAX'
    ];
    for (const symbolUpper of preferredUpper) {
      const token = tokenMap.get(symbolUpper);
      if (!token || !token.isEvmAddress) continue;
      if (symbolUpper === baseUpper) continue;
      setBuyFundingSymbol(token.symbol);
      return;
    }

    const fallback = buyFundingOptions[0] ? tokenMap.get(normalizeSymbol(buyFundingOptions[0])) : tokenMap.get(normalizeSymbol(resolvedQuoteSymbol));
    if (fallback) {
      setBuyFundingSymbol(fallback.symbol);
    }
  }, [
    baseSymbol,
    buyFundingSymbol,
    buyFundingOptions,
    resolvedQuoteSymbol,
    selectedPair?.id,
    side,
    tokenMap,
    wrappedNativeSymbol
  ]);

  useEffect(() => {
    if (!selectedPair) return;
    if (selectedPair.lowLiquidity) {
      setAmount((current) => {
        if (Number(current) > 0.05) return '0.05';
        if (!current || Number(current) <= 0) return '0.02';
        return current;
      });
    }
  }, [selectedPair?.id, selectedPair?.lowLiquidity]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function loadBalances() {
      if (!address || !publicClient) {
        if (active) {
          setWalletBalances({});
          setNativeBalance('0');
        }
        return;
      }

      const tokens = Array.from(tokenMap.values());
      const entries = await Promise.all(
        tokens.map(async (token) => {
          if (!isAddress(token.address)) return [token.symbol, '0'] as const;
          try {
            const raw = (await publicClient.readContract({
              address: token.address as Address,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [address]
            })) as bigint;
            return [token.symbol, formatUnits(raw, token.decimals)] as const;
          } catch {
            return [token.symbol, '0'] as const;
          }
        })
      );

      const next = Object.fromEntries(entries) as Record<string, string>;

      try {
        const rawNative = await publicClient.getBalance({ address });
        if (active) setNativeBalance(formatUnits(rawNative, 18));
      } catch {
        if (active) setNativeBalance('0');
      }

      if (active) {
        setWalletBalances(next);
      }
    }

    async function poll() {
      await loadBalances();
      if (!active) return;
      timer = setTimeout(() => {
        void poll();
      }, BALANCE_POLL_MS);
    }

    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [address, publicClient, nonce, tokenMap]);

  useEffect(() => {
    let active = true;

    async function loadProtocolSafetyState() {
      if (!publicClient || !musdAddressForAdmin || !isAddress(musdAddressForAdmin)) {
        if (!active) return;
        setProtocolPaused(false);
        setProtocolPauseReason('');
        setAdminChainSupplyMusd(0);
        return;
      }

      let paused = false;
      let pauseReason = '';
      let totalSupplyMusd = 0;
      let dailyMintedMusd = 0;

      try {
        paused = (await publicClient.readContract({
          address: musdAddressForAdmin as Address,
          abi: pausableAbi,
          functionName: 'paused'
        })) as boolean;
      } catch {
        paused = false;
      }

      try {
        const decimals = musdTokenForAdmin?.decimals ?? 18;
        const totalSupplyRaw = (await publicClient.readContract({
          address: musdAddressForAdmin as Address,
          abi: erc20Abi,
          functionName: 'totalSupply'
        })) as bigint;
        totalSupplyMusd = parseMusdValue(formatUnits(totalSupplyRaw, decimals));

        const latestBlock = await publicClient.getBlockNumber();
        const lookbackBlocks = chainBlocksPerDay(chainId);
        const dayFromBlock = latestBlock > lookbackBlocks ? latestBlock - lookbackBlocks : 0n;
        const dailyLogs = await publicClient.getLogs({
          address: musdAddressForAdmin as Address,
          event: transferEventAbi,
          args: { from: zeroAddress },
          fromBlock: dayFromBlock,
          toBlock: latestBlock
        });
        dailyMintedMusd = dailyLogs.reduce(
          (sum, log) => sum + parseMusdValue(formatUnits((log.args.value as bigint) || 0n, decimals)),
          0
        );
      } catch {
        totalSupplyMusd = 0;
        dailyMintedMusd = 0;
      }

      if (paused) {
        pauseReason = 'Emergency pause is active on mUSD contract.';
      }

      if (!active) return;
      setProtocolPaused(paused);
      setProtocolPauseReason(pauseReason);
      setAdminChainSupplyMusd(totalSupplyMusd);
      setAdminDailyMintedMusd(dailyMintedMusd);
    }

    void loadProtocolSafetyState();
    return () => {
      active = false;
    };
  }, [musdAddressForAdmin, musdTokenForAdmin?.decimals, nonce, publicClient]);

  useEffect(() => {
    let active = true;

    async function loadAdminState() {
      if (!canAccessAdminMint || !address || !publicClient || !musdAddressForAdmin || !isAddress(musdAddressForAdmin)) {
        if (active) {
          setAdminMinterReady(false);
          setAdminMintEvents([]);
          setAdminGovernanceReady(false);
          setAdminGovernanceNotice('');
          setAdminGovernanceOwner('');
          setAdminTimelockDelaySec(null);
          setAdminTimelockDelayOk(false);
          setAdminMultisigProposerOk(false);
        }
        return;
      }

      setAdminMintLoading(true);
      setAdminMintError('');
      try {
        const hasRole = (await publicClient.readContract({
          address: musdAddressForAdmin as Address,
          abi: accessControlAbi,
          functionName: 'hasRole',
          args: [minterRoleHash, address]
        })) as boolean;

        const latestBlock = await publicClient.getBlockNumber();
        const recentFromBlock = latestBlock > 120_000n ? latestBlock - 120_000n : 0n;
        const logs = await publicClient.getLogs({
          address: musdAddressForAdmin as Address,
          event: transferEventAbi,
          args: { from: zeroAddress },
          fromBlock: recentFromBlock,
          toBlock: latestBlock
        });

        const lookbackBlocks = chainBlocksPerDay(chainId);
        const dayFromBlock = latestBlock > lookbackBlocks ? latestBlock - lookbackBlocks : 0n;
        const dailyLogs = await publicClient.getLogs({
          address: musdAddressForAdmin as Address,
          event: transferEventAbi,
          args: { from: zeroAddress },
          fromBlock: dayFromBlock,
          toBlock: latestBlock
        });

        const decimals = musdTokenForAdmin?.decimals ?? 18;
        const dailyMinted = dailyLogs.reduce(
          (sum, log) => sum + parseMusdValue(formatUnits((log.args.value as bigint) || 0n, decimals)),
          0
        );
        const parsedEvents: AdminMintEvent[] = logs
          .slice(-20)
          .reverse()
          .map((log) => ({
            txHash: String(log.transactionHash || ''),
            recipient: String(log.args.to || ''),
            amount: formatUnits((log.args.value as bigint) || 0n, decimals),
            blockNumber: log.blockNumber || 0n
          }));

        const checks: string[] = [];
        let governanceReady = !MINT_REQUIRE_GOVERNANCE;
        let governanceNotice = MINT_REQUIRE_GOVERNANCE
          ? ''
          : 'Governance hardening checks are optional (NEXT_PUBLIC_MINT_REQUIRE_GOVERNANCE=false).';
        let governanceOwner = '';
        let governanceOwnerLower = '';
        let timelockDelaySec: number | null = null;
        let timelockDelayOk = false;
        let multisigProposerOk = false;

        try {
          const owner = (await publicClient.readContract({
            address: musdAddressForAdmin as Address,
            abi: ownableAbi,
            functionName: 'owner'
          })) as Address;
          governanceOwner = String(owner || '');
          governanceOwnerLower = governanceOwner.toLowerCase();
        } catch {
          checks.push('owner() not readable on mUSD contract.');
        }

        if (MINT_REQUIRE_GOVERNANCE) {
          if (governanceAllowlist.size === 0) {
            checks.push('Governance allowlist missing (NEXT_PUBLIC_MINTER_GOVERNANCE_ADDRESSES).');
          } else if (!governanceOwnerLower) {
            checks.push('Owner address unavailable for allowlist check.');
          } else if (!governanceAllowlist.has(governanceOwnerLower)) {
            checks.push(`Owner ${governanceOwner || '(unknown)'} is not in governance allowlist.`);
          }

          if (!configuredMinterTimelock) {
            checks.push('Timelock address missing (NEXT_PUBLIC_MINTER_TIMELOCK_ADDRESS).');
          } else if (!governanceOwnerLower) {
            checks.push('Owner cannot be compared with configured timelock.');
          } else if (governanceOwnerLower !== configuredMinterTimelock.toLowerCase()) {
            checks.push(`Owner ${governanceOwner} does not match timelock ${configuredMinterTimelock}.`);
          }

          if (configuredMinterTimelock) {
            try {
              const rawDelay = (await publicClient.readContract({
                address: configuredMinterTimelock as Address,
                abi: timelockAbi,
                functionName: 'getMinDelay'
              })) as bigint;
              timelockDelaySec = Number(rawDelay);
              timelockDelayOk = timelockDelaySec >= MINTER_TIMELOCK_MIN_DELAY_SEC;
              if (!timelockDelayOk) {
                checks.push(
                  `Timelock delay too low (${timelockDelaySec}s < ${MINTER_TIMELOCK_MIN_DELAY_SEC}s).`
                );
              }
            } catch {
              checks.push('Unable to read timelock min delay.');
            }
          }

          if (!configuredMinterMultisig) {
            checks.push('Multisig address missing (NEXT_PUBLIC_MINTER_MULTISIG_ADDRESS).');
          } else if (!configuredMinterTimelock) {
            checks.push('Multisig proposer role cannot be checked without timelock address.');
          } else {
            try {
              multisigProposerOk = (await publicClient.readContract({
                address: configuredMinterTimelock as Address,
                abi: accessControlAbi,
                functionName: 'hasRole',
                args: [proposerRoleHash, configuredMinterMultisig as Address]
              })) as boolean;
              if (!multisigProposerOk) {
                checks.push(`Multisig ${configuredMinterMultisig} has no PROPOSER_ROLE on timelock.`);
              }
            } catch {
              checks.push('Unable to verify multisig proposer role on timelock.');
            }
          }

          governanceReady = checks.length === 0;
          governanceNotice = governanceReady
            ? `Governance verified: owner ${governanceOwner} -> timelock (${timelockDelaySec ?? 0}s delay) with multisig proposer.`
            : checks.join(' ');
        }

        if (!active) return;
        setAdminMinterReady(hasRole);
        setAdminMintEvents(parsedEvents);
        setAdminDailyMintedMusd(dailyMinted);
        setAdminGovernanceReady(governanceReady);
        setAdminGovernanceNotice(governanceNotice);
        setAdminGovernanceOwner(governanceOwner);
        setAdminTimelockDelaySec(timelockDelaySec);
        setAdminTimelockDelayOk(timelockDelayOk);
        setAdminMultisigProposerOk(multisigProposerOk);
      } catch (err) {
        if (!active) return;
        setAdminMinterReady(false);
        setAdminMintEvents([]);
        setAdminGovernanceReady(false);
        setAdminGovernanceNotice('');
        setAdminGovernanceOwner('');
        setAdminTimelockDelaySec(null);
        setAdminTimelockDelayOk(false);
        setAdminMultisigProposerOk(false);
        setAdminMintError(err instanceof Error ? err.message : 'failed to load admin mint state');
      } finally {
        if (active) {
          setAdminMintLoading(false);
        }
      }
    }

    void loadAdminState();
    return () => {
      active = false;
    };
  }, [
    address,
    canAccessAdminMint,
    chainId,
    governanceAllowlist,
    configuredMinterMultisig,
    configuredMinterTimelock,
    minterRoleHash,
    proposerRoleHash,
    musdAddressForAdmin,
    musdTokenForAdmin?.decimals,
    nonce,
    publicClient
  ]);

  useEffect(() => {
    setQuote(null);
    setQuoteAt(null);
    setQuoteLockedContext('');
    setError('');
    setStatus('');
  }, [chainId, selectedPair?.id, side, tokenInSymbol, tokenOutSymbol]);

  const canSwitchNetwork = isConnected && walletChainId !== undefined && walletChainId !== chainId;

  const fetchQuoteViaApi = useCallback(
    async ({
      chainId: nextChainId,
      tokenIn: nextTokenIn,
      tokenOut: nextTokenOut,
      amountIn: nextAmountIn,
      slippageBps: nextSlippageBps,
      walletAddress
    }: {
      chainId: number;
      tokenIn: string;
      tokenOut: string;
      amountIn: string;
      slippageBps: number;
      walletAddress?: string;
    }) => {
      const params = new URLSearchParams({
        chain_id: String(nextChainId),
        token_in: nextTokenIn,
        token_out: nextTokenOut,
        amount_in: nextAmountIn,
        slippage_bps: String(nextSlippageBps)
      });
      if (walletAddress) params.set('wallet_address', walletAddress);
      return fetchJsonWithRetry<QuoteResponse>(`/quote?${params.toString()}`, {
        attempts: Math.max(2, FETCH_RETRY_ATTEMPTS),
        onRetry: ({ attempt, attempts, delayMs }) => {
          setStatus(`Quote retry ${attempt}/${attempts - 1} in ${Math.round(delayMs / 100) / 10}s...`);
        }
      });
    },
    []
  );

  const requestQuote = useCallback(async () => {
    setError('');
    setStatus('Refreshing route quote...');
    setQuote(null);
    setQuoteLockedContext('');

    if (!selectedPair) {
      setError('Select a tradable pair first.');
      return;
    }
    if (!tokenInInfo || !tokenOutInfo) {
      setError('Pair token metadata missing in registry.');
      return;
    }
    if (!amount || Number(amount) <= 0) {
      setError('Amount must be greater than zero.');
      return;
    }

    try {
      setQuoteLoading(true);
      const resolvedInputSymbol = tokenInInfo.symbol;
      const resolvedPayload = await buildRoutePlan({
        chainId,
        tokenIn: resolvedInputSymbol,
        tokenOut: tokenOutInfo.symbol,
        amountIn: amount,
        slippageBps,
        musdSymbol: resolvedQuoteSymbol,
        requireMusdQuote: REQUIRE_MUSD_QUOTE,
        walletAddress: address || undefined,
        fetchQuote: fetchQuoteViaApi
      });

      const routeHasMusd = resolvedPayload.route.some((symbol) => normalizeSymbol(symbol) === MUSD_SYMBOL);
      if (
        REQUIRE_MUSD_QUOTE &&
        normalizeSymbol(resolvedInputSymbol) !== MUSD_SYMBOL &&
        normalizeSymbol(tokenOutInfo.symbol) !== MUSD_SYMBOL &&
        !routeHasMusd
      ) {
        throw new Error('mUSD quote enforcement blocked this route. No valid mUSD intermediary route was found.');
      }

      setQuote(resolvedPayload);
      setQuoteAt(Date.now());
      setQuoteLockedContext(routeContextKey);
      setStatus(`${resolvedPayload.note} Route locked.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'quote request failed';
      setError(message);
    } finally {
      setQuoteLoading(false);
    }
  }, [
    address,
    amount,
    chainId,
    fetchQuoteViaApi,
    routeContextKey,
    resolvedQuoteSymbol,
    selectedPair,
    side,
    slippageBps,
    tokenInInfo,
    tokenOutInfo
  ]);

  const quoteAgeMs = useMemo(() => {
    if (!quoteAt) return 0;
    return Math.max(0, nowTickMs - quoteAt);
  }, [nowTickMs, quoteAt]);

  const staleQuote = useMemo(() => {
    if (!quoteAt) return false;
    return quoteAgeMs > QUOTE_STALE_MS;
  }, [quoteAgeMs, quoteAt]);

  const routeLocked = useMemo(() => {
    if (!quote) return false;
    if (!quoteLockedContext) return false;
    return quoteLockedContext === routeContextKey;
  }, [quote, quoteLockedContext, routeContextKey]);

  const routeLockMismatch = useMemo(() => {
    if (!quote) return false;
    if (!quoteLockedContext) return false;
    return quoteLockedContext !== routeContextKey;
  }, [quote, quoteLockedContext, routeContextKey]);

  const routeLockReason = useMemo(() => {
    if (routeLockMismatch) return 'Route inputs changed after quote. Refresh quote before execution.';
    if (staleQuote) return `Quote expired (${Math.round(quoteAgeMs / 1000)}s). Refresh quote before execution.`;
    return '';
  }, [quoteAgeMs, routeLockMismatch, staleQuote]);

  useEffect(() => {
    if (!quote) return;
    if (!routeLockReason) return;
    setStatus(routeLockReason);
  }, [quote, routeLockReason]);

  useEffect(() => {
    if (!routeLockMismatch) {
      routeAutoRefreshKeyRef.current = '';
      return;
    }
    if (entryMode !== 'market') return;
    if (!amount || Number(amount) <= 0) return;
    if (quoteLoading || executing) return;
    if (!selectedPair || !tokenInInfo || !tokenOutInfo) return;

    const refreshKey = `${quoteLockedContext}|${routeContextKey}`;
    if (routeAutoRefreshKeyRef.current === refreshKey) return;
    routeAutoRefreshKeyRef.current = refreshKey;

    const timer = setTimeout(() => {
      void requestQuote();
    }, 250);

    return () => {
      clearTimeout(timer);
    };
  }, [
    amount,
    entryMode,
    executing,
    quoteLoading,
    quoteLockedContext,
    requestQuote,
    routeContextKey,
    routeLockMismatch,
    selectedPair,
    tokenInInfo,
    tokenOutInfo
  ]);

  const adminPolicyBlockedReason = useMemo(() => {
    if (protocolPaused) return 'Emergency pause is active. Minting is blocked.';
    if (MINT_REQUIRE_GOVERNANCE && !adminGovernanceReady) {
      return adminGovernanceNotice || 'Governance policy check failed (multisig/timelock not verified).';
    }
    if (MINT_DAILY_CAP_MUSD > 0 && adminDailyMintedMusd >= MINT_DAILY_CAP_MUSD) {
      return `Daily mint cap reached (${shortAmount(MINT_DAILY_CAP_MUSD)} mUSD).`;
    }
    if (MINT_CHAIN_CAP_MUSD > 0 && adminChainSupplyMusd >= MINT_CHAIN_CAP_MUSD) {
      return `Chain mint cap reached (${shortAmount(MINT_CHAIN_CAP_MUSD)} mUSD).`;
    }
    return '';
  }, [adminChainSupplyMusd, adminDailyMintedMusd, adminGovernanceNotice, adminGovernanceReady, protocolPaused]);

  const executeDisabledReason = useMemo(() => {
    if (!selectedPair) return 'Select a tradable pair first.';
    if (protocolPaused) return protocolPauseReason || 'Execution disabled: emergency pause is active.';
    if (executionDisabledByDepth) {
      return `Execution disabled: depth ${shortAmount(tradeDepthMusd)} mUSD is below minimum ${shortAmount(
        EXECUTION_DISABLE_DEPTH_MUSD
      )}.`;
    }
    if (tradeCapExceeded) {
      return `Execution capped: requested ${shortAmount(tradeNotionalMusd)} mUSD exceeds max ${shortAmount(
        tradeSizeCapMusd
      )} mUSD for this pair.`;
    }
    if (bridgePolicy.blocked) return `Execution blocked by bridge policy: ${bridgePolicy.blockedReason}`;
    if (!isConnected || !address) return 'Connect wallet to enable trade execution.';
    if (walletChainId !== chainId) return `Wallet network mismatch. Switch wallet to chain ${chainId}.`;
    if (!tokenInInfo || !tokenOutInfo) return 'Token metadata missing in registry.';
    if (!amount || Number(amount) <= 0) return 'Enter a valid trade size.';
    if (entryMode === 'market') {
      if (!quote) return 'Execution locked: get a route quote first.';
      if (!routeLocked) {
        return quoteLoading
          ? 'Execution locked: route inputs changed, refreshing quote...'
          : 'Execution locked: route inputs changed, refresh quote.';
      }
      if (staleQuote) return 'Execution locked: quote is stale, refresh quote.';
      if (quoteSanityFailed) {
        return `Execution locked: quote sanity deviation ${shortAmount(quoteSanityDeviationBps)} bps exceeds ${shortAmount(
          quoteSanityThresholdBps
        )} bps.`;
      }
    }
    if (!selectedNetwork?.router_address || !isAddress(selectedNetwork.router_address)) {
      return 'Execution locked: router address missing for this chain.';
    }
    return '';
  }, [
    address,
    amount,
    chainId,
    entryMode,
    executionDisabledByDepth,
    bridgePolicy.blocked,
    bridgePolicy.blockedReason,
    isConnected,
    protocolPaused,
    protocolPauseReason,
    quote,
    quoteSanityDeviationBps,
    quoteSanityFailed,
    quoteSanityThresholdBps,
    routeLocked,
    selectedNetwork?.router_address,
    selectedPair,
    staleQuote,
    tradeCapExceeded,
    tradeDepthMusd,
    tradeNotionalMusd,
    tradeSizeCapMusd,
    tokenInInfo,
    tokenOutInfo,
    walletChainId
  ]);

  const executeMarket = useCallback(async (): Promise<boolean> => {
    setError('');
    setStatus('');

    if (!selectedPair) {
      setError('Select a pair before trade execution.');
      return false;
    }
    if (protocolPaused) {
      setError(protocolPauseReason || 'Execution is paused by protocol emergency switch.');
      return false;
    }
    if (executionDisabledByDepth) {
      setError(
        `Execution disabled. Pair depth ${shortAmount(tradeDepthMusd)} mUSD is below minimum ${shortAmount(
          EXECUTION_DISABLE_DEPTH_MUSD
        )} mUSD.`
      );
      return false;
    }
    if (tradeCapExceeded) {
      setError(
        `Trade size cap exceeded (${shortAmount(tradeNotionalMusd)} mUSD > ${shortAmount(
          tradeSizeCapMusd
        )} mUSD).`
      );
      return false;
    }
    if (bridgePolicy.blocked) {
      setError(`Bridge policy blocked execution: ${bridgePolicy.blockedReason}`);
      return false;
    }
    if (!quote) {
      setError('Get a quote first.');
      return false;
    }
    if (!routeLocked) {
      setError('Route lock mismatch detected. Refresh quote before execution.');
      return false;
    }
    if (staleQuote) {
      setError('Quote is stale. Refresh quote before execution.');
      return false;
    }
    if (quoteSanityFailed) {
      setError(
        `Quote sanity guard rejected execution (${shortAmount(quoteSanityDeviationBps)} bps > ${shortAmount(
          quoteSanityThresholdBps
        )} bps).`
      );
      return false;
    }
    if (!isConnected || !address) {
      setError('Connect wallet first.');
      return false;
    }
    if (walletChainId !== chainId) {
      setError(`Wallet network mismatch. Switch wallet to chain ${chainId}.`);
      return false;
    }
    if (!publicClient || !walletClient) {
      setError('Wallet client is not ready.');
      return false;
    }
    if (!selectedNetwork?.router_address || !isAddress(selectedNetwork.router_address)) {
      setError('Router address missing in chain registry.');
      return false;
    }

    const routeTokens = quote.route
      .map((symbol) => tokenMap.get(normalizeSymbol(symbol)))
      .filter((item): item is TokenRegistryItem => Boolean(item));
    if (routeTokens.length !== quote.route.length) {
      setError('Route token mapping failed for registry symbols.');
      return false;
    }

    const path: Address[] = [];
    for (const token of routeTokens) {
      if (!isAddress(token.address)) {
        setError(`Token ${token.symbol} is non-EVM in registry.`);
        return false;
      }
      path.push(token.address as Address);
    }

    const firstToken = routeTokens[0];
    const lastToken = routeTokens[routeTokens.length - 1];
    const router = selectedNetwork.router_address as Address;

    try {
      setExecuting(true);
      const amountInText = quote.amount_in || amount;
      const amountInBase = parseUnits(clampAmountPrecision(amountInText, firstToken.decimals), firstToken.decimals);
      const minOutBase = parseUnits(clampAmountPrecision(quote.min_out, lastToken.decimals), lastToken.decimals);

      const currentBalanceText =
        walletBalances[firstToken.symbol] ||
        walletBalances[normalizeSymbol(firstToken.symbol)] ||
        '0';
      const balanceRaw = parseUnits(
        clampAmountPrecision(currentBalanceText, firstToken.decimals),
        firstToken.decimals
      );

      if (balanceRaw < amountInBase) {
        const isWrappedNative = normalizeSymbol(firstToken.symbol) === wrappedNativeSymbol;
        if (isWrappedNative && autoWrapNative) {
          if (!wrappedNativeToken || !isAddress(wrappedNativeToken.address)) {
            setError(`Wrapped token ${wrappedNativeSymbol} is not configured for this chain.`);
            return false;
          }

          const deficit = amountInBase - balanceRaw;
          const nativeRaw = await publicClient.getBalance({ address });
          if (nativeRaw < deficit) {
            setError(
              `Insufficient native ${chainId === 97 ? 'tBNB' : 'gas token'} for auto-wrap. Required ${shortAmount(
                formatUnits(deficit, 18)
              )}.`
            );
            return false;
          }

          setStatus(`Auto-wrapping ${shortAmount(formatUnits(deficit, 18))} ${chainId === 97 ? 'tBNB' : 'native'}...`);
          const wrapHash = await walletClient.writeContract({
            account: walletClient.account,
            address: wrappedNativeToken.address as Address,
            abi: wrappedNativeAbi,
            functionName: 'deposit',
            args: [],
            value: deficit,
            gas: 180_000n
          });
          await publicClient.waitForTransactionReceipt({ hash: wrapHash });
          setNonce((value) => value + 1);
        } else {
          setError(
            `Insufficient ${firstToken.symbol} balance. ${
              isWrappedNative
                ? `Use native ${chainId === 97 ? 'tBNB' : 'gas token'} and enable auto-wrap, or wrap manually first.`
                : 'Fund this token before swap.'
            }`
          );
          return false;
        }
      }

      setStatus('Checking allowance...');
      const allowance = (await publicClient.readContract({
        address: firstToken.address as Address,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [address, router]
      })) as bigint;

      if (allowance < amountInBase) {
        setStatus('Approving allowance...');
        const approvalAmount =
          APPROVAL_MODE === 'unlimited'
            ? maxUint256
            : amountInBase + (amountInBase * BigInt(FINITE_APPROVAL_BUFFER_BPS)) / 10_000n;
        const approveHash = await walletClient.writeContract({
          account: walletClient.account,
          address: firstToken.address as Address,
          abi: erc20Abi,
          functionName: 'approve',
          args: [router, approvalAmount]
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
      }

      const deadline = BigInt(Math.floor(Date.now() / 1000) + 1_200);
      let gasLimit = DEFAULT_SWAP_GAS_BY_CHAIN[chainId] ?? 900_000n;
      try {
        const [estimatedGas, block] = await Promise.all([
          publicClient.estimateContractGas({
            account: address,
            address: router,
            abi: harmonyRouterAbi,
            functionName: 'swapExactTokensForTokens',
            args: [amountInBase, minOutBase, path, address, deadline]
          }),
          publicClient.getBlock({ blockTag: 'latest' })
        ]);
        const chainCap = block.gasLimit > 1_000_000n ? block.gasLimit - 1_000_000n : block.gasLimit;
        gasLimit = resolveSwapGasLimit(chainId, estimatedGas, chainCap);
      } catch {
        // fallback stays active
      }

      setStatus('Submitting wallet-signed swap...');
      const swapHash = await walletClient.writeContract({
        account: walletClient.account,
        address: router,
        abi: harmonyRouterAbi,
        functionName: 'swapExactTokensForTokens',
        args: [amountInBase, minOutBase, path, address, deadline],
        gas: gasLimit
      });
      setStatus(`Swap tx sent: ${swapHash}`);
      await publicClient.waitForTransactionReceipt({ hash: swapHash });
      setStatus(`Swap confirmed: ${swapHash}`);
      setLastExecutionTxHash(swapHash);
      setLastExecutionAt(Date.now());
      setNonce((value) => value + 1);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Swap failed';
      if (message.toLowerCase().includes('gas limit too high')) {
        setError('Swap gas estimate exceeded chain cap. Get a fresh quote and retry.');
      } else {
        setError(message);
      }
      return false;
    } finally {
      setExecuting(false);
    }
  }, [
    bridgePolicy.blocked,
    bridgePolicy.blockedReason,
    address,
    amount,
    autoWrapNative,
    chainId,
    executionDisabledByDepth,
    isConnected,
    protocolPaused,
    protocolPauseReason,
    publicClient,
    quote,
    quoteSanityDeviationBps,
    quoteSanityFailed,
    quoteSanityThresholdBps,
    routeLocked,
    selectedNetwork?.router_address,
    selectedPair,
    staleQuote,
    tokenMap,
    tradeCapExceeded,
    tradeDepthMusd,
    tradeNotionalMusd,
    tradeSizeCapMusd,
    walletBalances,
    walletChainId,
    walletClient,
    wrappedNativeSymbol,
    wrappedNativeToken
  ]);

  const executeAdminMint = useCallback(async () => {
    setAdminMintError('');
    setAdminMintStatus('');

    if (!canAccessAdminMint) {
      setAdminMintError('Admin mint panel is not enabled for this wallet.');
      return;
    }
    if (!adminMinterReady) {
      setAdminMintError('Connected wallet does not have MINTER_ROLE on mUSD.');
      return;
    }
    if (adminPolicyBlockedReason) {
      setAdminMintError(adminPolicyBlockedReason);
      return;
    }
    if (!walletClient || !publicClient || !walletClient.account) {
      setAdminMintError('Wallet client is not ready.');
      return;
    }
    if (!musdAddressForAdmin || !isAddress(musdAddressForAdmin)) {
      setAdminMintError('mUSD address missing in chain registry.');
      return;
    }
    if (!adminMintRecipient || !isAddress(adminMintRecipient)) {
      setAdminMintError('Recipient must be a valid EVM address.');
      return;
    }
    if (!adminMintAmount || Number(adminMintAmount) <= 0) {
      setAdminMintError('Mint amount must be greater than zero.');
      return;
    }

    try {
      setAdminMinting(true);
      const decimals = musdTokenForAdmin?.decimals ?? 18;
      const requested = parseMusdValue(adminMintAmount);
      if (MINT_DAILY_CAP_MUSD > 0 && adminDailyMintedMusd + requested > MINT_DAILY_CAP_MUSD) {
        setAdminMintError(
          `Daily mint cap exceeded (${shortAmount(adminDailyMintedMusd + requested)} / ${shortAmount(MINT_DAILY_CAP_MUSD)} mUSD).`
        );
        return;
      }
      if (MINT_CHAIN_CAP_MUSD > 0 && adminChainSupplyMusd + requested > MINT_CHAIN_CAP_MUSD) {
        setAdminMintError(
          `Chain mint cap exceeded (${shortAmount(adminChainSupplyMusd + requested)} / ${shortAmount(MINT_CHAIN_CAP_MUSD)} mUSD).`
        );
        return;
      }
      const amountRaw = parseUnits(clampAmountPrecision(adminMintAmount, decimals), decimals);
      const txHash = await walletClient.writeContract({
        account: walletClient.account,
        address: musdAddressForAdmin as Address,
        abi: mintableTokenAbi,
        functionName: 'mint',
        args: [adminMintRecipient as Address, amountRaw]
      });
      setAdminMintStatus(`Mint submitted: ${txHash}`);
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      setAdminMintStatus(`Mint confirmed: ${txHash}`);
      setNonce((value) => value + 1);
    } catch (err) {
      setAdminMintError(err instanceof Error ? err.message : 'admin mint failed');
    } finally {
      setAdminMinting(false);
    }
  }, [
    adminChainSupplyMusd,
    adminDailyMintedMusd,
    adminMintAmount,
    adminMintRecipient,
    adminMinterReady,
    adminPolicyBlockedReason,
    canAccessAdminMint,
    musdAddressForAdmin,
    musdTokenForAdmin?.decimals,
    publicClient,
    walletClient
  ]);

  const queueLimitDraft = useCallback((): boolean => {
    setError('');
    setStatus('');

    if (!selectedPair) {
      setError('Select a pair first.');
      return false;
    }
    if (!amount || Number(amount) <= 0 || !limitPrice || Number(limitPrice) <= 0) {
      setError('Limit amount and price must be greater than zero.');
      return false;
    }

    const id =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const next: LimitDraft = {
      id,
      chain_id: chainId,
      side,
      token_in: tokenInSymbol,
      token_out: tokenOutSymbol,
      amount,
      limit_price: limitPrice,
      created_at: new Date().toISOString()
    };

    setLimitDrafts((drafts) => [next, ...drafts].slice(0, 40));
    setStatus('Limit draft saved locally. On-chain limit movement comes next.');
    return true;
  }, [amount, chainId, limitPrice, selectedPair, side, tokenInSymbol, tokenOutSymbol]);

  const execute = useCallback(async (): Promise<boolean> => {
    if (entryMode === 'market') {
      return executeMarket();
    }
    return queueLimitDraft();
  }, [entryMode, executeMarket, queueLimitDraft]);

  const setMaxAmount = useCallback(() => {
    setAmount(shortAmount(walletBalances[tokenInSymbol] || '0'));
  }, [tokenInSymbol, walletBalances]);

  const availableBalance =
    walletBalances[tokenInSymbol] ||
    walletBalances[normalizeSymbol(tokenInSymbol)] ||
    '0';

  return {
    entryMode,
    setEntryMode,
    side,
    setSide,
    amount,
    setAmount,
    limitPrice,
    setLimitPrice,
    slippageBps,
    setSlippageBps,
    autoWrapNative,
    setAutoWrapNative,
    buyFundingSymbol,
    setBuyFundingSymbol,
    buyFundingOptions,
    tokenInSymbol,
    tokenOutSymbol,
    quoteSymbol: resolvedQuoteSymbol,
    tokenInInfo,
    tokenOutInfo,
    quote,
    quoteAt,
    quoteAgeMs,
    quoteTtlMs: QUOTE_STALE_MS,
    quoteLoading,
    staleQuote,
    routeLocked,
    routeLockMismatch,
    routeLockReason,
    approvalMode: APPROVAL_MODE,
    approvalRiskWarning:
      APPROVAL_MODE === 'unlimited'
        ? 'Unlimited approval enabled. Prefer finite approvals unless explicitly required.'
        : `Finite approval mode active (+${(FINITE_APPROVAL_BUFFER_BPS / 100).toFixed(2)}% buffer).`,
    protocolPaused,
    protocolPauseReason,
    quoteReferencePrice,
    quoteImpliedPrice,
    quoteSanityDeviationBps,
    quoteSanityThresholdBps,
    quoteSanityFailed,
    tradeNotionalMusd,
    tradeSizeCapMusd,
    chainReserveExposureMusd,
    executionDepthFloorMusd: EXECUTION_DISABLE_DEPTH_MUSD,
    tradeDepthMusd,
    executionDisabledByDepth,
    tradeCapExceeded,
    bridgePolicy,
    executeDisabledReason,
    executing,
    requestQuote,
    execute,
    status,
    error,
    nativeBalance,
    walletBalances,
    availableBalance,
    setMaxAmount,
    limitDrafts,
    canSwitchNetwork,
    wrappedNativeSymbol,
    isConnected,
    lastExecutionTxHash,
    lastExecutionAt,
    lowLiquidityMarket: Boolean(selectedPair?.lowLiquidity),
    lowLiquidityWarning: selectedPair?.lowLiquidity
      ? 'Low liquidity market. Suggested size is reduced and high notional trades may fail.'
      : '',
    admin: {
      enabled: ENABLE_ADMIN_MINT_UI,
      canAccess: canAccessAdminMint,
      isMinter: adminMinterReady,
      loading: adminMintLoading,
      mintEvents: adminMintEvents,
      mintAmount: adminMintAmount,
      setMintAmount: setAdminMintAmount,
      mintRecipient: adminMintRecipient,
      setMintRecipient: setAdminMintRecipient,
      minting: adminMinting,
      mintStatus: adminMintStatus,
      mintError: adminMintError,
      governanceRequired: MINT_REQUIRE_GOVERNANCE,
      governanceReady: adminGovernanceReady,
      governanceNotice: adminGovernanceNotice,
      governanceOwner: adminGovernanceOwner,
      multisigAddress: configuredMinterMultisig,
      timelockAddress: configuredMinterTimelock,
      timelockMinDelaySec: adminTimelockDelaySec,
      timelockMinDelayRequiredSec: MINTER_TIMELOCK_MIN_DELAY_SEC,
      timelockDelayOk: adminTimelockDelayOk,
      multisigProposerOk: adminMultisigProposerOk,
      dailyCapMusd: MINT_DAILY_CAP_MUSD,
      dailyMintedMusd: adminDailyMintedMusd,
      chainCapMusd: MINT_CHAIN_CAP_MUSD,
      chainSupplyMusd: adminChainSupplyMusd,
      policyBlockedReason: adminPolicyBlockedReason,
      executeMint: executeAdminMint
    }
  };
}
