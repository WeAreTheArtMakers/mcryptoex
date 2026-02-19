'use client';

import { useEffect, useMemo, useState } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi';
import {
  DEFAULT_CHAIN_ID,
  MarketRow,
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

function shortAddress(value?: string) {
  if (!value) return 'Not connected';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function isPositive(value: number | null) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function PairBadge({ selectedPair }: { selectedPair: MarketRow | null }) {
  return (
    <div className="rounded-xl border border-[#214157] bg-[#0b1b2a] px-4 py-3">
      <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Pair</p>
      <p className="mt-1 text-lg font-semibold text-slate-100">{selectedPair?.pair || 'Select pair'}</p>
    </div>
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
    <div className="rounded-xl border border-[#214157] bg-[#0b1b2a] px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Wallet</p>
          <p className="mt-1 text-sm font-semibold text-slate-100">{shortAddress(address)}</p>
          <p className="text-xs text-slate-400">Chain {walletChainId ?? 'read-only'}</p>
        </div>
        {isConnected ? (
          <button
            type="button"
            onClick={() => disconnect()}
            className="rounded-md border border-rose-500/40 bg-rose-500/10 px-2.5 py-1 text-xs font-semibold text-rose-200"
          >
            Disconnect
          </button>
        ) : null}
      </div>

      {!isConnected ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {connectable.slice(0, 2).map((connector) => (
            <button
              key={connector.uid || connector.id || connector.name}
              type="button"
              onClick={() => connect({ connector })}
              disabled={isPending}
              className="rounded-md border border-cyan-400/50 bg-cyan-500/10 px-2.5 py-1 text-xs font-semibold text-cyan-200 disabled:opacity-50"
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
          className="mt-3 rounded-md border border-amber-400/55 bg-amber-400/10 px-2.5 py-1 text-xs font-semibold text-amber-100 disabled:opacity-60"
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
  const [favorites, setFavorites] = useState<string[]>([]);

  const marketVM = useMarketListVM(chainId, searchQuery, filter, favorites);

  useEffect(() => {
    if (!marketVM.rows.length) {
      setSelectedPairId('');
      return;
    }
    if (!selectedPairId || !marketVM.allRows.some((row) => row.id === selectedPairId)) {
      const preferred = marketVM.rows.find((row) => row.pair.includes('MUSD')) || marketVM.rows[0];
      setSelectedPairId(preferred.id);
    }
  }, [marketVM.allRows, marketVM.rows, selectedPairId]);

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
      if ((event.target as HTMLElement | null)?.tagName === 'INPUT') return;

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
        const nextIndex =
          event.key === 'ArrowDown'
            ? Math.min(marketVM.rows.length - 1, current + 1)
            : Math.max(0, current - 1);
        setSelectedPairId(marketVM.rows[nextIndex].id);
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        entryVM.execute();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [entryVM, marketVM.rows, selectedPairId]);

  useEffect(() => {
    if (!selectedPair) return;

    if (selectedPair.pair === 'MUSD/WBNB' || selectedPair.pair === 'WBNB/MUSD') {
      if (selectedPair.token0 === 'MUSD' && selectedPair.token1 === 'WBNB') {
        entryVM.setSide('buy');
      }
      if (selectedPair.token0 === 'WBNB' && selectedPair.token1 === 'MUSD') {
        entryVM.setSide('sell');
      }
    }
  }, [selectedPair]);

  const chainLabel = marketVM.selectedNetwork ? `${marketVM.selectedNetwork.name} (${chainId})` : `Chain ${chainId}`;

  const currentPairPools = marketVM.allRows.length;
  const latestVolume = pairVM.metrics.volume24h;
  const latestFees = pairVM.metrics.fees24h;

  const chartReady = pairVM.chartPoints.some((point) => point.price || point.volume || point.fees);

  return (
    <div className="mx-[calc(50%-50vw)] w-screen px-3 pb-4 pt-1 md:px-4 xl:px-6">
      <div className="rounded-2xl border border-[#1f3b52] bg-[#071522] p-3 shadow-[0_22px_60px_rgba(0,0,0,0.45)] md:p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[11px] uppercase tracking-[0.22em] text-cyan-300/80">Exchange Movement</p>
            <h2 className="text-2xl font-semibold text-slate-100">Pro Trading Terminal</h2>
            <p className="text-xs text-slate-400">
              Wallet-first non-custodial execution. Tempo API is read-only for quote, analytics, and ledger views.
            </p>
          </div>
          <div className="grid w-full grid-cols-2 gap-2 md:w-auto md:grid-cols-4">
            <div className="rounded-xl border border-[#214157] bg-[#0b1b2a] px-3 py-2">
              <p className="text-[10px] uppercase tracking-[0.16em] text-slate-400">Chain</p>
              <p className="text-sm font-semibold text-slate-100">{chainId}</p>
            </div>
            <div className="rounded-xl border border-[#214157] bg-[#0b1b2a] px-3 py-2">
              <p className="text-[10px] uppercase tracking-[0.16em] text-slate-400">Pools</p>
              <p className="text-sm font-semibold text-slate-100">{currentPairPools}</p>
            </div>
            <div className="rounded-xl border border-[#214157] bg-[#0b1b2a] px-3 py-2">
              <p className="text-[10px] uppercase tracking-[0.16em] text-slate-400">Volume (24h)</p>
              <p className="text-sm font-semibold text-emerald-300">{shortAmount(latestVolume)}</p>
            </div>
            <div className="rounded-xl border border-[#214157] bg-[#0b1b2a] px-3 py-2">
              <p className="text-[10px] uppercase tracking-[0.16em] text-slate-400">Fees USD (24h)</p>
              <p className="text-sm font-semibold text-amber-300">{shortAmount(latestFees)}</p>
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
              className={`flex-1 rounded-md border px-2 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] ${
                mobilePanel === panel
                  ? 'border-cyan-400/80 bg-cyan-500/20 text-cyan-200'
                  : 'border-[#214157] bg-[#0b1b2a] text-slate-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="grid gap-3 lg:grid-cols-[330px_minmax(0,1fr)_390px]">
          <section className={`${mobilePanel === 'markets' ? 'block' : 'hidden'} space-y-2 lg:block`}>
            <div className="rounded-xl border border-[#214157] bg-[#081829] p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold text-slate-200">Market Watch</p>
                <div className="flex gap-1">
                  {(['all', 'favorites', 'spot'] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setFilter(value)}
                      className={`rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${
                        filter === value
                          ? 'bg-cyan-500/20 text-cyan-200'
                          : 'bg-[#0b1b2a] text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-2 flex items-center gap-2">
                <input
                  id="pro-market-search"
                  type="text"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="/ search pair or token"
                  className="w-full rounded-md border border-[#214157] bg-[#06111d] px-3 py-2 text-xs text-slate-100 outline-none placeholder:text-slate-500 focus:border-cyan-400/60"
                />
                <select
                  value={chainId}
                  onChange={(event) => setChainId(Number(event.target.value))}
                  className="rounded-md border border-[#214157] bg-[#06111d] px-2 py-2 text-xs text-slate-200"
                >
                  {(marketVM.networks.length ? marketVM.networks : [{ chain_id: chainId, name: chainLabel }]).map((network) => (
                    <option key={network.chain_id} value={network.chain_id}>
                      {network.chain_id}
                    </option>
                  ))}
                </select>
              </div>

              <div className="mt-3 rounded-md border border-[#193348] bg-[#06111d]">
                <div className="grid grid-cols-[24px_minmax(0,1fr)_90px_90px_90px] gap-2 border-b border-[#193348] px-2 py-2 text-[10px] uppercase tracking-[0.12em] text-slate-400">
                  <span>*</span>
                  <span>Pair</span>
                  <span className="text-right">Last</span>
                  <span className="text-right">24h %</span>
                  <span className="text-right">24h Vol</span>
                </div>
                <div className="max-h-[58vh] overflow-y-auto">
                  {marketVM.loading ? (
                    <div className="space-y-1 p-2">
                      {Array.from({ length: 8 }).map((_, idx) => (
                        <div key={idx} className="h-7 animate-pulse rounded bg-[#0d2132]" />
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
                          className={`grid w-full grid-cols-[24px_minmax(0,1fr)_90px_90px_90px] gap-2 px-2 py-1.5 text-xs transition ${
                            selected ? 'bg-cyan-500/18' : 'hover:bg-[#0f2335]'
                          }`}
                        >
                          <span
                            onClick={(event) => {
                              event.stopPropagation();
                              setFavorites((list) =>
                                list.includes(row.id) ? list.filter((item) => item !== row.id) : [row.id, ...list].slice(0, 50)
                              );
                            }}
                            className={`cursor-pointer text-center ${favorite ? 'text-amber-300' : 'text-slate-500'}`}
                            aria-hidden="true"
                          >
                            ★
                          </span>
                          <span className="truncate text-left text-slate-100">{row.pair}</span>
                          <span className="text-right font-mono text-slate-200">{row.last ? row.last.toFixed(6) : 'n/a'}</span>
                          <span className={`text-right font-mono ${isPositive(change) ? 'text-emerald-300' : 'text-rose-300'}`}>
                            {change === null ? 'n/a' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`}
                          </span>
                          <span className="text-right font-mono text-slate-300">{shortAmount(row.volume24h)}</span>
                        </button>
                      );
                    })
                  ) : (
                    <p className="p-3 text-xs text-slate-400">No tradable pairs found for this chain.</p>
                  )}
                </div>
              </div>

              {marketVM.error ? <p className="mt-2 text-xs text-rose-300">{marketVM.error}</p> : null}
            </div>
          </section>

          <section className={`${mobilePanel === 'chart' ? 'block' : 'hidden'} space-y-2 lg:block`}>
            <div className="rounded-xl border border-[#214157] bg-[#081829] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <PairBadge selectedPair={selectedPair} />
                <div className="flex items-center gap-1 rounded-xl border border-[#214157] bg-[#0b1b2a] p-1">
                  {(['1m', '5m', '1h', '1d'] as Timeframe[]).map((frame) => (
                    <button
                      key={frame}
                      type="button"
                      onClick={() => setTimeframe(frame)}
                      className={`rounded-md px-2 py-1 text-[11px] font-semibold uppercase ${
                        timeframe === frame
                          ? 'bg-cyan-500/20 text-cyan-200'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {frame}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
                <div className="rounded-lg border border-[#214157] bg-[#0b1b2a] px-3 py-2">
                  <p className="text-[10px] uppercase tracking-[0.12em] text-slate-400">Last</p>
                  <p className="font-mono text-sm text-slate-100">{shortAmount(pairVM.metrics.lastPrice)}</p>
                </div>
                <div className="rounded-lg border border-[#214157] bg-[#0b1b2a] px-3 py-2">
                  <p className="text-[10px] uppercase tracking-[0.12em] text-slate-400">24h Change</p>
                  <p
                    className={`font-mono text-sm ${
                      isPositive(pairVM.metrics.change24h) ? 'text-emerald-300' : 'text-rose-300'
                    }`}
                  >
                    {pairVM.metrics.change24h === null
                      ? 'n/a'
                      : `${pairVM.metrics.change24h >= 0 ? '+' : ''}${pairVM.metrics.change24h.toFixed(2)}%`}
                  </p>
                </div>
                <div className="rounded-lg border border-[#214157] bg-[#0b1b2a] px-3 py-2">
                  <p className="text-[10px] uppercase tracking-[0.12em] text-slate-400">Volume</p>
                  <p className="font-mono text-sm text-emerald-300">{shortAmount(pairVM.metrics.volume24h)}</p>
                </div>
                <div className="rounded-lg border border-[#214157] bg-[#0b1b2a] px-3 py-2">
                  <p className="text-[10px] uppercase tracking-[0.12em] text-slate-400">Fees</p>
                  <p className="font-mono text-sm text-amber-300">{shortAmount(pairVM.metrics.fees24h)}</p>
                </div>
              </div>

              <div className="mt-3 h-[420px] rounded-lg border border-[#193348] bg-[#06111d] p-2">
                {chartReady ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={pairVM.chartPoints} margin={{ top: 8, right: 10, left: 0, bottom: 14 }}>
                      <defs>
                        <linearGradient id="proPrice" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="4%" stopColor="#4ad6c2" stopOpacity={0.5} />
                          <stop offset="95%" stopColor="#4ad6c2" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="proVolume" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#2f76f6" stopOpacity={0.35} />
                          <stop offset="95%" stopColor="#2f76f6" stopOpacity={0.03} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1b3347" opacity={0.55} />
                      <XAxis dataKey="label" stroke="#6f8ba4" tick={{ fontSize: 10 }} minTickGap={20} />
                      <YAxis yAxisId="price" stroke="#4ad6c2" tick={{ fontSize: 10 }} />
                      <YAxis yAxisId="volume" orientation="right" stroke="#7fb3ff" tick={{ fontSize: 10 }} />
                      <Tooltip
                        contentStyle={{ background: '#0b1623', border: '1px solid #1f3b52', borderRadius: '0.75rem' }}
                        labelStyle={{ color: '#d1d5db' }}
                        formatter={(value, name) => [shortAmount(String(value)), String(name)]}
                      />
                      <Area yAxisId="price" dataKey="price" stroke="#4ad6c2" fill="url(#proPrice)" strokeWidth={2} />
                      <Area yAxisId="volume" dataKey="volume" stroke="#2f76f6" fill="url(#proVolume)" strokeWidth={1.5} />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-slate-400">
                    Waiting for chart inputs from swaps and analytics stream...
                  </div>
                )}
              </div>
              {pairVM.error ? <p className="mt-2 text-xs text-rose-300">{pairVM.error}</p> : null}
            </div>
          </section>

          <section className={`${mobilePanel === 'trade' ? 'block' : 'hidden'} space-y-2 lg:block`}>
            <div className="rounded-xl border border-[#214157] bg-[#081829] p-3">
              <WalletBadge chainId={chainId} />

              <div className="mt-3 rounded-xl border border-[#214157] bg-[#0b1b2a] p-2">
                <div className="grid grid-cols-2 gap-1">
                  {([
                    ['book', 'Order Book'],
                    ['trades', 'Trades']
                  ] as const).map(([tab, label]) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setBookTab(tab)}
                      className={`rounded-md px-2 py-1.5 text-xs font-semibold uppercase tracking-[0.12em] ${
                        bookTab === tab
                          ? 'bg-cyan-500/20 text-cyan-200'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {bookTab === 'book' ? (
                  <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                    <div className="text-slate-400">Price</div>
                    <div className="text-right text-slate-400">Size</div>
                    <div className="text-right text-slate-400">Total</div>

                    <div className="col-span-3 max-h-36 overflow-y-auto">
                      {orderbookVM.asks.map((level, idx) => (
                        <div key={`ask-${idx}`} className="grid grid-cols-3 gap-2 py-0.5 text-rose-300/90">
                          <span>{level.price.toFixed(6)}</span>
                          <span className="text-right">{shortAmount(level.size)}</span>
                          <span className="text-right">{shortAmount(level.total)}</span>
                        </div>
                      ))}
                    </div>

                    <div className="col-span-3 my-1 rounded-md bg-[#06111d] px-2 py-1 text-center text-[11px] text-slate-300">
                      Spread {shortAmount(orderbookVM.spread)}
                    </div>

                    <div className="col-span-3 max-h-36 overflow-y-auto">
                      {orderbookVM.bids.map((level, idx) => (
                        <div key={`bid-${idx}`} className="grid grid-cols-3 gap-2 py-0.5 text-emerald-300/90">
                          <span>{level.price.toFixed(6)}</span>
                          <span className="text-right">{shortAmount(level.size)}</span>
                          <span className="text-right">{shortAmount(level.total)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="mt-2 max-h-72 overflow-y-auto space-y-1">
                    {tradesVM.trades.slice(0, 60).map((trade) => (
                      <div key={trade.txHash} className="grid grid-cols-[56px_1fr_72px] items-center gap-2 rounded bg-[#06111d] px-2 py-1 text-xs">
                        <span className={`${trade.side === 'buy' ? 'text-emerald-300' : 'text-rose-300'}`}>{trade.side}</span>
                        <span className="font-mono text-slate-200">{trade.price.toFixed(6)}</span>
                        <span className="text-right text-slate-400">{new Date(trade.at).toLocaleTimeString()}</span>
                      </div>
                    ))}
                    {!tradesVM.trades.length ? <p className="py-3 text-center text-xs text-slate-400">No recent trades yet.</p> : null}
                  </div>
                )}
              </div>

              <div className="mt-3 rounded-xl border border-[#214157] bg-[#0b1b2a] p-3">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-300">Order Entry</p>
                  <div className="rounded-md border border-[#193348] bg-[#06111d] p-1 text-[11px]">
                    {(['market', 'limit'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => entryVM.setEntryMode(mode)}
                        className={`rounded px-2 py-1 font-semibold uppercase tracking-[0.12em] ${
                          entryVM.entryMode === mode
                            ? 'bg-cyan-500/20 text-cyan-200'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {mode}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="mb-2 grid grid-cols-2 gap-1 rounded-md bg-[#06111d] p-1 text-xs">
                  <button
                    type="button"
                    onClick={() => entryVM.setSide('buy')}
                    className={`rounded px-2 py-1.5 font-semibold ${
                      entryVM.side === 'buy'
                        ? 'bg-emerald-500/20 text-emerald-200'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Buy {selectedPair?.token0 || 'Base'}
                  </button>
                  <button
                    type="button"
                    onClick={() => entryVM.setSide('sell')}
                    className={`rounded px-2 py-1.5 font-semibold ${
                      entryVM.side === 'sell'
                        ? 'bg-rose-500/20 text-rose-200'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Sell {selectedPair?.token0 || 'Base'}
                  </button>
                </div>

                <div className="space-y-2 text-xs">
                  <div className="grid grid-cols-2 gap-2">
                    <label className="space-y-1">
                      <span className="text-slate-400">Token In</span>
                      <input
                        value={entryVM.tokenInSymbol}
                        readOnly
                        className="w-full rounded border border-[#214157] bg-[#06111d] px-2 py-1.5 text-slate-100"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-slate-400">Token Out</span>
                      <input
                        value={entryVM.tokenOutSymbol}
                        readOnly
                        className="w-full rounded border border-[#214157] bg-[#06111d] px-2 py-1.5 text-slate-100"
                      />
                    </label>
                  </div>

                  <label className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400">Amount</span>
                      <button
                        type="button"
                        onClick={entryVM.setMaxAmount}
                        className="rounded border border-[#214157] px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] text-cyan-200"
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
                      className="w-full rounded border border-[#214157] bg-[#06111d] px-2 py-1.5 text-slate-100"
                    />
                  </label>

                  {entryVM.entryMode === 'limit' ? (
                    <label className="space-y-1">
                      <span className="text-slate-400">Limit Price</span>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={entryVM.limitPrice}
                        onChange={(event) => entryVM.setLimitPrice(event.target.value)}
                        className="w-full rounded border border-[#214157] bg-[#06111d] px-2 py-1.5 text-slate-100"
                      />
                    </label>
                  ) : null}

                  <label className="space-y-1">
                    <span className="text-slate-400">Slippage (bps)</span>
                    <input
                      type="number"
                      min={1}
                      max={3000}
                      value={entryVM.slippageBps}
                      onChange={(event) => entryVM.setSlippageBps(Number(event.target.value))}
                      className="w-full rounded border border-[#214157] bg-[#06111d] px-2 py-1.5 text-slate-100"
                    />
                  </label>

                  <label className="flex items-center gap-2 rounded-md border border-cyan-500/30 bg-cyan-500/8 px-2 py-1.5 text-[11px] text-cyan-100">
                    <input
                      type="checkbox"
                      checked={entryVM.autoWrapNative}
                      onChange={(event) => entryVM.setAutoWrapNative(event.target.checked)}
                    />
                    Auto-wrap native to {entryVM.wrappedNativeSymbol} when needed
                  </label>

                  <div className="rounded-md border border-[#214157] bg-[#06111d] px-2 py-1.5 text-[11px] text-slate-300">
                    Available to trade: {shortAmount(entryVM.availableBalance)} {entryVM.tokenInSymbol}
                    <br />
                    Native {chainId === 97 ? 'tBNB' : 'gas'}: {shortAmount(entryVM.nativeBalance)}
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={entryVM.requestQuote}
                      disabled={entryVM.quoteLoading}
                      className="rounded-md border border-cyan-400/60 bg-cyan-500/12 px-3 py-2 text-xs font-semibold text-cyan-200 disabled:opacity-50"
                    >
                      {entryVM.quoteLoading ? 'Quoting...' : 'Get Quote'}
                    </button>
                    <button
                      type="button"
                      onClick={entryVM.execute}
                      disabled={entryVM.executing || !selectedPair}
                      className="rounded-md border border-emerald-400/60 bg-emerald-500/15 px-3 py-2 text-xs font-semibold text-emerald-200 disabled:opacity-50"
                    >
                      {entryVM.executing
                        ? 'Executing...'
                        : entryVM.entryMode === 'market'
                          ? 'Execute Market Swap'
                          : 'Queue Limit Draft'}
                    </button>
                  </div>

                  {entryVM.quote ? (
                    <div className="rounded-md border border-[#214157] bg-[#06111d] px-2 py-1.5 text-[11px] text-slate-200">
                      <p>
                        Expected: {entryVM.quote.expected_out} {entryVM.quote.token_out}
                      </p>
                      <p>
                        Minimum: {entryVM.quote.min_out} {entryVM.quote.token_out}
                      </p>
                      <p>Route: {entryVM.quote.route.join(' -> ')}</p>
                      <p>
                        Fee split: {entryVM.quote.total_fee_bps ?? 30} bps total / {entryVM.quote.lp_fee_bps ?? 25} LP /{' '}
                        {entryVM.quote.protocol_fee_bps ?? 5} protocol
                      </p>
                      {entryVM.staleQuote ? <p className="text-amber-300">Quote may be stale. Refresh before execute.</p> : null}
                    </div>
                  ) : null}

                  {entryVM.error ? <p className="text-xs text-rose-300">{entryVM.error}</p> : null}
                  {entryVM.status ? <p className="text-xs text-cyan-200">{entryVM.status}</p> : null}
                </div>
              </div>

              <div className="mt-3 rounded-xl border border-[#214157] bg-[#0b1b2a] p-3 text-xs text-slate-300">
                <p className="font-semibold uppercase tracking-[0.12em] text-slate-200">Route / Liquidity</p>
                <p className="mt-1">
                  Route target: {entryVM.tokenInSymbol} {'->'} {entryVM.tokenOutSymbol}
                </p>
                <p>Pair reserves: {selectedPair ? `${shortAmount(selectedPair.reserve0)} / ${shortAmount(selectedPair.reserve1)}` : 'n/a'}</p>
                <p>Protocol fee sink: on-chain treasury via pair fee split (non-custodial).</p>
              </div>
            </div>
          </section>
        </div>

        <section className={`${mobilePanel === 'account' ? 'block' : 'hidden'} mt-3 lg:block`}>
          <div className="rounded-xl border border-[#214157] bg-[#081829] p-3">
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="rounded-lg border border-[#193348] bg-[#06111d] p-2">
                <p className="px-1 pb-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-300">Portfolio Summary</p>
                <div className="h-48">
                  {marketVM.chainTokens.length ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={marketVM.chainTokens.map((token) => ({
                          symbol: token.symbol,
                          balance: Number(entryVM.walletBalances[token.symbol] || '0')
                        }))}
                        margin={{ top: 8, right: 8, left: 0, bottom: 18 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="#1b3347" opacity={0.5} />
                        <XAxis dataKey="symbol" stroke="#6f8ba4" tick={{ fontSize: 10 }} />
                        <YAxis stroke="#7fb3ff" tick={{ fontSize: 10 }} />
                        <Tooltip
                          contentStyle={{ background: '#0b1623', border: '1px solid #1f3b52', borderRadius: '0.75rem' }}
                          formatter={(value) => [shortAmount(String(value)), 'balance']}
                        />
                        <Bar dataKey="balance" fill="#2f76f6" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs text-slate-400">No token registry loaded.</div>
                  )}
                </div>
              </div>

              <div className="rounded-lg border border-[#193348] bg-[#06111d] p-2">
                <p className="px-1 pb-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-300">Recent Activity</p>
                <div className="max-h-52 space-y-1 overflow-y-auto">
                  {tradesVM.trades.slice(0, 18).map((trade) => (
                    <div key={`activity-${trade.txHash}`} className="rounded bg-[#0c1f31] px-2 py-1 text-xs text-slate-200">
                      <p>
                        {trade.side.toUpperCase()} {shortAmount(trade.baseAmount)} {trade.baseToken} @ {trade.price.toFixed(6)}
                      </p>
                      <p className="text-[11px] text-slate-400">
                        {new Date(trade.at).toLocaleString()} | fee ${shortAmount(trade.feeUsd)} | gas ${shortAmount(trade.gasUsd)}
                      </p>
                    </div>
                  ))}
                  {!tradesVM.trades.length ? <p className="px-2 py-3 text-xs text-slate-400">No recent swaps yet.</p> : null}
                </div>
              </div>
            </div>

            <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="rounded-lg border border-[#193348] bg-[#06111d] p-2">
                <p className="px-1 pb-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-300">Balances</p>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[440px] text-xs">
                    <thead>
                      <tr className="text-left text-slate-400">
                        <th className="px-2 py-1">Token</th>
                        <th className="px-2 py-1 text-right">Wallet Balance</th>
                        <th className="px-2 py-1 text-right">USD (approx)</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-t border-[#193348] text-slate-200">
                        <td className="px-2 py-1.5">Native {chainId === 97 ? 'tBNB' : 'gas token'}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{shortAmount(entryVM.nativeBalance)}</td>
                        <td className="px-2 py-1.5 text-right text-slate-400">n/a</td>
                      </tr>
                      {marketVM.chainTokens.map((token) => (
                        <tr key={token.address + token.symbol} className="border-t border-[#193348] text-slate-200">
                          <td className="px-2 py-1.5">{token.symbol}</td>
                          <td className="px-2 py-1.5 text-right font-mono">{shortAmount(entryVM.walletBalances[token.symbol] || '0')}</td>
                          <td className="px-2 py-1.5 text-right text-slate-400">n/a</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="rounded-lg border border-[#193348] bg-[#06111d] p-2">
                <p className="px-1 pb-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-300">Open Limit Drafts</p>
                <div className="max-h-52 space-y-1 overflow-y-auto">
                  {entryVM.limitDrafts.slice(0, 15).map((draft) => (
                    <div key={draft.id} className="rounded bg-[#0c1f31] px-2 py-1 text-xs text-slate-200">
                      <p>
                        {draft.side.toUpperCase()} {draft.amount} {draft.token_out} with {draft.token_in} @ {draft.limit_price}
                      </p>
                      <p className="text-[11px] text-slate-400">{new Date(draft.created_at).toLocaleString()}</p>
                    </div>
                  ))}
                  {!entryVM.limitDrafts.length ? <p className="px-2 py-3 text-xs text-slate-400">No local drafts yet.</p> : null}
                </div>
              </div>
            </div>
          </div>
        </section>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#214157] bg-[#0b1b2a] px-3 py-2 text-[11px] text-slate-400">
          <p>Shortcuts: `/` search, `↑↓` pair select, `Enter` execute.</p>
          <p>
            Security: wallet-signed only, backend cannot custody funds or authorize trades.
            {entryVM.canSwitchNetwork ? ' Wallet chain mismatch detected.' : ''}
          </p>
        </div>
      </div>
    </div>
  );
}
