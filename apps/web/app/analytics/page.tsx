'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';

const API_BASE = process.env.NEXT_PUBLIC_TEMPO_API_BASE || 'http://localhost:8500';
const FETCH_ATTEMPTS = Math.max(1, Number(process.env.NEXT_PUBLIC_ANALYTICS_FETCH_ATTEMPTS || '4'));
const FETCH_BASE_DELAY_MS = Math.max(150, Number(process.env.NEXT_PUBLIC_ANALYTICS_RETRY_BASE_MS || '500'));
const FETCH_MAX_DELAY_MS = Math.max(FETCH_BASE_DELAY_MS, Number(process.env.NEXT_PUBLIC_ANALYTICS_RETRY_MAX_MS || '6000'));

type AnalyticsPayload = {
  minutes: number;
  volume_by_chain_token: Array<Record<string, string | number>>;
  fee_revenue: Array<Record<string, string | number>>;
  gas_cost_averages: Array<Record<string, string | number>>;
  fee_breakdown_by_pool_token: Array<Record<string, string | number>>;
  protocol_revenue_musd_daily: Array<Record<string, string | number>>;
  conversion_slippage: Array<Record<string, string | number>>;
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
};

type PairsPayload = {
  rows: PairRow[];
};

type NetworkItem = {
  chain_id: number;
  name: string;
};

type TokensPayload = {
  networks?: NetworkItem[];
};

type TimePoint = {
  bucket: string;
  label: string;
  volume: number;
  fees: number;
  gas: number;
  slippage: number;
};

type FeePoint = {
  key: string;
  fee: number;
};

type PoolSnapshotPoint = {
  label: string;
  liquidity: number;
  feeUsd: number;
  swaps: number;
};

type RetryState = {
  active: boolean;
  target: string;
  attempt: number;
  attempts: number;
  nextRetryAt: number;
  reason: string;
};

function n(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  target: string,
  onRetry: (state: RetryState) => void
): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) return res;
      const retriable = res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500;
      if (!retriable || attempt === FETCH_ATTEMPTS) {
        throw new Error(`${target} endpoint unavailable (${res.status})`);
      }
      throw new Error(`${target} endpoint temporary failure (${res.status})`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('request failed');
      if (attempt >= FETCH_ATTEMPTS) break;
      const backoff = Math.min(FETCH_MAX_DELAY_MS, Math.round(FETCH_BASE_DELAY_MS * 2 ** (attempt - 1)));
      const jitter = Math.floor(Math.random() * Math.max(60, Math.round(backoff * 0.25)));
      const delayMs = backoff + jitter;
      onRetry({
        active: true,
        target,
        attempt,
        attempts: FETCH_ATTEMPTS,
        nextRetryAt: Date.now() + delayMs,
        reason: lastError.message
      });
      await sleep(delayMs);
    }
  }
  throw lastError || new Error(`${target} request failed`);
}

function sumDecimal(rows: Array<Record<string, string | number>>, field: string): number {
  return rows.reduce((sum, row) => sum + n(row[field]), 0);
}

function formatMetric(value: number | null, digits: number): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  return value.toFixed(digits);
}

export default function AnalyticsPage() {
  const [minutes, setMinutes] = useState(180);
  const [chainFilter, setChainFilter] = useState<number>(97);
  const [networks, setNetworks] = useState<NetworkItem[]>([
    { chain_id: 97, name: 'BNB Chain Testnet' },
    { chain_id: 11155111, name: 'Ethereum Sepolia' }
  ]);
  const [payload, setPayload] = useState<AnalyticsPayload | null>(null);
  const [pairRows, setPairRows] = useState<PairRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastUpdateAt, setLastUpdateAt] = useState<Date | null>(null);
  const [retryState, setRetryState] = useState<RetryState>({
    active: false,
    target: '',
    attempt: 0,
    attempts: FETCH_ATTEMPTS,
    nextRetryAt: 0,
    reason: ''
  });
  const [isStale, setIsStale] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;

    async function load() {
      try {
        setLoading(true);
        setRetryState((current) => ({ ...current, active: false, reason: '' }));

        const pairsPath = chainFilter === 0 ? '/pairs?limit=120' : `/pairs?chain_id=${chainFilter}&limit=120`;
        const [analyticsRes, tokensRes, pairsRes] = await Promise.all([
          fetchWithRetry(`${API_BASE}/analytics?minutes=${minutes}`, 'analytics', (state) => {
            if (!active) return;
            setRetryState(state);
          }),
          fetchWithRetry(`${API_BASE}/tokens`, 'tokens', (state) => {
            if (!active) return;
            setRetryState(state);
          }),
          fetchWithRetry(`${API_BASE}${pairsPath}`, 'pairs', (state) => {
            if (!active) return;
            setRetryState(state);
          })
        ]);

        const body = (await analyticsRes.json()) as AnalyticsPayload;
        const tokenBody = (await tokensRes.json()) as TokensPayload;
        const pairBody = (await pairsRes.json()) as PairsPayload;

        if (!active) return;

        setPayload(body);
        setPairRows(Array.isArray(pairBody.rows) ? pairBody.rows : []);
        if (tokenBody.networks?.length) setNetworks(tokenBody.networks);
        setLastUpdateAt(new Date());
        setError('');
        setIsStale(false);
        setRetryState((current) => ({ ...current, active: false, reason: '' }));
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : 'failed to load analytics');
        setIsStale(true);
      } finally {
        if (active) {
          setLoading(false);
          timer = window.setTimeout(load, 12_000);
        }
      }
    }

    void load();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [minutes, chainFilter]);

  const filtered = useMemo(() => {
    if (!payload) {
      return {
        volumeRows: [] as Array<Record<string, string | number>>,
        feeRows: [] as Array<Record<string, string | number>>,
        gasRows: [] as Array<Record<string, string | number>>,
        feeBreakdownRows: [] as Array<Record<string, string | number>>,
        revenueRows: [] as Array<Record<string, string | number>>,
        slippageRows: [] as Array<Record<string, string | number>>
      };
    }

    const byChain = (rows: Array<Record<string, string | number>>) =>
      rows.filter((row) => chainFilter === 0 || Number(row.chain_id) === chainFilter);

    return {
      volumeRows: byChain(payload.volume_by_chain_token),
      feeRows: byChain(payload.fee_revenue),
      gasRows: byChain(payload.gas_cost_averages),
      feeBreakdownRows: byChain(payload.fee_breakdown_by_pool_token),
      revenueRows: byChain(payload.protocol_revenue_musd_daily),
      slippageRows: byChain(payload.conversion_slippage)
    };
  }, [payload, chainFilter]);

  const timeline = useMemo<TimePoint[]>(() => {
    const map = new Map<string, TimePoint>();

    for (const row of filtered.volumeRows) {
      const bucket = String(row.bucket || '');
      if (!bucket) continue;
      const point = map.get(bucket) || {
        bucket,
        label: new Date(bucket).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        volume: 0,
        fees: 0,
        gas: 0,
        slippage: 0
      };
      point.volume += n(row.volume);
      map.set(bucket, point);
    }

    for (const row of filtered.feeRows) {
      const bucket = String(row.bucket || '');
      if (!bucket) continue;
      const point = map.get(bucket) || {
        bucket,
        label: new Date(bucket).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        volume: 0,
        fees: 0,
        gas: 0,
        slippage: 0
      };
      point.fees += n(row.revenue_usd);
      map.set(bucket, point);
    }

    for (const row of filtered.gasRows) {
      const bucket = String(row.bucket || '');
      if (!bucket) continue;
      const point = map.get(bucket) || {
        bucket,
        label: new Date(bucket).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        volume: 0,
        fees: 0,
        gas: 0,
        slippage: 0
      };
      point.gas += n(row.avg_gas_cost_usd);
      map.set(bucket, point);
    }

    for (const row of filtered.slippageRows) {
      const bucket = String(row.bucket || '');
      if (!bucket) continue;
      const point = map.get(bucket) || {
        bucket,
        label: new Date(bucket).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        volume: 0,
        fees: 0,
        gas: 0,
        slippage: 0
      };
      point.slippage += n(row.slippage_bps);
      map.set(bucket, point);
    }

    return Array.from(map.values()).sort((a, b) => a.bucket.localeCompare(b.bucket)).slice(-140);
  }, [filtered]);

  const feeByPoolOrToken = useMemo<FeePoint[]>(() => {
    const map = new Map<string, number>();
    for (const row of filtered.feeBreakdownRows) {
      const pool = String(row.pool_address || '').slice(0, 10);
      const token = String(row.token || 'token');
      const key = `${token}:${pool || 'n/a'}`;
      map.set(key, (map.get(key) || 0) + n(row.fee_amount));
    }
    return Array.from(map.entries())
      .map(([key, fee]) => ({ key, fee }))
      .sort((a, b) => b.fee - a.fee)
      .slice(0, 10);
  }, [filtered]);

  const revenueDaily = useMemo(
    () =>
      filtered.revenueRows
        .map((row) => ({
          day: String(row.bucket || '').slice(0, 10),
          revenue: n(row.revenue_musd)
        }))
        .sort((a, b) => a.day.localeCompare(b.day))
        .slice(-30),
    [filtered]
  );
  const poolSnapshot = useMemo<PoolSnapshotPoint[]>(() => {
    return pairRows
      .filter((row) => chainFilter === 0 || Number(row.chain_id) === chainFilter)
      .map((row) => ({
        label: `${row.token0_symbol}/${row.token1_symbol}`,
        liquidity: n(row.reserve0_decimal) + n(row.reserve1_decimal),
        feeUsd: n(row.total_fee_usd),
        swaps: n(row.swaps)
      }))
      .sort((a, b) => b.liquidity - a.liquidity)
      .slice(0, 12);
  }, [pairRows, chainFilter]);

  const summary = useMemo(() => {
    return {
      totalVolume: filtered.volumeRows.length ? sumDecimal(filtered.volumeRows, 'volume') : null,
      totalFeeRevenue: filtered.feeRows.length ? sumDecimal(filtered.feeRows, 'revenue_usd') : null,
      avgGas: filtered.gasRows.length ? sumDecimal(filtered.gasRows, 'avg_gas_cost_usd') / filtered.gasRows.length : null,
      revenueMusd: filtered.revenueRows.length ? sumDecimal(filtered.revenueRows, 'revenue_musd') : null,
      avgSlippageBps: filtered.slippageRows.length
        ? sumDecimal(filtered.slippageRows, 'slippage_bps') / filtered.slippageRows.length
        : null,
      poolLiquidity: poolSnapshot.length ? poolSnapshot.reduce((sum, row) => sum + row.liquidity, 0) : null
    };
  }, [filtered, poolSnapshot]);

  const retryDelayMs = Math.max(0, retryState.nextRetryAt - nowMs);

  return (
    <section className="space-y-4 rounded-3xl border border-slateblue/70 bg-gradient-to-br from-[#101a34]/95 via-[#122744]/90 to-[#1a2f4d]/80 p-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-brass">Analytics</p>
          <h2 className="mt-2 text-2xl font-semibold">Tempo Metrics Dashboard</h2>
        </div>
        <div className="rounded-xl border border-slateblue/70 bg-slate-950/60 px-3 py-2 text-xs text-slate-200">
          Live refresh 12s {lastUpdateAt ? `| ${lastUpdateAt.toLocaleTimeString()}` : ''}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm text-slate-200">
          Window (minutes)
          <input
            type="number"
            min={15}
            max={1440}
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
            className="ml-2 w-28 rounded-lg border border-slateblue/70 bg-slate-950/80 px-2 py-1"
          />
        </label>
        <label className="text-sm text-slate-200">
          Chain
          <select
            value={chainFilter}
            onChange={(e) => setChainFilter(Number(e.target.value))}
            className="ml-2 rounded-lg border border-slateblue/70 bg-slate-950/80 px-2 py-1"
          >
            <option value={0}>All Chains</option>
            {networks.map((network) => (
              <option key={network.chain_id} value={network.chain_id}>
                {network.name} ({network.chain_id})
              </option>
            ))}
          </select>
        </label>
      </div>

      {loading ? <p className="text-sm text-slate-300">Loading analytics...</p> : null}
      {error ? <p className="text-sm text-rose-300">{error}</p> : null}
      {retryState.active ? (
        <p className="text-xs text-amber-300">
          Retry/backoff: {retryState.target} attempt {retryState.attempt}/{retryState.attempts} in{' '}
          {(retryDelayMs / 1000).toFixed(1)}s ({retryState.reason})
        </p>
      ) : null}
      {isStale ? (
        <p className="text-xs text-amber-200">Showing last known metrics snapshot while the API reconnects.</p>
      ) : null}

      {!loading ? (
        <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
            <div className="rounded-xl border border-slateblue/50 bg-slate-950/60 p-3">
              <p className="text-xs uppercase tracking-[0.14em] text-slate-400">Total Volume</p>
              <p className={`mt-1 font-mono text-lg ${summary.totalVolume === null ? 'text-slate-500' : ''}`}>
                {formatMetric(summary.totalVolume, 4)}
              </p>
            </div>
            <div className="rounded-xl border border-slateblue/50 bg-slate-950/60 p-3">
              <p className="text-xs uppercase tracking-[0.14em] text-slate-400">Fee Revenue (USD)</p>
              <p className={`mt-1 font-mono text-lg ${summary.totalFeeRevenue === null ? 'text-slate-500' : ''}`}>
                {formatMetric(summary.totalFeeRevenue, 4)}
              </p>
            </div>
            <div className="rounded-xl border border-slateblue/50 bg-slate-950/60 p-3">
              <p className="text-xs uppercase tracking-[0.14em] text-slate-400">Avg Gas (USD)</p>
              <p className={`mt-1 font-mono text-lg ${summary.avgGas === null ? 'text-slate-500' : ''}`}>
                {formatMetric(summary.avgGas, 4)}
              </p>
            </div>
            <div className="rounded-xl border border-slateblue/50 bg-slate-950/60 p-3">
              <p className="text-xs uppercase tracking-[0.14em] text-slate-400">Revenue (mUSD)</p>
              <p className={`mt-1 font-mono text-lg ${summary.revenueMusd === null ? 'text-slate-500' : ''}`}>
                {formatMetric(summary.revenueMusd, 4)}
              </p>
            </div>
            <div className="rounded-xl border border-slateblue/50 bg-slate-950/60 p-3">
              <p className="text-xs uppercase tracking-[0.14em] text-slate-400">Conv. Slippage (bps)</p>
              <p className={`mt-1 font-mono text-lg ${summary.avgSlippageBps === null ? 'text-slate-500' : ''}`}>
                {formatMetric(summary.avgSlippageBps, 2)}
              </p>
            </div>
            <div className="rounded-xl border border-slateblue/50 bg-slate-950/60 p-3">
              <p className="text-xs uppercase tracking-[0.14em] text-slate-400">Pool Liquidity (snapshot)</p>
              <p className={`mt-1 font-mono text-lg ${summary.poolLiquidity === null ? 'text-slate-500' : ''}`}>
                {formatMetric(summary.poolLiquidity, 4)}
              </p>
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <div className="h-72 rounded-2xl border border-slateblue/65 bg-[#081223]/70 p-2">
              {timeline.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={timeline}>
                    <defs>
                      <linearGradient id="analyticsVolume" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#34d399" stopOpacity={0.5} />
                        <stop offset="95%" stopColor="#34d399" stopOpacity={0.05} />
                      </linearGradient>
                      <linearGradient id="analyticsFees" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.4} />
                        <stop offset="95%" stopColor="#f59e0b" stopOpacity={0.04} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.45} />
                    <XAxis dataKey="label" stroke="#cbd5e1" tick={{ fontSize: 11 }} minTickGap={20} />
                    <YAxis yAxisId="left" stroke="#34d399" tick={{ fontSize: 11 }} />
                    <YAxis yAxisId="right" orientation="right" stroke="#f59e0b" tick={{ fontSize: 11 }} />
                    <Tooltip
                      contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: '0.75rem' }}
                      formatter={(value, name) => [n(value).toFixed(6), String(name)]}
                    />
                    <Area yAxisId="left" type="monotone" dataKey="volume" stroke="#34d399" fill="url(#analyticsVolume)" />
                    <Area yAxisId="right" type="monotone" dataKey="fees" stroke="#f59e0b" fill="url(#analyticsFees)" />
                  </AreaChart>
                </ResponsiveContainer>
              ) : poolSnapshot.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={poolSnapshot} margin={{ top: 8, right: 8, left: 0, bottom: 36 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.35} />
                    <XAxis dataKey="label" angle={-16} textAnchor="end" height={42} stroke="#cbd5e1" tick={{ fontSize: 10 }} />
                    <YAxis stroke="#34d399" tick={{ fontSize: 11 }} />
                    <Tooltip
                      contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: '0.75rem' }}
                      formatter={(value) => [n(value).toFixed(6), 'pool_liquidity']}
                    />
                    <Bar dataKey="liquidity" fill="#34d399" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-slate-300">No volume/fee bars yet.</div>
              )}
            </div>

            <div className="h-72 rounded-2xl border border-slateblue/65 bg-[#081223]/70 p-2">
              {timeline.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={timeline}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.4} />
                    <XAxis dataKey="label" stroke="#cbd5e1" tick={{ fontSize: 11 }} minTickGap={20} />
                    <YAxis yAxisId="left" stroke="#7dd3fc" tick={{ fontSize: 11 }} />
                    <YAxis yAxisId="right" orientation="right" stroke="#fda4af" tick={{ fontSize: 11 }} />
                    <Tooltip
                      contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: '0.75rem' }}
                      formatter={(value, name) => [n(value).toFixed(6), String(name)]}
                    />
                    <Line yAxisId="left" dataKey="gas" name="avg_gas_usd" stroke="#38bdf8" dot={false} strokeWidth={2} />
                    <Line yAxisId="right" dataKey="slippage" name="slippage_bps" stroke="#fb7185" dot={false} strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              ) : poolSnapshot.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={poolSnapshot} margin={{ top: 8, right: 8, left: 0, bottom: 36 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.35} />
                    <XAxis dataKey="label" angle={-16} textAnchor="end" height={42} stroke="#cbd5e1" tick={{ fontSize: 10 }} />
                    <YAxis yAxisId="left" stroke="#38bdf8" tick={{ fontSize: 11 }} />
                    <YAxis yAxisId="right" orientation="right" stroke="#f59e0b" tick={{ fontSize: 11 }} />
                    <Tooltip
                      contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: '0.75rem' }}
                      formatter={(value, name) => [n(value).toFixed(6), String(name)]}
                    />
                    <Bar yAxisId="left" dataKey="swaps" fill="#38bdf8" radius={[6, 6, 0, 0]} />
                    <Bar yAxisId="right" dataKey="feeUsd" fill="#f59e0b" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-slate-300">No gas/slippage bars yet.</div>
              )}
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <div className="h-64 rounded-2xl border border-slateblue/65 bg-[#081223]/70 p-2">
              {feeByPoolOrToken.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={feeByPoolOrToken} margin={{ top: 8, right: 8, left: 0, bottom: 50 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.35} />
                    <XAxis dataKey="key" angle={-25} textAnchor="end" height={58} stroke="#cbd5e1" tick={{ fontSize: 10 }} />
                    <YAxis stroke="#34d399" tick={{ fontSize: 11 }} />
                    <Tooltip
                      contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: '0.75rem' }}
                      formatter={(value) => [n(value).toFixed(6), 'fee_amount']}
                    />
                    <Bar dataKey="fee" fill="#34d399" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-slate-300">No fee breakdown rows yet.</div>
              )}
            </div>

            <div className="h-64 rounded-2xl border border-slateblue/65 bg-[#081223]/70 p-2">
              {revenueDaily.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={revenueDaily} margin={{ top: 8, right: 8, left: 0, bottom: 30 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.35} />
                    <XAxis dataKey="day" stroke="#cbd5e1" tick={{ fontSize: 10 }} />
                    <YAxis stroke="#f59e0b" tick={{ fontSize: 11 }} />
                    <Tooltip
                      contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: '0.75rem' }}
                      formatter={(value) => [n(value).toFixed(6), 'revenue_musd']}
                    />
                    <Bar dataKey="revenue" fill="#f59e0b" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-slate-300">No protocol mUSD revenue rows yet.</div>
              )}
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}
