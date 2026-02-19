'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAccount } from 'wagmi';
import {
  DEFAULT_CHAIN_ID,
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
type AccountTab = 'balances' | 'positions' | 'open-orders' | 'twap' | 'trade-history' | 'funding-history' | 'order-history';

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
};

const LAYOUT_STORAGE_KEY = 'mcryptoex.pro.layout.v3';

function shortAddress(value?: string) {
  if (!value) return '0x...';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function formatChange(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)}%`;
}

function changeClass(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'text-slate-300';
  return value >= 0 ? 'text-emerald-300' : 'text-rose-300';
}

function safe(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function OhlcCanvas({ candles, pairLabel }: { candles: OhlcCandle[]; pairLabel: string }) {
  const width = 1180;
  const height = 520;
  const left = 58;
  const right = 20;
  const top = 18;
  const priceBottom = 382;
  const volumeTop = 402;
  const volumeBottom = 500;

  if (!candles.length) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-400">
        Waiting for OHLC feed from ledger buckets for {pairLabel}.
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

  const maxVolume = Math.max(1, ...candles.map((candle) => safe(candle.volume)));
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

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full">
      <rect x={0} y={0} width={width} height={height} fill="#08131e" />

      {yTicks.map((tick, idx) => (
        <g key={`tick-${idx}`}>
          <line x1={left} x2={width - right} y1={tick.y} y2={tick.y} stroke="#173042" strokeDasharray="4 4" opacity={0.65} />
          <text x={width - 4} y={tick.y + 4} fill="#8ea5b9" fontSize="11" textAnchor="end">
            {tick.price.toFixed(3)}
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
            <line x1={x} y1={yHigh} x2={x} y2={yLow} stroke={color} strokeWidth={1.35} />
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
              <text x={x} y={height - 6} fill="#8399ad" fontSize="10" textAnchor="middle">
                {candle.label}
              </text>
            ) : null}
          </g>
        );
      })}

      <line x1={left} x2={width - right} y1={volumeTop - 2} y2={volumeTop - 2} stroke="#173042" />
      <text x={left} y={volumeTop - 8} fill="#8ea5b9" fontSize="10">
        Volume
      </text>
    </svg>
  );
}

export function ProTerminal() {
  const [chainId, setChainId] = useState(DEFAULT_CHAIN_ID);
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<MarketFilter>('all');
  const [selectedPairId, setSelectedPairId] = useState('');
  const [timeframe, setTimeframe] = useState<Timeframe>('1h');
  const [bookTab, setBookTab] = useState<BookTab>('book');
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('markets');
  const [accountTab, setAccountTab] = useState<AccountTab>('balances');
  const [favorites, setFavorites] = useState<string[]>([]);
  const [selectedPairByChain, setSelectedPairByChain] = useState<Record<string, string>>({});
  const [ready, setReady] = useState(false);
  const [sizePct, setSizePct] = useState(0);

  const { address } = useAccount();

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PersistedLayout>;
        if (typeof parsed.chainId === 'number') setChainId(parsed.chainId);
        if (typeof parsed.searchQuery === 'string') setSearchQuery(parsed.searchQuery);
        if (parsed.filter === 'all' || parsed.filter === 'favorites' || parsed.filter === 'spot') setFilter(parsed.filter);
        if (parsed.timeframe === '1m' || parsed.timeframe === '5m' || parsed.timeframe === '1h' || parsed.timeframe === '1d') setTimeframe(parsed.timeframe);
        if (parsed.bookTab === 'book' || parsed.bookTab === 'trades') setBookTab(parsed.bookTab);
        if (parsed.mobilePanel === 'markets' || parsed.mobilePanel === 'chart' || parsed.mobilePanel === 'trade' || parsed.mobilePanel === 'account') {
          setMobilePanel(parsed.mobilePanel);
        }
        if (
          parsed.accountTab === 'balances' ||
          parsed.accountTab === 'positions' ||
          parsed.accountTab === 'open-orders' ||
          parsed.accountTab === 'twap' ||
          parsed.accountTab === 'trade-history' ||
          parsed.accountTab === 'funding-history' ||
          parsed.accountTab === 'order-history'
        ) {
          setAccountTab(parsed.accountTab);
        }
        if (Array.isArray(parsed.favorites)) {
          setFavorites(parsed.favorites.filter((item): item is string => typeof item === 'string').slice(0, 250));
        }
        if (parsed.selectedPairByChain && typeof parsed.selectedPairByChain === 'object') {
          const next: Record<string, string> = {};
          for (const [key, value] of Object.entries(parsed.selectedPairByChain)) {
            if (typeof value === 'string') next[key] = value;
          }
          setSelectedPairByChain(next);
        }
      }
    } catch {
      // ignore
    } finally {
      setReady(true);
    }
  }, []);

  const marketVM = useMarketListVM(chainId, searchQuery, filter, favorites);

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
      selectedPairByChain
    };
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(payload));
  }, [accountTab, bookTab, chainId, favorites, filter, mobilePanel, ready, searchQuery, selectedPairByChain, timeframe]);

  useEffect(() => {
    const current = selectedPairByChain[String(chainId)];

    if (!marketVM.rows.length) {
      setSelectedPairId('');
      return;
    }

    if (current && marketVM.allRows.some((row) => row.id === current)) {
      if (selectedPairId !== current) setSelectedPairId(current);
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
      return { ...current, [key]: selectedPairId };
    });
  }, [chainId, selectedPairId]);

  const selectedPair = useMemo(() => marketVM.allRows.find((row) => row.id === selectedPairId) || null, [marketVM.allRows, selectedPairId]);

  const tradesVM = useTradesVM(chainId, selectedPair);
  const pairVM = usePairVM({ chainId, selectedPair, trades: tradesVM.trades, timeframe });
  const orderbookVM = useOrderbookVM(selectedPair, pairVM.metrics.lastPrice);
  const entryVM = useOrderEntryVM({
    chainId,
    selectedPair,
    tokenMap: marketVM.tokenMap,
    selectedNetwork: marketVM.selectedNetwork
  });

  const askMax = Math.max(1, ...orderbookVM.asks.map((level) => safe(level.total)));
  const bidMax = Math.max(1, ...orderbookVM.bids.map((level) => safe(level.total)));

  const chainLabel = marketVM.selectedNetwork ? `${marketVM.selectedNetwork.name} (${chainId})` : `Chain ${chainId}`;

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
        const current = Math.max(0, marketVM.rows.findIndex((row) => row.id === selectedPairId));
        const next = event.key === 'ArrowDown' ? Math.min(marketVM.rows.length - 1, current + 1) : Math.max(0, current - 1);
        setSelectedPairId(marketVM.rows[next].id);
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
  }, [entryVM, marketVM.rows, selectedPair, selectedPairId]);

  const executePrimary = async () => {
    if (entryVM.entryMode === 'market' && !entryVM.quote) {
      await entryVM.requestQuote();
      return;
    }
    await entryVM.execute();
  };

  return (
    <div className="flex min-h-screen flex-col bg-[#06111d] text-slate-100">
      <header className="flex h-14 items-center justify-between border-b border-[#183344] bg-[#09141f] px-4">
        <div className="flex items-center gap-5">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-[#67e3d5]" />
            <span className="text-sm font-semibold">mCryptoEx</span>
          </div>
          <nav className="hidden items-center gap-5 text-sm text-slate-200 xl:flex">
            {['Trade', 'Portfolio', 'Earn', 'Vaults', 'Staking', 'Referrals', 'Leaderboard', 'More'].map((item) => (
              <button key={item} type="button" className={`transition ${item === 'Trade' ? 'text-[#58d4c8]' : 'hover:text-white'}`}>
                {item}
              </button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <button className="rounded-md border border-[#204257] bg-[#0c1a29] px-3 py-1 text-sm text-slate-200">{shortAddress(address)}</button>
          {['◰', '◎', '⚙'].map((icon) => (
            <button key={icon} className="h-8 w-8 rounded-md border border-[#204257] bg-[#0c1a29] text-xs text-slate-200">
              {icon}
            </button>
          ))}
        </div>
      </header>

      <div className="h-8 border-b border-[#1b3f4d] bg-[#58d4c8] px-4 py-1 text-xs font-medium text-[#062428]">
        Wallet-first non-custodial trading. Tempo API is read-only; all executions are wallet-signed.
      </div>

      <main className="flex-1 p-1.5">
        <div className="mb-1 grid grid-cols-[minmax(0,1fr)_280px] gap-1 rounded border border-[#173448] bg-[#0a1724] px-2 py-2 text-xs">
          <div className="flex min-w-0 items-center gap-4 overflow-hidden">
            <button className="text-lg text-[#63e0d2]">✦</button>
            <div className="min-w-0">
              <p className="truncate text-2xl font-semibold">{selectedPair?.pair || 'Select Pair'}</p>
            </div>
            <div className="hidden items-center gap-6 text-sm text-slate-300 md:flex">
              <div>
                <p className="text-slate-500">Price</p>
                <p className="font-mono text-[#8de5db]">{shortAmount(pairVM.metrics.lastPrice)}</p>
              </div>
              <div>
                <p className="text-slate-500">24H Change</p>
                <p className={`font-mono ${changeClass(pairVM.metrics.change24h)}`}>{formatChange(pairVM.metrics.change24h)}</p>
              </div>
              <div>
                <p className="text-slate-500">24H Volume</p>
                <p className="font-mono">{shortAmount(pairVM.metrics.volume24h)} {selectedPair?.token1 || ''}</p>
              </div>
              <div>
                <p className="text-slate-500">Market Cap</p>
                <p className="font-mono text-slate-300">n/a</p>
              </div>
            </div>
          </div>
          <div className="flex items-center justify-end gap-1">
            {['↗', '⧉', '☰'].map((i) => (
              <button key={i} className="h-7 w-7 rounded border border-[#21445b] bg-[#0c1a29] text-[11px] text-slate-300">
                {i}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-1 flex gap-1 lg:hidden">
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
              className={`flex-1 rounded border px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.1em] ${
                mobilePanel === panel
                  ? 'border-[#55d1c5] bg-[#132f3f] text-[#78e6db]'
                  : 'border-[#21445b] bg-[#0c1a29] text-slate-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="grid h-[calc(100vh-214px)] gap-1 lg:grid-cols-[520px_minmax(0,1fr)_640px]">
          <section className={`${mobilePanel === 'markets' ? 'block' : 'hidden'} rounded border border-[#173448] bg-[#0a1724] p-2 lg:block`}>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs text-slate-400">{chainLabel}</p>
              <div className="flex items-center gap-1">
                <button className="rounded border border-[#21445b] bg-[#0c1a29] px-2 py-1 text-[11px] text-[#77e5da]">Strict</button>
                <button className="rounded border border-[#21445b] bg-[#0c1a29] px-2 py-1 text-[11px] text-slate-300">All</button>
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
                {(marketVM.networks.length ? marketVM.networks : [{ chain_id: chainId, name: chainLabel }]).map((network) => (
                  <option key={network.chain_id} value={network.chain_id}>
                    {network.chain_id}
                  </option>
                ))}
              </select>
            </div>

            <div className="mb-2 flex flex-wrap gap-1 text-[11px]">
              {['All', 'Perps', 'Spot', 'Crypto', 'Tradfi', 'HIP-3', 'Trending', 'Pre-launch'].map((chip) => (
                <button
                  key={chip}
                  className={`rounded border px-2 py-1 ${chip === 'All' ? 'border-[#57d6ca] text-[#75e6da]' : 'border-[#21445b] text-slate-400'}`}
                >
                  {chip}
                </button>
              ))}
            </div>

            <div className="overflow-hidden rounded border border-[#183549]">
              <div className="grid grid-cols-[24px_minmax(0,1fr)_90px_110px_88px_106px] gap-2 border-b border-[#183549] bg-[#091622] px-2 py-2 text-[11px] text-slate-400">
                <span>☆</span>
                <span>Symbol</span>
                <span className="text-right">Last Price</span>
                <span className="text-right">24H Change</span>
                <span className="text-right">Volume</span>
                <span className="text-right">Open Interest</span>
              </div>
              <div className="max-h-[calc(100vh-390px)] overflow-y-auto">
                {marketVM.loading ? (
                  <div className="space-y-1 p-2">
                    {Array.from({ length: 14 }).map((_, i) => (
                      <div key={i} className="h-7 animate-pulse rounded bg-[#102436]" />
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
                        onClick={() => setSelectedPairId(row.id)}
                        className={`grid w-full grid-cols-[24px_minmax(0,1fr)_90px_110px_88px_106px] gap-2 px-2 py-1.5 text-xs ${
                          isSelected ? 'bg-[#173449]' : 'hover:bg-[#102436]'
                        }`}
                      >
                        <span
                          onClick={(event) => {
                            event.stopPropagation();
                            setFavorites((list) =>
                              list.includes(row.id) ? list.filter((item) => item !== row.id) : [row.id, ...list].slice(0, 250)
                            );
                          }}
                          className={`text-center ${isFav ? 'text-amber-300' : 'text-slate-600'}`}
                          aria-hidden="true"
                        >
                          ★
                        </span>
                        <span className="truncate text-left text-slate-100">{row.pair}</span>
                        <span className="text-right font-mono text-slate-200">{row.last ? row.last.toFixed(4) : 'n/a'}</span>
                        <span className={`text-right font-mono ${changeClass(row.change24h)}`}>{formatChange(row.change24h)}</span>
                        <span className="text-right font-mono text-slate-300">{shortAmount(row.volume24h)}</span>
                        <span className="text-right font-mono text-slate-500">--</span>
                      </button>
                    );
                  })
                ) : (
                  <p className="p-3 text-xs text-slate-400">No market rows.</p>
                )}
              </div>
            </div>
            {marketVM.error ? <p className="mt-2 text-xs text-rose-300">{marketVM.error}</p> : null}
          </section>

          <section className={`${mobilePanel === 'chart' ? 'block' : 'hidden'} rounded border border-[#173448] bg-[#0a1724] p-2 lg:block`}>
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm text-slate-300">
                {(['5m', '1h', '1d'] as const).map((frame) => (
                  <button
                    key={frame}
                    type="button"
                    onClick={() => setTimeframe(frame === '5m' ? '5m' : frame === '1h' ? '1h' : '1d')}
                    className={`rounded px-2 py-1 ${timeframe === frame ? 'bg-[#173449] text-[#75e6da]' : 'text-slate-400'}`}
                  >
                    {frame}
                  </button>
                ))}
                <span className="text-slate-500">|</span>
                <button className="text-slate-300">Indicators</button>
              </div>
              <div className="flex items-center gap-1">
                {['◌', '⛶'].map((icon) => (
                  <button key={icon} className="h-7 w-7 rounded border border-[#21445b] bg-[#0c1a29] text-xs text-slate-300">
                    {icon}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid h-[calc(100%-34px)] grid-cols-[30px_minmax(0,1fr)] gap-2">
              <div className="flex flex-col items-center gap-2 rounded border border-[#183549] bg-[#08131f] py-2 text-[11px] text-slate-400">
                {['＋', '／', '↕', '∿', '⌖', '◍', 'T'].map((tool) => (
                  <button key={tool} className="h-6 w-6 rounded border border-[#21445b] bg-[#0b1723]">
                    {tool}
                  </button>
                ))}
              </div>
              <div className="overflow-hidden rounded border border-[#183549] bg-[#08131f]">
                <OhlcCanvas candles={pairVM.ohlcCandles} pairLabel={selectedPair?.pair || 'pair'} />
              </div>
            </div>
            {pairVM.error ? <p className="mt-2 text-xs text-rose-300">{pairVM.error}</p> : null}
          </section>

          <section className={`${mobilePanel === 'trade' ? 'block' : 'hidden'} grid grid-cols-[minmax(0,1fr)_292px] gap-1 lg:grid`}>
            <div className="rounded border border-[#173448] bg-[#0a1724] p-2">
              <div className="mb-2 flex items-center justify-between">
                <div className="flex gap-1 text-xs">
                  <button
                    type="button"
                    onClick={() => setBookTab('book')}
                    className={`rounded px-2 py-1 ${bookTab === 'book' ? 'bg-[#173449] text-[#75e6da]' : 'text-slate-400'}`}
                  >
                    Order Book
                  </button>
                  <button
                    type="button"
                    onClick={() => setBookTab('trades')}
                    className={`rounded px-2 py-1 ${bookTab === 'trades' ? 'bg-[#173449] text-[#75e6da]' : 'text-slate-400'}`}
                  >
                    Trades
                  </button>
                </div>
                <div className="text-xs text-slate-500">{selectedPair?.token0 || '--'}</div>
              </div>

              {bookTab === 'book' ? (
                <div className="text-xs">
                  <div className="mb-1 flex items-center justify-between text-slate-500">
                    <span>0.001</span>
                    <span>{selectedPair?.token0 || ''}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-slate-500">
                    <span>Price</span>
                    <span className="text-right">Size</span>
                    <span className="text-right">Total</span>
                  </div>

                  <div className="mt-1 max-h-56 space-y-0.5 overflow-y-auto">
                    {orderbookVM.asks.map((level, idx) => {
                      const depth = Math.min(100, (safe(level.total) / askMax) * 100);
                      return (
                        <div key={`ask-${idx}`} className="relative grid grid-cols-3 gap-2 overflow-hidden py-0.5 text-rose-300">
                          <div className="absolute inset-y-0 right-0 bg-rose-500/10" style={{ width: `${depth}%` }} />
                          <span className="relative">{level.price.toFixed(3)}</span>
                          <span className="relative text-right">{shortAmount(level.size)}</span>
                          <span className="relative text-right">{shortAmount(level.total)}</span>
                        </div>
                      );
                    })}
                  </div>

                  <div className="my-1 rounded bg-[#111f2d] px-2 py-1 text-center text-[11px] text-slate-300">
                    Spread {shortAmount(orderbookVM.spread)}
                  </div>

                  <div className="max-h-56 space-y-0.5 overflow-y-auto">
                    {orderbookVM.bids.map((level, idx) => {
                      const depth = Math.min(100, (safe(level.total) / bidMax) * 100);
                      return (
                        <div key={`bid-${idx}`} className="relative grid grid-cols-3 gap-2 overflow-hidden py-0.5 text-emerald-300">
                          <div className="absolute inset-y-0 right-0 bg-emerald-500/10" style={{ width: `${depth}%` }} />
                          <span className="relative">{level.price.toFixed(3)}</span>
                          <span className="relative text-right">{shortAmount(level.size)}</span>
                          <span className="relative text-right">{shortAmount(level.total)}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="max-h-[490px] space-y-1 overflow-y-auto text-xs">
                  {tradesVM.trades.slice(0, 120).map((trade) => (
                    <div key={`${trade.txHash}-${trade.at}`} className="grid grid-cols-[56px_1fr_80px] rounded bg-[#111f2d] px-2 py-1">
                      <span className={trade.side === 'buy' ? 'text-emerald-300' : 'text-rose-300'}>{trade.side}</span>
                      <span className="font-mono text-slate-200">{trade.price.toFixed(6)}</span>
                      <span className="text-right text-slate-400">{new Date(trade.at).toLocaleTimeString()}</span>
                    </div>
                  ))}
                  {!tradesVM.trades.length ? <p className="py-3 text-center text-slate-400">No trades yet.</p> : null}
                </div>
              )}
            </div>

            <div className="rounded border border-[#173448] bg-[#0a1724] p-2">
              <div className="mb-2 flex items-center justify-between text-xs">
                <div className="flex gap-1">
                  {(['market', 'limit'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => entryVM.setEntryMode(mode)}
                      className={`rounded px-2 py-1 uppercase ${entryVM.entryMode === mode ? 'bg-[#173449] text-[#75e6da]' : 'text-slate-400'}`}
                    >
                      {mode}
                    </button>
                  ))}
                  <button className="rounded px-2 py-1 text-slate-400">Pro</button>
                </div>
                <span className="text-slate-500">⌄</span>
              </div>

              <div className="mb-2 grid grid-cols-2 gap-1 rounded border border-[#21445b] bg-[#0c1a29] p-1 text-xs">
                <button
                  type="button"
                  onClick={() => entryVM.setSide('buy')}
                  className={`rounded px-2 py-1.5 font-semibold ${entryVM.side === 'buy' ? 'bg-[#58d4c8] text-[#052326]' : 'text-slate-300'}`}
                >
                  Buy
                </button>
                <button
                  type="button"
                  onClick={() => entryVM.setSide('sell')}
                  className={`rounded px-2 py-1.5 font-semibold ${entryVM.side === 'sell' ? 'bg-[#7b2935] text-rose-100' : 'text-slate-300'}`}
                >
                  Sell
                </button>
              </div>

              <div className="space-y-2 text-xs">
                <p className="text-slate-400">
                  Available to Trade <span className="float-right text-slate-200">{shortAmount(entryVM.availableBalance)} {entryVM.tokenInSymbol}</span>
                </p>

                <label className="space-y-1">
                  <span className="text-slate-500">Size</span>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={entryVM.amount}
                    onChange={(event) => entryVM.setAmount(event.target.value)}
                    className="h-9 w-full rounded border border-[#21445b] bg-[#0c1a29] px-2 text-slate-100"
                  />
                </label>

                <div className="space-y-1">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={sizePct}
                    onChange={(event) => setSizePct(Number(event.target.value))}
                    className="w-full accent-[#58d4c8]"
                  />
                  <p className="text-right text-slate-400">{sizePct}%</p>
                </div>

                <label className="flex items-center gap-2 text-[11px] text-cyan-100">
                  <input
                    type="checkbox"
                    checked={entryVM.autoWrapNative}
                    onChange={(event) => entryVM.setAutoWrapNative(event.target.checked)}
                  />
                  Auto-wrap native to {entryVM.wrappedNativeSymbol}
                </label>

                <button
                  type="button"
                  onClick={executePrimary}
                  disabled={entryVM.executing}
                  className="h-11 w-full rounded border border-[#5ee2d5] bg-[#58d4c8] text-sm font-semibold text-[#052326] disabled:opacity-60"
                >
                  {entryVM.executing
                    ? 'Executing...'
                    : !entryVM.isConnected
                      ? 'Enable Trading'
                      : entryVM.entryMode === 'market' && !entryVM.quote
                        ? 'Get Quote'
                        : 'Execute Trade'}
                </button>

                <div className="rounded border border-[#21445b] bg-[#0c1a29] px-2 py-1.5 text-[11px] text-slate-300">
                  <p className="flex justify-between"><span>Order Value</span><span>N/A</span></p>
                  <p className="mt-0.5 flex justify-between"><span>Slippage</span><span>Est: 0% / Max: {(entryVM.slippageBps / 100).toFixed(2)}%</span></p>
                  <p className="mt-0.5 flex justify-between"><span>Fees</span><span>{((entryVM.quote?.total_fee_bps ?? 30) / 10000 * 100).toFixed(4)}% / {((entryVM.quote?.protocol_fee_bps ?? 5) / 10000 * 100).toFixed(4)}%</span></p>
                </div>

                <button className="h-10 w-full rounded border border-[#5ee2d5] bg-[#58d4c8] text-sm font-semibold text-[#052326]">Deposit</button>
                <div className="grid grid-cols-2 gap-1">
                  <button className="h-8 rounded border border-[#21445b] bg-[#0c1a29] text-[11px] text-slate-200">Perps ↔ Spot</button>
                  <button className="h-8 rounded border border-[#21445b] bg-[#0c1a29] text-[11px] text-slate-200">Withdraw</button>
                </div>

                <div className="rounded border border-[#21445b] bg-[#0c1a29] px-2 py-1.5 text-[11px] text-slate-300">
                  <p className="font-semibold text-slate-200">Account Equity</p>
                  <p className="mt-1 flex justify-between"><span>Spot</span><span>$0.00</span></p>
                  <p className="flex justify-between"><span>Perps</span><span>$0.00</span></p>
                  <p className="flex justify-between"><span>Perps Overview</span><span>--</span></p>
                </div>

                {entryVM.quote ? (
                  <div className="rounded border border-[#21445b] bg-[#0c1a29] px-2 py-1 text-[11px] text-slate-300">
                    <p>Route: {entryVM.quote.route.join(' -> ')}</p>
                    <p>Expected: {entryVM.quote.expected_out} {entryVM.quote.token_out}</p>
                    <p>Minimum: {entryVM.quote.min_out} {entryVM.quote.token_out}</p>
                    {entryVM.staleQuote ? <p className="text-amber-300">stale quote</p> : null}
                  </div>
                ) : null}

                {entryVM.error ? <p className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-300">{entryVM.error}</p> : null}
                {entryVM.status ? <p className="rounded border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 text-[11px] text-cyan-200">{entryVM.status}</p> : null}
              </div>
            </div>
          </section>
        </div>

        <section className={`${mobilePanel === 'account' ? 'block' : 'hidden'} mt-1 rounded border border-[#173448] bg-[#0a1724] p-2 lg:block`}>
          <div className="mb-2 flex flex-wrap items-center gap-1">
            {([
              ['balances', 'Balances'],
              ['positions', 'Positions'],
              ['open-orders', 'Open Orders'],
              ['twap', 'TWAP'],
              ['trade-history', 'Trade History'],
              ['funding-history', 'Funding History'],
              ['order-history', 'Order History']
            ] as const).map(([tab, label]) => (
              <button
                key={tab}
                type="button"
                onClick={() => setAccountTab(tab)}
                className={`rounded px-2 py-1 text-xs ${accountTab === tab ? 'bg-[#173449] text-[#75e6da]' : 'text-slate-400'}`}
              >
                {label}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-2 text-[11px] text-slate-500">
              <span>Send</span>
              <span>Transfer</span>
              <span>Repay</span>
              <span>Contract</span>
            </div>
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_380px] gap-1">
            <div className="rounded border border-[#183549] bg-[#08131f] p-2">
              {accountTab === 'balances' ? (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[680px] text-xs">
                    <thead>
                      <tr className="text-left text-slate-500">
                        <th className="px-2 py-1">Coin</th>
                        <th className="px-2 py-1 text-right">Total Balance</th>
                        <th className="px-2 py-1 text-right">Available Balance</th>
                        <th className="px-2 py-1 text-right">USD Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-t border-[#183549] text-slate-200">
                        <td className="px-2 py-1.5">Native {chainId === 97 ? 'tBNB' : 'gas token'}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{shortAmount(entryVM.nativeBalance)}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{shortAmount(entryVM.nativeBalance)}</td>
                        <td className="px-2 py-1.5 text-right text-slate-500">n/a</td>
                      </tr>
                      {marketVM.chainTokens.map((token) => (
                        <tr key={`bal-${token.address}-${token.symbol}`} className="border-t border-[#183549] text-slate-200">
                          <td className="px-2 py-1.5">{token.symbol}</td>
                          <td className="px-2 py-1.5 text-right font-mono">{shortAmount(entryVM.walletBalances[token.symbol] || '0')}</td>
                          <td className="px-2 py-1.5 text-right font-mono">{shortAmount(entryVM.walletBalances[token.symbol] || '0')}</td>
                          <td className="px-2 py-1.5 text-right text-slate-500">n/a</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="py-10 text-center text-xs text-slate-400">{accountTab} panel placeholder ready.</div>
              )}
            </div>

            <div className="rounded border border-[#183549] bg-[#08131f] p-2">
              <p className="mb-1 text-xs text-slate-400">Recent Activity</p>
              <div className="max-h-40 space-y-1 overflow-y-auto">
                {tradesVM.trades.slice(0, 20).map((trade) => (
                  <div key={`${trade.txHash}-${trade.at}`} className="rounded bg-[#101f2d] px-2 py-1 text-xs">
                    <p className={trade.side === 'buy' ? 'text-emerald-300' : 'text-rose-300'}>
                      {trade.side.toUpperCase()} {shortAmount(trade.baseAmount)} {trade.baseToken}
                    </p>
                    <p className="text-[11px] text-slate-400">{new Date(trade.at).toLocaleString()}</p>
                  </div>
                ))}
                {!tradesVM.trades.length ? <p className="px-2 py-3 text-xs text-slate-500">No activity yet.</p> : null}
              </div>
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
      </main>
    </div>
  );
}
