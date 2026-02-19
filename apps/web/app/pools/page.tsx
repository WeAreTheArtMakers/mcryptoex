'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

const API_BASE = process.env.NEXT_PUBLIC_TEMPO_API_BASE || 'http://localhost:8500';
const LOCAL_CHAIN_ENABLED = process.env.NEXT_PUBLIC_ENABLE_LOCAL_CHAIN === 'true';
const ENV_DEFAULT_CHAIN_ID = Number(process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID || (LOCAL_CHAIN_ENABLED ? '31337' : '97'));
const DEFAULT_CHAIN_ID = Number.isFinite(ENV_DEFAULT_CHAIN_ID) ? ENV_DEFAULT_CHAIN_ID : LOCAL_CHAIN_ENABLED ? 31337 : 97;

type NetworkItem = {
  chain_id: number;
  name: string;
  pair_count?: number;
};

type TokensResponse = {
  networks?: NetworkItem[];
};

type PairRow = {
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

type AnalyticsRow = {
  bucket: string;
  chain_id: number | string;
  volume?: string;
  revenue_usd?: string;
};

type AnalyticsResponse = {
  volume_by_chain_token: AnalyticsRow[];
  fee_revenue: AnalyticsRow[];
};

type TimePoint = {
  bucket: string;
  label: string;
  volume: number;
  fees: number;
};

type FeePoolPoint = {
  pair: string;
  feeUsd: number;
  swaps: number;
};

const DEFAULT_NETWORKS: NetworkItem[] = [
  { chain_id: 97, name: 'BNB Chain Testnet' },
  { chain_id: 11155111, name: 'Ethereum Sepolia' }
];

function n(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function shortAmount(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  if (parsed === 0) return '0';
  if (parsed < 0.000001) return parsed.toExponential(2);
  return parsed.toFixed(6).replace(/\.?0+$/, '');
}

export default function PoolsPage() {
  const [chainId, setChainId] = useState(DEFAULT_CHAIN_ID);
  const [networks, setNetworks] = useState<NetworkItem[]>(DEFAULT_NETWORKS);
  const [pairs, setPairs] = useState<PairRow[]>([]);
  const [timeline, setTimeline] = useState<TimePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const selectedNetwork = useMemo(() => networks.find((x) => x.chain_id === chainId), [networks, chainId]);

  const topPools = useMemo<FeePoolPoint[]>(() => {
    return pairs
      .map((pair) => ({
        pair: `${pair.token0_symbol}/${pair.token1_symbol}`,
        feeUsd: n(pair.total_fee_usd),
        swaps: n(pair.swaps)
      }))
      .sort((a, b) => b.feeUsd - a.feeUsd || b.swaps - a.swaps)
      .slice(0, 8);
  }, [pairs]);

  const totals = useMemo(() => {
    const totalFees = pairs.reduce((sum, pair) => sum + n(pair.total_fee_usd), 0);
    const totalSwaps = pairs.reduce((sum, pair) => sum + n(pair.swaps), 0);
    const totalNotionalIn = pairs.reduce((sum, pair) => sum + n(pair.total_amount_in), 0);
    return { totalFees, totalSwaps, totalNotionalIn };
  }, [pairs]);

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        setLoading(true);

        const [tokensRes, pairsRes, analyticsRes] = await Promise.all([
          fetch(`${API_BASE}/tokens`, { cache: 'no-store' }),
          fetch(`${API_BASE}/pairs?chain_id=${chainId}&limit=120`, { cache: 'no-store' }),
          fetch(`${API_BASE}/analytics?minutes=360`, { cache: 'no-store' })
        ]);

        if (!tokensRes.ok) throw new Error(`tokens unavailable (${tokensRes.status})`);
        if (!pairsRes.ok) throw new Error(`pairs unavailable (${pairsRes.status})`);
        if (!analyticsRes.ok) throw new Error(`analytics unavailable (${analyticsRes.status})`);

        const tokensPayload = (await tokensRes.json()) as TokensResponse;
        const pairsPayload = (await pairsRes.json()) as PairsResponse;
        const analyticsPayload = (await analyticsRes.json()) as AnalyticsResponse;

        if (!active) return;

        if (tokensPayload.networks?.length) setNetworks(tokensPayload.networks);
        setPairs(pairsPayload.rows || []);

        const map = new Map<string, TimePoint>();
        for (const row of analyticsPayload.volume_by_chain_token || []) {
          if (Number(row.chain_id) !== chainId) continue;
          const existing = map.get(row.bucket) || {
            bucket: row.bucket,
            label: new Date(row.bucket).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            volume: 0,
            fees: 0
          };
          existing.volume += n(row.volume);
          map.set(row.bucket, existing);
        }
        for (const row of analyticsPayload.fee_revenue || []) {
          if (Number(row.chain_id) !== chainId) continue;
          const existing = map.get(row.bucket) || {
            bucket: row.bucket,
            label: new Date(row.bucket).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            volume: 0,
            fees: 0
          };
          existing.fees += n(row.revenue_usd);
          map.set(row.bucket, existing);
        }

        setTimeline(Array.from(map.values()).sort((a, b) => a.bucket.localeCompare(b.bucket)).slice(-120));
        setError('');
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : 'failed to load pool explorer data');
        setPairs([]);
        setTimeline([]);
      } finally {
        if (active) setLoading(false);
      }
    }

    load();
    const timer = setInterval(load, 12_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [chainId]);

  return (
    <section className="space-y-4 rounded-3xl border border-slateblue/70 bg-gradient-to-br from-[#0f1d37]/95 via-[#102541]/90 to-[#143954]/80 p-6 shadow-halo">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-brass">Pools</p>
          <h2 className="mt-2 text-2xl font-semibold">Pool Explorer</h2>
        </div>
        <label className="text-xs uppercase tracking-[0.14em] text-slate-300">
          Chain
          <select
            value={chainId}
            onChange={(event) => setChainId(Number(event.target.value))}
            className="ml-2 rounded-lg border border-slateblue/70 bg-slate-950/80 px-3 py-2 text-sm"
          >
            {networks.map((network) => (
              <option key={network.chain_id} value={network.chain_id}>
                {network.name} ({network.chain_id})
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid gap-2 sm:grid-cols-4">
        <div className="rounded-xl border border-mint/45 bg-mint/10 p-3">
          <p className="text-[11px] uppercase tracking-[0.14em] text-mint">Pools</p>
          <p className="mt-1 font-mono">{pairs.length}</p>
        </div>
        <div className="rounded-xl border border-brass/45 bg-brass/10 p-3">
          <p className="text-[11px] uppercase tracking-[0.14em] text-amber-100">Total Swaps</p>
          <p className="mt-1 font-mono">{totals.totalSwaps}</p>
        </div>
        <div className="rounded-xl border border-cyan-300/40 bg-cyan-500/10 p-3">
          <p className="text-[11px] uppercase tracking-[0.14em] text-cyan-100">Fee USD</p>
          <p className="mt-1 font-mono">{totals.totalFees.toFixed(4)}</p>
        </div>
        <div className="rounded-xl border border-slateblue/50 bg-slate-950/55 p-3">
          <p className="text-[11px] uppercase tracking-[0.14em] text-slate-200">Notional In</p>
          <p className="mt-1 font-mono">{totals.totalNotionalIn.toFixed(4)}</p>
        </div>
      </div>

      {loading ? <p className="text-sm text-slate-300">Loading pool explorer...</p> : null}
      {error ? <p className="text-sm text-rose-300">{error}</p> : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <div className="h-72 rounded-2xl border border-slateblue/60 bg-[#081223]/70 p-2">
          {timeline.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={timeline}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.45} />
                <XAxis dataKey="label" stroke="#cbd5e1" tick={{ fontSize: 11 }} minTickGap={20} />
                <YAxis yAxisId="left" stroke="#34d399" tick={{ fontSize: 11 }} />
                <YAxis yAxisId="right" orientation="right" stroke="#f59e0b" tick={{ fontSize: 11 }} />
                <Tooltip
                  contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: '0.75rem' }}
                  formatter={(value, name) => [n(value).toFixed(6), String(name)]}
                />
                <Line yAxisId="left" dataKey="volume" name="volume" stroke="#34d399" dot={false} strokeWidth={2} />
                <Line yAxisId="right" dataKey="fees" name="fees_usd" stroke="#f59e0b" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-slate-300">No analytics bars yet for this chain.</div>
          )}
        </div>

        <div className="h-72 rounded-2xl border border-slateblue/60 bg-[#081223]/70 p-2">
          {topPools.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={topPools} margin={{ top: 10, right: 12, left: 6, bottom: 28 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.35} />
                <XAxis dataKey="pair" stroke="#cbd5e1" angle={-20} textAnchor="end" height={48} tick={{ fontSize: 10 }} />
                <YAxis stroke="#93c5fd" tick={{ fontSize: 11 }} />
                <Tooltip
                  contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: '0.75rem' }}
                  formatter={(value, name) => [n(value).toFixed(6), String(name)]}
                />
                <Bar dataKey="feeUsd" name="fee_usd" fill="#38bdf8" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-slate-300">No fee-bearing pools yet.</div>
          )}
        </div>
      </div>

      <section className="rounded-2xl border border-slateblue/60 bg-slate-950/45 p-4">
        <div className="flex items-center justify-between">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-300">Pool Board</p>
          <Link href="/liquidity" className="rounded-lg border border-mint/60 bg-mint/20 px-3 py-1.5 text-xs font-semibold text-mint">
            Create / Seed Pool
          </Link>
        </div>

        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-left text-xs">
            <thead className="text-slate-300">
              <tr>
                <th className="px-2 py-1">Pair</th>
                <th className="px-2 py-1">Reserves</th>
                <th className="px-2 py-1">Swaps</th>
                <th className="px-2 py-1">Fee USD</th>
                <th className="px-2 py-1">Last Swap</th>
                <th className="px-2 py-1">Action</th>
              </tr>
            </thead>
            <tbody>
              {pairs.length === 0 ? (
                <tr>
                  <td className="px-2 py-2 text-slate-300" colSpan={6}>
                    No pools discovered for {selectedNetwork?.name || chainId}.
                  </td>
                </tr>
              ) : (
                pairs.map((pair) => (
                  <tr key={pair.pool_address} className="border-t border-slateblue/30">
                    <td className="px-2 py-2">{pair.token0_symbol}/{pair.token1_symbol}</td>
                    <td className="px-2 py-2 font-mono">
                      {shortAmount(pair.reserve0_decimal)} / {shortAmount(pair.reserve1_decimal)}
                    </td>
                    <td className="px-2 py-2">{pair.swaps}</td>
                    <td className="px-2 py-2 font-mono">{shortAmount(pair.total_fee_usd)}</td>
                    <td className="px-2 py-2">{pair.last_swap_at ? new Date(pair.last_swap_at).toLocaleString() : 'n/a'}</td>
                    <td className="px-2 py-2">
                      <Link
                        href={`/liquidity?tokenA=${encodeURIComponent(pair.token0_symbol)}&tokenB=${encodeURIComponent(pair.token1_symbol)}`}
                        className="rounded-md border border-cyan-300/60 bg-cyan-500/20 px-2 py-1 text-xs font-semibold text-cyan-100"
                      >
                        Add Liquidity
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}
