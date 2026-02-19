'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Address, erc20Abi, formatUnits, isAddress, maxUint256, parseUnits } from 'viem';
import { useAccount, usePublicClient, useWalletClient } from 'wagmi';

const API_BASE = process.env.NEXT_PUBLIC_TEMPO_API_BASE || 'http://localhost:8500';
const LOCAL_CHAIN_ENABLED = process.env.NEXT_PUBLIC_ENABLE_LOCAL_CHAIN === 'true';
const ENV_DEFAULT_CHAIN_ID = Number(process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID || (LOCAL_CHAIN_ENABLED ? '31337' : '97'));
export const DEFAULT_CHAIN_ID = Number.isFinite(ENV_DEFAULT_CHAIN_ID) ? ENV_DEFAULT_CHAIN_ID : LOCAL_CHAIN_ENABLED ? 31337 : 97;

const DEFAULT_SWAP_GAS_BY_CHAIN: Record<number, bigint> = {
  97: 900_000n,
  11155111: 1_200_000n,
  31337: 1_200_000n
};
const SWAP_GAS_SOFT_CAP = 3_000_000n;
const SWAP_GAS_FLOOR = 250_000n;
const LEDGER_RECENT_MAX_LIMIT = 1200;
const ANALYTICS_MAX_MINUTES = 10080;

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

export type TokenItem = {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
};

export type NetworkItem = {
  chain_id: number;
  chain_key: string;
  name: string;
  router_address?: string;
  swap_fee_bps?: number;
  protocol_fee_bps?: number;
  pair_count?: number;
};

type TokensResponse = {
  chains: Record<string, TokenItem[]>;
  networks?: NetworkItem[];
};

export type PairRow = {
  chain_id: number;
  pool_address: string;
  token0_symbol: string;
  token1_symbol: string;
  reserve0_decimal: string;
  reserve1_decimal: string;
  swaps: number;
  total_fee_usd: string;
  total_amount_in: string;
  last_swap_at?: string | null;
};

type PairsResponse = {
  rows: PairRow[];
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
  token0: string;
  token1: string;
  last: number | null;
  change24h: number | null;
  volume24h: number;
  poolAddress: string;
  swaps: number;
  reserve0: number;
  reserve1: number;
  totalFeeUsd: number;
  lastSwapAt?: string | null;
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

export type QuoteResponse = {
  chain_id: number;
  token_in: string;
  token_out: string;
  amount_in: string;
  expected_out: string;
  min_out: string;
  route: string[];
  route_depth?: string;
  total_fee_bps?: number;
  protocol_fee_bps?: number;
  lp_fee_bps?: number;
  protocol_fee_amount_in?: string;
};

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

function n(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
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

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { cache: 'no-store' });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    if (body && typeof body === 'object') {
      const detail = (body as { detail?: unknown }).detail;
      if (typeof detail === 'string' && detail.trim()) {
        throw new Error(detail);
      }
    }
    throw new Error(`request failed: ${res.status}`);
  }
  return body as T;
}

async function fetchLedgerRecentWithFallback(chainId: number, preferredLimit: number): Promise<LedgerResponse> {
  const candidates = Array.from(
    new Set([preferredLimit, 1000, 800, 500, 300, 200].filter((value) => Number.isFinite(value) && value > 0))
  );
  let lastError: Error | null = null;

  for (const limit of candidates) {
    try {
      return await fetchJson<LedgerResponse>(`/ledger/recent?chain_id=${chainId}&limit=${limit}`);
    } catch (err) {
      if (err instanceof Error) {
        lastError = err;
        if (!err.message.includes('422')) {
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
      return await fetchJson<AnalyticsResponse>(`/analytics?minutes=${minutes}`);
    } catch (err) {
      if (err instanceof Error) {
        lastError = err;
        if (!err.message.includes('422')) {
          throw err;
        }
      } else {
        throw err;
      }
    }
  }

  throw lastError || new Error('analytics endpoint unavailable');
}

function tokenPairKey(a: string, b: string): string {
  const left = normalizeSymbol(a);
  const right = normalizeSymbol(b);
  return `${left}/${right}`;
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

type PairStats = {
  lastPrice: number | null;
  change24h: number | null;
  volume24h: number;
  lastSwapAt: string | null;
};

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

function computePairStatsMap(pairs: PairRow[], chainId: number, ledgerRows: LedgerEntry[]): Map<string, PairStats> {
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
    const id = `${pair.chain_id}:${pair.pool_address}`;
    pairByPool.set(pair.pool_address.toLowerCase(), {
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
  const stats = new Map<string, PairStats>();

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

function parseMarketRows(pairs: PairRow[], chainId: number, pairStats: Map<string, PairStats>): MarketRow[] {
  const rows = pairs
    .filter((pair) => Number(pair.chain_id) === chainId)
    .map((pair) => {
      const id = `${pair.chain_id}:${pair.pool_address}`;
      const reserve0 = n(pair.reserve0_decimal);
      const reserve1 = n(pair.reserve1_decimal);
      const fallbackLast = reserve0 > 0 ? reserve1 / reserve0 : null;
      const stats = pairStats.get(id);
      return {
        id,
        chainId: pair.chain_id,
        pair: tokenPairKey(pair.token0_symbol, pair.token1_symbol),
        token0: normalizeSymbol(pair.token0_symbol),
        token1: normalizeSymbol(pair.token1_symbol),
        last: stats?.lastPrice ?? fallbackLast,
        change24h: stats?.change24h ?? null,
        volume24h: stats?.volume24h ?? n(pair.total_amount_in),
        poolAddress: pair.pool_address,
        swaps: n(pair.swaps),
        reserve0,
        reserve1,
        totalFeeUsd: n(pair.total_fee_usd),
        lastSwapAt: stats?.lastSwapAt ?? pair.last_swap_at ?? null
      } as MarketRow;
    });

  const preferredByPair = new Map<string, MarketRow>();
  for (const row of rows) {
    const current = preferredByPair.get(row.pair);
    if (!current) {
      preferredByPair.set(row.pair, row);
      continue;
    }

    const currentLiquidity = current.reserve0 * current.reserve1;
    const nextLiquidity = row.reserve0 * row.reserve1;
    const currentScore = current.volume24h * 1_000_000 + current.swaps * 1_000 + currentLiquidity;
    const nextScore = row.volume24h * 1_000_000 + row.swaps * 1_000 + nextLiquidity;
    if (nextScore > currentScore) {
      preferredByPair.set(row.pair, row);
    }
  }

  return Array.from(preferredByPair.values()).sort((a, b) => {
    if (b.volume24h !== a.volume24h) return b.volume24h - a.volume24h;
    if (b.swaps !== a.swaps) return b.swaps - a.swaps;
    return (b.last || 0) - (a.last || 0);
  });
}

function parseTrades(rows: LedgerEntry[], selectedPair?: MarketRow | null): TradeRow[] {
  if (!selectedPair) return [];
  const executions = parseSwapExecutions(rows);
  const trades: TradeRow[] = [];

  const selectedPoolAddress = selectedPair.poolAddress.toLowerCase();
  const base = selectedPair.token0;
  const quote = selectedPair.token1;

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
  const [pairs, setPairs] = useState<PairRow[]>([]);
  const [ledgerRows, setLedgerRows] = useState<LedgerEntry[]>([]);
  const [tokensByChain, setTokensByChain] = useState<Record<string, TokenItem[]>>({});
  const [networks, setNetworks] = useState<NetworkItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setError('');
      try {
        const [pairsPayload, tokensPayloadData, ledgerPayload] = await Promise.all([
          fetchJson<PairsResponse>(`/pairs?chain_id=${chainId}&limit=250`),
          fetchJson<TokensResponse>('/tokens'),
          fetchLedgerRecentWithFallback(chainId, LEDGER_RECENT_MAX_LIMIT)
        ]);
        if (!active) return;
        setPairs(pairsPayload.rows || []);
        setTokensByChain(tokensPayloadData.chains || {});
        setNetworks(tokensPayloadData.networks || []);
        setLedgerRows(ledgerPayload.rows || []);
      } catch (err) {
        if (!active) return;
        const message = err instanceof Error ? err.message : 'failed to load markets';
        setError(message);
      } finally {
        if (active) setLoading(false);
      }
    }

    load();
    const marketPollMs = Math.max(1000, Number(process.env.NEXT_PUBLIC_PRO_MARKET_POLL_MS || '2500'));
    const timer = window.setInterval(load, marketPollMs);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [chainId, refreshNonce]);

  const pairStats = useMemo(() => computePairStatsMap(pairs, chainId, ledgerRows), [chainId, ledgerRows, pairs]);
  const marketRows = useMemo(() => parseMarketRows(pairs, chainId, pairStats), [pairs, chainId, pairStats]);

  const filteredRows = useMemo(() => {
    const query = searchQuery.trim().toUpperCase();
    return marketRows.filter((row) => {
      if (filter === 'favorites' && !favorites.includes(row.id)) return false;
      if (filter === 'spot' && !(row.pair.includes('MUSD') || row.pair.includes('USDC') || row.pair.includes('USDT'))) {
        return false;
      }
      if (!query) return true;
      return row.pair.includes(query) || row.token0.includes(query) || row.token1.includes(query);
    });
  }, [favorites, filter, marketRows, searchQuery]);

  const chainTokens = useMemo(() => tokensByChain[String(chainId)] || [], [tokensByChain, chainId]);
  const tokenMap = useMemo(() => {
    const map = new Map<string, TokenItem>();
    for (const token of chainTokens) {
      map.set(normalizeSymbol(token.symbol), token);
    }
    return map;
  }, [chainTokens]);

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

    async function load() {
      setLoading(true);
      setError('');
      try {
        const payload = await fetchLedgerRecentWithFallback(chainId, LEDGER_RECENT_MAX_LIMIT);
        if (!active) return;
        setTrades(parseTrades(payload.rows || [], selectedPair));
      } catch (err) {
        if (!active) return;
        const message = err instanceof Error ? err.message : 'failed to load trades';
        setError(message);
      } finally {
        if (active) setLoading(false);
      }
    }

    load();
    const tradesPollMs = Math.max(250, Number(process.env.NEXT_PUBLIC_PRO_TRADES_POLL_MS || '1000'));
    const timer = window.setInterval(load, tradesPollMs);
    return () => {
      active = false;
      window.clearInterval(timer);
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

    async function load() {
      setLoading(true);
      setError('');
      try {
        const payload = await fetchAnalyticsWithFallback(minutes);
        if (!active) return;
        setAnalytics(payload);
      } catch (err) {
        if (!active) return;
        const message = err instanceof Error ? err.message : 'failed to load analytics';
        setError(message);
      } finally {
        if (active) setLoading(false);
      }
    }

    load();
    const analyticsPollMs = Math.max(1000, Number(process.env.NEXT_PUBLIC_PRO_ANALYTICS_POLL_MS || '3000'));
    const timer = window.setInterval(load, analyticsPollMs);
    return () => {
      active = false;
      window.clearInterval(timer);
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

export function useOrderbookVM(selectedPair: MarketRow | null, lastPrice: number) {
  const orderbook = useMemo(() => {
    if (!selectedPair) {
      return { bids: [] as OrderbookLevel[], asks: [] as OrderbookLevel[], spread: 0 };
    }

    const mid = lastPrice > 0 ? lastPrice : selectedPair.last || 0;
    if (mid <= 0) {
      return { bids: [] as OrderbookLevel[], asks: [] as OrderbookLevel[], spread: 0 };
    }

    const baseDepth = Math.max(selectedPair.reserve0 * 0.02, 0.01);
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

export function useOrderEntryVM(params: {
  chainId: number;
  selectedPair: MarketRow | null;
  tokenMap: Map<string, TokenItem>;
  selectedNetwork: NetworkItem | null;
}) {
  const { chainId, selectedPair, tokenMap, selectedNetwork } = params;

  const [entryMode, setEntryMode] = useState<'market' | 'limit'>('market');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('0.1');
  const [limitPrice, setLimitPrice] = useState('1');
  const [slippageBps, setSlippageBps] = useState(50);
  const [autoWrapNative, setAutoWrapNative] = useState(true);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [quoteAt, setQuoteAt] = useState<number | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [nativeBalance, setNativeBalance] = useState('0');
  const [walletBalances, setWalletBalances] = useState<Record<string, string>>({});
  const [limitDrafts, setLimitDrafts] = useState<LimitDraft[]>([]);
  const [nonce, setNonce] = useState(0);

  const { address, isConnected, chainId: walletChainId } = useAccount();
  const publicClient = usePublicClient({ chainId });
  const { data: walletClient } = useWalletClient({ chainId });

  const baseSymbol = selectedPair?.token0 || 'MUSD';
  const quoteSymbol = selectedPair?.token1 || 'WBNB';
  const tokenInSymbol = side === 'buy' ? quoteSymbol : baseSymbol;
  const tokenOutSymbol = side === 'buy' ? baseSymbol : quoteSymbol;
  const tokenInInfo = tokenMap.get(normalizeSymbol(tokenInSymbol)) || null;
  const tokenOutInfo = tokenMap.get(normalizeSymbol(tokenOutSymbol)) || null;

  const wrappedNativeSymbol = useMemo(() => {
    const maybeWbnb = tokenMap.get('WBNB');
    if (maybeWbnb) return 'WBNB';
    const maybeWeth = tokenMap.get('WETH');
    if (maybeWeth) return 'WETH';
    return chainId === 97 ? 'WBNB' : 'WETH';
  }, [chainId, tokenMap]);
  const wrappedNativeToken = tokenMap.get(wrappedNativeSymbol) || null;

  const limitStorageKey = `mcryptoex.pro.limit-orders.v1.${chainId}`;

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
    let active = true;

    async function loadBalances() {
      if (!address || !publicClient) {
        if (active) {
          setWalletBalances({});
          setNativeBalance('0');
        }
        return;
      }

      const next: Record<string, string> = {};
      const tokens = Array.from(tokenMap.values());

      for (const token of tokens) {
        if (!isAddress(token.address)) {
          next[token.symbol] = '0';
          continue;
        }
        try {
          const raw = (await publicClient.readContract({
            address: token.address as Address,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [address]
          })) as bigint;
          next[token.symbol] = formatUnits(raw, token.decimals);
        } catch {
          next[token.symbol] = '0';
        }
      }

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

    loadBalances();
    return () => {
      active = false;
    };
  }, [address, publicClient, nonce, tokenMap]);

  useEffect(() => {
    setQuote(null);
    setQuoteAt(null);
    setError('');
    setStatus('');
  }, [chainId, selectedPair?.id, side]);

  const canSwitchNetwork = isConnected && walletChainId !== undefined && walletChainId !== chainId;

  const requestQuote = useCallback(async () => {
    setError('');
    setStatus('');
    setQuote(null);

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
      const params = new URLSearchParams({
        chain_id: String(chainId),
        token_in: tokenInInfo.symbol,
        token_out: tokenOutInfo.symbol,
        amount_in: amount,
        slippage_bps: String(slippageBps)
      });
      if (address) params.set('wallet_address', address);
      const payload = await fetchJson<QuoteResponse>(`/quote?${params.toString()}`);
      setQuote(payload);
      setQuoteAt(Date.now());
    } catch (err) {
      const message = err instanceof Error ? err.message : 'quote request failed';
      setError(message);
    } finally {
      setQuoteLoading(false);
    }
  }, [address, amount, chainId, selectedPair, slippageBps, tokenInInfo, tokenOutInfo]);

  const executeMarket = useCallback(async () => {
    setError('');
    setStatus('');

    if (!selectedPair) {
      setError('Select a pair before trade execution.');
      return;
    }
    if (!quote) {
      setError('Get a quote first.');
      return;
    }
    if (!isConnected || !address) {
      setError('Connect wallet first.');
      return;
    }
    if (walletChainId !== chainId) {
      setError(`Wallet network mismatch. Switch wallet to chain ${chainId}.`);
      return;
    }
    if (!publicClient || !walletClient) {
      setError('Wallet client is not ready.');
      return;
    }
    if (!selectedNetwork?.router_address || !isAddress(selectedNetwork.router_address)) {
      setError('Router address missing in chain registry.');
      return;
    }

    const routeTokens = quote.route
      .map((symbol) => tokenMap.get(normalizeSymbol(symbol)))
      .filter((item): item is TokenItem => Boolean(item));
    if (routeTokens.length !== quote.route.length) {
      setError('Route token mapping failed for registry symbols.');
      return;
    }

    const path: Address[] = [];
    for (const token of routeTokens) {
      if (!isAddress(token.address)) {
        setError(`Token ${token.symbol} is non-EVM in registry.`);
        return;
      }
      path.push(token.address as Address);
    }

    const firstToken = routeTokens[0];
    const lastToken = routeTokens[routeTokens.length - 1];
    const router = selectedNetwork.router_address as Address;

    try {
      setExecuting(true);
      const amountInBase = parseUnits(clampAmountPrecision(amount, firstToken.decimals), firstToken.decimals);
      const minOutBase = parseUnits(clampAmountPrecision(quote.min_out, lastToken.decimals), lastToken.decimals);

      const balanceRaw = parseUnits(
        clampAmountPrecision(walletBalances[firstToken.symbol] || '0', firstToken.decimals),
        firstToken.decimals
      );

      if (balanceRaw < amountInBase) {
        const isWrappedNative = normalizeSymbol(firstToken.symbol) === wrappedNativeSymbol;
        if (isWrappedNative && autoWrapNative) {
          if (!wrappedNativeToken || !isAddress(wrappedNativeToken.address)) {
            setError(`Wrapped token ${wrappedNativeSymbol} is not configured for this chain.`);
            return;
          }

          const deficit = amountInBase - balanceRaw;
          const nativeRaw = await publicClient.getBalance({ address });
          if (nativeRaw < deficit) {
            setError(
              `Insufficient native ${chainId === 97 ? 'tBNB' : 'gas token'} for auto-wrap. Required ${shortAmount(
                formatUnits(deficit, 18)
              )}.`
            );
            return;
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
          return;
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
        const approveHash = await walletClient.writeContract({
          account: walletClient.account,
          address: firstToken.address as Address,
          abi: erc20Abi,
          functionName: 'approve',
          args: [router, maxUint256]
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
      setNonce((value) => value + 1);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Swap failed';
      if (message.toLowerCase().includes('gas limit too high')) {
        setError('Swap gas estimate exceeded chain cap. Get a fresh quote and retry.');
      } else {
        setError(message);
      }
    } finally {
      setExecuting(false);
    }
  }, [
    address,
    amount,
    autoWrapNative,
    chainId,
    isConnected,
    publicClient,
    quote,
    selectedNetwork?.router_address,
    selectedPair,
    tokenMap,
    walletBalances,
    walletChainId,
    walletClient,
    wrappedNativeSymbol,
    wrappedNativeToken
  ]);

  const queueLimitDraft = useCallback(() => {
    setError('');
    setStatus('');

    if (!selectedPair) {
      setError('Select a pair first.');
      return;
    }
    if (!amount || Number(amount) <= 0 || !limitPrice || Number(limitPrice) <= 0) {
      setError('Limit amount and price must be greater than zero.');
      return;
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
  }, [amount, chainId, limitPrice, selectedPair, side, tokenInSymbol, tokenOutSymbol]);

  const execute = useCallback(async () => {
    if (entryMode === 'market') {
      await executeMarket();
      return;
    }
    queueLimitDraft();
  }, [entryMode, executeMarket, queueLimitDraft]);

  const setMaxAmount = useCallback(() => {
    setAmount(shortAmount(walletBalances[tokenInSymbol] || '0'));
  }, [tokenInSymbol, walletBalances]);

  const staleQuote = useMemo(() => {
    if (!quoteAt) return false;
    return Date.now() - quoteAt > 30_000;
  }, [quoteAt]);

  const availableBalance = walletBalances[tokenInSymbol] || '0';

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
    tokenInSymbol,
    tokenOutSymbol,
    tokenInInfo,
    tokenOutInfo,
    quote,
    quoteAt,
    quoteLoading,
    staleQuote,
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
    isConnected
  };
}
