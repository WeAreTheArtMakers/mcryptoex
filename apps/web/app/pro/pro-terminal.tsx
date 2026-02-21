'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import {
  MouseEvent as ReactMouseEvent,
  WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { useAccount } from 'wagmi';
import {
  DEFAULT_CHAIN_ID,
  MarketRow,
  OhlcCandle,
  Timeframe,
  shortAmount,
  useMarketListVM,
  useOrderEntryVM,
  useOrderbookVM,
  useEndpointHealthVM,
  usePairVM,
  useTradesVM
} from './use-pro-vm';
import {
  PairInput,
  PairStatsItem,
  buildTokenRegistry,
  buildVenueMarkets
} from './markets.config';
import { defaultMarketPair, staticChainTokens } from './tokens.config';

type MarketFilter = 'spot';
type MobilePanel = 'markets' | 'chart' | 'trade' | 'account';
type BookTab = 'book' | 'trades';
type AccountTab = 'balances' | 'trade-history';
type DeskTab = 'trade' | 'referrals';
type ReferralStat = {
  invitees: string[];
  rewardModx: number;
  trades: number;
  updatedAt?: string;
  lastTxHash?: string;
};
type ReferralLedger = {
  referredByWallet: Record<string, string>;
  statsByReferrer: Record<string, ReferralStat>;
};
type TokensResponse = {
  chains?: Record<
    string,
    Array<{
      symbol: string;
      name: string;
      address: string;
      decimals: number;
      source?: string;
      is_wrapped?: boolean;
      underlying_symbol?: string;
    }>
  >;
};
type PairsResponse = {
  rows?: PairInput[];
};
const DRAWING_TOOLS = ['＋', '／', '↕', '∿', '⌖', '◍', 'T'] as const;
type DrawingTool = (typeof DRAWING_TOOLS)[number];
type DrawingMode = 'point' | 'line' | 'vertical' | 'horizontal' | 'text';
type DrawingObject = {
  id: string;
  tool: DrawingTool;
  bucket: number;
  price: number;
  bucket2?: number;
  price2?: number;
  text?: string;
  createdAt: number;
};
type DrawingStore = Record<string, DrawingObject[]>;
type DrawingAnchor = {
  bucket: number;
  price: number;
  tool: DrawingTool;
};

type PersistedLayout = {
  chainId: number;
  searchQuery: string;
  filter: MarketFilter;
  timeframe: Timeframe;
  bookTab: BookTab;
  mobilePanel: MobilePanel;
  accountTab: AccountTab;
  favorites: string[];
  selectedPairByChain: Record<string, string>;
  selectedPairSymbolByChain?: Record<string, string>;
};

const LAYOUT_STORAGE_KEY = 'mcryptoex.pro.layout.v4';
const DRAWING_STORAGE_KEY = 'mcryptoex.pro.drawings.v1';
const RECENT_ACTIVITY_HEIGHT_KEY = 'mcryptoex.pro.recentActivityHeight.v1';
const DRAWING_CONTEXT_LIMIT = 220;
const ZOOM_MIN = 1;
const ZOOM_MAX = 10;
const RSI_PERIOD = 14;
const BOLLINGER_PERIOD = 20;
const BOLLINGER_MULTIPLIER = 2;
const MACD_FAST = 12;
const MACD_SLOW = 26;
const MACD_SIGNAL = 9;
const ATR_PERIOD = 14;
const STOCH_PERIOD = 14;
const STOCH_SMOOTH = 3;
const RECENT_ACTIVITY_MIN_HEIGHT = 180;
const RECENT_ACTIVITY_MAX_HEIGHT = 1400;
const TEMPO_API_BASE =
  process.env.NEXT_PUBLIC_TEMPO_API_BASE || 'http://localhost:8500';
const GLOBAL_VENUE_POLL_MS = Math.max(
  2500,
  Number(process.env.NEXT_PUBLIC_GLOBAL_VENUE_POLL_MS || '12000')
);
const STABLE_MUSD_QUOTE_BASES = new Set(['USDC', 'USDT']);
const DESK_LINKS: Array<{ id: DeskTab; label: string; href: string }> = [
  { id: 'trade', label: 'Trade', href: '/pro?desk=trade' },
  { id: 'referrals', label: 'Referrals', href: '/pro?desk=referrals' }
];

const PLATFORM_LINKS = [
  { label: 'Exchange Pro', href: '/pro' },
  { label: 'Harmony Swap', href: '/harmony' },
  { label: 'Liquidity', href: '/liquidity' },
  { label: 'Pools', href: '/pools' },
  { label: 'Ledger', href: '/ledger' },
  { label: 'Analytics', href: '/analytics' }
] as const;

const REFERRAL_STORAGE_KEY = 'mcryptoex.pro.referrals.v1';
const REFERRAL_REWARD_BPS = Math.max(
  0,
  Number(process.env.NEXT_PUBLIC_REFERRAL_REWARD_BPS || '25')
);
const MODX_TOKEN_ADDRESS = '0xB6322eD8561604Ca2A1b9c17e4d02B957EB242fe';
const MODX_STAKING_ADDRESS = '0xab3544A6f2aF70064c5B5D3f0E74323DB9a81945';

function emptyReferralLedger(): ReferralLedger {
  return { referredByWallet: {}, statsByReferrer: {} };
}

function readReferralLedger(): ReferralLedger {
  if (typeof window === 'undefined') return emptyReferralLedger();
  try {
    const raw = window.localStorage.getItem(REFERRAL_STORAGE_KEY);
    if (!raw) return emptyReferralLedger();
    const parsed = JSON.parse(raw) as Partial<ReferralLedger>;
    return {
      referredByWallet:
        parsed.referredByWallet && typeof parsed.referredByWallet === 'object'
          ? parsed.referredByWallet
          : {},
      statsByReferrer:
        parsed.statsByReferrer && typeof parsed.statsByReferrer === 'object'
          ? parsed.statsByReferrer
          : {}
    };
  } catch {
    return emptyReferralLedger();
  }
}

function writeReferralLedger(next: ReferralLedger): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(REFERRAL_STORAGE_KEY, JSON.stringify(next));
}

function safeReferralStat(value: ReferralStat | undefined): ReferralStat {
  if (!value) {
    return { invitees: [], rewardModx: 0, trades: 0 };
  }
  return {
    invitees: Array.isArray(value.invitees)
      ? value.invitees.filter((item) => typeof item === 'string')
      : [],
    rewardModx: Number.isFinite(value.rewardModx) ? value.rewardModx : 0,
    trades: Number.isFinite(value.trades) ? value.trades : 0,
    updatedAt: value.updatedAt,
    lastTxHash: value.lastTxHash
  };
}

function readDrawingStore(): DrawingStore {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(DRAWING_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as DrawingStore;
    if (!parsed || typeof parsed !== 'object') return {};
    const next: DrawingStore = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue;
      next[key] = value
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
          id: String((item as DrawingObject).id || ''),
          tool: DRAWING_TOOLS.includes((item as DrawingObject).tool)
            ? (item as DrawingObject).tool
            : '＋',
          bucket: Number((item as DrawingObject).bucket) || 0,
          price: Number((item as DrawingObject).price) || 0,
          bucket2: Number((item as DrawingObject).bucket2) || undefined,
          price2: Number((item as DrawingObject).price2) || undefined,
          text:
            typeof (item as DrawingObject).text === 'string'
              ? String((item as DrawingObject).text).slice(0, 48)
              : undefined,
          createdAt: Number((item as DrawingObject).createdAt) || Date.now()
        }))
        .filter((item) => {
          if (!item.id) return false;
          if (
            !(item.bucket > 0 && Number.isFinite(item.price) && item.price > 0)
          )
            return false;
          if (item.bucket2 !== undefined && !(item.bucket2 > 0)) return false;
          if (
            item.price2 !== undefined &&
            !(Number.isFinite(item.price2) && item.price2 > 0)
          )
            return false;
          return true;
        })
        .slice(-DRAWING_CONTEXT_LIMIT);
    }
    return next;
  } catch {
    return {};
  }
}

function writeDrawingStore(next: DrawingStore): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(DRAWING_STORAGE_KEY, JSON.stringify(next));
}

function drawingContextKey(
  chainId: number,
  pairId: string,
  timeframe: Timeframe
): string {
  return `${chainId}:${pairId}:${timeframe}`;
}

const DESK_TITLES: Record<
  Exclude<DeskTab, 'trade'>,
  { title: string; subtitle: string }
> = {
  referrals: {
    title: 'Referrals Hub',
    subtitle: 'Invite tracking and community growth panel.'
  }
};

const DRAWING_TOOL_META: Record<
  DrawingTool,
  { label: string; hint: string; mode: DrawingMode }
> = {
  '＋': { label: 'Marker', hint: 'Single-point marker', mode: 'point' },
  '／': { label: 'Trend Line', hint: 'Two clicks to place line', mode: 'line' },
  '↕': { label: 'Vertical', hint: 'Session marker', mode: 'vertical' },
  '∿': {
    label: 'Channel',
    hint: 'Two clicks to place channel line',
    mode: 'line'
  },
  '⌖': { label: 'Horizontal', hint: 'Price level line', mode: 'horizontal' },
  '◍': { label: 'Circle', hint: 'Point highlight', mode: 'point' },
  T: { label: 'Text', hint: 'Drop text marker', mode: 'text' }
};

function shortAddress(value?: string) {
  if (!value) return '0x...';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function shortEndpoint(value?: string) {
  if (!value) return 'n/a';
  try {
    const parsed = new URL(value);
    return parsed.host;
  } catch {
    return value.replace(/^https?:\/\//, '');
  }
}

async function fetchTempoJson<T>(path: string): Promise<T> {
  const response = await fetch(`${TEMPO_API_BASE}${path}`, {
    cache: 'no-store'
  });
  if (!response.ok) {
    throw new Error(`${path} failed (${response.status})`);
  }
  return (await response.json()) as T;
}

function normalizeSavedPairId(value: string): string {
  const [chain, pool] = String(value || '').split(':');
  if (!chain || !pool) return value;
  return `${chain}:${pool.toLowerCase()}`;
}

function formatChange(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)}%`;
}

function normalizePairLabel(value: string): string {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function defaultPairCandidates(): string[] {
  const normalized = normalizePairLabel(defaultMarketPair());
  if (!normalized.includes('/')) return [normalized];
  const [left, right] = normalized.split('/');
  if (!left || !right) return [normalized];
  return [`${left}/${right}`, `${right}/${left}`];
}

function changeClass(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return 'text-slate-300';
  return value >= 0 ? 'text-emerald-300' : 'text-rose-300';
}

function safe(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function isStableMusdRail(row: Pick<MarketRow, 'baseSymbol' | 'quoteSymbol'> | null): boolean {
  if (!row) return false;
  const base = normalizePairLabel(row.baseSymbol || '');
  const quote = normalizePairLabel(row.quoteSymbol || '');
  return quote === 'MUSD' && STABLE_MUSD_QUOTE_BASES.has(base);
}

type WeightedPricePoint = {
  price: number;
  weight: number;
};

function computeWeightedMedianPrice(points: WeightedPricePoint[]): number | null {
  const filtered = points.filter(
    (point) =>
      Number.isFinite(point.price) &&
      point.price > 0 &&
      Number.isFinite(point.weight) &&
      point.weight > 0
  );
  if (!filtered.length) return null;
  const ordered = [...filtered].sort((a, b) => a.price - b.price);
  const totalWeight = ordered.reduce((sum, point) => sum + point.weight, 0);
  if (!(totalWeight > 0)) return null;
  const midpoint = totalWeight / 2;
  let cumulative = 0;
  for (const point of ordered) {
    cumulative += point.weight;
    if (cumulative >= midpoint) return point.price;
  }
  return ordered[ordered.length - 1]?.price ?? null;
}

async function copyText(value: string): Promise<boolean> {
  if (!value) return false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function formatSyntheticBucket(bucket: number, timeframe: Timeframe): string {
  const date = new Date(bucket);
  if (timeframe === '1d')
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric'
    });
  if (timeframe === '1h')
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit'
    });
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function syntheticStepMs(timeframe: Timeframe): number {
  if (timeframe === '1d') return 24 * 60 * 60 * 1000;
  if (timeframe === '1h') return 60 * 60 * 1000;
  if (timeframe === '5m') return 5 * 60 * 1000;
  return 60 * 1000;
}

function buildSyntheticCandles(
  pair: MarketRow | null,
  timeframe: Timeframe
): OhlcCandle[] {
  let base = 1;
  let volumeBase = 0;
  let feeBase = 0;

  if (pair) {
    base = pair.last && pair.last > 0 ? pair.last : 0;
    if (base <= 0 && pair.reserveBase > 0 && pair.reserveQuote > 0) {
      base = pair.reserveQuote / pair.reserveBase;
    }
    volumeBase = pair.volume24h;
    feeBase = pair.totalFeeUsd;
  }
  if (!Number.isFinite(base) || base <= 0) base = 1;

  const stepMs = syntheticStepMs(timeframe);
  const count =
    timeframe === '1d'
      ? 30
      : timeframe === '1h'
      ? 72
      : timeframe === '5m'
      ? 120
      : 180;
  const normalizedVolume = Math.max(0, volumeBase / Math.max(1, count));
  const normalizedFees = Math.max(0, feeBase / Math.max(1, count));
  const now = Date.now();
  const candles: OhlcCandle[] = [];

  for (let idx = count - 1; idx >= 0; idx -= 1) {
    const bucket = Math.floor((now - idx * stepMs) / stepMs) * stepMs;
    const phase = (count - idx) / 8;
    const driftOpen = Math.sin(phase) * base * 0.0018;
    const driftClose = Math.sin(phase + 0.5) * base * 0.0018;
    const open = Math.max(0.00000001, base + driftOpen);
    const close = Math.max(0.00000001, base + driftClose);
    const high = Math.max(open, close) * 1.0009;
    const low = Math.min(open, close) * 0.9991;

    candles.push({
      bucket,
      label: formatSyntheticBucket(bucket, timeframe),
      open,
      high,
      low,
      close,
      volume: normalizedVolume,
      fees: normalizedFees,
      tradeCount: 0
    });
  }

  return candles;
}

function densifyCandles(candles: OhlcCandle[], timeframe: Timeframe): OhlcCandle[] {
  if (!candles.length) return [];
  const stepMs = syntheticStepMs(timeframe);
  const sorted = [...candles]
    .filter((candle) => Number.isFinite(candle.bucket))
    .sort((a, b) => a.bucket - b.bucket);

  if (!sorted.length) return [];

  const deduped = new Map<number, OhlcCandle>();
  for (const candle of sorted) deduped.set(candle.bucket, candle);
  const unique = Array.from(deduped.values()).sort((a, b) => a.bucket - b.bucket);

  const filled: OhlcCandle[] = [];
  for (let idx = 0; idx < unique.length; idx += 1) {
    const current = unique[idx];
    const prev = idx > 0 ? unique[idx - 1] : null;
    if (prev) {
      let cursor = prev.bucket + stepMs;
      const missing = Math.max(
        0,
        Math.floor((current.bucket - prev.bucket) / stepMs) - 1
      );
      let gapIndex = 0;
      while (cursor < current.bucket) {
        gapIndex += 1;
        const ratio = missing > 0 ? gapIndex / (missing + 1) : 1;
        const interpolatedClose =
          prev.close + (current.open - prev.close) * ratio;
        const open = Math.max(
          0.00000001,
          filled[filled.length - 1]?.close ?? prev.close
        );
        const close = Math.max(0.00000001, interpolatedClose);
        const high = Math.max(open, close) * 1.00035;
        const low = Math.min(open, close) * 0.99965;
        const volume =
          (Math.max(prev.volume, 0) + Math.max(current.volume, 0)) * 0.1;
        filled.push({
          bucket: cursor,
          label: formatSyntheticBucket(cursor, timeframe),
          open,
          high,
          low,
          close,
          volume,
          fees: 0,
          tradeCount: 0
        });
        cursor += stepMs;
      }
    }
    filled.push(current);
  }

  const targetCount =
    timeframe === '1d'
      ? 60
      : timeframe === '1h'
      ? 120
      : timeframe === '5m'
      ? 180
      : 240;
  const first = filled[0];
  while (filled.length < targetCount) {
    const prev = filled[0] || first;
    const bucket = prev.bucket - stepMs;
    const flatPrice = Math.max(0.00000001, prev.open);
    filled.unshift({
      bucket,
      label: formatSyntheticBucket(bucket, timeframe),
      open: flatPrice,
      high: flatPrice,
      low: flatPrice,
      close: flatPrice,
      volume: 0,
      fees: 0,
      tradeCount: 0
    });
  }
  return filled.slice(-280);
}

function minimumVisibleCandles(timeframe: Timeframe): number {
  if (timeframe === '1m') return 140;
  if (timeframe === '5m') return 120;
  if (timeframe === '1h') return 100;
  return 80;
}

function mergeCandlesWithSynthetic(
  realCandles: OhlcCandle[],
  syntheticCandles: OhlcCandle[]
): OhlcCandle[] {
  const merged = new Map<number, OhlcCandle>();
  for (const candle of syntheticCandles) merged.set(candle.bucket, candle);
  for (const candle of realCandles) merged.set(candle.bucket, candle);
  return Array.from(merged.values())
    .sort((a, b) => a.bucket - b.bucket)
    .slice(-280);
}

function composeDisplayCandles(
  realCandles: OhlcCandle[],
  pair: MarketRow | null,
  timeframe: Timeframe
): { candles: OhlcCandle[]; source: 'ledger' | 'hybrid' | 'synthetic' } {
  const synthetic = buildSyntheticCandles(pair, timeframe);
  if (!realCandles.length) return { candles: synthetic, source: 'synthetic' };

  const denseReal = densifyCandles(realCandles, timeframe);
  if (denseReal.length < minimumVisibleCandles(timeframe)) {
    return {
      candles: mergeCandlesWithSynthetic(denseReal, synthetic),
      source: 'hybrid'
    };
  }
  return { candles: denseReal, source: 'ledger' };
}

function clampValue(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sliceCandlesForViewport(
  candles: OhlcCandle[],
  zoom: number,
  panBars: number
) {
  if (!candles.length) return { candles: [] as OhlcCandle[], maxPanBars: 0 };
  const safeZoom = clampValue(zoom, ZOOM_MIN, ZOOM_MAX);
  const minVisible = Math.min(candles.length, 22);
  const visibleCount = Math.max(
    minVisible,
    Math.floor(candles.length / safeZoom)
  );
  const maxPanBars = Math.max(0, candles.length - visibleCount);
  const safePanBars = clampValue(Math.round(panBars), 0, maxPanBars);
  const start = Math.max(0, candles.length - visibleCount - safePanBars);
  return {
    candles: candles.slice(start, start + visibleCount),
    maxPanBars
  };
}

function buildPolylinePath(points: Array<{ x: number; y: number }>): string {
  if (!points.length) return '';
  return points
    .map((point, idx) => `${idx === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
    .join(' ');
}

function nearestCandleIndex(candles: OhlcCandle[], bucket: number): number {
  return candles.reduce(
    (best, candle, idx) => {
      const distance = Math.abs(candle.bucket - bucket);
      if (distance < best.distance) return { index: idx, distance };
      return best;
    },
    { index: 0, distance: Number.POSITIVE_INFINITY }
  ).index;
}

function computeSma(
  candles: OhlcCandle[],
  period: number
): Array<number | null> {
  const out: Array<number | null> = [];
  let sum = 0;
  candles.forEach((candle, idx) => {
    sum += candle.close;
    if (idx >= period) sum -= candles[idx - period].close;
    if (idx >= period - 1) {
      out.push(sum / period);
      return;
    }
    out.push(null);
  });
  return out;
}

function computeEma(
  candles: OhlcCandle[],
  period: number
): Array<number | null> {
  const out: Array<number | null> = [];
  const multiplier = 2 / (period + 1);
  let ema: number | null = null;
  candles.forEach((candle, idx) => {
    if (idx < period - 1) {
      out.push(null);
      return;
    }
    if (ema === null) {
      const seed =
        candles
          .slice(idx - period + 1, idx + 1)
          .reduce((sum, item) => sum + item.close, 0) / period;
      ema = seed;
    } else {
      ema = (candle.close - ema) * multiplier + ema;
    }
    out.push(ema);
  });
  return out;
}

function computeVwap(candles: OhlcCandle[]): Array<number | null> {
  const out: Array<number | null> = [];
  let cumulativePV = 0;
  let cumulativeVolume = 0;
  candles.forEach((candle) => {
    const typical = (candle.high + candle.low + candle.close) / 3;
    cumulativePV += typical * Math.max(candle.volume, 0);
    cumulativeVolume += Math.max(candle.volume, 0);
    out.push(cumulativeVolume > 0 ? cumulativePV / cumulativeVolume : null);
  });
  return out;
}

function computeRsi(
  candles: OhlcCandle[],
  period = RSI_PERIOD
): Array<number | null> {
  const rsi = new Array<number | null>(candles.length).fill(null);
  if (candles.length <= period) return rsi;

  let gainSum = 0;
  let lossSum = 0;
  for (let idx = 1; idx <= period; idx += 1) {
    const diff = candles[idx].close - candles[idx - 1].close;
    if (diff >= 0) gainSum += diff;
    else lossSum += Math.abs(diff);
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let idx = period + 1; idx < candles.length; idx += 1) {
    const diff = candles[idx].close - candles[idx - 1].close;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[idx] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function computeStdDev(values: number[]): number {
  if (!values.length) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function computeBollingerBands(
  candles: OhlcCandle[],
  period = BOLLINGER_PERIOD,
  multiplier = BOLLINGER_MULTIPLIER
): {
  upper: Array<number | null>;
  middle: Array<number | null>;
  lower: Array<number | null>;
} {
  const middle = computeSma(candles, period);
  const upper: Array<number | null> = new Array(candles.length).fill(null);
  const lower: Array<number | null> = new Array(candles.length).fill(null);
  for (let idx = period - 1; idx < candles.length; idx += 1) {
    const window = candles.slice(idx - period + 1, idx + 1).map((item) => item.close);
    const dev = computeStdDev(window);
    const mid = middle[idx];
    if (mid === null) continue;
    upper[idx] = mid + dev * multiplier;
    lower[idx] = Math.max(0.00000001, mid - dev * multiplier);
  }
  return { upper, middle, lower };
}

function computeEmaFromSeries(values: Array<number | null>, period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  const multiplier = 2 / (period + 1);
  let ema: number | null = null;
  const seed: number[] = [];
  for (let idx = 0; idx < values.length; idx += 1) {
    const value = values[idx];
    if (!Number.isFinite(value ?? NaN)) continue;
    const safeValue = Number(value);
    if (ema === null) {
      seed.push(safeValue);
      if (seed.length < period) continue;
      if (seed.length > period) seed.shift();
      ema = seed.reduce((sum, item) => sum + item, 0) / period;
      out[idx] = ema;
      continue;
    }
    ema = (safeValue - ema) * multiplier + ema;
    out[idx] = ema;
  }
  return out;
}

function computeMacd(candles: OhlcCandle[]): {
  macd: Array<number | null>;
  signal: Array<number | null>;
  histogram: Array<number | null>;
} {
  const fast = computeEma(candles, MACD_FAST);
  const slow = computeEma(candles, MACD_SLOW);
  const macd = candles.map((_, idx) => {
    const a = fast[idx];
    const b = slow[idx];
    if (a === null || b === null) return null;
    return a - b;
  });
  const signal = computeEmaFromSeries(macd, MACD_SIGNAL);
  const histogram = macd.map((value, idx) => {
    const sig = signal[idx];
    if (value === null || sig === null) return null;
    return value - sig;
  });
  return { macd, signal, histogram };
}

function computeAtr(candles: OhlcCandle[], period = ATR_PERIOD): Array<number | null> {
  const out: Array<number | null> = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const trueRanges: number[] = [];
  for (let idx = 0; idx < candles.length; idx += 1) {
    if (idx === 0) {
      trueRanges.push(candles[idx].high - candles[idx].low);
      continue;
    }
    const prevClose = candles[idx - 1].close;
    const tr = Math.max(
      candles[idx].high - candles[idx].low,
      Math.abs(candles[idx].high - prevClose),
      Math.abs(candles[idx].low - prevClose)
    );
    trueRanges.push(tr);
  }

  let seed = 0;
  for (let idx = 1; idx <= period; idx += 1) seed += trueRanges[idx];
  let atr = seed / period;
  out[period] = atr;
  for (let idx = period + 1; idx < candles.length; idx += 1) {
    atr = (atr * (period - 1) + trueRanges[idx]) / period;
    out[idx] = atr;
  }
  return out;
}

function computeStochastic(
  candles: OhlcCandle[],
  period = STOCH_PERIOD,
  smooth = STOCH_SMOOTH
): { k: Array<number | null>; d: Array<number | null> } {
  const k: Array<number | null> = new Array(candles.length).fill(null);
  for (let idx = period - 1; idx < candles.length; idx += 1) {
    const window = candles.slice(idx - period + 1, idx + 1);
    const highest = Math.max(...window.map((item) => item.high));
    const lowest = Math.min(...window.map((item) => item.low));
    const span = Math.max(highest - lowest, 0.00000001);
    k[idx] = ((candles[idx].close - lowest) / span) * 100;
  }
  const d = computeEmaFromSeries(k, smooth);
  return { k, d };
}

function mapSeriesToPath(
  values: Array<number | null>,
  mapY: (value: number) => number,
  left: number,
  step: number
): string {
  const points = values
    .map((value, idx) => {
      if (value === null || !Number.isFinite(value)) return null;
      return { x: left + idx * step + step / 2, y: mapY(value) };
    })
    .filter((item): item is { x: number; y: number } => Boolean(item));
  return buildPolylinePath(points);
}

function RsiPanel({ candles }: { candles: OhlcCandle[] }) {
  const width = 1180;
  const height = 120;
  const left = 58;
  const right = 20;
  const top = 12;
  const bottom = 95;
  if (!candles.length) return null;

  const rsi = computeRsi(candles);
  const step = candles.length ? (width - left - right) / candles.length : 1;
  const mapRsiY = (value: number) =>
    bottom - (clampValue(value, 0, 100) / 100) * (bottom - top);
  const points = rsi
    .map((value, idx) =>
      value === null
        ? null
        : { x: left + idx * step + step / 2, y: mapRsiY(value) }
    )
    .filter((item): item is { x: number; y: number } => Boolean(item));
  const path = buildPolylinePath(points);
  const latest = [...rsi].reverse().find((value) => value !== null) ?? null;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-[92px] w-full border-t border-[#173042] bg-[#08131f]"
    >
      <rect x={0} y={0} width={width} height={height} fill="#08131f" />
      <line
        x1={left}
        x2={width - right}
        y1={mapRsiY(70)}
        y2={mapRsiY(70)}
        stroke="#5a3240"
        strokeDasharray="4 3"
      />
      <line
        x1={left}
        x2={width - right}
        y1={mapRsiY(30)}
        y2={mapRsiY(30)}
        stroke="#24455d"
        strokeDasharray="4 3"
      />
      <line
        x1={left}
        x2={width - right}
        y1={mapRsiY(50)}
        y2={mapRsiY(50)}
        stroke="#173042"
        strokeDasharray="2 4"
      />
      {path ? (
        <path d={path} fill="none" stroke="#c78bff" strokeWidth={1.8} />
      ) : null}
      <text x={left} y={height - 8} fill="#8ea5b9" fontSize="10">
        RSI {RSI_PERIOD}
      </text>
      <text
        x={width - 6}
        y={height - 8}
        fill="#8ea5b9"
        fontSize="10"
        textAnchor="end"
      >
        {latest !== null ? latest.toFixed(2) : '--'}
      </text>
    </svg>
  );
}

function MacdPanel({ candles }: { candles: OhlcCandle[] }) {
  const width = 1180;
  const height = 128;
  const left = 58;
  const right = 20;
  const top = 10;
  const bottom = 102;
  if (!candles.length) return null;

  const { macd, signal, histogram } = computeMacd(candles);
  const values = [
    ...macd.filter((value): value is number => value !== null),
    ...signal.filter((value): value is number => value !== null),
    ...histogram.filter((value): value is number => value !== null)
  ];
  if (!values.length) return null;
  const max = Math.max(...values.map((value) => Math.abs(value)), 0.000001);
  const scale = max * 1.25;
  const step = candles.length ? (width - left - right) / candles.length : 1;
  const mapY = (value: number) =>
    bottom - ((value + scale) / (scale * 2)) * (bottom - top);
  const midY = mapY(0);
  const macdPath = mapSeriesToPath(macd, mapY, left, step);
  const signalPath = mapSeriesToPath(signal, mapY, left, step);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-[98px] w-full border-t border-[#173042] bg-[#08131f]"
    >
      <rect x={0} y={0} width={width} height={height} fill="#08131f" />
      <line
        x1={left}
        x2={width - right}
        y1={midY}
        y2={midY}
        stroke="#1f4257"
        strokeDasharray="4 4"
      />
      {histogram.map((value, idx) => {
        if (value === null || !Number.isFinite(value)) return null;
        const x = left + idx * step + step / 2;
        const y = mapY(value);
        const barTop = Math.min(y, midY);
        const barHeight = Math.max(1, Math.abs(y - midY));
        return (
          <rect
            key={`macd-h-${idx}`}
            x={x - Math.max(1, step * 0.2)}
            y={barTop}
            width={Math.max(1.5, step * 0.4)}
            height={barHeight}
            fill={value >= 0 ? 'rgba(57,210,180,0.45)' : 'rgba(234,107,119,0.45)'}
          />
        );
      })}
      {macdPath ? (
        <path d={macdPath} fill="none" stroke="#57c2ff" strokeWidth={1.6} />
      ) : null}
      {signalPath ? (
        <path d={signalPath} fill="none" stroke="#ffb86c" strokeWidth={1.4} />
      ) : null}
      <text x={left} y={height - 8} fill="#8ea5b9" fontSize="10">
        MACD 12/26/9
      </text>
    </svg>
  );
}

function AtrPanel({ candles }: { candles: OhlcCandle[] }) {
  const width = 1180;
  const height = 110;
  const left = 58;
  const right = 20;
  const top = 10;
  const bottom = 86;
  if (!candles.length) return null;

  const atr = computeAtr(candles);
  const values = atr.filter((value): value is number => value !== null);
  if (!values.length) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 0.000001);
  const step = candles.length ? (width - left - right) / candles.length : 1;
  const mapY = (value: number) =>
    bottom - ((value - min) / span) * (bottom - top);
  const path = mapSeriesToPath(atr, mapY, left, step);
  const latest = values[values.length - 1];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-[84px] w-full border-t border-[#173042] bg-[#08131f]"
    >
      <rect x={0} y={0} width={width} height={height} fill="#08131f" />
      {path ? (
        <path d={path} fill="none" stroke="#9fe870" strokeWidth={1.5} />
      ) : null}
      <text x={left} y={height - 8} fill="#8ea5b9" fontSize="10">
        ATR {ATR_PERIOD}
      </text>
      <text
        x={width - 6}
        y={height - 8}
        fill="#8ea5b9"
        fontSize="10"
        textAnchor="end"
      >
        {latest.toFixed(5)}
      </text>
    </svg>
  );
}

function StochasticPanel({ candles }: { candles: OhlcCandle[] }) {
  const width = 1180;
  const height = 118;
  const left = 58;
  const right = 20;
  const top = 10;
  const bottom = 92;
  if (!candles.length) return null;

  const { k, d } = computeStochastic(candles);
  const step = candles.length ? (width - left - right) / candles.length : 1;
  const mapY = (value: number) =>
    bottom - (clampValue(value, 0, 100) / 100) * (bottom - top);
  const pathK = mapSeriesToPath(k, mapY, left, step);
  const pathD = mapSeriesToPath(d, mapY, left, step);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-[90px] w-full border-t border-[#173042] bg-[#08131f]"
    >
      <rect x={0} y={0} width={width} height={height} fill="#08131f" />
      <line
        x1={left}
        x2={width - right}
        y1={mapY(80)}
        y2={mapY(80)}
        stroke="#5a3240"
        strokeDasharray="4 3"
      />
      <line
        x1={left}
        x2={width - right}
        y1={mapY(20)}
        y2={mapY(20)}
        stroke="#24455d"
        strokeDasharray="4 3"
      />
      {pathK ? (
        <path d={pathK} fill="none" stroke="#7ce8dc" strokeWidth={1.5} />
      ) : null}
      {pathD ? (
        <path d={pathD} fill="none" stroke="#ffa07a" strokeWidth={1.4} />
      ) : null}
      <text x={left} y={height - 8} fill="#8ea5b9" fontSize="10">
        Stochastic {STOCH_PERIOD}/{STOCH_SMOOTH}
      </text>
    </svg>
  );
}

function OhlcCanvas({
  candles,
  pairLabel,
  drawings,
  onAddDrawing,
  panBars,
  onPanAbsolute,
  onPanNudge,
  onZoomNudge,
  indicatorSma20,
  indicatorEma50,
  indicatorEma200,
  indicatorVwap,
  indicatorBollinger,
  indicatorPivot
}: {
  candles: OhlcCandle[];
  pairLabel: string;
  drawings: DrawingObject[];
  onAddDrawing?: (payload: { bucket: number; price: number }) => void;
  panBars: number;
  onPanAbsolute?: (next: number) => void;
  onPanNudge?: (deltaBars: number) => void;
  onZoomNudge?: (delta: number) => void;
  indicatorSma20: boolean;
  indicatorEma50: boolean;
  indicatorEma200: boolean;
  indicatorVwap: boolean;
  indicatorBollinger: boolean;
  indicatorPivot: boolean;
}) {
  const width = 1180;
  const height = 520;
  const left = 58;
  const right = 20;
  const top = 18;
  const priceBottom = 382;
  const volumeTop = 402;
  const volumeBottom = 500;
  const dragRef = useRef<{ startX: number; startPan: number } | null>(null);
  const dragMovedRef = useRef(false);

  if (!candles.length) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-400">
        Select a market to load candles for {pairLabel}.
      </div>
    );
  }

  const highs = candles.map((candle) => safe(candle.high));
  const lows = candles.map((candle) => safe(candle.low));
  const maxHigh = Math.max(...highs);
  const minLow = Math.min(...lows);
  const span = Math.max(maxHigh - minLow, 0.000001);
  const pad = span * 0.08;
  const minPrice = minLow - pad;
  const maxPrice = maxHigh + pad;
  const safeSpan = Math.max(maxPrice - minPrice, 0.000001);
  const pricePrecision = (() => {
    if (safeSpan >= 1000) return 2;
    if (safeSpan >= 100) return 3;
    if (safeSpan >= 10) return 4;
    if (safeSpan >= 1) return 5;
    if (safeSpan >= 0.1) return 6;
    if (safeSpan >= 0.01) return 7;
    return 8;
  })();

  const maxVolume = Math.max(
    1,
    ...candles.map((candle) => safe(candle.volume))
  );
  const step = candles.length ? (width - left - right) / candles.length : 1;
  const bodyWidth = Math.max(2, step * 0.58);

  const mapPrice = (price: number) => {
    const ratio = (price - minPrice) / safeSpan;
    return priceBottom - ratio * (priceBottom - top);
  };
  const mapVolume = (volume: number) => {
    const ratio = volume / maxVolume;
    return volumeBottom - ratio * (volumeBottom - volumeTop);
  };

  const yTicks = Array.from({ length: 7 }).map((_, idx) => {
    const ratio = idx / 6;
    const price = maxPrice - ratio * safeSpan;
    const y = top + ratio * (priceBottom - top);
    return { y, price };
  });

  const xTickStep = Math.max(1, Math.floor(candles.length / 7));
  const sma20 = indicatorSma20 ? computeSma(candles, 20) : [];
  const ema50 = indicatorEma50 ? computeEma(candles, 50) : [];
  const ema200 = indicatorEma200 ? computeEma(candles, 200) : [];
  const vwap = indicatorVwap ? computeVwap(candles) : [];
  const bollinger = indicatorBollinger
    ? computeBollingerBands(candles, BOLLINGER_PERIOD, BOLLINGER_MULTIPLIER)
    : null;
  const toPoints = (values: Array<number | null>) =>
    values
      .map((value, idx) => {
        if (value === null || !Number.isFinite(value)) return null;
        return { x: left + idx * step + step / 2, y: mapPrice(value) };
      })
      .filter((item): item is { x: number; y: number } => Boolean(item));

  const indicatorPaths = {
    sma20: buildPolylinePath(toPoints(sma20)),
    ema50: buildPolylinePath(toPoints(ema50)),
    ema200: buildPolylinePath(toPoints(ema200)),
    vwap: buildPolylinePath(toPoints(vwap)),
    bbUpper: buildPolylinePath(toPoints(bollinger?.upper || [])),
    bbMiddle: buildPolylinePath(toPoints(bollinger?.middle || [])),
    bbLower: buildPolylinePath(toPoints(bollinger?.lower || []))
  };
  const bollingerArea = bollinger
    ? bollinger.upper
        .map((upper, idx) => {
          const lower = bollinger.lower[idx];
          if (
            upper === null ||
            lower === null ||
            !Number.isFinite(upper) ||
            !Number.isFinite(lower)
          )
            return null;
          return {
            x: left + idx * step + step / 2,
            yUpper: mapPrice(upper),
            yLower: mapPrice(lower)
          };
        })
        .filter(
          (
            item
          ): item is { x: number; yUpper: number; yLower: number } =>
            Boolean(item)
        )
    : [];
  const bollingerAreaPath = bollingerArea.length
    ? `M ${bollingerArea[0].x} ${bollingerArea[0].yUpper} ${bollingerArea
        .slice(1)
        .map((item) => `L ${item.x} ${item.yUpper}`)
        .join(' ')} ${bollingerArea
        .slice()
        .reverse()
        .map((item) => `L ${item.x} ${item.yLower}`)
        .join(' ')} Z`
    : '';

  const pivotSource =
    candles[candles.length - 2] || candles[candles.length - 1];
  const pivotLevels = indicatorPivot
    ? (() => {
        const pivot =
          (pivotSource.high + pivotSource.low + pivotSource.close) / 3;
        const r1 = 2 * pivot - pivotSource.low;
        const s1 = 2 * pivot - pivotSource.high;
        return [
          { label: 'R1', value: r1, color: '#f18ca5' },
          { label: 'P', value: pivot, color: '#87d8ff' },
          { label: 'S1', value: s1, color: '#7de3b7' }
        ];
      })()
    : [];
  const legendItems = [
    indicatorSma20 ? { label: 'SMA20', color: '#ffd166' } : null,
    indicatorEma50 ? { label: 'EMA50', color: '#8ab4ff' } : null,
    indicatorEma200 ? { label: 'EMA200', color: '#8ca6ff' } : null,
    indicatorVwap ? { label: 'VWAP', color: '#bb86fc' } : null,
    indicatorBollinger ? { label: 'BB(20,2)', color: '#6fd6c8' } : null,
    indicatorPivot ? { label: 'Pivot', color: '#87d8ff' } : null
  ].filter((item): item is { label: string; color: string } => Boolean(item));

  const markerPoints = drawings
    .map((drawing) => {
      const idx1 = nearestCandleIndex(candles, drawing.bucket);
      const idx2 = drawing.bucket2
        ? nearestCandleIndex(candles, drawing.bucket2)
        : idx1;
      const x1 = left + idx1 * step + step / 2;
      const y1 = mapPrice(drawing.price);
      const x2 = left + idx2 * step + step / 2;
      const y2 = mapPrice(drawing.price2 ?? drawing.price);
      if (!Number.isFinite(x1) || !Number.isFinite(y1)) return null;
      return { ...drawing, x1, y1, x2, y2 };
    })
    .filter(
      (
        item
      ): item is DrawingObject & {
        x1: number;
        y1: number;
        x2: number;
        y2: number;
      } => Boolean(item && Number.isFinite(item.x1) && Number.isFinite(item.y1))
    );

  const placeDrawing = (event: ReactMouseEvent<SVGSVGElement>) => {
    if (dragMovedRef.current) {
      dragMovedRef.current = false;
      return;
    }
    if (!onAddDrawing || !candles.length) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const scaleX = width / rect.width;
    const scaleY = height / rect.height;
    const localX = (event.clientX - rect.left) * scaleX;
    const localY = (event.clientY - rect.top) * scaleY;

    if (localX < left || localX > width - right) return;
    if (localY < top || localY > priceBottom) return;

    const index = Math.min(
      candles.length - 1,
      Math.max(0, Math.floor((localX - left) / step))
    );
    const ratio = (priceBottom - localY) / (priceBottom - top);
    const price = minPrice + ratio * safeSpan;
    onAddDrawing({ bucket: candles[index].bucket, price });
  };

  const onWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    if (event.shiftKey) {
      event.preventDefault();
      onPanNudge?.(event.deltaY > 0 ? 4 : -4);
      return;
    }
    if (event.ctrlKey || event.metaKey || Math.abs(event.deltaY) > 0) {
      event.preventDefault();
      onZoomNudge?.(event.deltaY < 0 ? 1 : -1);
    }
  };

  const onMouseDown = (event: ReactMouseEvent<SVGSVGElement>) => {
    dragRef.current = { startX: event.clientX, startPan: panBars };
    dragMovedRef.current = false;
  };

  const onMouseMove = (event: ReactMouseEvent<SVGSVGElement>) => {
    if (!dragRef.current) return;
    const deltaPx = dragRef.current.startX - event.clientX;
    if (Math.abs(deltaPx) > 3) dragMovedRef.current = true;
    const deltaBars = Math.round(deltaPx / Math.max(8, step));
    onPanAbsolute?.(dragRef.current.startPan + deltaBars);
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-[520px] w-full cursor-crosshair"
      onClick={placeDrawing}
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
    >
      <rect x={0} y={0} width={width} height={height} fill="#08131e" />

      {yTicks.map((tick, idx) => (
        <g key={`tick-${idx}`}>
          <line
            x1={left}
            x2={width - right}
            y1={tick.y}
            y2={tick.y}
            stroke="#173042"
            strokeDasharray="4 4"
            opacity={0.65}
          />
          <text
            x={width - 4}
            y={tick.y + 4}
            fill="#8ea5b9"
            fontSize="11"
            textAnchor="end"
          >
            {tick.price.toFixed(pricePrecision)}
          </text>
        </g>
      ))}

      {legendItems.length ? (
        <g>
          {legendItems.map((item, idx) => (
            <g
              key={`legend-${item.label}`}
              transform={`translate(${left + 8}, ${top + 8 + idx * 13})`}
            >
              <rect x={0} y={-8} width={8} height={8} rx={1} fill={item.color} />
              <text x={12} y={0} fill="#9ab4c8" fontSize="10">
                {item.label}
              </text>
            </g>
          ))}
        </g>
      ) : null}

      {indicatorBollinger && bollingerAreaPath ? (
        <path d={bollingerAreaPath} fill="rgba(117, 230, 218, 0.08)" />
      ) : null}

      {pivotLevels.map((level) => (
        <g key={`pivot-${level.label}`}>
          <line
            x1={left}
            x2={width - right}
            y1={mapPrice(level.value)}
            y2={mapPrice(level.value)}
            stroke={level.color}
            strokeDasharray="5 4"
          />
          <text
            x={width - right - 4}
            y={mapPrice(level.value) - 3}
            fill={level.color}
            fontSize="10"
            textAnchor="end"
          >
            {level.label}
          </text>
        </g>
      ))}

      {candles.map((candle, idx) => {
        const x = left + idx * step + step / 2;
        const yHigh = mapPrice(candle.high);
        const yLow = mapPrice(candle.low);
        const yOpen = mapPrice(candle.open);
        const yClose = mapPrice(candle.close);
        const topBody = Math.min(yOpen, yClose);
        const bodyHeight = Math.max(1.4, Math.abs(yClose - yOpen));
        const up = candle.close >= candle.open;
        const color = up ? '#39d2b4' : '#ea6b77';

        const yVol = mapVolume(candle.volume);
        const showLabel = idx % xTickStep === 0 || idx === candles.length - 1;

        return (
          <g key={`candle-${candle.bucket}-${idx}`}>
            <line
              x1={x}
              y1={yHigh}
              x2={x}
              y2={yLow}
              stroke={color}
              strokeWidth={1.35}
            />
            <rect
              x={x - bodyWidth / 2}
              y={topBody}
              width={bodyWidth}
              height={bodyHeight}
              fill={up ? '#31c7a8' : '#e95f70'}
              rx={0.5}
            />
            <rect
              x={x - bodyWidth / 2}
              y={yVol}
              width={bodyWidth}
              height={Math.max(1, volumeBottom - yVol)}
              fill={up ? 'rgba(57,210,180,0.34)' : 'rgba(234,107,119,0.34)'}
            />
            {showLabel ? (
              <text
                x={x}
                y={height - 6}
                fill="#8399ad"
                fontSize="10"
                textAnchor="middle"
              >
                {candle.label}
              </text>
            ) : null}
          </g>
        );
      })}

      {candles.length ? (
        <g>
          <line
            x1={left}
            x2={width - right}
            y1={mapPrice(candles[candles.length - 1].close)}
            y2={mapPrice(candles[candles.length - 1].close)}
            stroke="#45cfc0"
            strokeDasharray="4 4"
            opacity={0.7}
          />
          <text
            x={width - 4}
            y={mapPrice(candles[candles.length - 1].close) - 4}
            fill="#7ce8dc"
            fontSize="10"
            textAnchor="end"
          >
            {candles[candles.length - 1].close.toFixed(pricePrecision)}
          </text>
        </g>
      ) : null}

      {indicatorPaths.sma20 ? (
        <path
          d={indicatorPaths.sma20}
          fill="none"
          stroke="#ffd166"
          strokeWidth={1.8}
        />
      ) : null}
      {indicatorPaths.ema50 ? (
        <path
          d={indicatorPaths.ema50}
          fill="none"
          stroke="#8ab4ff"
          strokeWidth={1.8}
        />
      ) : null}
      {indicatorPaths.ema200 ? (
        <path
          d={indicatorPaths.ema200}
          fill="none"
          stroke="#8ca6ff"
          strokeWidth={1.25}
          strokeDasharray="4 3"
        />
      ) : null}
      {indicatorPaths.vwap ? (
        <path
          d={indicatorPaths.vwap}
          fill="none"
          stroke="#bb86fc"
          strokeWidth={1.8}
        />
      ) : null}
      {indicatorPaths.bbUpper ? (
        <path
          d={indicatorPaths.bbUpper}
          fill="none"
          stroke="#6fd6c8"
          strokeWidth={1.2}
          strokeDasharray="3 2"
        />
      ) : null}
      {indicatorPaths.bbMiddle ? (
        <path
          d={indicatorPaths.bbMiddle}
          fill="none"
          stroke="#6f99ff"
          strokeWidth={1.1}
          strokeDasharray="2 2"
        />
      ) : null}
      {indicatorPaths.bbLower ? (
        <path
          d={indicatorPaths.bbLower}
          fill="none"
          stroke="#6fd6c8"
          strokeWidth={1.2}
          strokeDasharray="3 2"
        />
      ) : null}

      {markerPoints.map((marker) => {
        if (marker.tool === '／') {
          return (
            <line
              key={`drawing-${marker.id}`}
              x1={marker.x1}
              y1={marker.y1}
              x2={marker.x2}
              y2={marker.y2}
              stroke="#79e7dc"
              strokeWidth={1.6}
            />
          );
        }
        if (marker.tool === '∿') {
          const curveY = Math.min(marker.y1, marker.y2) - 18;
          return (
            <path
              key={`drawing-${marker.id}`}
              d={`M ${marker.x1} ${marker.y1} Q ${
                (marker.x1 + marker.x2) / 2
              } ${curveY} ${marker.x2} ${marker.y2}`}
              fill="none"
              stroke="#9adfff"
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
          );
        }
        if (marker.tool === '↕') {
          return (
            <line
              key={`drawing-${marker.id}`}
              x1={marker.x1}
              y1={top}
              x2={marker.x1}
              y2={priceBottom}
              stroke="#79e7dc"
              strokeDasharray="5 3"
            />
          );
        }
        if (marker.tool === '⌖') {
          return (
            <g key={`drawing-${marker.id}`}>
              <line
                x1={left}
                y1={marker.y1}
                x2={width - right}
                y2={marker.y1}
                stroke="#79e7dc"
                strokeDasharray="5 4"
              />
              <circle cx={marker.x1} cy={marker.y1} r={3.5} fill="#79e7dc" />
            </g>
          );
        }
        if (marker.tool === '◍') {
          return (
            <g key={`drawing-${marker.id}`}>
              <circle
                cx={marker.x1}
                cy={marker.y1}
                r={7}
                fill="none"
                stroke="#79e7dc"
                strokeWidth={1.2}
              />
              <circle cx={marker.x1} cy={marker.y1} r={2.5} fill="#79e7dc" />
            </g>
          );
        }
        if (marker.tool === 'T') {
          return (
            <text
              key={`drawing-${marker.id}`}
              x={marker.x1 + 4}
              y={marker.y1 - 5}
              fill="#79e7dc"
              fontSize="12"
            >
              {marker.text || 'T'}
            </text>
          );
        }
        return (
          <g key={`drawing-${marker.id}`}>
            <line
              x1={marker.x1 - 5}
              y1={marker.y1}
              x2={marker.x1 + 5}
              y2={marker.y1}
              stroke="#79e7dc"
            />
            <line
              x1={marker.x1}
              y1={marker.y1 - 5}
              x2={marker.x1}
              y2={marker.y1 + 5}
              stroke="#79e7dc"
            />
          </g>
        );
      })}

      <line
        x1={left}
        x2={width - right}
        y1={volumeTop - 2}
        y2={volumeTop - 2}
        stroke="#173042"
      />
      <text x={left} y={volumeTop - 8} fill="#8ea5b9" fontSize="10">
        Volume
      </text>
    </svg>
  );
}

export function ProTerminal() {
  const [chainId, setChainId] = useState(DEFAULT_CHAIN_ID);
  const [searchQuery, setSearchQuery] = useState('');
  const filter: MarketFilter = 'spot';
  const [selectedPairId, setSelectedPairId] = useState('');
  const [timeframe, setTimeframe] = useState<Timeframe>('1h');
  const [bookTab, setBookTab] = useState<BookTab>('book');
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('markets');
  const [accountTab, setAccountTab] = useState<AccountTab>('balances');
  const [strictMode, setStrictMode] = useState(true);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [selectedPairByChain, setSelectedPairByChain] = useState<
    Record<string, string>
  >({});
  const [selectedPairSymbolByChain, setSelectedPairSymbolByChain] = useState<
    Record<string, string>
  >({});
  const [ready, setReady] = useState(false);
  const [sizePct, setSizePct] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [denseMode, setDenseMode] = useState(false);
  const [leftPanelCollapsed, setLeftPanelCollapsed] = useState(false);
  const [indicatorsOpen, setIndicatorsOpen] = useState(false);
  const [activeDrawingTool, setActiveDrawingTool] = useState<DrawingTool>('＋');
  const [indicatorSma20, setIndicatorSma20] = useState(true);
  const [indicatorEma50, setIndicatorEma50] = useState(false);
  const [indicatorEma200, setIndicatorEma200] = useState(false);
  const [indicatorVwap, setIndicatorVwap] = useState(false);
  const [indicatorBollinger, setIndicatorBollinger] = useState(true);
  const [indicatorRsi14, setIndicatorRsi14] = useState(false);
  const [indicatorMacd, setIndicatorMacd] = useState(false);
  const [indicatorAtr, setIndicatorAtr] = useState(false);
  const [indicatorStoch, setIndicatorStoch] = useState(false);
  const [indicatorPivot, setIndicatorPivot] = useState(true);
  const [chartZoom, setChartZoom] = useState(1);
  const [chartPanBars, setChartPanBars] = useState(0);
  const [drawingAnchor, setDrawingAnchor] = useState<DrawingAnchor | null>(
    null
  );
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [uiNotice, setUiNotice] = useState('');
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const [globalVenueRows, setGlobalVenueRows] = useState<MarketRow[]>([]);
  const [globalVenueLoading, setGlobalVenueLoading] = useState(false);
  const [globalVenueError, setGlobalVenueError] = useState('');
  const [globalVenueUpdatedAt, setGlobalVenueUpdatedAt] = useState('');
  const [referralLedger, setReferralLedger] = useState<ReferralLedger>(() =>
    emptyReferralLedger()
  );
  const [drawingStore, setDrawingStore] = useState<DrawingStore>({});
  const [chartFullscreen, setChartFullscreen] = useState(false);
  const [recentActivityHeight, setRecentActivityHeight] = useState(380);

  const { address } = useAccount();
  const walletMenuRef = useRef<HTMLDivElement | null>(null);
  const chartViewportRef = useRef<HTMLDivElement | null>(null);
  const recentResizeRef = useRef<{
    startY: number;
    startHeight: number;
  } | null>(null);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeDesk = useMemo<DeskTab>(() => {
    const raw = (searchParams.get('desk') || 'trade').toLowerCase();
    if (raw === 'referrals') return 'referrals';
    return 'trade';
  }, [searchParams]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PersistedLayout>;
        if (typeof parsed.chainId === 'number') setChainId(parsed.chainId);
        if (typeof parsed.searchQuery === 'string')
          setSearchQuery(parsed.searchQuery);
        // Spot-only market list in pro terminal.
        if (
          parsed.timeframe === '1m' ||
          parsed.timeframe === '5m' ||
          parsed.timeframe === '1h' ||
          parsed.timeframe === '1d'
        )
          setTimeframe(parsed.timeframe);
        if (parsed.bookTab === 'book' || parsed.bookTab === 'trades')
          setBookTab(parsed.bookTab);
        if (
          parsed.mobilePanel === 'markets' ||
          parsed.mobilePanel === 'chart' ||
          parsed.mobilePanel === 'trade' ||
          parsed.mobilePanel === 'account'
        ) {
          setMobilePanel(parsed.mobilePanel);
        }
        if (
          parsed.accountTab === 'balances' ||
          parsed.accountTab === 'trade-history'
        ) {
          setAccountTab(parsed.accountTab);
        }
        if (Array.isArray(parsed.favorites)) {
          setFavorites(
            parsed.favorites
              .filter((item): item is string => typeof item === 'string')
              .map((item) => normalizeSavedPairId(item))
              .slice(0, 250)
          );
        }
        if (
          parsed.selectedPairByChain &&
          typeof parsed.selectedPairByChain === 'object'
        ) {
          const next: Record<string, string> = {};
          for (const [key, value] of Object.entries(
            parsed.selectedPairByChain
          )) {
            if (typeof value === 'string')
              next[key] = normalizeSavedPairId(value);
          }
          setSelectedPairByChain(next);
        }
        if (
          parsed.selectedPairSymbolByChain &&
          typeof parsed.selectedPairSymbolByChain === 'object'
        ) {
          const next: Record<string, string> = {};
          for (const [key, value] of Object.entries(
            parsed.selectedPairSymbolByChain
          )) {
            if (typeof value === 'string') next[key] = value;
          }
          setSelectedPairSymbolByChain(next);
        }
      }
    } catch {
      // ignore
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    setReferralLedger(readReferralLedger());
  }, []);

  useEffect(() => {
    setDrawingStore(readDrawingStore());
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const raw = window.localStorage.getItem(RECENT_ACTIVITY_HEIGHT_KEY);
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= RECENT_ACTIVITY_MIN_HEIGHT) {
      setRecentActivityHeight(
        clampValue(
          parsed,
          RECENT_ACTIVITY_MIN_HEIGHT,
          RECENT_ACTIVITY_MAX_HEIGHT
        )
      );
    }
  }, []);

  const marketVM = useMarketListVM(
    chainId,
    searchQuery,
    filter,
    favorites,
    refreshNonce
  );
  const healthVM = useEndpointHealthVM(refreshNonce);

  useEffect(() => {
    if (!ready || typeof window === 'undefined') return;
    const payload: PersistedLayout = {
      chainId,
      searchQuery,
      filter,
      timeframe,
      bookTab,
      mobilePanel,
      accountTab,
      favorites,
      selectedPairByChain,
      selectedPairSymbolByChain
    };
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(payload));
  }, [
    accountTab,
    bookTab,
    chainId,
    favorites,
    filter,
    mobilePanel,
    ready,
    searchQuery,
    selectedPairByChain,
    selectedPairSymbolByChain,
    timeframe
  ]);

  useEffect(() => {
    writeDrawingStore(drawingStore);
  }, [drawingStore]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(
      RECENT_ACTIVITY_HEIGHT_KEY,
      String(Math.round(recentActivityHeight))
    );
  }, [recentActivityHeight]);

  useEffect(() => {
    setDrawingAnchor(null);
  }, [activeDrawingTool, chainId, selectedPairId, timeframe]);

  useEffect(() => {
    setChartPanBars(0);
  }, [chainId, selectedPairId, timeframe]);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onFullscreenChange = () => {
      setChartFullscreen(
        Boolean(
          chartViewportRef.current &&
            document.fullscreenElement === chartViewportRef.current
        )
      );
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () =>
      document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  useEffect(() => {
    const chainKey = String(chainId);
    const current = normalizeSavedPairId(selectedPairByChain[chainKey] || '');
    const currentPairSymbol = selectedPairSymbolByChain[chainKey];

    if (!marketVM.allRows.length) {
      // Keep previous selection during transient poll failures to avoid
      // forcing users back to the default pair on every refresh hiccup.
      if (marketVM.loading || marketVM.error) return;
      return;
    }

    if (current && marketVM.allRows.some((row) => row.id === current)) {
      if (selectedPairId !== current) setSelectedPairId(current);
      return;
    }

    if (
      selectedPairId &&
      marketVM.allRows.some((row) => row.id === selectedPairId)
    ) {
      return;
    }

    if (currentPairSymbol) {
      const bySymbol = marketVM.allRows.find(
        (row) => row.pair === currentPairSymbol
      );
      if (bySymbol) {
        setSelectedPairId(bySymbol.id);
        return;
      }
    }

    const desiredPairs = defaultPairCandidates();
    const desired =
      marketVM.rows.find((row) =>
        desiredPairs.includes(normalizePairLabel(row.pair))
      ) || null;
    const hasActivity = (row: MarketRow | null) =>
      Boolean(row && (row.lastSwapAt || row.swaps > 0 || row.volume24h > 0));
    const mostActive =
      marketVM.rows.find((row) => hasActivity(row)) ||
      marketVM.rows.find(
        (row) => normalizePairLabel(row.quoteSymbol) === 'MUSD'
      ) ||
      marketVM.rows[0] ||
      null;
    const preferred = hasActivity(desired) ? desired : mostActive || desired;
    if (!preferred) return;
    setSelectedPairId(preferred.id);
  }, [
    chainId,
    marketVM.allRows,
    marketVM.rows,
    selectedPairByChain,
    selectedPairId,
    selectedPairSymbolByChain
  ]);

  useEffect(() => {
    if (!selectedPairId) return;
    setSelectedPairByChain((current) => {
      const key = String(chainId);
      if (current[key] === selectedPairId) return current;
      return { ...current, [key]: selectedPairId };
    });
  }, [chainId, selectedPairId]);

  const selectedPair = useMemo(
    () => marketVM.allRows.find((row) => row.id === selectedPairId) || null,
    [marketVM.allRows, selectedPairId]
  );

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const selectedPairLabel = selectedPair?.displayPair || selectedPair?.pair || '';
    const targetLabel = normalizePairLabel(selectedPairLabel);

    if (!targetLabel || !marketVM.networks.length) {
      setGlobalVenueRows([]);
      setGlobalVenueError('');
      setGlobalVenueLoading(false);
      setGlobalVenueUpdatedAt('');
      return;
    }

    async function load() {
      setGlobalVenueLoading(true);
      setGlobalVenueError('');
      try {
        const tokensPayload = await fetchTempoJson<TokensResponse>('/tokens');
        const chains = tokensPayload.chains || {};

        const rowsByChain = await Promise.all(
          marketVM.networks.map(async (network) => {
            const nextChainId = Number(network.chain_id);
            if (!Number.isFinite(nextChainId)) return [] as MarketRow[];
            const pairsPayload = await fetchTempoJson<PairsResponse>(
              `/pairs?chain_id=${nextChainId}&limit=250&include_external=false`
            );
            const dynamicTokens = Array.isArray(chains[String(nextChainId)])
              ? chains[String(nextChainId)] || []
              : [];
            const chainTokens = [
              ...dynamicTokens,
              ...staticChainTokens(nextChainId)
            ];
            const tokenRegistry = buildTokenRegistry(nextChainId, chainTokens);
            const emptyStats = new Map<string, PairStatsItem>();
            const venueRows = buildVenueMarkets({
              chainId: nextChainId,
              registry: tokenRegistry,
              pairs: pairsPayload.rows || [],
              pairStatsById: emptyStats
            });
            return venueRows as MarketRow[];
          })
        );

        if (!active) return;
        const flattened = rowsByChain.flat();
        const filtered = flattened.filter((row) => {
          const rowLabel = normalizePairLabel(row.displayPair || row.pair);
          const rowPair = normalizePairLabel(row.pair);
          return rowLabel === targetLabel || rowPair === targetLabel;
        });

        setGlobalVenueRows(filtered);
        setGlobalVenueUpdatedAt(new Date().toISOString());
      } catch (error) {
        if (!active) return;
        setGlobalVenueError(
          error instanceof Error ? error.message : 'Global venue feed unavailable'
        );
      } finally {
        if (active) {
          setGlobalVenueLoading(false);
          timer = window.setTimeout(load, GLOBAL_VENUE_POLL_MS);
        }
      }
    }

    void load();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [marketVM.networks, selectedPair?.displayPair, selectedPair?.pair]);

  useEffect(() => {
    if (!selectedPair) return;
    const key = String(chainId);
    setSelectedPairSymbolByChain((current) => {
      if (current[key] === selectedPair.pair) return current;
      return { ...current, [key]: selectedPair.pair };
    });
  }, [chainId, selectedPair]);

  const tradesVM = useTradesVM(chainId, selectedPair, refreshNonce);
  const pairVM = usePairVM({
    chainId,
    selectedPair,
    trades: tradesVM.trades,
    timeframe,
    refreshNonce
  });
  const orderbookVM = useOrderbookVM(selectedPair, pairVM.metrics.lastPrice);

  const globalFairPriceMusd = useMemo(() => {
    if (isStableMusdRail(selectedPair)) return 1;
    const points: WeightedPricePoint[] = globalVenueRows
      .filter((row) => row.hasPool && Number(row.last || 0) > 0)
      .map((row) => ({
        price: Number(row.last || 0),
        weight: Math.max(1, Number(row.reserveQuote || 0))
      }));
    return computeWeightedMedianPrice(points);
  }, [globalVenueRows, selectedPair]);

  const entryVM = useOrderEntryVM({
    chainId,
    selectedPair,
    tokenMap: marketVM.tokenMap,
    selectedNetwork: marketVM.selectedNetwork,
    quoteSymbol: marketVM.quoteSymbol,
    marketRows: marketVM.allRows,
    globalFairPriceMusd
  });

  const askMax = Math.max(
    1,
    ...orderbookVM.asks.map((level) => safe(level.total))
  );
  const bidMax = Math.max(
    1,
    ...orderbookVM.bids.map((level) => safe(level.total))
  );
  const displayCandles = useMemo(
    () => composeDisplayCandles(pairVM.ohlcCandles, selectedPair, timeframe),
    [pairVM.ohlcCandles, selectedPair, timeframe]
  );
  const viewport = useMemo(
    () =>
      sliceCandlesForViewport(
        displayCandles.candles,
        chartZoom,
        chartPanBars
      ),
    [chartPanBars, chartZoom, displayCandles.candles]
  );
  const visibleCandles = viewport.candles;
  const maxPanBars = viewport.maxPanBars;
  const chartSource = displayCandles.source;
  const usingSyntheticChart =
    chartSource === 'synthetic' || chartSource === 'hybrid';
  const drawingContext = useMemo(
    () => drawingContextKey(chainId, selectedPair?.id || 'none', timeframe),
    [chainId, selectedPair?.id, timeframe]
  );
  const activeDrawings = drawingStore[drawingContext] || [];

  useEffect(() => {
    if (chartPanBars > maxPanBars) {
      setChartPanBars(maxPanBars);
    }
  }, [chartPanBars, maxPanBars]);

  const addDrawingPoint = useCallback(
    (payload: { bucket: number; price: number }) => {
      if (!selectedPair) {
        setUiNotice('Select a pair before adding drawings.');
        return;
      }
      const toolMeta = DRAWING_TOOL_META[activeDrawingTool];
      if (toolMeta.mode === 'line') {
        if (!drawingAnchor || drawingAnchor.tool !== activeDrawingTool) {
          setDrawingAnchor({ ...payload, tool: activeDrawingTool });
          setUiNotice(
            `${toolMeta.label}: first point set. Click second point to complete.`
          );
          return;
        }
      }
      const id =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      setDrawingStore((current) => {
        const nextItem: DrawingObject = {
          id,
          tool: activeDrawingTool,
          bucket: payload.bucket,
          price: payload.price,
          createdAt: Date.now()
        };
        if (
          toolMeta.mode === 'line' &&
          drawingAnchor &&
          drawingAnchor.tool === activeDrawingTool
        ) {
          nextItem.bucket = drawingAnchor.bucket;
          nextItem.price = drawingAnchor.price;
          nextItem.bucket2 = payload.bucket;
          nextItem.price2 = payload.price;
        } else if (toolMeta.mode === 'horizontal') {
          nextItem.price = payload.price;
        } else if (toolMeta.mode === 'text') {
          nextItem.text = 'T';
        }
        const nextForContext = [
          ...(current[drawingContext] || []),
          nextItem
        ].slice(-DRAWING_CONTEXT_LIMIT);
        return { ...current, [drawingContext]: nextForContext };
      });
      setDrawingAnchor(null);
      setUiNotice(
        `${toolMeta.label} saved for ${selectedPair.displayPair} (${timeframe}).`
      );
    },
    [activeDrawingTool, drawingAnchor, drawingContext, selectedPair, timeframe]
  );
  const clearDrawingContext = useCallback(() => {
    setDrawingStore((current) => {
      if (!current[drawingContext]?.length) return current;
      const next = { ...current };
      delete next[drawingContext];
      return next;
    });
    setDrawingAnchor(null);
    setUiNotice('Drawing objects cleared for current pair/timeframe.');
  }, [drawingContext]);

  const chainLabel = marketVM.selectedNetwork
    ? `${marketVM.selectedNetwork.name} (${chainId})`
    : `Chain ${chainId}`;
  const networkNameByChain = useMemo(() => {
    const map = new Map<number, string>();
    marketVM.networks.forEach((network) => {
      map.set(Number(network.chain_id), network.name);
    });
    return map;
  }, [marketVM.networks]);
  const healthFailover = useMemo(
    () => healthVM.history.find((item) => item.switched)?.reason || 'none',
    [healthVM.history]
  );
  const healthCheckedLabel = useMemo(
    () =>
      healthVM.lastCheckedAt
        ? new Date(healthVM.lastCheckedAt).toLocaleTimeString()
        : '--',
    [healthVM.lastCheckedAt]
  );
  const musdBalance = useMemo(() => {
    const raw =
      entryVM.walletBalances[entryVM.quoteSymbol] ??
      entryVM.walletBalances.MUSD ??
      entryVM.walletBalances.mUSD ??
      '0';
    return Number(raw);
  }, [entryVM.quoteSymbol, entryVM.walletBalances]);
  const needsMusdOnboarding =
    entryVM.isConnected &&
    Number.isFinite(musdBalance) &&
    musdBalance <= 0.0000001;
  const walletLower = String(address || '').toLowerCase();
  const myReferralCode =
    walletLower && /^0x[a-f0-9]{40}$/.test(walletLower) ? walletLower : '';
  const referredBy = walletLower
    ? referralLedger.referredByWallet[walletLower] || ''
    : '';
  const myReferralStat = myReferralCode
    ? safeReferralStat(referralLedger.statsByReferrer[myReferralCode])
    : safeReferralStat(undefined);
  const referralInviteLink = useMemo(() => {
    if (!myReferralCode) return '';
    if (typeof window === 'undefined')
      return `/pro?desk=trade&ref=${myReferralCode}`;
    return `${window.location.origin}/pro?desk=trade&ref=${myReferralCode}`;
  }, [myReferralCode]);

  const selectPair = useCallback(
    (row: MarketRow) => {
      setSelectedPairId(row.id);
      const key = String(chainId);
      setSelectedPairByChain((current) =>
        current[key] === row.id ? current : { ...current, [key]: row.id }
      );
      setSelectedPairSymbolByChain((current) =>
        current[key] === row.pair ? current : { ...current, [key]: row.pair }
      );
    },
    [chainId]
  );

  const setupFirstTradeToMusd = useCallback(() => {
    const normalizedWrapped = entryVM.wrappedNativeSymbol.toUpperCase();
    const musdPairs = marketVM.allRows.filter(
      (row) => normalizePairLabel(row.quoteSymbol) === 'MUSD'
    );

    const preferred =
      musdPairs.find(
        (row) => normalizePairLabel(row.baseSymbol) === normalizedWrapped
      ) ||
      musdPairs[0] ||
      null;

    if (!preferred) return;
    selectPair(preferred);
    entryVM.setEntryMode('market');
    entryVM.setSide('sell');
    if (!entryVM.amount || Number(entryVM.amount) <= 0) {
      entryVM.setAmount('0.1');
    }
    setMobilePanel('trade');
  }, [entryVM, marketVM.allRows, selectPair]);

  const bestVenueSummary = useMemo(() => {
    const rows = globalVenueRows.filter(
      (row) =>
        row.hasPool &&
        Number.isFinite(row.last ?? NaN) &&
        Number(row.last || 0) > 0
    );
    if (!rows.length) {
      return {
        bestOverall: null as MarketRow | null,
        bestBuy: null as MarketRow | null,
        bestSell: null as MarketRow | null,
        bestDepth: null as MarketRow | null
      };
    }

    const bestDepth = [...rows].sort(
      (a, b) => (b.reserveQuote || 0) - (a.reserveQuote || 0)
    )[0];
    const bestBuy = [...rows].sort((a, b) => {
      const byPrice = Number(a.last || 0) - Number(b.last || 0);
      if (byPrice !== 0) return byPrice;
      return (b.reserveQuote || 0) - (a.reserveQuote || 0);
    })[0];
    const bestSell = [...rows].sort((a, b) => {
      const byPrice = Number(b.last || 0) - Number(a.last || 0);
      if (byPrice !== 0) return byPrice;
      return (b.reserveQuote || 0) - (a.reserveQuote || 0);
    })[0];

    let bestOverall = bestDepth;
    if (entryVM.side === 'buy' && bestBuy) bestOverall = bestBuy;
    if (entryVM.side === 'sell' && bestSell) bestOverall = bestSell;

    return { bestOverall, bestBuy, bestSell, bestDepth };
  }, [entryVM.side, globalVenueRows]);

  const bestVenueDelta = useMemo(() => {
    const bestPrice = Number(bestVenueSummary.bestOverall?.last || 0);
    const currentPrice = Number(selectedPair?.last || pairVM.metrics.lastPrice || 0);
    if (!(bestPrice > 0 && currentPrice > 0)) return null;
    return ((bestPrice - currentPrice) / currentPrice) * 100;
  }, [
    bestVenueSummary.bestOverall?.last,
    pairVM.metrics.lastPrice,
    selectedPair?.last
  ]);

  const switchToGlobalVenue = useCallback((row: MarketRow) => {
    const nextChainId = Number(row.chainId);
    if (!Number.isFinite(nextChainId)) return;
    const nextPairId = normalizeSavedPairId(row.id);
    const chainKey = String(nextChainId);
    setSelectedPairByChain((current) => ({
      ...current,
      [chainKey]: nextPairId
    }));
    setSelectedPairSymbolByChain((current) => ({
      ...current,
      [chainKey]: row.pair
    }));
    setSelectedPairId(nextPairId);
    setChainId(nextChainId);
    setUiNotice(
      `Global Best Venue selected: ${row.displayPair} on chain ${nextChainId}.`
    );
  }, []);

  useEffect(() => {
    if (!walletLower || !/^0x[a-f0-9]{40}$/.test(walletLower)) return;
    const ref = String(searchParams.get('ref') || '')
      .trim()
      .toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(ref) || ref === walletLower) return;

    const nextLedger = readReferralLedger();
    if (nextLedger.referredByWallet[walletLower] === ref) return;

    nextLedger.referredByWallet[walletLower] = ref;
    const refStat = safeReferralStat(nextLedger.statsByReferrer[ref]);
    if (!refStat.invitees.includes(walletLower)) {
      refStat.invitees = [walletLower, ...refStat.invitees].slice(0, 500);
    }
    refStat.updatedAt = new Date().toISOString();
    nextLedger.statsByReferrer[ref] = refStat;
    writeReferralLedger(nextLedger);
    setReferralLedger(nextLedger);
    setUiNotice(`Referral tag linked: ${shortAddress(ref)}.`);
  }, [searchParams, walletLower]);

  useEffect(() => {
    if (!walletLower || !entryVM.lastExecutionTxHash) return;
    const referrer = referralLedger.referredByWallet[walletLower];
    if (!referrer || !/^0x[a-f0-9]{40}$/.test(referrer)) return;

    const currentStat = safeReferralStat(
      referralLedger.statsByReferrer[referrer]
    );
    if (currentStat.lastTxHash === entryVM.lastExecutionTxHash) return;

    const quoteNotional = Number(
      entryVM.quote?.amount_in || entryVM.amount || 0
    );
    const rewardModx = Number.isFinite(quoteNotional)
      ? (quoteNotional * REFERRAL_REWARD_BPS) / 10_000
      : 0;

    const nextLedger = readReferralLedger();
    const nextReferrerStat = safeReferralStat(
      nextLedger.statsByReferrer[referrer]
    );
    if (!nextReferrerStat.invitees.includes(walletLower)) {
      nextReferrerStat.invitees = [
        walletLower,
        ...nextReferrerStat.invitees
      ].slice(0, 500);
    }
    nextReferrerStat.trades += 1;
    nextReferrerStat.rewardModx += rewardModx;
    nextReferrerStat.lastTxHash = entryVM.lastExecutionTxHash;
    nextReferrerStat.updatedAt = new Date().toISOString();
    nextLedger.statsByReferrer[referrer] = nextReferrerStat;
    writeReferralLedger(nextLedger);
    setReferralLedger(nextLedger);
    setUiNotice(
      `Referral reward accrued for ${shortAddress(referrer)}: +${shortAmount(
        rewardModx
      )} MODX (tx ${entryVM.lastExecutionTxHash.slice(0, 10)}...).`
    );
  }, [
    entryVM.amount,
    entryVM.lastExecutionTxHash,
    entryVM.quote?.amount_in,
    referralLedger,
    walletLower
  ]);

  useEffect(() => {
    if (sizePct <= 0) return;
    const base = Number(entryVM.availableBalance || '0');
    if (!Number.isFinite(base) || base <= 0) {
      entryVM.setAmount('0');
      return;
    }
    const nextAmount = (base * sizePct) / 100;
    entryVM.setAmount(nextAmount.toFixed(6));
  }, [entryVM, sizePct]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;

      if (event.key === '/') {
        event.preventDefault();
        const el = document.getElementById('pro-market-search');
        if (el instanceof HTMLInputElement) el.focus();
      }

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (!marketVM.rows.length) return;
        event.preventDefault();
        const current = Math.max(
          0,
          marketVM.rows.findIndex((row) => row.id === selectedPairId)
        );
        const next =
          event.key === 'ArrowDown'
            ? Math.min(marketVM.rows.length - 1, current + 1)
            : Math.max(0, current - 1);
        selectPair(marketVM.rows[next]);
      }

      if (event.key === 'Enter' && selectedPair) {
        event.preventDefault();
        if (entryVM.entryMode === 'market' && !entryVM.quote) {
          void entryVM.requestQuote();
        } else {
          void entryVM.execute();
        }
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [entryVM, marketVM.rows, selectPair, selectedPair, selectedPairId]);

  useEffect(() => {
    if (!uiNotice) return undefined;
    const timer = window.setTimeout(() => setUiNotice(''), 3600);
    return () => window.clearTimeout(timer);
  }, [uiNotice]);

  useEffect(() => {
    if (!walletMenuOpen) return undefined;
    const handleClickOutside = (event: MouseEvent) => {
      if (!walletMenuRef.current) return;
      if (!walletMenuRef.current.contains(event.target as Node)) {
        setWalletMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [walletMenuOpen]);

  const accountExplorerUrl = useMemo(() => {
    if (!address) return '';
    if (chainId === 97) return `https://testnet.bscscan.com/address/${address}`;
    if (chainId === 11155111)
      return `https://sepolia.etherscan.io/address/${address}`;
    return '';
  }, [address, chainId]);

  const openSelectedInHarmony = useCallback(() => {
    if (!selectedPair) {
      setUiNotice('Select a pair first.');
      return;
    }
    const url = `/harmony?chain_id=${chainId}&token_in=${selectedPair.baseSymbol}&token_out=${selectedPair.quoteSymbol}`;
    if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }, [chainId, selectedPair]);

  const copySelectedPair = useCallback(async () => {
    if (!selectedPair) {
      setUiNotice('No pair selected.');
      return;
    }
    const payload = `${selectedPair.pair} | pool=${selectedPair.poolAddress} | chain=${selectedPair.chainId}`;
    const copied = await copyText(payload);
    setUiNotice(copied ? 'Pair metadata copied.' : 'Clipboard unavailable.');
  }, [selectedPair]);

  const fullRefresh = useCallback(() => {
    setRefreshNonce((value) => value + 1);
    setUiNotice(
      `Refreshing market, trades, and analytics... ${new Date().toLocaleTimeString()}`
    );
  }, []);

  const nudgeChartZoom = useCallback((delta: number) => {
    setChartZoom((value) => {
      const next = delta > 0 ? value * 1.2 : value / 1.2;
      return Number(
        clampValue(Number(next.toFixed(2)), ZOOM_MIN, ZOOM_MAX).toFixed(2)
      );
    });
  }, []);

  const nudgeChartPan = useCallback(
    (deltaBars: number) => {
      setChartPanBars((value) => clampValue(value + deltaBars, 0, maxPanBars));
    },
    [maxPanBars]
  );

  const setChartPanAbsolute = useCallback(
    (next: number) => {
      setChartPanBars(clampValue(next, 0, maxPanBars));
    },
    [maxPanBars]
  );

  const resetChartViewport = useCallback(() => {
    setChartPanBars(0);
    setChartZoom(1);
    setUiNotice('Chart viewport reset (zoom + pan).');
  }, []);

  const toggleChartFullscreen = useCallback(() => {
    if (typeof document === 'undefined') return;
    const target = chartViewportRef.current;
    if (!target) return;
    if (document.fullscreenElement === target) {
      void document.exitFullscreen?.();
      return;
    }
    void target.requestFullscreen?.();
  }, []);

  const nudgeRecentActivityHeight = useCallback((delta: number) => {
    setRecentActivityHeight((value) =>
      clampValue(
        value + delta,
        RECENT_ACTIVITY_MIN_HEIGHT,
        RECENT_ACTIVITY_MAX_HEIGHT
      )
    );
  }, []);

  const startRecentActivityResize = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      recentResizeRef.current = {
        startY: event.clientY,
        startHeight: recentActivityHeight
      };

      const onMove = (moveEvent: MouseEvent) => {
        if (!recentResizeRef.current) return;
        const delta = moveEvent.clientY - recentResizeRef.current.startY;
        setRecentActivityHeight(
          clampValue(
            recentResizeRef.current.startHeight + delta,
            RECENT_ACTIVITY_MIN_HEIGHT,
            RECENT_ACTIVITY_MAX_HEIGHT
          )
        );
      };

      const onUp = () => {
        recentResizeRef.current = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [recentActivityHeight]
  );

  const executePrimary = async () => {
    if (
      entryVM.entryMode === 'market' &&
      (!entryVM.quote || entryVM.staleQuote || !entryVM.routeLocked)
    ) {
      await entryVM.requestQuote();
      return;
    }
    const ok = await entryVM.execute();
    if (ok) {
      setUiNotice('Trade execution completed. Panels are refreshing.');
    }
  };

  return (
    <div
      className={`flex min-h-screen flex-col bg-[#06111d] text-slate-100 ${
        denseMode ? 'text-[13px] leading-5' : 'text-[15px] leading-6'
      }`}
    >
      <header className="flex h-16 items-center justify-between border-b border-[#183344] bg-[#09141f] px-4">
        <div className="flex min-w-0 items-center gap-5">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-[#67e3d5]" />
            <span className="text-base font-semibold">mCryptoEx</span>
          </div>
          <nav className="hidden items-center gap-4 text-sm text-slate-200 lg:flex">
            {DESK_LINKS.map((item) => (
              <Link
                key={item.id}
                href={item.href}
                className={`rounded px-1.5 py-1 transition ${
                  activeDesk === item.id
                    ? 'text-[#58d4c8]'
                    : 'text-slate-200 hover:text-white'
                }`}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <div className="hidden min-w-0 items-center gap-1.5 lg:flex">
            <span
              className={`rounded border px-2 py-1 text-[11px] font-semibold ${
                healthVM.status === 'healthy'
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  : healthVM.status === 'degraded'
                  ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                  : 'border-rose-500/40 bg-rose-500/10 text-rose-300'
              }`}
            >
              PC {healthVM.status}
            </span>
            <span className="rounded border border-[#21445b] bg-[#0c1a29] px-2 py-1 text-[11px] text-slate-300">
              {typeof healthVM.latencyMs === 'number'
                ? `${healthVM.latencyMs} ms`
                : 'n/a'}
            </span>
            <span
              title={
                healthFailover === 'none'
                  ? 'No failover event yet'
                  : healthFailover
              }
              className="max-w-[180px] truncate rounded border border-[#21445b] bg-[#0c1a29] px-2 py-1 text-[11px] text-slate-400"
            >
              failover: {healthFailover === 'none' ? 'none' : 'detected'}
            </span>
            <span className="max-w-[180px] truncate rounded border border-[#21445b] bg-[#0c1a29] px-2 py-1 text-[11px] text-slate-400">
              {shortEndpoint(healthVM.activeEndpoint)}
            </span>
            <span
              className="rounded border border-[#21445b] bg-[#0c1a29] px-2 py-1 text-[11px] text-slate-500"
              title={`Candidates: ${healthVM.candidateCount} | Checked: ${healthCheckedLabel}`}
            >
              #{healthVM.candidateCount}
            </span>
          </div>
          <div ref={walletMenuRef} className="relative flex items-center gap-2">
            <button
              type="button"
              onClick={() => setWalletMenuOpen((open) => !open)}
              className={`rounded-md border bg-[#0c1a29] px-3 py-1.5 text-sm text-slate-200 transition ${
                walletMenuOpen
                  ? 'border-[#57d6ca] text-[#79e7dc]'
                  : 'border-[#204257] hover:border-[#57d6ca]'
              }`}
            >
              {shortAddress(address)}
            </button>
            <button
              type="button"
              title="Toggle compact density"
              onClick={() =>
                setDenseMode((value) => {
                  const next = !value;
                  setUiNotice(
                    next
                      ? 'Dense typography enabled.'
                      : 'Comfortable typography enabled.'
                  );
                  return next;
                })
              }
              className="flex h-9 items-center gap-1 rounded-md border border-[#204257] bg-[#0c1a29] px-2 text-xs text-slate-200 transition hover:border-[#57d6ca]"
            >
              <span aria-hidden="true">◰</span>
              <span className="hidden xl:inline">Density</span>
            </button>
            <button
              type="button"
              title="Refresh all panels"
              onClick={fullRefresh}
              className="flex h-9 items-center gap-1 rounded-md border border-[#204257] bg-[#0c1a29] px-2 text-xs text-slate-200 transition hover:border-[#57d6ca]"
            >
              <span aria-hidden="true">◎</span>
              <span className="hidden xl:inline">Refresh</span>
            </button>
            <button
              type="button"
              title="Open terminal settings"
              onClick={() =>
                setSettingsOpen((value) => {
                  const next = !value;
                  setUiNotice(
                    next
                      ? 'Terminal settings opened.'
                      : 'Terminal settings closed.'
                  );
                  return next;
                })
              }
              className={`flex h-9 items-center gap-1 rounded-md border bg-[#0c1a29] px-2 text-xs text-slate-200 transition ${
                settingsOpen
                  ? 'border-[#57d6ca] text-[#79e7dc]'
                  : 'border-[#204257] hover:border-[#57d6ca]'
              }`}
            >
              <span aria-hidden="true">⚙</span>
              <span className="hidden xl:inline">Settings</span>
            </button>
            {walletMenuOpen ? (
              <div className="absolute right-0 top-12 z-40 w-64 rounded-md border border-[#21445b] bg-[#0b1a29] p-2 shadow-[0_18px_60px_rgba(0,0,0,0.45)]">
                <p className="truncate px-2 py-1 text-xs text-slate-400">
                  Wallet
                </p>
                <p className="truncate px-2 pb-1 text-xs text-[#79e7dc]">
                  {address || 'Not connected'}
                </p>
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await copyText(address || '');
                    setUiNotice(
                      ok ? 'Wallet address copied.' : 'Clipboard unavailable.'
                    );
                    setWalletMenuOpen(false);
                  }}
                  className="mt-1 flex w-full items-center rounded px-2 py-1.5 text-left text-sm text-slate-200 hover:bg-[#123245]"
                >
                  Copy address
                </button>
                {accountExplorerUrl ? (
                  <a
                    href={accountExplorerUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 flex w-full items-center rounded px-2 py-1.5 text-left text-sm text-slate-200 hover:bg-[#123245]"
                    onClick={() => setWalletMenuOpen(false)}
                  >
                    Open in explorer
                  </a>
                ) : null}
                <Link
                  href="/harmony?intent=deposit"
                  className="mt-1 flex w-full items-center rounded px-2 py-1.5 text-left text-sm text-slate-200 hover:bg-[#123245]"
                  onClick={() => setWalletMenuOpen(false)}
                >
                  Open deposit flow
                </Link>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <div className="border-b border-[#1b3f4d] bg-[#58d4c8] px-4 py-1.5 text-sm font-medium text-[#062428]">
        Wallet-first non-custodial trading. Tempo API is read-only; all
        executions are wallet-signed.
      </div>
      <div className="border-b border-[#1b3f4d] bg-[#091623] px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          {PLATFORM_LINKS.map((item) => {
            const active = item.href === pathname;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded border px-2.5 py-1.5 text-xs font-semibold tracking-[0.03em] ${
                  active
                    ? 'border-[#57d6ca] bg-[#123345] text-[#79e7dc]'
                    : 'border-[#21445b] bg-[#0c1a29] text-slate-300 hover:text-white'
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      </div>

      <div className="border-b border-[#1b3f4d] bg-[#08121c] px-3 py-2">
        {uiNotice ? (
          <p className="text-sm text-[#79e7dc]">{uiNotice}</p>
        ) : activeDesk !== 'trade' ? (
          <p className="text-sm text-slate-300">
            <span className="text-[#79e7dc]">
              {DESK_TITLES[activeDesk].title}:
            </span>{' '}
            {DESK_TITLES[activeDesk].subtitle}
          </p>
        ) : needsMusdOnboarding ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <p className="text-slate-200">
              First step: convert native {chainId === 97 ? 'tBNB' : 'gas token'}{' '}
              to <span className="text-[#79e7dc]">mUSD</span> to start trading
              pairs.
            </p>
            <button
              type="button"
              onClick={setupFirstTradeToMusd}
              className="rounded border border-[#57d6ca] bg-[#123345] px-2 py-1 text-xs font-semibold text-[#79e7dc]"
            >
              Auto Setup Native → mUSD
            </button>
            <Link
              href="/harmony?intent=first-trade&output=mUSD"
              className="text-[#79e7dc] underline"
            >
              Open Guided Swap
            </Link>
          </div>
        ) : (
          <p className="text-sm text-slate-400">
            mUSD balance detected. You can quote and execute trades directly
            from this panel.
          </p>
        )}
      </div>

      {settingsOpen ? (
        <div className="border-b border-[#1b3f4d] bg-[#081522] px-3 py-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button
              type="button"
              onClick={() => setDenseMode(false)}
              className={`rounded border px-2 py-1 ${
                !denseMode
                  ? 'border-[#57d6ca] bg-[#123345] text-[#79e7dc]'
                  : 'border-[#21445b] text-slate-300'
              }`}
            >
              Comfortable Text
            </button>
            <button
              type="button"
              onClick={() => setDenseMode(true)}
              className={`rounded border px-2 py-1 ${
                denseMode
                  ? 'border-[#57d6ca] bg-[#123345] text-[#79e7dc]'
                  : 'border-[#21445b] text-slate-300'
              }`}
            >
              Dense Text
            </button>
            <button
              type="button"
              onClick={() => setLeftPanelCollapsed((value) => !value)}
              className="rounded border border-[#21445b] px-2 py-1 text-slate-300"
            >
              {leftPanelCollapsed
                ? 'Show Market Panel'
                : 'Collapse Market Panel'}
            </button>
            <button
              type="button"
              onClick={fullRefresh}
              className="rounded border border-[#21445b] px-2 py-1 text-slate-300"
            >
              Refresh Feeds
            </button>
          </div>
        </div>
      ) : null}

      <main className="flex-1 p-2">
        {activeDesk === 'trade' ? (
          <>
            <div className="mb-1 grid grid-cols-[minmax(0,1fr)_280px] gap-1 rounded border border-[#173448] bg-[#0a1724] px-2 py-2 text-[15px]">
              <div className="flex min-w-0 items-center gap-4 overflow-hidden">
                <button className="text-lg text-[#63e0d2]">✦</button>
                <div className="min-w-0">
                  <p className="truncate text-2xl font-semibold">
                    {selectedPair?.displayPair || 'Select Pair'}
                  </p>
                </div>
                <div className="hidden items-center gap-6 text-sm text-slate-300 md:flex">
                  <div>
                    <p className="text-slate-500">Price (mUSD)</p>
                    <p className="font-mono text-[#8de5db]">
                      {shortAmount(pairVM.metrics.lastPrice)}
                    </p>
                  </div>
                  <div>
                    <p className="text-slate-500">24H Change</p>
                    <p
                      className={`font-mono ${changeClass(
                        pairVM.metrics.change24h
                      )}`}
                    >
                      {formatChange(pairVM.metrics.change24h)}
                    </p>
                  </div>
                  <div>
                    <p className="text-slate-500">
                      24H Volume ({selectedPair?.quoteDisplaySymbol || 'mUSD'})
                    </p>
                    <p className="font-mono">
                      {shortAmount(pairVM.metrics.volume24h)}{' '}
                      {selectedPair?.quoteDisplaySymbol || 'mUSD'}
                    </p>
                  </div>
                  <div>
                    <p className="text-slate-500">Market Cap</p>
                    <p className="font-mono text-slate-300">n/a</p>
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-end gap-1">
                <button
                  type="button"
                  onClick={openSelectedInHarmony}
                  title="Open selected pair in Harmony swap"
                  className="h-8 w-8 rounded border border-[#21445b] bg-[#0c1a29] text-sm text-slate-300 transition hover:border-[#57d6ca]"
                >
                  ↗
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void copySelectedPair();
                  }}
                  title="Copy selected pair metadata"
                  className="h-8 w-8 rounded border border-[#21445b] bg-[#0c1a29] text-sm text-slate-300 transition hover:border-[#57d6ca]"
                >
                  ⧉
                </button>
                <button
                  type="button"
                  onClick={() => setLeftPanelCollapsed((value) => !value)}
                  title="Toggle market panel"
                  className={`h-8 w-8 rounded border bg-[#0c1a29] text-sm text-slate-300 transition ${
                    leftPanelCollapsed
                      ? 'border-[#57d6ca] text-[#79e7dc]'
                      : 'border-[#21445b] hover:border-[#57d6ca]'
                  }`}
                >
                  ☰
                </button>
              </div>
            </div>

            <div className="mb-1 rounded border border-[#173448] bg-[#0a1724] px-2 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-400">
                    Global Best Venue
                  </p>
                  <span className="rounded border border-[#21445b] bg-[#0d1d2b] px-2 py-0.5 text-[11px] text-slate-300">
                    live cross-chain
                  </span>
                </div>
                <p className="text-[11px] text-slate-500">
                  {globalVenueUpdatedAt
                    ? `Updated ${new Date(globalVenueUpdatedAt).toLocaleTimeString()}`
                    : '--'}
                </p>
              </div>
              {globalVenueLoading ? (
                <p className="mt-2 text-sm text-slate-400">
                  Checking best price/depth across chains...
                </p>
              ) : globalVenueError ? (
                <p className="mt-2 text-sm text-rose-300">{globalVenueError}</p>
              ) : !bestVenueSummary.bestOverall ? (
                <p className="mt-2 text-sm text-slate-400">
                  No cross-chain venue data available for this pair yet.
                </p>
              ) : (
                <div className="mt-2 grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto]">
                  <div className="grid gap-1 text-sm text-slate-300 sm:grid-cols-2 lg:grid-cols-5">
                    <div className="rounded border border-[#1b3f52] bg-[#0b1a28] px-2 py-1">
                      <p className="text-[11px] text-slate-500">Best Venue</p>
                      <p className="font-semibold text-[#79e7dc]">
                        {networkNameByChain.get(
                          Number(bestVenueSummary.bestOverall.chainId)
                        ) || `Chain ${bestVenueSummary.bestOverall.chainId}`}
                      </p>
                    </div>
                    <div className="rounded border border-[#1b3f52] bg-[#0b1a28] px-2 py-1">
                      <p className="text-[11px] text-slate-500">Best Price</p>
                      <p className="font-mono">
                        {shortAmount(
                          Number(bestVenueSummary.bestOverall.last || 0)
                        )}
                      </p>
                    </div>
                    <div className="rounded border border-[#1b3f52] bg-[#0b1a28] px-2 py-1">
                      <p className="text-[11px] text-slate-500">
                        Deepest mUSD Liquidity
                      </p>
                      <p className="font-mono">
                        {shortAmount(bestVenueSummary.bestDepth?.reserveQuote || 0)}
                      </p>
                    </div>
                    <div className="rounded border border-[#1b3f52] bg-[#0b1a28] px-2 py-1">
                      <p className="text-[11px] text-slate-500">
                        Delta vs Current Chain
                      </p>
                      <p
                        className={`font-mono ${
                          typeof bestVenueDelta === 'number'
                            ? bestVenueDelta >= 0
                              ? 'text-emerald-300'
                              : 'text-rose-300'
                            : 'text-slate-300'
                        }`}
                      >
                        {typeof bestVenueDelta === 'number'
                          ? `${bestVenueDelta >= 0 ? '+' : ''}${bestVenueDelta.toFixed(3)}%`
                          : 'n/a'}
                      </p>
                    </div>
                    <div className="rounded border border-[#1b3f52] bg-[#0b1a28] px-2 py-1">
                      <p className="text-[11px] text-slate-500">
                        Global Fair Price
                      </p>
                      <p className="font-mono">
                        {globalFairPriceMusd && Number.isFinite(globalFairPriceMusd)
                          ? shortAmount(globalFairPriceMusd)
                          : 'n/a'}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      switchToGlobalVenue(bestVenueSummary.bestOverall as MarketRow)
                    }
                    className="h-10 rounded border border-[#57d6ca] bg-[#123345] px-3 text-sm font-semibold text-[#79e7dc] transition hover:bg-[#18465d]"
                  >
                    Switch To Best Venue
                  </button>
                </div>
              )}
            </div>

            <div className="mb-1 flex gap-1 lg:hidden">
              {(
                [
                  ['markets', 'Market'],
                  ['chart', 'Chart'],
                  ['trade', 'Trade'],
                  ['account', 'Account']
                ] as const
              ).map(([panel, label]) => (
                <button
                  key={panel}
                  type="button"
                  onClick={() => setMobilePanel(panel)}
                  className={`flex-1 rounded border px-2 py-1 text-xs font-semibold uppercase tracking-[0.08em] ${
                    mobilePanel === panel
                      ? 'border-[#55d1c5] bg-[#132f3f] text-[#78e6db]'
                      : 'border-[#21445b] bg-[#0c1a29] text-slate-300'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div
              className={`grid min-h-[500px] gap-1 lg:min-h-[560px] xl:h-[56vh] ${
                leftPanelCollapsed
                  ? 'lg:grid-cols-1 xl:grid-cols-[minmax(0,1fr)_520px]'
                  : 'lg:grid-cols-[340px_minmax(0,1fr)] xl:grid-cols-[420px_minmax(0,1fr)_520px]'
              }`}
            >
              <section
                className={`${
                  mobilePanel === 'markets' ? 'block' : 'hidden'
                } rounded border border-[#173448] bg-[#0a1724] p-2 ${
                  leftPanelCollapsed ? 'lg:hidden' : 'lg:block'
                }`}
              >
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-sm text-slate-400">{chainLabel}</p>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setStrictMode(true)}
                      className={`rounded border px-2 py-1 text-xs ${
                        strictMode
                          ? 'border-[#57d6ca] bg-[#123345] text-[#75e6da]'
                          : 'border-[#21445b] bg-[#0c1a29] text-slate-300'
                      }`}
                    >
                      Strict
                    </button>
                    <button
                      type="button"
                      onClick={() => setStrictMode(false)}
                      className={`rounded border px-2 py-1 text-xs ${
                        !strictMode
                          ? 'border-[#57d6ca] bg-[#123345] text-[#75e6da]'
                          : 'border-[#21445b] bg-[#0c1a29] text-slate-300'
                      }`}
                    >
                      Relaxed
                    </button>
                  </div>
                </div>

                <div className="mb-2 flex items-center gap-2">
                  <input
                    id="pro-market-search"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Search"
                    className="h-9 flex-1 rounded border border-[#21445b] bg-[#0a1623] px-3 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-[#59d8cc]"
                  />
                  <select
                    value={chainId}
                    onChange={(event) => setChainId(Number(event.target.value))}
                    className="h-9 rounded border border-[#21445b] bg-[#0a1623] px-2 text-xs text-slate-300"
                  >
                    {(marketVM.networks.length
                      ? marketVM.networks
                      : [{ chain_id: chainId, name: chainLabel }]
                    ).map((network) => (
                      <option key={network.chain_id} value={network.chain_id}>
                        {network.chain_id}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="mb-2 flex flex-wrap items-center gap-1 text-xs">
                  <span className="rounded border border-[#57d6ca] bg-[#123345] px-2 py-1 text-[#75e6da]">
                    Spot
                  </span>
                  <span className="text-slate-500">
                    Star markets to pin them on top.
                  </span>
                </div>

                <div className="overflow-x-auto overflow-y-hidden rounded border border-[#183549]">
                  <div className="grid min-w-[560px] grid-cols-[24px_minmax(220px,1.8fr)_96px_96px_96px] gap-1 border-b border-[#183549] bg-[#091622] px-2 py-2 text-[12px] text-slate-400">
                    <span>☆</span>
                    <span>Symbol</span>
                    <span className="text-right">Last Price</span>
                    <span className="text-right">24H Change</span>
                    <span className="text-right">Volume</span>
                  </div>
                  <div className="max-h-[340px] overflow-y-auto">
                    {marketVM.loading ? (
                      <div className="space-y-1 p-2">
                        {Array.from({ length: 14 }).map((_, i) => (
                          <div
                            key={i}
                            className="h-7 animate-pulse rounded bg-[#102436]"
                          />
                        ))}
                      </div>
                    ) : marketVM.rows.length ? (
                      marketVM.rows.map((row) => {
                        const isSelected = row.id === selectedPairId;
                        const isFav = favorites.includes(row.id);
                        return (
                          <button
                            key={row.id}
                            type="button"
                            onClick={() => selectPair(row)}
                            className={`grid w-full min-w-[560px] grid-cols-[24px_minmax(220px,1.8fr)_96px_96px_96px] gap-1 px-2 py-2 text-[13px] ${
                              isSelected ? 'bg-[#173449]' : 'hover:bg-[#102436]'
                            }`}
                          >
                            <span
                              onClick={(event) => {
                                event.stopPropagation();
                                setFavorites((list) =>
                                  list.includes(row.id)
                                    ? list.filter((item) => item !== row.id)
                                    : [row.id, ...list].slice(0, 250)
                                );
                              }}
                              className={`text-center ${
                                isFav ? 'text-amber-300' : 'text-slate-600'
                              }`}
                              aria-hidden="true"
                            >
                              ★
                            </span>
                            <span className="flex min-w-0 items-center gap-1.5 text-left text-slate-100">
                              <span className="min-w-0 flex-1">
                                <span
                                  className="block truncate font-semibold tracking-[0.02em]"
                                  title={row.displayPair}
                                >
                                  {row.displayPair}
                                </span>
                                {row.pair && row.pair !== row.displayPair ? (
                                  <span
                                    className="block truncate text-[11px] text-slate-500"
                                    title={row.pair}
                                  >
                                    {row.pair}
                                  </span>
                                ) : null}
                              </span>
                              <span className="flex shrink-0 items-center gap-1">
                                {row.lowLiquidity ? (
                                  <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-0 text-[10px] text-amber-300">
                                    Low
                                  </span>
                                ) : null}
                                {!row.hasPool ? (
                                  <span className="rounded border border-rose-500/30 bg-rose-500/10 px-1 py-0 text-[10px] text-rose-300">
                                    No pool
                                  </span>
                                ) : null}
                              </span>
                            </span>
                            <span className="text-right font-mono text-slate-200">
                              {row.last ? row.last.toFixed(4) : 'n/a'}
                            </span>
                            <span
                              className={`text-right font-mono ${changeClass(
                                row.change24h
                              )}`}
                            >
                              {formatChange(row.change24h)}
                            </span>
                            <span className="text-right font-mono text-slate-300">
                              {shortAmount(row.volume24h)}
                            </span>
                          </button>
                        );
                      })
                    ) : (
                      <p className="p-3 text-sm text-slate-400">
                        No market rows. Check chain selection or bootstrap
                        liquidity.
                      </p>
                    )}
                  </div>
                </div>
                {marketVM.error ? (
                  <p className="mt-2 text-xs text-rose-300">{marketVM.error}</p>
                ) : null}
              </section>

              <section
                className={`${
                  mobilePanel === 'chart' ? 'block' : 'hidden'
                } rounded border border-[#173448] bg-[#0a1724] p-2 lg:block`}
              >
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm text-slate-300">
                    {(['1m', '5m', '1h', '1d'] as const).map((frame) => (
                      <button
                        key={frame}
                        type="button"
                        onClick={() => setTimeframe(frame)}
                        className={`rounded px-2 py-1 ${
                          timeframe === frame
                            ? 'bg-[#173449] text-[#75e6da]'
                            : 'text-slate-400'
                        }`}
                      >
                        {frame}
                      </button>
                    ))}
                    <span className="text-slate-500">|</span>
                    <button
                      type="button"
                      onClick={() => {
                        setIndicatorsOpen((value) => !value);
                        setUiNotice('Indicators panel opened.');
                      }}
                      className={`${
                        indicatorsOpen ? 'text-[#79e7dc]' : 'text-slate-300'
                      }`}
                    >
                      Indicators
                    </button>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={resetChartViewport}
                      title="Reset chart zoom + pan"
                      className="h-8 w-8 rounded border border-[#21445b] bg-[#0c1a29] text-sm text-slate-300"
                    >
                      ◌
                    </button>
                    <button
                      type="button"
                      onClick={() => nudgeChartZoom(-1)}
                      title="Zoom out"
                      className="h-8 w-8 rounded border border-[#21445b] bg-[#0c1a29] text-sm text-slate-300"
                    >
                      －
                    </button>
                    <button
                      type="button"
                      onClick={() => nudgeChartZoom(1)}
                      title="Zoom in"
                      className="h-8 w-8 rounded border border-[#21445b] bg-[#0c1a29] text-sm text-slate-300"
                    >
                      ＋
                    </button>
                    <button
                      type="button"
                      onClick={clearDrawingContext}
                      title="Clear drawings for selected pair/timeframe"
                      className="h-8 w-8 rounded border border-[#21445b] bg-[#0c1a29] text-sm text-slate-300"
                    >
                      ⌫
                    </button>
                    <button
                      type="button"
                      onClick={toggleChartFullscreen}
                      title="Toggle chart fullscreen only"
                      className={`h-8 w-8 rounded border bg-[#0c1a29] text-sm ${
                        chartFullscreen
                          ? 'border-[#57d6ca] text-[#79e7dc]'
                          : 'border-[#21445b] text-slate-300'
                      }`}
                    >
                      ⛶
                    </button>
                  </div>
                </div>

                {indicatorsOpen ? (
                  <div className="mb-2 rounded border border-[#1a3c4e] bg-[#0b1a29] p-2 text-xs text-slate-300">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="rounded border border-[#2a5368] bg-[#0f2334] px-2 py-0.5 text-[#7ce8dc]">
                        Candle + volume feed is active
                      </span>
                      <span className="rounded border border-[#2a5368] bg-[#0f2334] px-2 py-0.5 text-slate-300">
                        Exchange-style indicator pack ready
                      </span>
                      <span className="rounded border border-[#2a5368] bg-[#0f2334] px-2 py-0.5 text-slate-300">
                        {[
                          indicatorSma20,
                          indicatorEma50,
                          indicatorEma200,
                          indicatorVwap,
                          indicatorBollinger,
                          indicatorRsi14,
                          indicatorMacd,
                          indicatorAtr,
                          indicatorStoch,
                          indicatorPivot
                        ].filter(Boolean).length}{' '}
                        active
                      </span>
                    </div>
                    <div className="grid gap-1 sm:grid-cols-3 xl:grid-cols-5">
                      <label className="flex cursor-pointer items-center gap-2 rounded border border-[#22465c] px-2 py-1">
                        <input
                          type="checkbox"
                          checked={indicatorSma20}
                          onChange={(event) =>
                            setIndicatorSma20(event.target.checked)
                          }
                        />
                        <span>SMA 20</span>
                      </label>
                      <label className="flex cursor-pointer items-center gap-2 rounded border border-[#22465c] px-2 py-1">
                        <input
                          type="checkbox"
                          checked={indicatorEma50}
                          onChange={(event) =>
                            setIndicatorEma50(event.target.checked)
                          }
                        />
                        <span>EMA 50</span>
                      </label>
                      <label className="flex cursor-pointer items-center gap-2 rounded border border-[#22465c] px-2 py-1">
                        <input
                          type="checkbox"
                          checked={indicatorEma200}
                          onChange={(event) =>
                            setIndicatorEma200(event.target.checked)
                          }
                        />
                        <span>EMA 200</span>
                      </label>
                      <label className="flex cursor-pointer items-center gap-2 rounded border border-[#22465c] px-2 py-1">
                        <input
                          type="checkbox"
                          checked={indicatorVwap}
                          onChange={(event) =>
                            setIndicatorVwap(event.target.checked)
                          }
                        />
                        <span>VWAP</span>
                      </label>
                      <label className="flex cursor-pointer items-center gap-2 rounded border border-[#22465c] px-2 py-1">
                        <input
                          type="checkbox"
                          checked={indicatorBollinger}
                          onChange={(event) =>
                            setIndicatorBollinger(event.target.checked)
                          }
                        />
                        <span>Bollinger 20/2</span>
                      </label>
                      <label className="flex cursor-pointer items-center gap-2 rounded border border-[#22465c] px-2 py-1">
                        <input
                          type="checkbox"
                          checked={indicatorRsi14}
                          onChange={(event) =>
                            setIndicatorRsi14(event.target.checked)
                          }
                        />
                        <span>RSI 14</span>
                      </label>
                      <label className="flex cursor-pointer items-center gap-2 rounded border border-[#22465c] px-2 py-1">
                        <input
                          type="checkbox"
                          checked={indicatorMacd}
                          onChange={(event) =>
                            setIndicatorMacd(event.target.checked)
                          }
                        />
                        <span>MACD (12/26/9)</span>
                      </label>
                      <label className="flex cursor-pointer items-center gap-2 rounded border border-[#22465c] px-2 py-1">
                        <input
                          type="checkbox"
                          checked={indicatorAtr}
                          onChange={(event) =>
                            setIndicatorAtr(event.target.checked)
                          }
                        />
                        <span>ATR 14</span>
                      </label>
                      <label className="flex cursor-pointer items-center gap-2 rounded border border-[#22465c] px-2 py-1">
                        <input
                          type="checkbox"
                          checked={indicatorStoch}
                          onChange={(event) =>
                            setIndicatorStoch(event.target.checked)
                          }
                        />
                        <span>Stochastic 14/3</span>
                      </label>
                      <label className="flex cursor-pointer items-center gap-2 rounded border border-[#22465c] px-2 py-1">
                        <input
                          type="checkbox"
                          checked={indicatorPivot}
                          onChange={(event) =>
                            setIndicatorPivot(event.target.checked)
                          }
                        />
                        <span>Pivot (P/R1/S1)</span>
                      </label>
                    </div>
                  </div>
                ) : null}

                <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                  <span>Zoom: {chartZoom.toFixed(2)}x</span>
                  <span>
                    Pan: {chartPanBars} / {maxPanBars} bars
                  </span>
                  <span>Wheel: zoom</span>
                  <span>Shift + wheel / drag: pan</span>
                  {drawingAnchor ? (
                    <span className="text-amber-300">
                      Line start armed (
                      {DRAWING_TOOL_META[drawingAnchor.tool].label})
                    </span>
                  ) : null}
                </div>

                <div
                  ref={chartViewportRef}
                  className="grid h-[calc(100%-34px)] grid-cols-[34px_minmax(0,1fr)] gap-2"
                >
                  <div className="flex flex-col items-center gap-2 rounded border border-[#183549] bg-[#08131f] py-2 text-xs text-slate-400">
                    {DRAWING_TOOLS.map((tool) => (
                      <button
                        key={tool}
                        type="button"
                        title={DRAWING_TOOL_META[tool].hint}
                        onClick={() => {
                          setActiveDrawingTool(tool);
                          setDrawingAnchor(null);
                          setUiNotice(
                            `Drawing tool active: ${DRAWING_TOOL_META[tool].label}. ${DRAWING_TOOL_META[tool].hint}`
                          );
                        }}
                        className={`h-7 w-7 rounded border bg-[#0b1723] ${
                          activeDrawingTool === tool
                            ? 'border-[#57d6ca] text-[#79e7dc]'
                            : 'border-[#21445b]'
                        }`}
                      >
                        {tool}
                      </button>
                    ))}
                  </div>
                  <div className="overflow-y-auto rounded border border-[#183549] bg-[#08131f]">
                    <OhlcCanvas
                      candles={visibleCandles}
                      pairLabel={selectedPair?.pair || 'pair'}
                      drawings={activeDrawings}
                      onAddDrawing={addDrawingPoint}
                      panBars={chartPanBars}
                      onPanAbsolute={setChartPanAbsolute}
                      onPanNudge={nudgeChartPan}
                      onZoomNudge={nudgeChartZoom}
                      indicatorSma20={indicatorSma20}
                      indicatorEma50={indicatorEma50}
                      indicatorEma200={indicatorEma200}
                      indicatorVwap={indicatorVwap}
                      indicatorBollinger={indicatorBollinger}
                      indicatorPivot={indicatorPivot}
                    />
                    {indicatorRsi14 ? (
                      <RsiPanel candles={visibleCandles} />
                    ) : null}
                    {indicatorMacd ? (
                      <MacdPanel candles={visibleCandles} />
                    ) : null}
                    {indicatorAtr ? (
                      <AtrPanel candles={visibleCandles} />
                    ) : null}
                    {indicatorStoch ? (
                      <StochasticPanel candles={visibleCandles} />
                    ) : null}
                  </div>
                </div>
                {usingSyntheticChart ? (
                  <p className="mt-2 text-xs text-cyan-200">
                    {chartSource === 'synthetic'
                      ? 'No indexed swaps yet for this pair. Showing pool-preview candles; execute a trade (or run the seed bot) to switch to ledger OHLC automatically.'
                      : 'Low trade density detected. Showing hybrid candles (ledger + pool preview) for better chart continuity.'}
                  </p>
                ) : null}
                <p className="mt-1 text-xs text-slate-400">
                  Drawings: {activeDrawings.length} object(s), persisted per
                  pair/timeframe in local storage.
                </p>
                {pairVM.error ? (
                  <p className="mt-2 text-xs text-rose-300">{pairVM.error}</p>
                ) : null}
              </section>

              <section
                className={`${
                  mobilePanel === 'trade' ? 'block' : 'hidden'
                } grid min-h-0 grid-cols-[minmax(0,1fr)_292px] gap-1 lg:grid`}
              >
                <div className="min-h-0 rounded border border-[#173448] bg-[#0a1724] p-2">
                  <div className="mb-2 flex items-center justify-between">
                    <div className="flex gap-1 text-sm">
                      <button
                        type="button"
                        onClick={() => setBookTab('book')}
                        className={`rounded px-2 py-1 ${
                          bookTab === 'book'
                            ? 'bg-[#173449] text-[#75e6da]'
                            : 'text-slate-400'
                        }`}
                      >
                        Order Book
                      </button>
                      <button
                        type="button"
                        onClick={() => setBookTab('trades')}
                        className={`rounded px-2 py-1 ${
                          bookTab === 'trades'
                            ? 'bg-[#173449] text-[#75e6da]'
                            : 'text-slate-400'
                        }`}
                      >
                        Trades
                      </button>
                    </div>
                    <div className="text-sm text-slate-500">
                      {selectedPair?.baseDisplaySymbol || '--'}
                    </div>
                  </div>

                  {bookTab === 'book' ? (
                    <div className="text-sm">
                      <div className="mb-1 flex items-center justify-between text-slate-500">
                        <span>0.001</span>
                        <span>{selectedPair?.baseDisplaySymbol || ''}</span>
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-slate-500">
                        <span>
                          Price ({selectedPair?.quoteDisplaySymbol || 'mUSD'})
                        </span>
                        <span className="text-right">
                          Size ({selectedPair?.baseDisplaySymbol || '--'})
                        </span>
                        <span className="text-right">
                          Total ({selectedPair?.quoteDisplaySymbol || 'mUSD'})
                        </span>
                      </div>

                      <div className="mt-1 max-h-56 space-y-0.5 overflow-y-auto">
                        {orderbookVM.asks.map((level, idx) => {
                          const depth = Math.min(
                            100,
                            (safe(level.total) / askMax) * 100
                          );
                          return (
                            <div
                              key={`ask-${idx}`}
                              className="relative grid grid-cols-3 gap-2 overflow-hidden py-0.5 text-rose-300"
                            >
                              <div
                                className="absolute inset-y-0 right-0 bg-rose-500/10"
                                style={{ width: `${depth}%` }}
                              />
                              <span className="relative">
                                {level.price.toFixed(3)}
                              </span>
                              <span className="relative text-right">
                                {shortAmount(level.size)}
                              </span>
                              <span className="relative text-right">
                                {shortAmount(level.total)}
                              </span>
                            </div>
                          );
                        })}
                      </div>

                      <div className="my-1 rounded bg-[#111f2d] px-2 py-1 text-center text-sm text-slate-300">
                        Spread {shortAmount(orderbookVM.spread)}
                      </div>

                      <div className="max-h-56 space-y-0.5 overflow-y-auto">
                        {orderbookVM.bids.map((level, idx) => {
                          const depth = Math.min(
                            100,
                            (safe(level.total) / bidMax) * 100
                          );
                          return (
                            <div
                              key={`bid-${idx}`}
                              className="relative grid grid-cols-3 gap-2 overflow-hidden py-0.5 text-emerald-300"
                            >
                              <div
                                className="absolute inset-y-0 right-0 bg-emerald-500/10"
                                style={{ width: `${depth}%` }}
                              />
                              <span className="relative">
                                {level.price.toFixed(3)}
                              </span>
                              <span className="relative text-right">
                                {shortAmount(level.size)}
                              </span>
                              <span className="relative text-right">
                                {shortAmount(level.total)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <div className="max-h-[490px] space-y-1 overflow-y-auto text-sm">
                      {tradesVM.trades.slice(0, 120).map((trade) => (
                        <div
                          key={`${trade.txHash}-${trade.at}`}
                          className="grid grid-cols-[56px_1fr_80px] rounded bg-[#111f2d] px-2 py-1"
                        >
                          <span
                            className={
                              trade.side === 'buy'
                                ? 'text-emerald-300'
                                : 'text-rose-300'
                            }
                          >
                            {trade.side}
                          </span>
                          <span className="font-mono text-slate-200">
                            {trade.price.toFixed(6)}
                          </span>
                          <span className="text-right text-slate-400">
                            {new Date(trade.at).toLocaleTimeString()}
                          </span>
                        </div>
                      ))}
                      {!tradesVM.trades.length ? (
                        <p className="py-3 text-center text-slate-400">
                          No trades yet.
                        </p>
                      ) : null}
                    </div>
                  )}
                </div>

                <div className="min-h-0 overflow-y-auto rounded border border-[#173448] bg-[#0a1724] p-2 pb-5">
                  <div className="mb-2 flex items-center justify-between text-sm">
                    <div className="flex gap-1">
                      {(['market', 'limit'] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => entryVM.setEntryMode(mode)}
                          className={`rounded px-2 py-1 uppercase ${
                            entryVM.entryMode === mode
                              ? 'bg-[#173449] text-[#75e6da]'
                              : 'text-slate-400'
                          }`}
                        >
                          {mode}
                        </button>
                      ))}
                    </div>
                    <span className="text-[11px] text-slate-500">
                      {entryVM.entryMode === 'market'
                        ? 'Wallet-signed spot swap'
                        : 'Limit draft queue (non-custodial)'}
                    </span>
                  </div>

                  <div className="mb-2 grid grid-cols-2 gap-1 rounded border border-[#21445b] bg-[#0c1a29] p-1 text-sm">
                    <button
                      type="button"
                      onClick={() => entryVM.setSide('buy')}
                      className={`rounded px-2 py-1.5 font-semibold ${
                        entryVM.side === 'buy'
                          ? 'bg-[#58d4c8] text-[#052326]'
                          : 'text-slate-300'
                      }`}
                    >
                      Buy
                    </button>
                    <button
                      type="button"
                      onClick={() => entryVM.setSide('sell')}
                      className={`rounded px-2 py-1.5 font-semibold ${
                        entryVM.side === 'sell'
                          ? 'bg-[#7b2935] text-rose-100'
                          : 'text-slate-300'
                      }`}
                    >
                      Sell
                    </button>
                  </div>

                  <div className="space-y-2 text-sm">
                    <p className="text-slate-400">
                      Available to Trade{' '}
                      <span className="float-right text-slate-200">
                        {shortAmount(entryVM.availableBalance)}{' '}
                        {entryVM.tokenInSymbol}
                      </span>
                    </p>

                    {entryVM.side === 'buy' ? (
                      <label className="space-y-1">
                        <span className="text-slate-500">Pay With</span>
                        <select
                          value={entryVM.buyFundingSymbol}
                          onChange={(event) =>
                            entryVM.setBuyFundingSymbol(event.target.value)
                          }
                          className="h-9 w-full rounded border border-[#21445b] bg-[#0c1a29] px-2 text-slate-100"
                        >
                          {entryVM.buyFundingOptions.map((symbol) => (
                            <option key={`fund-${symbol}`} value={symbol}>
                              {symbol}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <p className="text-xs text-slate-400">
                        Sell {entryVM.tokenInSymbol} into {entryVM.quoteSymbol}{' '}
                        (venue quote).
                      </p>
                    )}

                    <label className="space-y-1">
                      <span className="text-slate-500">Size</span>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={entryVM.amount}
                        onChange={(event) =>
                          entryVM.setAmount(event.target.value)
                        }
                        className="h-9 w-full rounded border border-[#21445b] bg-[#0c1a29] px-2 text-slate-100"
                      />
                    </label>

                    {entryVM.entryMode === 'limit' ? (
                      <label className="space-y-1">
                        <span className="text-slate-500">
                          Limit Price (
                          {selectedPair?.quoteDisplaySymbol || 'mUSD'})
                        </span>
                        <input
                          type="number"
                          min="0"
                          step="any"
                          value={entryVM.limitPrice}
                          onChange={(event) =>
                            entryVM.setLimitPrice(event.target.value)
                          }
                          className="h-9 w-full rounded border border-[#21445b] bg-[#0c1a29] px-2 text-slate-100"
                        />
                      </label>
                    ) : null}

                    <div className="space-y-1">
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={sizePct}
                        onChange={(event) =>
                          setSizePct(Number(event.target.value))
                        }
                        className="w-full accent-[#58d4c8]"
                      />
                      <p className="text-right text-slate-400">{sizePct}%</p>
                    </div>

                    <label className="flex items-center gap-2 text-sm text-cyan-100">
                      <input
                        type="checkbox"
                        checked={entryVM.autoWrapNative}
                        onChange={(event) =>
                          entryVM.setAutoWrapNative(event.target.checked)
                        }
                      />
                      Auto-wrap native to {entryVM.wrappedNativeSymbol}
                    </label>

                    <label className="space-y-1">
                      <span className="text-slate-500">Slippage (bps)</span>
                      <input
                        type="number"
                        min={1}
                        max={3000}
                        value={entryVM.slippageBps}
                        onChange={(event) =>
                          entryVM.setSlippageBps(Number(event.target.value))
                        }
                        className="h-9 w-full rounded border border-[#21445b] bg-[#0c1a29] px-2 text-slate-100"
                      />
                    </label>

                    <button
                      type="button"
                      onClick={executePrimary}
                      disabled={entryVM.executing || entryVM.quoteLoading}
                      className="h-11 w-full rounded border border-[#5ee2d5] bg-[#58d4c8] text-sm font-semibold text-[#052326] disabled:opacity-60"
                    >
                      {entryVM.executing
                        ? 'Executing...'
                        : entryVM.quoteLoading
                        ? 'Refreshing Quote...'
                        : !entryVM.isConnected
                        ? 'Enable Trading'
                        : entryVM.entryMode === 'limit'
                        ? 'Save Limit Order'
                        : entryVM.entryMode === 'market' &&
                          (!entryVM.quote ||
                            entryVM.staleQuote ||
                            !entryVM.routeLocked)
                        ? 'Get Fresh Quote'
                        : 'Execute Trade'}
                    </button>
                    <p
                      className={`text-xs ${
                        entryVM.executeDisabledReason
                          ? 'text-amber-300'
                          : 'text-emerald-300'
                      }`}
                    >
                      {entryVM.executeDisabledReason ||
                        'Execution ready: route lock active and quote fresh.'}
                    </p>
                    <p
                      className={`text-[11px] ${
                        entryVM.approvalMode === 'unlimited'
                          ? 'text-amber-300'
                          : 'text-slate-400'
                      }`}
                    >
                      {entryVM.approvalRiskWarning}
                    </p>
                    {entryVM.bridgePolicy.warnings.length ? (
                      <p className="text-[11px] text-cyan-200">
                        Bridge policy:{' '}
                        {entryVM.bridgePolicy.warnings.join(' • ')}
                      </p>
                    ) : null}

                    <div className="rounded border border-[#21445b] bg-[#0c1a29] px-2 py-1.5 text-sm text-slate-300">
                      <p className="flex justify-between">
                        <span>Order Value</span>
                        <span>
                          {entryVM.tradeNotionalMusd > 0
                            ? `${shortAmount(entryVM.tradeNotionalMusd)} mUSD`
                            : 'N/A'}
                        </span>
                      </p>
                      <p className="mt-0.5 flex justify-between">
                        <span>Slippage</span>
                        <span>
                          Est: 0% / Max:{' '}
                          {(entryVM.slippageBps / 100).toFixed(2)}%
                        </span>
                      </p>
                      <p className="mt-0.5 flex justify-between">
                        <span>Fees</span>
                        <span>
                          {(
                            ((entryVM.quote?.total_fee_bps ?? 30) / 10000) *
                            100
                          ).toFixed(4)}
                          % /{' '}
                          {(
                            ((entryVM.quote?.protocol_fee_bps ?? 5) / 10000) *
                            100
                          ).toFixed(4)}
                          %
                        </span>
                      </p>
                      <p className="mt-0.5 flex justify-between">
                        <span>Depth / Cap</span>
                        <span>
                          {shortAmount(entryVM.tradeDepthMusd)} /{' '}
                          {shortAmount(entryVM.tradeSizeCapMusd || 0)} mUSD
                        </span>
                      </p>
                    </div>

                    <Link
                      href="/harmony?intent=deposit"
                      className="flex h-10 w-full items-center justify-center rounded border border-[#5ee2d5] bg-[#58d4c8] text-sm font-semibold text-[#052326]"
                    >
                      Deposit
                    </Link>
                    <Link
                      href="/harmony?intent=withdraw"
                      className="flex h-8 items-center justify-center rounded border border-[#21445b] bg-[#0c1a29] text-xs text-slate-200"
                    >
                      Withdraw
                    </Link>

                    <div className="rounded border border-[#21445b] bg-[#0c1a29] px-2 py-1.5 text-sm text-slate-300">
                      <p className="font-semibold text-slate-200">
                        Account Equity
                      </p>
                      <p className="mt-1 flex justify-between">
                        <span>Spot</span>
                        <span>$0.00</span>
                      </p>
                    </div>

                    {entryVM.quote ? (
                      <div className="rounded border border-[#21445b] bg-[#0c1a29] px-2 py-1 text-sm text-slate-300">
                        <p className="text-cyan-200">{entryVM.quote.note}</p>
                        <p>Route: {entryVM.quote.route.join(' -> ')}</p>
                        <p>
                          Expected: {entryVM.quote.expected_out}{' '}
                          {entryVM.quote.token_out}
                        </p>
                        <p>
                          Minimum: {entryVM.quote.min_out}{' '}
                          {entryVM.quote.token_out}
                        </p>
                        <p
                          className={
                            entryVM.routeLocked
                              ? 'text-emerald-300'
                              : 'text-amber-300'
                          }
                        >
                          Route lock:{' '}
                          {entryVM.routeLocked ? 'active' : 'refresh required'}
                        </p>
                        <p
                          className={
                            entryVM.staleQuote
                              ? 'text-amber-300'
                              : 'text-slate-400'
                          }
                        >
                          Quote age:{' '}
                          {Math.max(0, Math.round(entryVM.quoteAgeMs / 1000))}s
                          / {Math.round(entryVM.quoteTtlMs / 1000)}s TTL
                        </p>
                        <p className="text-slate-400">
                          Quote sanity:{' '}
                          {entryVM.quoteReferencePrice > 0 &&
                          entryVM.quoteImpliedPrice > 0
                            ? `${shortAmount(
                                entryVM.quoteImpliedPrice
                              )} vs ref ${shortAmount(
                                entryVM.quoteReferencePrice
                              )} (${shortAmount(
                                entryVM.quoteSanityDeviationBps
                              )} bps / max ${shortAmount(
                                entryVM.quoteSanityThresholdBps
                              )})`
                            : 'waiting for valid price context'}
                        </p>
                        {entryVM.routeLockReason ? (
                          <p className="text-amber-300">
                            {entryVM.routeLockReason}
                          </p>
                        ) : null}
                        {entryVM.quoteSanityFailed ? (
                          <p className="text-rose-300">
                            Quote sanity guard: execution blocked.
                          </p>
                        ) : null}
                        {entryVM.protocolPaused ? (
                          <p className="text-rose-300">
                            Emergency pause active: execution disabled.
                          </p>
                        ) : null}
                      </div>
                    ) : null}

                    <div className="rounded border border-[#21445b] bg-[#0c1a29] px-2 py-1 text-xs text-slate-300">
                      <p className="font-semibold text-cyan-200">
                        Proof & Transparency
                      </p>
                      <p className="mt-1 flex justify-between">
                        <span>mUSD circulating</span>
                        <span>{shortAmount(entryVM.admin.chainSupplyMusd)} mUSD</span>
                      </p>
                      <p className="flex justify-between">
                        <span>24h minted</span>
                        <span>
                          {shortAmount(entryVM.admin.dailyMintedMusd)} /{' '}
                          {shortAmount(entryVM.admin.dailyCapMusd)} mUSD
                        </span>
                      </p>
                      <p className="flex justify-between">
                        <span>Pair reserve depth</span>
                        <span>{shortAmount(entryVM.tradeDepthMusd)} mUSD</span>
                      </p>
                      <p className="flex justify-between">
                        <span>Chain reserve depth</span>
                        <span>{shortAmount(entryVM.chainReserveExposureMusd)} mUSD</span>
                      </p>
                      <p className="flex justify-between">
                        <span>Depth floor</span>
                        <span>{shortAmount(entryVM.executionDepthFloorMusd)} mUSD</span>
                      </p>
                    </div>

                    {entryVM.error ? (
                      <p className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-xs text-rose-300">
                        {entryVM.error}
                      </p>
                    ) : null}
                    {entryVM.status ? (
                      <p className="rounded border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 text-xs text-cyan-200">
                        {entryVM.status}
                      </p>
                    ) : null}

                    {entryVM.admin.enabled && entryVM.admin.canAccess ? (
                      <div className="rounded border border-[#4b2f63] bg-[#20192d] px-2 py-2 text-xs text-slate-200">
                        <p className="font-semibold text-[#c9b8ff]">
                          Admin Mint (allowlist)
                        </p>
                        <p className="mt-1 text-slate-300">
                          Minter role:{' '}
                          {entryVM.admin.loading
                            ? 'checking...'
                            : entryVM.admin.isMinter
                            ? 'active'
                            : 'missing'}
                        </p>
                        <p className="mt-1 text-slate-300">
                          Governance:{' '}
                          {entryVM.admin.governanceReady
                            ? 'verified'
                            : entryVM.admin.governanceRequired
                            ? 'required / missing'
                            : 'optional'}
                        </p>
                        <p className="mt-1 text-slate-300">
                          Owner: {entryVM.admin.governanceOwner || '--'}
                        </p>
                        <p className="mt-1 text-slate-300">
                          Timelock:{' '}
                          {entryVM.admin.timelockAddress
                            ? `${entryVM.admin.timelockAddress} (${entryVM.admin.timelockDelayOk ? 'delay ok' : 'delay low'})`
                            : 'missing'}
                        </p>
                        <p className="mt-1 text-slate-300">
                          Timelock delay:{' '}
                          {entryVM.admin.timelockMinDelaySec !== null
                            ? `${shortAmount(entryVM.admin.timelockMinDelaySec)}s / req ${shortAmount(
                                entryVM.admin.timelockMinDelayRequiredSec
                              )}s`
                            : '--'}
                        </p>
                        <p className="mt-1 text-slate-300">
                          Multisig proposer:{' '}
                          {entryVM.admin.multisigAddress
                            ? entryVM.admin.multisigProposerOk
                              ? 'ok'
                              : 'missing role'
                            : 'missing'}
                        </p>
                        <p className="mt-1 text-slate-300">
                          24h Mint:{' '}
                          {shortAmount(entryVM.admin.dailyMintedMusd)} /{' '}
                          {shortAmount(entryVM.admin.dailyCapMusd)} mUSD
                        </p>
                        <p className="mt-1 text-slate-300">
                          Chain Supply:{' '}
                          {shortAmount(entryVM.admin.chainSupplyMusd)} /{' '}
                          {shortAmount(entryVM.admin.chainCapMusd)} mUSD
                        </p>
                        {entryVM.admin.governanceNotice ? (
                          <p className="mt-1 text-[11px] text-cyan-200">
                            {entryVM.admin.governanceNotice}
                          </p>
                        ) : null}
                        {entryVM.admin.policyBlockedReason ? (
                          <p className="mt-1 text-[11px] text-amber-300">
                            {entryVM.admin.policyBlockedReason}
                          </p>
                        ) : null}
                        <label className="mt-2 block space-y-1">
                          <span className="text-slate-400">Recipient</span>
                          <input
                            type="text"
                            value={entryVM.admin.mintRecipient}
                            onChange={(event) =>
                              entryVM.admin.setMintRecipient(event.target.value)
                            }
                            placeholder="0x..."
                            className="h-8 w-full rounded border border-[#5f3a7e] bg-[#140f1f] px-2 text-xs text-slate-100"
                          />
                        </label>
                        <label className="mt-2 block space-y-1">
                          <span className="text-slate-400">Amount (mUSD)</span>
                          <input
                            type="number"
                            min="0"
                            step="any"
                            value={entryVM.admin.mintAmount}
                            onChange={(event) =>
                              entryVM.admin.setMintAmount(event.target.value)
                            }
                            className="h-8 w-full rounded border border-[#5f3a7e] bg-[#140f1f] px-2 text-xs text-slate-100"
                          />
                        </label>
                        <button
                          type="button"
                          disabled={
                            entryVM.admin.minting ||
                            !entryVM.admin.isMinter ||
                            Boolean(entryVM.admin.policyBlockedReason)
                          }
                          onClick={entryVM.admin.executeMint}
                          className="mt-2 h-9 w-full rounded border border-[#8c66d6] bg-[#6e4bb8] text-xs font-semibold text-white disabled:opacity-60"
                        >
                          {entryVM.admin.minting ? 'Minting...' : 'Mint mUSD'}
                        </button>
                        {entryVM.admin.mintStatus ? (
                          <p className="mt-1 text-[#9be7df]">
                            {entryVM.admin.mintStatus}
                          </p>
                        ) : null}
                        {entryVM.admin.mintError ? (
                          <p className="mt-1 text-rose-300">
                            {entryVM.admin.mintError}
                          </p>
                        ) : null}
                        {entryVM.admin.mintEvents.length ? (
                          <div className="mt-2 max-h-24 space-y-1 overflow-auto rounded border border-[#5f3a7e] bg-[#140f1f] p-1">
                            {entryVM.admin.mintEvents
                              .slice(0, 6)
                              .map((event) => (
                                <div
                                  key={`${
                                    event.txHash
                                  }-${event.blockNumber.toString()}`}
                                  className="text-[10px] text-slate-300"
                                >
                                  <p className="truncate">
                                    to {event.recipient}
                                  </p>
                                  <p>{shortAmount(event.amount)} mUSD</p>
                                </div>
                              ))}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              </section>
            </div>

            <section
              className={`${
                mobilePanel === 'account' ? 'block' : 'hidden'
              } mt-1 rounded border border-[#173448] bg-[#0a1724] p-2 lg:block`}
            >
              <div className="mb-2 flex flex-wrap items-center gap-1">
                {(
                  [
                    ['balances', 'Balances'],
                    ['trade-history', 'Trade History']
                  ] as const
                ).map(([tab, label]) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setAccountTab(tab)}
                    className={`rounded px-2 py-1 text-xs ${
                      accountTab === tab
                        ? 'bg-[#173449] text-[#75e6da]'
                        : 'text-slate-400'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="grid items-start gap-1 xl:grid-cols-[minmax(0,1fr)_minmax(340px,460px)]">
                <div className="self-start rounded border border-[#183549] bg-[#08131f] p-2">
                  {accountTab === 'balances' ? (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[680px] text-sm">
                        <thead>
                          <tr className="text-left text-slate-500">
                            <th className="px-2 py-1">Coin</th>
                            <th className="px-2 py-1 text-right">
                              Total Balance
                            </th>
                            <th className="px-2 py-1 text-right">
                              Available Balance
                            </th>
                            <th className="px-2 py-1 text-right">USD Value</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr className="border-t border-[#183549] text-slate-200">
                            <td className="px-2 py-1.5">
                              Native {chainId === 97 ? 'tBNB' : 'gas token'}
                            </td>
                            <td className="px-2 py-1.5 text-right font-mono">
                              {shortAmount(entryVM.nativeBalance)}
                            </td>
                            <td className="px-2 py-1.5 text-right font-mono">
                              {shortAmount(entryVM.nativeBalance)}
                            </td>
                            <td className="px-2 py-1.5 text-right text-slate-500">
                              n/a
                            </td>
                          </tr>
                          {marketVM.chainTokens.map((token) => (
                            <tr
                              key={`bal-${token.address}-${token.symbol}`}
                              className="border-t border-[#183549] text-slate-200"
                            >
                              <td className="px-2 py-1.5">{token.symbol}</td>
                              <td className="px-2 py-1.5 text-right font-mono">
                                {shortAmount(
                                  entryVM.walletBalances[token.symbol] || '0'
                                )}
                              </td>
                              <td className="px-2 py-1.5 text-right font-mono">
                                {shortAmount(
                                  entryVM.walletBalances[token.symbol] || '0'
                                )}
                              </td>
                              <td className="px-2 py-1.5 text-right text-slate-500">
                                n/a
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[760px] text-sm">
                        <thead>
                          <tr className="text-left text-slate-500">
                            <th className="px-2 py-1">Time</th>
                            <th className="px-2 py-1">Side</th>
                            <th className="px-2 py-1">Pair</th>
                            <th className="px-2 py-1 text-right">Price</th>
                            <th className="px-2 py-1 text-right">Size</th>
                            <th className="px-2 py-1 text-right">Total</th>
                            <th className="px-2 py-1 text-right">Tx</th>
                          </tr>
                        </thead>
                        <tbody>
                          {tradesVM.trades.slice(0, 150).map((trade) => (
                            <tr
                              key={`hist-${trade.txHash}-${trade.at}`}
                              className="border-t border-[#183549] text-slate-200"
                            >
                              <td className="px-2 py-1.5">
                                {new Date(trade.at).toLocaleString()}
                              </td>
                              <td
                                className={`px-2 py-1.5 ${
                                  trade.side === 'buy'
                                    ? 'text-emerald-300'
                                    : 'text-rose-300'
                                }`}
                              >
                                {trade.side.toUpperCase()}
                              </td>
                              <td className="px-2 py-1.5 font-mono">
                                {trade.baseToken}/mUSD
                              </td>
                              <td className="px-2 py-1.5 text-right font-mono">
                                {trade.price.toFixed(6)}
                              </td>
                              <td className="px-2 py-1.5 text-right font-mono">
                                {shortAmount(trade.baseAmount)}
                              </td>
                              <td className="px-2 py-1.5 text-right font-mono">
                                {shortAmount(trade.quoteAmount)}
                              </td>
                              <td className="px-2 py-1.5 text-right font-mono text-slate-400">
                                {trade.txHash.slice(0, 10)}...
                              </td>
                            </tr>
                          ))}
                          {!tradesVM.trades.length ? (
                            <tr>
                              <td
                                colSpan={7}
                                className="px-2 py-4 text-center text-slate-500"
                              >
                                No trades yet.
                              </td>
                            </tr>
                          ) : null}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <div className="rounded border border-[#183549] bg-[#08131f] p-2">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold tracking-[0.01em] text-slate-200">
                      Recent Activity
                    </p>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => nudgeRecentActivityHeight(-40)}
                        title="Shrink panel"
                        className="h-7 w-7 rounded border border-[#21445b] bg-[#0c1a29] text-xs text-slate-300 hover:border-[#57d6ca]"
                      >
                        －
                      </button>
                      <button
                        type="button"
                        onClick={() => nudgeRecentActivityHeight(40)}
                        title="Expand panel"
                        className="h-7 w-7 rounded border border-[#21445b] bg-[#0c1a29] text-xs text-slate-300 hover:border-[#57d6ca]"
                      >
                        ＋
                      </button>
                    </div>
                  </div>

                  <div
                    className="relative rounded border border-[#1a3548] bg-[#071424]"
                    style={{
                      height: `${recentActivityHeight}px`,
                      minHeight: `${RECENT_ACTIVITY_MIN_HEIGHT}px`
                    }}
                  >
                    <div className="h-full space-y-1 overflow-y-auto p-1.5">
                      {tradesVM.trades.slice(0, 60).map((trade) => (
                        <div
                          key={`${trade.txHash}-${trade.at}`}
                          className="rounded border border-[#173042] bg-[#0f2233] px-2 py-1.5 text-xs transition hover:border-[#2a5d79]"
                        >
                          <p
                            className={
                              trade.side === 'buy'
                                ? 'text-emerald-300'
                                : 'text-rose-300'
                            }
                          >
                            {trade.side.toUpperCase()}{' '}
                            {shortAmount(trade.baseAmount)} {trade.baseToken}
                          </p>
                          <p className="text-xs text-slate-400">
                            {new Date(trade.at).toLocaleString()}
                          </p>
                        </div>
                      ))}
                      {!tradesVM.trades.length ? (
                        <p className="px-2 py-3 text-xs text-slate-500">
                          No activity yet.
                        </p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onMouseDown={startRecentActivityResize}
                      title="Drag to resize panel height"
                      className="absolute bottom-0 left-0 right-0 h-3 cursor-row-resize border-t border-[#21445b] bg-gradient-to-b from-transparent to-[#143046]/70"
                      aria-label="Resize recent activity panel"
                    >
                      <span className="pointer-events-none block text-center text-[10px] tracking-[0.2em] text-slate-500">
                        ⋯
                      </span>
                    </button>
                  </div>
                  <p className="mt-1 text-[11px] text-slate-500">
                    Height: {Math.round(recentActivityHeight)}px. Drag bottom
                    handle to expand downward.
                  </p>
                </div>
              </div>

              <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                <div className="flex items-center gap-2 rounded border border-[#204257] bg-[#0c1a29] px-2 py-1 text-[#71e4d9]">
                  <span className="h-2 w-2 rounded-full bg-[#59d8cc]" />
                  Online
                </div>
                <p>Shortcuts: / search, ↑↓ pair, Enter trade</p>
              </div>
            </section>
          </>
        ) : (
          <section className="grid h-[calc(100vh-214px)] gap-2 rounded border border-[#173448] bg-[#0a1724] p-3 lg:grid-cols-[1.45fr_1fr]">
            <div className="space-y-2">
              <div className="rounded border border-[#183549] bg-[#08131f] p-3">
                <p className="text-lg font-semibold text-[#79e7dc]">
                  Referrals Hub
                </p>
                <p className="text-sm text-slate-300">
                  Invite tracking, MODX reward estimation, and community growth
                  controls.
                </p>
                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  <div className="rounded border border-[#21445b] bg-[#0d1a28] p-2">
                    <p className="text-xs text-slate-500">Your Code</p>
                    <p className="font-mono text-xs text-slate-100">
                      {myReferralCode || 'Connect wallet'}
                    </p>
                  </div>
                  <div className="rounded border border-[#21445b] bg-[#0d1a28] p-2">
                    <p className="text-xs text-slate-500">Referred By</p>
                    <p className="font-mono text-xs text-slate-100">
                      {referredBy
                        ? shortAddress(referredBy)
                        : 'None yet (open with ?ref=0x...)'}
                    </p>
                  </div>
                  <div className="rounded border border-[#21445b] bg-[#0d1a28] p-2">
                    <p className="text-xs text-slate-500">Reward Rule</p>
                    <p className="font-mono text-xs text-slate-100">
                      {(REFERRAL_REWARD_BPS / 100).toFixed(2)}% in MODX
                      (estimate)
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded border border-[#183549] bg-[#08131f] p-3">
                <p className="mb-2 text-sm font-semibold text-slate-200">
                  Invite Link
                </p>
                <div className="flex gap-2">
                  <input
                    readOnly
                    value={referralInviteLink || ''}
                    placeholder="Connect wallet to generate invite link"
                    className="h-10 flex-1 rounded border border-[#21445b] bg-[#0c1a29] px-3 text-xs text-slate-100"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      const ok = await copyText(referralInviteLink);
                      setUiNotice(
                        ok
                          ? 'Referral invite link copied.'
                          : 'Clipboard unavailable.'
                      );
                    }}
                    className="h-10 rounded border border-[#57d6ca] bg-[#123345] px-3 text-xs font-semibold text-[#79e7dc]"
                    disabled={!referralInviteLink}
                  >
                    Copy
                  </button>
                </div>
                <p className="mt-2 text-xs text-slate-400">
                  Share this link. When invited users execute wallet-signed
                  swaps, MODX reward estimate is tracked in this panel.
                </p>
              </div>

              <div className="grid gap-2 sm:grid-cols-3">
                <div className="rounded border border-[#183549] bg-[#08131f] p-3">
                  <p className="text-xs text-slate-500">Invitees</p>
                  <p className="font-mono text-xl text-slate-100">
                    {myReferralStat.invitees.length}
                  </p>
                </div>
                <div className="rounded border border-[#183549] bg-[#08131f] p-3">
                  <p className="text-xs text-slate-500">Tracked Trades</p>
                  <p className="font-mono text-xl text-slate-100">
                    {myReferralStat.trades}
                  </p>
                </div>
                <div className="rounded border border-[#183549] bg-[#08131f] p-3">
                  <p className="text-xs text-slate-500">Reward (MODX)</p>
                  <p className="font-mono text-xl text-[#79e7dc]">
                    {shortAmount(myReferralStat.rewardModx)}
                  </p>
                </div>
              </div>

              <div className="rounded border border-[#183549] bg-[#08131f] p-3">
                <p className="mb-2 text-sm font-semibold text-slate-200">
                  Invitees
                </p>
                <div className="max-h-[320px] overflow-auto rounded border border-[#183549]">
                  <table className="w-full text-xs">
                    <thead className="bg-[#091622] text-slate-500">
                      <tr>
                        <th className="px-2 py-1 text-left">Wallet</th>
                        <th className="px-2 py-1 text-right">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {myReferralStat.invitees.map((wallet) => (
                        <tr
                          key={`invitee-${wallet}`}
                          className="border-t border-[#183549] text-slate-200"
                        >
                          <td className="px-2 py-1.5 font-mono">{wallet}</td>
                          <td className="px-2 py-1.5 text-right text-[#79e7dc]">
                            tracked
                          </td>
                        </tr>
                      ))}
                      {!myReferralStat.invitees.length ? (
                        <tr>
                          <td
                            colSpan={2}
                            className="px-2 py-4 text-center text-slate-500"
                          >
                            No invite activity yet.
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <div className="rounded border border-[#183549] bg-[#08131f] p-3">
                <p className="mb-2 text-sm font-semibold text-slate-200">
                  MODX Integration
                </p>
                <div className="space-y-2 text-xs">
                  <div className="rounded border border-[#21445b] bg-[#0c1a29] p-2">
                    <p className="text-slate-500">Token</p>
                    <p className="font-mono text-slate-100">
                      {MODX_TOKEN_ADDRESS}
                    </p>
                  </div>
                  <div className="rounded border border-[#21445b] bg-[#0c1a29] p-2">
                    <p className="text-slate-500">Staking</p>
                    <p className="font-mono text-slate-100">
                      {MODX_STAKING_ADDRESS}
                    </p>
                  </div>
                </div>
                <div className="mt-2 grid gap-2">
                  <a
                    href={`https://testnet.bscscan.com/address/${MODX_TOKEN_ADDRESS}`}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded border border-[#21445b] bg-[#0c1a29] px-3 py-2 text-center text-xs text-slate-200"
                  >
                    MODX Token Explorer
                  </a>
                  <a
                    href={`https://testnet.bscscan.com/address/${MODX_STAKING_ADDRESS}`}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded border border-[#21445b] bg-[#0c1a29] px-3 py-2 text-center text-xs text-slate-200"
                  >
                    MODX Staking Explorer
                  </a>
                </div>
              </div>

              <div className="rounded border border-[#183549] bg-[#08131f] p-3">
                <p className="mb-2 text-sm font-semibold text-slate-200">
                  Actions
                </p>
                <div className="grid gap-2">
                  <Link
                    href="/pro?desk=trade"
                    className="rounded border border-[#57d6ca] bg-[#123345] px-3 py-2 text-center text-sm font-semibold text-[#79e7dc]"
                  >
                    Back To Trade
                  </Link>
                  <Link
                    href={`/harmony?chain_id=${chainId}&token_in=MODX&token_out=mUSD`}
                    className="rounded border border-[#21445b] bg-[#0c1a29] px-3 py-2 text-center text-sm text-slate-200"
                  >
                    Open MODX ↔ mUSD Swap
                  </Link>
                  <button
                    type="button"
                    onClick={() =>
                      setUiNotice(
                        'MODX reward claim contract call will be wired to staking movement in the next phase.'
                      )
                    }
                    className="rounded border border-[#21445b] bg-[#0c1a29] px-3 py-2 text-sm text-slate-200"
                  >
                    Claim MODX (Preview)
                  </button>
                </div>
                {chainId !== 97 ? (
                  <p className="mt-2 text-xs text-amber-300">
                    MODX addresses are configured for BNB Chain Testnet (97).
                    Switch chain to execute MODX routes.
                  </p>
                ) : null}
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
