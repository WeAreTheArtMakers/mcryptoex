import { WalletPanel } from '../../components/wallet-panel';

export default function OverturePage() {
  return (
    <div className="grid gap-4 md:grid-cols-[1.5fr_1fr]">
      <section className="rounded-2xl border border-slateblue/70 bg-slate-900/50 p-6 shadow-halo">
        <p className="text-xs uppercase tracking-[0.2em] text-brass">Movement 4</p>
        <h2 className="mt-2 text-3xl font-semibold">Wallet-first Non-Custodial Trading</h2>
        <p className="mt-4 max-w-2xl text-slate-200">
          mCryptoEx signs transactions in your wallet only. Tempo API is read-only infrastructure for quoting,
          analytics, and ledger views. It cannot custody funds or authorize trades.
        </p>
        <div className="mt-6 rounded-xl border border-amber-300/40 bg-amber-500/10 p-4 text-sm text-amber-100">
          Dissonance Guard: always verify chain, slippage, and bridge trust assumptions before swapping.
        </div>
      </section>
      <WalletPanel />
    </div>
  );
}
