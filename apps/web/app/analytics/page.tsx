'use client';

import { useEffect, useMemo, useState } from 'react';

type AnalyticsPayload = {
  minutes: number;
  volume_by_chain_token: Array<Record<string, string | number>>;
  fee_revenue: Array<Record<string, string | number>>;
  gas_cost_averages: Array<Record<string, string | number>>;
  fee_breakdown_by_pool_token: Array<Record<string, string | number>>;
  protocol_revenue_musd_daily: Array<Record<string, string | number>>;
  conversion_slippage: Array<Record<string, string | number>>;
};

const API_BASE = process.env.NEXT_PUBLIC_TEMPO_API_BASE || 'http://localhost:8500';

function sumDecimal(rows: Array<Record<string, string | number>>, field: string): number {
  return rows.reduce((sum, row) => sum + Number(row[field] || 0), 0);
}

export default function AnalyticsPage() {
  const [minutes, setMinutes] = useState(180);
  const [payload, setPayload] = useState<AnalyticsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        setLoading(true);
        const res = await fetch(`${API_BASE}/analytics?minutes=${minutes}`, { cache: 'no-store' });
        if (!res.ok) {
          throw new Error(`analytics endpoint unavailable (${res.status})`);
        }
        const body = (await res.json()) as AnalyticsPayload;
        if (!active) return;
        setPayload(body);
        setError('');
      } catch (loadError) {
        if (!active) return;
        setPayload(null);
        setError(loadError instanceof Error ? loadError.message : 'failed to load analytics');
      } finally {
        if (active) setLoading(false);
      }
    }

    load();
    const timer = setInterval(load, 15_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [minutes]);

  const summary = useMemo(() => {
    if (!payload) return null;
    return {
      totalVolume: sumDecimal(payload.volume_by_chain_token, 'volume'),
      totalFeeRevenue: sumDecimal(payload.fee_revenue, 'revenue_usd'),
      avgGas: payload.gas_cost_averages.length
        ? sumDecimal(payload.gas_cost_averages, 'avg_gas_cost_usd') / payload.gas_cost_averages.length
        : 0,
      revenueMusd: sumDecimal(payload.protocol_revenue_musd_daily, 'revenue_musd'),
      avgSlippageBps: payload.conversion_slippage.length
        ? sumDecimal(payload.conversion_slippage, 'slippage_bps') / payload.conversion_slippage.length
        : 0
    };
  }, [payload]);

  return (
    <section className="rounded-2xl border border-slateblue/70 bg-slate-900/50 p-6">
      <p className="text-xs uppercase tracking-[0.2em] text-brass">Analytics</p>
      <h2 className="mt-2 text-2xl font-semibold">Tempo Metrics Dashboard</h2>

      <div className="mt-4 flex flex-wrap items-center gap-3">
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
      </div>

      {loading ? <p className="mt-4 text-sm text-slate-300">Loading analytics...</p> : null}
      {error ? <p className="mt-4 text-sm text-rose-300">{error}</p> : null}

      {summary && !loading && !error ? (
        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <div className="rounded-xl border border-slateblue/50 bg-slate-950/60 p-3">
            <p className="text-xs uppercase tracking-[0.14em] text-slate-400">Total Volume</p>
            <p className="mt-1 font-mono text-lg">{summary.totalVolume.toFixed(4)}</p>
          </div>
          <div className="rounded-xl border border-slateblue/50 bg-slate-950/60 p-3">
            <p className="text-xs uppercase tracking-[0.14em] text-slate-400">Fee Revenue (USD)</p>
            <p className="mt-1 font-mono text-lg">{summary.totalFeeRevenue.toFixed(4)}</p>
          </div>
          <div className="rounded-xl border border-slateblue/50 bg-slate-950/60 p-3">
            <p className="text-xs uppercase tracking-[0.14em] text-slate-400">Avg Gas (USD)</p>
            <p className="mt-1 font-mono text-lg">{summary.avgGas.toFixed(4)}</p>
          </div>
          <div className="rounded-xl border border-slateblue/50 bg-slate-950/60 p-3">
            <p className="text-xs uppercase tracking-[0.14em] text-slate-400">Revenue (mUSD)</p>
            <p className="mt-1 font-mono text-lg">{summary.revenueMusd.toFixed(4)}</p>
          </div>
          <div className="rounded-xl border border-slateblue/50 bg-slate-950/60 p-3">
            <p className="text-xs uppercase tracking-[0.14em] text-slate-400">Conv. Slippage (bps)</p>
            <p className="mt-1 font-mono text-lg">{summary.avgSlippageBps.toFixed(2)}</p>
          </div>
        </div>
      ) : null}
    </section>
  );
}
