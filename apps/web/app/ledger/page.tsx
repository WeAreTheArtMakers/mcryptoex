'use client';

import { useEffect, useState } from 'react';

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

const API_BASE = process.env.NEXT_PUBLIC_TEMPO_API_BASE || 'http://localhost:8500';

function short(value: string, keep = 10): string {
  if (!value) return '-';
  if (value.length <= keep) return value;
  return `${value.slice(0, keep)}...`;
}

export default function LedgerPage() {
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [error, setError] = useState<string>('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        setLoading(true);
        const res = await fetch(`${API_BASE}/ledger/recent?limit=80`, { cache: 'no-store' });
        if (!res.ok) {
          throw new Error(`ledger endpoint unavailable (${res.status})`);
        }
        const payload = (await res.json()) as { rows?: LedgerRow[] };
        if (!active) return;
        setRows(payload.rows || []);
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
    const timer = setInterval(load, 12_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <section className="rounded-2xl border border-slateblue/70 bg-slate-900/50 p-6">
      <p className="text-xs uppercase tracking-[0.2em] text-brass">Ledger</p>
      <h2 className="mt-2 text-2xl font-semibold">Fee + Gas Accounting</h2>
      <p className="mt-3 text-slate-200">
        Immutable double-entry rows from the Tempo pipeline (swap/liquidity/mUSD/treasury actions).
      </p>

      {loading ? <p className="mt-4 text-sm text-slate-300">Loading recent ledger entries...</p> : null}
      {error ? <p className="mt-4 text-sm text-rose-300">{error}</p> : null}

      {!loading && !error ? (
        <div className="mt-5 overflow-x-auto rounded-xl border border-slateblue/40">
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
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-3 py-3 text-slate-300">
                    No ledger rows yet.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.entry_id} className="border-t border-slateblue/30 bg-slate-900/30">
                    <td className="px-3 py-2">{new Date(row.occurred_at).toLocaleString()}</td>
                    <td className="px-3 py-2">{row.chain_id}</td>
                    <td className="px-3 py-2">{row.entry_type}</td>
                    <td className="px-3 py-2 font-mono">{short(row.account_id, 20)}</td>
                    <td className="px-3 py-2">{row.side}</td>
                    <td className="px-3 py-2">{row.asset}</td>
                    <td className="px-3 py-2 font-mono">{row.amount}</td>
                    <td className="px-3 py-2 font-mono">{row.fee_usd}</td>
                    <td className="px-3 py-2 font-mono">{row.gas_cost_usd}</td>
                    <td className="px-3 py-2 font-mono">{short(row.tx_hash, 14)}</td>
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
