'use client';

import { useEffect, useMemo, useState } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

const API_BASE = process.env.NEXT_PUBLIC_TEMPO_API_BASE || 'http://localhost:8500';
const LOCAL_CHAIN_ENABLED = process.env.NEXT_PUBLIC_ENABLE_LOCAL_CHAIN === 'true';
const ENV_DEFAULT_CHAIN_ID = Number(process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID || (LOCAL_CHAIN_ENABLED ? '31337' : '97'));
const DEFAULT_CHAIN_ID = Number.isFinite(ENV_DEFAULT_CHAIN_ID) ? ENV_DEFAULT_CHAIN_ID : LOCAL_CHAIN_ENABLED ? 31337 : 97;

type LedgerRow = {
  entry_id: number;
  tx_id: string;
  note_id: string;
  chain_id: number;
  tx_hash: string;
  account_id: string;
  side: string;
  asset: string;
  amount: string;
  entry_type: string;
  fee_usd: string;
  gas_cost_usd: string;
  protocol_revenue_usd: string;
  pool_address: string;
  occurred_at: string;
};

type LedgerPayload = {
  rows?: LedgerRow[];
};

type NetworkItem = {
  chain_id: number;
  name: string;
  protocol_fee_receiver?: string;
  protocol_fee_bps?: number;
  swap_fee_bps?: number;
};

type TokensPayload = {
  networks?: NetworkItem[];
};

type ChartPoint = {
  bucket: string;
  label: string;
  feeUsd: number;
  gasUsd: number;
  revenueUsd: number;
};

function n(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function short(value: string, keep = 10): string {
  if (!value) return '-';
  if (value.length <= keep) return value;
  return `${value.slice(0, keep)}...`;
}

function shortAmount(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  if (parsed === 0) return '0';
  if (parsed < 0.000001) return parsed.toExponential(2);
  return parsed.toFixed(6).replace(/\.?0+$/, '');
}

export default function LedgerPage() {
  const [chainId, setChainId] = useState<number>(DEFAULT_CHAIN_ID);
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [networks, setNetworks] = useState<NetworkItem[]>([
    { chain_id: 97, name: 'BNB Chain Testnet' },
    { chain_id: 11155111, name: 'Ethereum Sepolia' }
  ]);
  const [entryTypeFilter, setEntryTypeFilter] = useState<string>('all');
  const [accountFilter, setAccountFilter] = useState<string>('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const selectedNetwork = useMemo(() => networks.find((network) => network.chain_id === chainId), [networks, chainId]);

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        setLoading(true);

        const [ledgerRes, tokensRes] = await Promise.all([
          fetch(`${API_BASE}/ledger/recent?limit=220&chain_id=${chainId}`, { cache: 'no-store' }),
          fetch(`${API_BASE}/tokens`, { cache: 'no-store' })
        ]);

        if (!ledgerRes.ok) {
          throw new Error(`ledger endpoint unavailable (${ledgerRes.status})`);
        }
        if (!tokensRes.ok) {
          throw new Error(`token registry unavailable (${tokensRes.status})`);
        }

        const ledgerPayload = (await ledgerRes.json()) as LedgerPayload;
        const tokenPayload = (await tokensRes.json()) as TokensPayload;

        if (!active) return;
        setRows(ledgerPayload.rows || []);
        if (tokenPayload.networks?.length) setNetworks(tokenPayload.networks);
        setError('');
      } catch (loadError) {
        if (!active) return;
        setRows([]);
        setError(loadError instanceof Error ? loadError.message : 'failed to load ledger entries');
      } finally {
        if (active) setLoading(false);
      }
    }

    load();
    const timer = setInterval(load, 10_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [chainId]);

  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      const typePass = entryTypeFilter === 'all' || row.entry_type === entryTypeFilter;
      const accountPass = !accountFilter || row.account_id.toLowerCase().includes(accountFilter.toLowerCase());
      return typePass && accountPass;
    });
  }, [rows, entryTypeFilter, accountFilter]);

  const entryTypes = useMemo(() => {
    return Array.from(new Set(rows.map((row) => row.entry_type))).sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const summary = useMemo(() => {
    const totalFeeUsd = filteredRows.reduce((sum, row) => sum + n(row.fee_usd), 0);
    const totalGasUsd = filteredRows.reduce((sum, row) => sum + n(row.gas_cost_usd), 0);
    const totalRevenueUsd = filteredRows.reduce((sum, row) => sum + n(row.protocol_revenue_usd), 0);
    return { totalFeeUsd, totalGasUsd, totalRevenueUsd };
  }, [filteredRows]);

  const timeline = useMemo<ChartPoint[]>(() => {
    const map = new Map<string, ChartPoint>();

    for (const row of filteredRows) {
      const bucket = new Date(new Date(row.occurred_at).setSeconds(0, 0)).toISOString();
      const point = map.get(bucket) || {
        bucket,
        label: new Date(bucket).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        feeUsd: 0,
        gasUsd: 0,
        revenueUsd: 0
      };
      point.feeUsd += n(row.fee_usd);
      point.gasUsd += n(row.gas_cost_usd);
      point.revenueUsd += n(row.protocol_revenue_usd);
      map.set(bucket, point);
    }

    return Array.from(map.values()).sort((a, b) => a.bucket.localeCompare(b.bucket)).slice(-100);
  }, [filteredRows]);

  return (
    <section className="space-y-4 rounded-3xl border border-slateblue/70 bg-gradient-to-br from-[#0f1c37]/95 via-[#142843]/90 to-[#1b3350]/80 p-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-brass">Ledger</p>
          <h2 className="mt-2 text-2xl font-semibold">Fee + Gas Accounting</h2>
          <p className="mt-2 text-sm text-slate-200">
            Immutable double-entry rows from the Tempo pipeline (swap/liquidity/mUSD/treasury actions).
          </p>
        </div>

        <div className="rounded-xl border border-slateblue/70 bg-slate-950/60 px-3 py-2 text-xs text-slate-200">
          Chain {chainId} | Rows {filteredRows.length}
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-xl border border-mint/45 bg-mint/10 p-3">
          <p className="text-[11px] uppercase tracking-[0.14em] text-mint">Total Fee USD</p>
          <p className="mt-1 font-mono">{summary.totalFeeUsd.toFixed(4)}</p>
        </div>
        <div className="rounded-xl border border-brass/45 bg-brass/10 p-3">
          <p className="text-[11px] uppercase tracking-[0.14em] text-amber-100">Total Gas USD</p>
          <p className="mt-1 font-mono">{summary.totalGasUsd.toFixed(4)}</p>
        </div>
        <div className="rounded-xl border border-cyan-300/40 bg-cyan-500/10 p-3">
          <p className="text-[11px] uppercase tracking-[0.14em] text-cyan-100">Protocol Revenue USD</p>
          <p className="mt-1 font-mono">{summary.totalRevenueUsd.toFixed(4)}</p>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <label className="space-y-1">
          <span className="text-xs uppercase tracking-[0.14em] text-slate-300">Chain</span>
          <select
            value={chainId}
            onChange={(event) => setChainId(Number(event.target.value))}
            className="w-full rounded-lg border border-slateblue/70 bg-slate-950/80 px-3 py-2 text-sm"
          >
            {networks.map((network) => (
              <option key={network.chain_id} value={network.chain_id}>
                {network.name} ({network.chain_id})
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 md:col-span-1">
          <span className="text-xs uppercase tracking-[0.14em] text-slate-300">Entry Type</span>
          <select
            value={entryTypeFilter}
            onChange={(event) => setEntryTypeFilter(event.target.value)}
            className="w-full rounded-lg border border-slateblue/70 bg-slate-950/80 px-3 py-2 text-sm"
          >
            <option value="all">All</option>
            {entryTypes.map((entryType) => (
              <option key={entryType} value={entryType}>
                {entryType}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 md:col-span-2">
          <span className="text-xs uppercase tracking-[0.14em] text-slate-300">Account Filter</span>
          <input
            type="text"
            value={accountFilter}
            onChange={(event) => setAccountFilter(event.target.value)}
            placeholder="protocol:treasury / user:0x..."
            className="w-full rounded-lg border border-slateblue/70 bg-slate-950/80 px-3 py-2 text-sm"
          />
        </label>
      </div>

      <div className="h-64 rounded-2xl border border-slateblue/60 bg-[#081223]/70 p-2">
        {timeline.length ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={timeline}>
              <defs>
                <linearGradient id="ledgerFeeFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#34d399" stopOpacity={0.45} />
                  <stop offset="95%" stopColor="#34d399" stopOpacity={0.05} />
                </linearGradient>
                <linearGradient id="ledgerGasFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#38bdf8" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#38bdf8" stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.45} />
              <XAxis dataKey="label" stroke="#cbd5e1" tick={{ fontSize: 11 }} minTickGap={16} />
              <YAxis yAxisId="left" stroke="#34d399" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="right" orientation="right" stroke="#38bdf8" tick={{ fontSize: 11 }} />
              <Tooltip
                contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: '0.75rem' }}
                formatter={(value, name) => [n(value).toFixed(6), String(name)]}
              />
              <Area yAxisId="left" type="monotone" dataKey="feeUsd" name="fee_usd" stroke="#34d399" fill="url(#ledgerFeeFill)" />
              <Area yAxisId="right" type="monotone" dataKey="gasUsd" name="gas_usd" stroke="#38bdf8" fill="url(#ledgerGasFill)" />
              <Area yAxisId="left" type="monotone" dataKey="revenueUsd" name="protocol_revenue_usd" stroke="#f59e0b" fillOpacity={0} />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-slate-300">No ledger series for this filter yet.</div>
        )}
      </div>

      <section className="rounded-2xl border border-amber-400/35 bg-amber-500/10 p-4 text-sm text-amber-100">
        <p className="text-xs uppercase tracking-[0.22em] text-amber-300">Protocol Fee Destination</p>
        <p className="mt-2">
          Collected protocol fees are transferred by pair contracts into the Resonance Vault fee receiver:
          <span className="ml-1 font-mono text-xs">{selectedNetwork?.protocol_fee_receiver || 'not configured'}</span>
        </p>
        <p className="mt-1 text-xs text-amber-50/90">
          Fee model: {selectedNetwork?.swap_fee_bps ?? 30} bps total / {selectedNetwork?.protocol_fee_bps ?? 5} bps protocol.
        </p>
      </section>

      {loading ? <p className="text-sm text-slate-300">Loading recent ledger entries...</p> : null}
      {error ? <p className="text-sm text-rose-300">{error}</p> : null}

      {!loading && !error ? (
        <div className="overflow-x-auto rounded-xl border border-slateblue/40">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-slate-950/70 text-slate-300">
              <tr>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Chain</th>
                <th className="px-3 py-2">Entry</th>
                <th className="px-3 py-2">Account</th>
                <th className="px-3 py-2">Side</th>
                <th className="px-3 py-2">Asset</th>
                <th className="px-3 py-2">Amount</th>
                <th className="px-3 py-2">Fee USD</th>
                <th className="px-3 py-2">Gas USD</th>
                <th className="px-3 py-2">Tx</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-3 py-3 text-slate-300">
                    No ledger rows for current filters.
                  </td>
                </tr>
              ) : (
                filteredRows.map((row) => (
                  <tr key={row.entry_id} className="border-t border-slateblue/30 bg-slate-900/30">
                    <td className="px-3 py-2">{new Date(row.occurred_at).toLocaleString()}</td>
                    <td className="px-3 py-2">{row.chain_id}</td>
                    <td className="px-3 py-2">{row.entry_type}</td>
                    <td className="px-3 py-2 font-mono">{short(row.account_id, 24)}</td>
                    <td className={`px-3 py-2 ${row.side === 'credit' ? 'text-emerald-300' : 'text-rose-300'}`}>{row.side}</td>
                    <td className="px-3 py-2">{row.asset}</td>
                    <td className="px-3 py-2 font-mono">{shortAmount(row.amount)}</td>
                    <td className="px-3 py-2 font-mono">{shortAmount(row.fee_usd)}</td>
                    <td className="px-3 py-2 font-mono">{shortAmount(row.gas_cost_usd)}</td>
                    <td className="px-3 py-2 font-mono">{short(row.tx_hash, 18)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
