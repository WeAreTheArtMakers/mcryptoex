'use client';

import { useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi';
import {
  DEFAULT_CHAIN_ID,
  MarketRow,
  OhlcCandle,
  Timeframe,
  shortAmount,
  useMarketListVM,
  useOrderEntryVM,
  useOrderbookVM,
  usePairVM,
  useTradesVM
} from './use-pro-vm';

type MarketFilter = 'all' | 'favorites' | 'spot';
type MobilePanel = 'markets' | 'chart' | 'trade' | 'account';
type BookTab = 'book' | 'trades';
type AccountTab = 'balances' | 'positions' | 'orders' | 'history';

type PersistedLayout = {
  chainId: number;
  searchQuery: string;
  filter: MarketFilter;
  timeframe: Timeframe;
  bookTab: BookTab;
  mobilePanel: MobilePanel;
  favorites: string[];
  selectedPairByChain: Record<string, string>;
};

const LAYOUT_STORAGE_KEY = 'mcryptoex.pro.layout.v2';

function shortAddress(value?: string) {
  if (!value) return 'Not connected';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function pctClass(value: number | null) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'text-slate-300';
  return value >= 0 ? 'text-emerald-300' : 'text-rose-300';
}

function formatChange(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function numOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function OhlcViewport({ candles, pairLabel }: { candles: OhlcCandle[]; pairLabel: string }) {
  const width = 1180;
  const height = 440;
  const left = 52;
  const right = 16;
  const priceTop = 14;
  const priceBottom = 314;
  const volumeTop = 332;
  const volumeBottom = 420;

  if (!candles.length) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-400">
        Waiting for on-chain trades to build OHLC candles for {pairLabel}.
      </div>
    );
  }

  const highMax = Math.max(...candles.map((candle) => numOrZero(candle.high)));
  const lowMin = Math.min(...candles.map((candle) => numOrZero(candle.low)));
  const priceSpan = Math.max(highMax - lowMin, 0.000001);
  const pad = priceSpan * 0.08;
  const minPrice = lowMin - pad;
  const maxPrice = highMax + pad;
  const safeSpan = Math.max(maxPrice - minPrice, 0.000001);

  const maxVolume = Math.max(1, ...candles.map((candle) => numOrZero(candle.volume)));
  const step = candles.length > 0 ? (width - left - right) / candles.length : 0;
  const bodyWidth = Math.max(2.5, step * 0.55);

  const mapPriceY = (price: number) => {
    const ratio = (price - minPrice) / safeSpan;
    return priceBottom - ratio * (priceBottom - priceTop);
  };

  const mapVolumeY = (volume: number) => {
    const ratio = volume / maxVolume;
    return volumeBottom - ratio * (volumeBottom - volumeTop);
  };

  const horizontalTicks = Array.from({ length: 6 }).map((_, idx) => {
    const ratio = idx / 5;
    const value = maxPrice - ratio * safeSpan;
    const y = priceTop + ratio * (priceBottom - priceTop);
    return { y, value };
  });

  const xLabelStep = Math.max(1, Math.floor(candles.length / 6));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full">
      <rect x={0} y={0} width={width} height={height} fill="#071521" />

      {horizontalTicks.map((tick, idx) => (
        <g key={`h-${idx}`}>
          <line x1={left} x2={width - right} y1={tick.y} y2={tick.y} stroke="#143247" strokeDasharray="4 4" opacity={0.65} />
          <text x={width - 6} y={tick.y + 4} textAnchor="end" fill="#8ca5bd" fontSize="11">
            {tick.value.toFixed(4)}
          </text>
        </g>
      ))}

      {candles.map((candle, idx) => {
        const xCenter = left + idx * step + step / 2;
        const yHigh = mapPriceY(candle.high);
        const yLow = mapPriceY(candle.low);
        const yOpen = mapPriceY(candle.open);
        const yClose = mapPriceY(candle.close);
        const top = Math.min(yOpen, yClose);
        const bottom = Math.max(yOpen, yClose);
        const up = candle.close >= candle.open;
        const color = up ? '#3ad6b5' : '#ef6d7a';

        const volumeY = mapVolumeY(candle.volume);
        const labelVisible = idx % xLabelStep === 0 || idx === candles.length - 1;

        return (
          <g key={`${candle.bucket}-${idx}`}>
            <line x1={xCenter} x2={xCenter} y1={yHigh} y2={yLow} stroke={color} strokeWidth={1.4} />
            <rect
              x={xCenter - bodyWidth / 2}
              y={top}
              width={bodyWidth}
              height={Math.max(1.8, bottom - top)}
              fill={up ? '#31c7a8' : '#e55f6d'}
              opacity={0.95}
              rx={0.7}
            />

            <rect
              x={xCenter - bodyWidth / 2}
              y={volumeY}
              width={bodyWidth}
              height={Math.max(1, volumeBottom - volumeY)}
              fill={up ? 'rgba(58,214,181,0.35)' : 'rgba(239,109,122,0.35)'}
            />

            {labelVisible ? (
              <text x={xCenter} y={height - 8} textAnchor="middle" fill="#8ca5bd" fontSize="10">
                {candle.label}
              </text>
            ) : null}
          </g>
        );
      })}

      <line x1={left} x2={width - right} y1={volumeTop - 2} y2={volumeTop - 2} stroke="#143247" />
      <text x={left} y={volumeTop - 8} fill="#8ca5bd" fontSize="10">
        Vol
      </text>
    </svg>
  );
}

function WalletBadge({ chainId }: { chainId: number }) {
  const { address, isConnected, chainId: walletChainId } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  const connectable = useMemo(() => {
    return connectors.filter((connector) => connector.type !== 'injected' || connector.name);
  }, [connectors]);

  return (
    <div className="rounded-lg border border-[#21384a] bg-[#081423] p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-[10px] uppercase tracking-[0.14em] text-slate-500">Wallet</p>
          <p className="text-sm font-semibold text-slate-100">{shortAddress(address)}</p>
          <p className="text-[11px] text-slate-400">Chain {walletChainId ?? 'read-only'}</p>
        </div>
        {isConnected ? (
          <button
            type="button"
            onClick={() => disconnect()}
            className="rounded border border-rose-500/45 bg-rose-500/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-rose-200"
          >
            Disconnect
          </button>
        ) : null}
      </div>

      {!isConnected ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {connectable.slice(0, 2).map((connector) => (
            <button
              key={connector.uid || connector.id || connector.name}
              type="button"
              onClick={() => connect({ connector })}
              disabled={isPending}
              className="rounded border border-cyan-400/55 bg-cyan-500/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-cyan-200 disabled:opacity-50"
            >
              {isPending ? 'Connecting...' : connector.name}
            </button>
          ))}
        </div>
      ) : walletChainId !== chainId ? (
        <button
          type="button"
          onClick={() => switchChain({ chainId })}
          disabled={switching}
          className="mt-2 rounded border border-amber-400/55 bg-amber-400/12 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-200 disabled:opacity-50"
        >
          {switching ? 'Switching...' : `Switch to ${chainId}`}
        </button>
      ) : null}
    </div>
  );
}

export function ProTerminal() {
  const [chainId, setChainId] = useState(DEFAULT_CHAIN_ID);
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<MarketFilter>('all');
  const [selectedPairId, setSelectedPairId] = useState<string>('');
  const [timeframe, setTimeframe] = useState<Timeframe>('5m');
  const [bookTab, setBookTab] = useState<BookTab>('book');
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('markets');
  const [accountTab, setAccountTab] = useState<AccountTab>('balances');
  const [favorites, setFavorites] = useState<string[]>([]);
  const [selectedPairByChain, setSelectedPairByChain] = useState<Record<string, string>>({});
  const [layoutReady, setLayoutReady] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PersistedLayout>;
        if (typeof parsed.chainId === 'number') setChainId(parsed.chainId);
        if (typeof parsed.searchQuery === 'string') setSearchQuery(parsed.searchQuery);
        if (parsed.filter === 'all' || parsed.filter === 'favorites' || parsed.filter === 'spot') setFilter(parsed.filter);
        if (parsed.timeframe === '1m' || parsed.timeframe === '5m' || parsed.timeframe === '1h' || parsed.timeframe === '1d') {
          setTimeframe(parsed.timeframe);
        }
        if (parsed.bookTab === 'book' || parsed.bookTab === 'trades') setBookTab(parsed.bookTab);
        if (
          parsed.mobilePanel === 'markets' ||
          parsed.mobilePanel === 'chart' ||
          parsed.mobilePanel === 'trade' ||
          parsed.mobilePanel === 'account'
        ) {
          setMobilePanel(parsed.mobilePanel);
        }
        if (Array.isArray(parsed.favorites)) {
          setFavorites(parsed.favorites.filter((item): item is string => typeof item === 'string').slice(0, 200));
        }
        if (parsed.selectedPairByChain && typeof parsed.selectedPairByChain === 'object') {
          const next: Record<string, string> = {};
          for (const [key, value] of Object.entries(parsed.selectedPairByChain)) {
            if (typeof value === 'string') {
              next[key] = value;
            }
          }
          setSelectedPairByChain(next);
        }
      }
    } catch {
      // ignore malformed persistence payload
    } finally {
      setLayoutReady(true);
    }
  }, []);

  const marketVM = useMarketListVM(chainId, searchQuery, filter, favorites);

  useEffect(() => {
    if (!layoutReady || typeof window === 'undefined') return;
    const payload: PersistedLayout = {
      chainId,
      searchQuery,
      filter,
      timeframe,
      bookTab,
      mobilePanel,
      favorites,
      selectedPairByChain
    };
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(payload));
  }, [bookTab, chainId, favorites, filter, layoutReady, mobilePanel, searchQuery, selectedPairByChain, timeframe]);

  useEffect(() => {
    const persistedPair = selectedPairByChain[String(chainId)];
    if (!marketVM.rows.length) {
      setSelectedPairId('');
      return;
    }

    if (persistedPair && marketVM.allRows.some((row) => row.id === persistedPair)) {
      if (selectedPairId !== persistedPair) setSelectedPairId(persistedPair);
      return;
    }

    if (selectedPairId && marketVM.allRows.some((row) => row.id === selectedPairId)) {
      return;
    }

    const preferred = marketVM.rows.find((row) => row.pair.includes('MUSD')) || marketVM.rows[0];
    setSelectedPairId(preferred.id);
  }, [chainId, marketVM.allRows, marketVM.rows, selectedPairByChain, selectedPairId]);

  useEffect(() => {
    if (!selectedPairId) return;
    setSelectedPairByChain((current) => {
      const key = String(chainId);
      if (current[key] === selectedPairId) return current;
      return {
        ...current,
        [key]: selectedPairId
      };
    });
  }, [chainId, selectedPairId]);

  const selectedPair = useMemo(
    () => marketVM.allRows.find((row) => row.id === selectedPairId) || null,
    [marketVM.allRows, selectedPairId]
  );

  const tradesVM = useTradesVM(chainId, selectedPair);
  const pairVM = usePairVM({
    chainId,
    selectedPair,
    trades: tradesVM.trades,
    timeframe
  });
  const orderbookVM = useOrderbookVM(selectedPair, pairVM.metrics.lastPrice);
  const entryVM = useOrderEntryVM({
    chainId,
    selectedPair,
    tokenMap: marketVM.tokenMap,
    selectedNetwork: marketVM.selectedNetwork
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;

      if (event.key === '/') {
        event.preventDefault();
        const input = document.getElementById('pro-market-search');
        if (input instanceof HTMLInputElement) input.focus();
      }

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (!marketVM.rows.length) return;
        event.preventDefault();
        const index = marketVM.rows.findIndex((row) => row.id === selectedPairId);
        const current = index >= 0 ? index : 0;
        const nextIndex = event.key === 'ArrowDown' ? Math.min(marketVM.rows.length - 1, current + 1) : Math.max(0, current - 1);
        setSelectedPairId(marketVM.rows[nextIndex].id);
      }

      if (event.key === 'Enter' && selectedPair) {
        event.preventDefault();
        entryVM.execute();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [entryVM, marketVM.rows, selectedPair, selectedPairId]);

  const chainLabel = marketVM.selectedNetwork ? `${marketVM.selectedNetwork.name} (${chainId})` : `Chain ${chainId}`;
  const candleReady = pairVM.ohlcCandles.length > 0;

  const orderbookMaxAsk = Math.max(1, ...orderbookVM.asks.map((level) => level.total));
  const orderbookMaxBid = Math.max(1, ...orderbookVM.bids.map((level) => level.total));

  const toggleFavorite = (id: string) => {
    setFavorites((list) => (list.includes(id) ? list.filter((item) => item !== id) : [id, ...list].slice(0, 200)));
  };

  return (
    <div className="mx-[calc(50%-50vw)] w-screen px-2 pb-4 md:px-4">
      <div className="mb-2 rounded-lg border border-[#1a394a] bg-[#0a1726]">
        <div className="rounded-t-lg bg-[#53d4cf] px-3 py-1 text-xs font-medium text-[#062429]">
          Welcome to mCryptoEx Pro Terminal. Wallet-signed non-custodial Spot trading.
        </div>
        <div className="grid gap-2 px-3 py-2 md:grid-cols-5">
          <div>
            <p className="text-[10px] uppercase tracking-[0.14em] text-slate-500">Pair</p>
            <p className="text-sm font-semibold text-slate-100">{selectedPair?.pair || 'Select pair'}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-[0.14em] text-slate-500">Last</p>
            <p className="font-mono text-sm text-slate-100">{shortAmount(pairVM.metrics.lastPrice)}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-[0.14em] text-slate-500">24h Change</p>
            <p className={`font-mono text-sm ${pctClass(pairVM.metrics.change24h)}`}>{formatChange(pairVM.metrics.change24h)}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-[0.14em] text-slate-500">24h Volume</p>
            <p className="font-mono text-sm text-slate-100">{shortAmount(pairVM.metrics.volume24h)}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-[0.14em] text-slate-500">Route Target</p>
            <p className="font-mono text-sm text-cyan-200">
              {entryVM.tokenInSymbol} {'->'} {entryVM.tokenOutSymbol}
            </p>
          </div>
        </div>
      </div>

      <div className="mb-2 flex gap-2 lg:hidden">
        {([
          ['markets', 'Market'],
          ['chart', 'Chart'],
          ['trade', 'Trade'],
          ['account', 'Account']
        ] as const).map(([panel, label]) => (
          <button
            key={panel}
            type="button"
            onClick={() => setMobilePanel(panel)}
            className={`flex-1 rounded-md border px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] ${
              mobilePanel === panel
                ? 'border-cyan-400/80 bg-cyan-500/20 text-cyan-200'
                : 'border-[#21384a] bg-[#081423] text-slate-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid gap-2 lg:grid-cols-[520px_minmax(0,1fr)_420px]">
        <section className={`${mobilePanel === 'markets' ? 'block' : 'hidden'} lg:block`}>
          <div className="h-full rounded-lg border border-[#1a394a] bg-[#081423] p-2.5">
            <div className="mb-2 flex items-center justify-between">
              <div>
                <p className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Market Watch</p>
                <p className="text-sm font-semibold text-slate-100">{chainLabel}</p>
              </div>
              <div className="flex gap-1 rounded border border-[#223f53] bg-[#0a1726] p-1">
                {(['all', 'favorites', 'spot'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setFilter(value)}
                    className={`rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] ${
                      filter === value
                        ? 'bg-cyan-500/20 text-cyan-200'
                        : 'text-slate-400 hover:text-slate-100'
                    }`}
                  >
                    {value}
                  </button>
                ))}
              </div>
            </div>

            <div className="mb-2 grid grid-cols-[minmax(0,1fr)_110px] gap-2">
              <input
                id="pro-market-search"
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search token or pair"
                className="rounded border border-[#223f53] bg-[#07111e] px-3 py-2 text-xs text-slate-100 outline-none placeholder:text-slate-500 focus:border-cyan-400/70"
              />
              <select
                value={chainId}
                onChange={(event) => setChainId(Number(event.target.value))}
                className="rounded border border-[#223f53] bg-[#07111e] px-2 py-2 text-xs text-slate-200"
              >
                {(marketVM.networks.length ? marketVM.networks : [{ chain_id: chainId, name: chainLabel }]).map((network) => (
                  <option key={network.chain_id} value={network.chain_id}>
                    {network.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="overflow-hidden rounded border border-[#173449] bg-[#06111d]">
              <div className="grid grid-cols-[24px_minmax(0,1.2fr)_80px_92px_90px_88px] gap-2 border-b border-[#173449] px-2 py-2 text-[10px] uppercase tracking-[0.12em] text-slate-500">
                <span>*</span>
                <span>Symbol</span>
                <span className="text-right">Last</span>
                <span className="text-right">24h %</span>
                <span className="text-right">Volume</span>
                <span className="text-right">OI</span>
              </div>

              <div className="max-h-[62vh] overflow-y-auto">
                {marketVM.loading ? (
                  <div className="space-y-1 p-2">
                    {Array.from({ length: 12 }).map((_, idx) => (
                      <div key={idx} className="h-7 animate-pulse rounded bg-[#0c1f32]" />
                    ))}
                  </div>
                ) : marketVM.rows.length ? (
                  marketVM.rows.map((row) => {
                    const selected = row.id === selectedPairId;
                    const favorite = favorites.includes(row.id);
                    const change = row.change24h;
                    return (
                      <button
                        key={row.id}
                        type="button"
                        onClick={() => setSelectedPairId(row.id)}
                        className={`grid w-full grid-cols-[24px_minmax(0,1.2fr)_80px_92px_90px_88px] gap-2 px-2 py-1.5 text-xs ${
                          selected ? 'bg-cyan-500/16' : 'hover:bg-[#0d2235]'
                        }`}
                      >
                        <span
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleFavorite(row.id);
                          }}
                          className={`cursor-pointer text-center ${favorite ? 'text-amber-300' : 'text-slate-600'}`}
                          aria-hidden="true"
                        >
                          ★
                        </span>
                        <span className="truncate text-left text-slate-100">{row.pair}</span>
                        <span className="text-right font-mono text-slate-200">{row.last ? row.last.toFixed(5) : 'n/a'}</span>
                        <span className={`text-right font-mono ${pctClass(change)}`}>{formatChange(change)}</span>
                        <span className="text-right font-mono text-slate-300">{shortAmount(row.volume24h)}</span>
                        <span className="text-right font-mono text-slate-500">--</span>
                      </button>
                    );
                  })
                ) : (
                  <p className="p-3 text-xs text-slate-400">No tradable pairs for this chain.</p>
                )}
              </div>
            </div>
            {marketVM.error ? <p className="mt-2 text-xs text-rose-300">{marketVM.error}</p> : null}
          </div>
        </section>

        <section className={`${mobilePanel === 'chart' ? 'block' : 'hidden'} lg:block`}>
          <div className="h-full rounded-lg border border-[#1a394a] bg-[#081423] p-2.5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div>
                <p className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Chart</p>
                <p className="text-xl font-semibold text-slate-100">{selectedPair?.pair || 'Select pair'}</p>
              </div>
              <div className="flex items-center gap-1 rounded border border-[#223f53] bg-[#0a1726] p-1">
                {(['1m', '5m', '1h', '1d'] as Timeframe[]).map((frame) => (
                  <button
                    key={frame}
                    type="button"
                    onClick={() => setTimeframe(frame)}
                    className={`rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.1em] ${
                      timeframe === frame
                        ? 'bg-cyan-500/20 text-cyan-200'
                        : 'text-slate-400 hover:text-slate-100'
                    }`}
                  >
                    {frame}
                  </button>
                ))}
              </div>
            </div>

            <div className="h-[468px] overflow-hidden rounded border border-[#173449] bg-[#071521]">
              {candleReady ? (
                <OhlcViewport candles={pairVM.ohlcCandles} pairLabel={selectedPair?.pair || 'pair'} />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-slate-400">
                  Waiting for analytics stream and swap events...
                </div>
              )}
            </div>
            {pairVM.error ? <p className="mt-2 text-xs text-rose-300">{pairVM.error}</p> : null}
          </div>
        </section>

        <section className={`${mobilePanel === 'trade' ? 'block' : 'hidden'} lg:block`}>
          <div className="h-full space-y-2 rounded-lg border border-[#1a394a] bg-[#081423] p-2.5">
            <WalletBadge chainId={chainId} />

            <div className="rounded-lg border border-[#21384a] bg-[#081423] p-2">
              <div className="mb-1 flex items-center gap-1">
                {([
                  ['book', 'Order Book'],
                  ['trades', 'Trades']
                ] as const).map(([tab, label]) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setBookTab(tab)}
                    className={`rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] ${
                      bookTab === tab
                        ? 'bg-cyan-500/20 text-cyan-200'
                        : 'text-slate-400 hover:text-slate-100'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {bookTab === 'book' ? (
                <div className="grid grid-cols-3 gap-2 text-[11px]">
                  <div className="text-slate-500">Price</div>
                  <div className="text-right text-slate-500">Size</div>
                  <div className="text-right text-slate-500">Total</div>

                  <div className="col-span-3 max-h-44 overflow-y-auto">
                    {orderbookVM.asks.map((level, idx) => {
                      const depth = Math.min(100, (level.total / orderbookMaxAsk) * 100);
                      return (
                        <div key={`ask-${idx}`} className="relative grid grid-cols-3 gap-2 overflow-hidden py-0.5 text-rose-300">
                          <div className="absolute inset-y-0 right-0 bg-rose-500/10" style={{ width: `${depth}%` }} />
                          <span className="relative">{level.price.toFixed(6)}</span>
                          <span className="relative text-right">{shortAmount(level.size)}</span>
                          <span className="relative text-right">{shortAmount(level.total)}</span>
                        </div>
                      );
                    })}
                  </div>

                  <div className="col-span-3 rounded bg-[#07111e] px-2 py-1 text-center text-[11px] text-slate-300">
                    Spread {shortAmount(orderbookVM.spread)}
                  </div>

                  <div className="col-span-3 max-h-44 overflow-y-auto">
                    {orderbookVM.bids.map((level, idx) => {
                      const depth = Math.min(100, (level.total / orderbookMaxBid) * 100);
                      return (
                        <div key={`bid-${idx}`} className="relative grid grid-cols-3 gap-2 overflow-hidden py-0.5 text-emerald-300">
                          <div className="absolute inset-y-0 right-0 bg-emerald-500/10" style={{ width: `${depth}%` }} />
                          <span className="relative">{level.price.toFixed(6)}</span>
                          <span className="relative text-right">{shortAmount(level.size)}</span>
                          <span className="relative text-right">{shortAmount(level.total)}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="max-h-[340px] space-y-1 overflow-y-auto text-[11px]">
                  {tradesVM.trades.slice(0, 80).map((trade) => (
                    <div key={`trade-${trade.txHash}`} className="grid grid-cols-[54px_1fr_72px] rounded bg-[#07111e] px-2 py-1">
                      <span className={trade.side === 'buy' ? 'text-emerald-300' : 'text-rose-300'}>{trade.side}</span>
                      <span className="font-mono text-slate-200">{trade.price.toFixed(6)}</span>
                      <span className="text-right text-slate-400">{new Date(trade.at).toLocaleTimeString()}</span>
                    </div>
                  ))}
                  {!tradesVM.trades.length ? <p className="px-2 py-3 text-center text-slate-400">No recent trades yet.</p> : null}
                </div>
              )}
            </div>

            <div className="rounded-lg border border-[#21384a] bg-[#081423] p-2">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Order Entry</p>
                <div className="rounded border border-[#223f53] bg-[#07111e] p-1 text-[10px]">
                  {(['market', 'limit'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => entryVM.setEntryMode(mode)}
                      className={`rounded px-2 py-1 font-semibold uppercase tracking-[0.12em] ${
                        entryVM.entryMode === mode
                          ? 'bg-cyan-500/20 text-cyan-200'
                          : 'text-slate-400 hover:text-slate-100'
                      }`}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mb-2 grid grid-cols-2 gap-1 rounded border border-[#223f53] bg-[#07111e] p-1 text-xs">
                <button
                  type="button"
                  onClick={() => entryVM.setSide('buy')}
                  className={`rounded px-2 py-1.5 font-semibold ${
                    entryVM.side === 'buy' ? 'bg-emerald-500/18 text-emerald-200' : 'text-slate-400 hover:text-slate-100'
                  }`}
                >
                  Buy
                </button>
                <button
                  type="button"
                  onClick={() => entryVM.setSide('sell')}
                  className={`rounded px-2 py-1.5 font-semibold ${
                    entryVM.side === 'sell' ? 'bg-rose-500/18 text-rose-200' : 'text-slate-400 hover:text-slate-100'
                  }`}
                >
                  Sell
                </button>
              </div>

              <div className="space-y-2 text-xs">
                <div className="grid grid-cols-2 gap-2">
                  <label className="space-y-1">
                    <span className="text-slate-500">Token In</span>
                    <input
                      value={entryVM.tokenInSymbol}
                      readOnly
                      className="w-full rounded border border-[#223f53] bg-[#07111e] px-2 py-1.5 text-slate-100"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-slate-500">Token Out</span>
                    <input
                      value={entryVM.tokenOutSymbol}
                      readOnly
                      className="w-full rounded border border-[#223f53] bg-[#07111e] px-2 py-1.5 text-slate-100"
                    />
                  </label>
                </div>

                <label className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500">Amount</span>
                    <button
                      type="button"
                      onClick={entryVM.setMaxAmount}
                      className="rounded border border-[#223f53] px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] text-cyan-200"
                    >
                      Max
                    </button>
                  </div>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={entryVM.amount}
                    onChange={(event) => entryVM.setAmount(event.target.value)}
                    className="w-full rounded border border-[#223f53] bg-[#07111e] px-2 py-1.5 text-slate-100"
                  />
                </label>

                {entryVM.entryMode === 'limit' ? (
                  <label className="space-y-1">
                    <span className="text-slate-500">Limit Price</span>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={entryVM.limitPrice}
                      onChange={(event) => entryVM.setLimitPrice(event.target.value)}
                      className="w-full rounded border border-[#223f53] bg-[#07111e] px-2 py-1.5 text-slate-100"
                    />
                  </label>
                ) : null}

                <label className="space-y-1">
                  <span className="text-slate-500">Slippage (bps)</span>
                  <input
                    type="number"
                    min={1}
                    max={3000}
                    value={entryVM.slippageBps}
                    onChange={(event) => entryVM.setSlippageBps(Number(event.target.value))}
                    className="w-full rounded border border-[#223f53] bg-[#07111e] px-2 py-1.5 text-slate-100"
                  />
                </label>

                <label className="flex items-center gap-2 rounded border border-cyan-400/35 bg-cyan-500/8 px-2 py-1.5 text-[11px] text-cyan-100">
                  <input
                    type="checkbox"
                    checked={entryVM.autoWrapNative}
                    onChange={(event) => entryVM.setAutoWrapNative(event.target.checked)}
                  />
                  Auto-wrap native to {entryVM.wrappedNativeSymbol}
                </label>

                <div className="rounded border border-[#223f53] bg-[#07111e] px-2 py-1.5 text-[11px] text-slate-300">
                  Available: {shortAmount(entryVM.availableBalance)} {entryVM.tokenInSymbol}
                  <br />
                  Native: {shortAmount(entryVM.nativeBalance)} {chainId === 97 ? 'tBNB' : 'gas'}
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={entryVM.requestQuote}
                    disabled={entryVM.quoteLoading}
                    className="rounded border border-cyan-400/70 bg-cyan-500/15 px-2 py-2 text-xs font-semibold text-cyan-200 disabled:opacity-50"
                  >
                    {entryVM.quoteLoading ? 'Quoting...' : 'Get Quote'}
                  </button>
                  <button
                    type="button"
                    onClick={entryVM.execute}
                    disabled={entryVM.executing || !selectedPair}
                    className="rounded border border-emerald-400/65 bg-emerald-500/15 px-2 py-2 text-xs font-semibold text-emerald-200 disabled:opacity-50"
                  >
                    {entryVM.executing
                      ? 'Executing...'
                      : entryVM.entryMode === 'market'
                        ? 'Execute Market Swap'
                        : 'Queue Limit Draft'}
                  </button>
                </div>

                {entryVM.quote ? (
                  <div className="rounded border border-[#223f53] bg-[#07111e] px-2 py-1.5 text-[11px] text-slate-200">
                    <p>
                      Expected: {entryVM.quote.expected_out} {entryVM.quote.token_out}
                    </p>
                    <p>
                      Min: {entryVM.quote.min_out} {entryVM.quote.token_out}
                    </p>
                    <p>Route: {entryVM.quote.route.join(' -> ')}</p>
                    <p>
                      Fee: {entryVM.quote.total_fee_bps ?? 30} bps ({entryVM.quote.lp_fee_bps ?? 25} LP /{' '}
                      {entryVM.quote.protocol_fee_bps ?? 5} protocol)
                    </p>
                    {entryVM.staleQuote ? <p className="text-amber-300">Quote stale, refresh before execute.</p> : null}
                  </div>
                ) : null}

                {entryVM.error ? <p className="text-xs text-rose-300">{entryVM.error}</p> : null}
                {entryVM.status ? <p className="text-xs text-cyan-200">{entryVM.status}</p> : null}
              </div>
            </div>
          </div>
        </section>
      </div>

      <section className={`${mobilePanel === 'account' ? 'block' : 'hidden'} mt-2 lg:block`}>
        <div className="rounded-lg border border-[#1a394a] bg-[#081423] p-2.5">
          <div className="mb-2 flex items-center gap-1">
            {([
              ['balances', 'Balances'],
              ['positions', 'Positions'],
              ['orders', 'Open Orders'],
              ['history', 'Trade History']
            ] as const).map(([tab, label]) => (
              <button
                key={tab}
                type="button"
                onClick={() => setAccountTab(tab)}
                className={`rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] ${
                  accountTab === tab
                    ? 'bg-cyan-500/20 text-cyan-200'
                    : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_390px]">
            <div className="rounded border border-[#173449] bg-[#06111d] p-2">
              {accountTab === 'balances' ? (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-xs">
                    <thead>
                      <tr className="text-left text-slate-500">
                        <th className="px-2 py-1">Coin</th>
                        <th className="px-2 py-1 text-right">Total Balance</th>
                        <th className="px-2 py-1 text-right">Available Balance</th>
                        <th className="px-2 py-1 text-right">USD Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-t border-[#173449] text-slate-200">
                        <td className="px-2 py-1.5">Native {chainId === 97 ? 'tBNB' : 'gas token'}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{shortAmount(entryVM.nativeBalance)}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{shortAmount(entryVM.nativeBalance)}</td>
                        <td className="px-2 py-1.5 text-right text-slate-400">n/a</td>
                      </tr>
                      {marketVM.chainTokens.map((token) => (
                        <tr key={`bal-${token.address}-${token.symbol}`} className="border-t border-[#173449] text-slate-200">
                          <td className="px-2 py-1.5">{token.symbol}</td>
                          <td className="px-2 py-1.5 text-right font-mono">{shortAmount(entryVM.walletBalances[token.symbol] || '0')}</td>
                          <td className="px-2 py-1.5 text-right font-mono">{shortAmount(entryVM.walletBalances[token.symbol] || '0')}</td>
                          <td className="px-2 py-1.5 text-right text-slate-400">n/a</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {accountTab === 'positions' ? (
                <div className="py-8 text-center text-xs text-slate-400">Spot-only movement. LP positions render in Liquidity/Pools.</div>
              ) : null}

              {accountTab === 'orders' ? (
                <div className="max-h-56 space-y-1 overflow-y-auto">
                  {entryVM.limitDrafts.slice(0, 24).map((draft) => (
                    <div key={draft.id} className="rounded bg-[#0a1d2f] px-2 py-1 text-xs text-slate-200">
                      <p>
                        {draft.side.toUpperCase()} {draft.amount} {draft.token_out} with {draft.token_in} @ {draft.limit_price}
                      </p>
                      <p className="text-[11px] text-slate-400">{new Date(draft.created_at).toLocaleString()}</p>
                    </div>
                  ))}
                  {!entryVM.limitDrafts.length ? <p className="py-6 text-center text-xs text-slate-400">No open local drafts.</p> : null}
                </div>
              ) : null}

              {accountTab === 'history' ? (
                <div className="max-h-56 space-y-1 overflow-y-auto">
                  {tradesVM.trades.slice(0, 24).map((trade) => (
                    <div key={`${trade.txHash}-${trade.at}`} className="rounded bg-[#0a1d2f] px-2 py-1 text-xs text-slate-200">
                      <p>
                        {trade.side.toUpperCase()} {shortAmount(trade.baseAmount)} {trade.baseToken} @ {trade.price.toFixed(6)}
                      </p>
                      <p className="text-[11px] text-slate-400">
                        {new Date(trade.at).toLocaleString()} | fee ${shortAmount(trade.feeUsd)} | gas ${shortAmount(trade.gasUsd)}
                      </p>
                    </div>
                  ))}
                  {!tradesVM.trades.length ? <p className="py-6 text-center text-xs text-slate-400">No trade history yet.</p> : null}
                </div>
              ) : null}
            </div>

            <div className="rounded border border-[#173449] bg-[#06111d] p-2">
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Portfolio Distribution</p>
              <div className="h-48">
                {marketVM.chainTokens.length ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={marketVM.chainTokens.map((token) => ({
                        symbol: token.symbol,
                        balance: Number(entryVM.walletBalances[token.symbol] || '0')
                      }))}
                      margin={{ top: 6, right: 8, left: 0, bottom: 20 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#173449" opacity={0.55} />
                      <XAxis dataKey="symbol" stroke="#7d96ab" tick={{ fontSize: 10 }} />
                      <YAxis stroke="#7d96ab" tick={{ fontSize: 10 }} />
                      <Tooltip
                        contentStyle={{ background: '#081423', border: '1px solid #1f3b52', borderRadius: '0.5rem' }}
                        formatter={(value) => [shortAmount(String(value)), 'balance']}
                      />
                      <Bar dataKey="balance" fill="#2f76f6" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-slate-400">No token registry data.</div>
                )}
              </div>

              <div className="mt-3 rounded border border-[#223f53] bg-[#07111e] px-2 py-1.5 text-[11px] text-slate-300">
                Shortcuts: <span className="font-mono">/</span> search, <span className="font-mono">↑↓</span> pair,{' '}
                <span className="font-mono">Enter</span> execute.
                <br />
                Security: wallet-signed trades only, no server-side custody.
                {entryVM.canSwitchNetwork ? ' Wallet chain mismatch detected.' : ''}
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
