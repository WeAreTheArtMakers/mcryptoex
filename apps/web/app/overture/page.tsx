import Link from 'next/link';
import { WalletPanel } from '../../components/wallet-panel';

export default function OverturePage() {
  return (
    <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
      <section className="rounded-2xl border border-slateblue/70 bg-slate-900/50 p-6 shadow-halo">
        <p className="text-xs uppercase tracking-[0.2em] text-brass">Overture</p>
        <h2 className="mt-2 text-3xl font-semibold">Start In 3 Steps (mUSD-first)</h2>
        <p className="mt-4 max-w-2xl text-slate-200">
          mCryptoEx is non-custodial: funds always stay in your wallet. Tempo API is read-only (quotes + analytics).
        </p>

        <div className="mt-5 grid gap-3 md:grid-cols-3">
          <article className="rounded-xl border border-slateblue/60 bg-slate-950/40 p-4">
            <p className="text-xs uppercase tracking-[0.16em] text-cyan-200">Step 1</p>
            <h3 className="mt-1 font-semibold">Connect Wallet</h3>
            <p className="mt-2 text-xs text-slate-300">Connect MetaMask/WalletConnect and select your chain.</p>
          </article>
          <article className="rounded-xl border border-brass/50 bg-amber-950/20 p-4">
            <p className="text-xs uppercase tracking-[0.16em] text-amber-200">Step 2</p>
            <h3 className="mt-1 font-semibold">Convert to mUSD</h3>
            <p className="mt-2 text-xs text-slate-200">Swap or mint into mUSD first so trading routes are stable.</p>
          </article>
          <article className="rounded-xl border border-emerald-300/40 bg-emerald-950/20 p-4">
            <p className="text-xs uppercase tracking-[0.16em] text-emerald-200">Step 3</p>
            <h3 className="mt-1 font-semibold">Trade Pairs</h3>
            <p className="mt-2 text-xs text-slate-200">Open Exchange Pro and trade mUSD pairs with wallet-signed txs.</p>
          </article>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <Link
            href="/harmony?intent=first-trade&output=mUSD"
            className="rounded-xl border border-brass/60 bg-brass/20 px-4 py-2 text-sm font-semibold text-amber-100 hover:bg-brass/30"
          >
            1) Convert Funds To mUSD
          </Link>
          <Link
            href="/pro"
            className="rounded-xl border border-mint/60 bg-mint/15 px-4 py-2 text-sm font-semibold text-mint hover:bg-mint/25"
          >
            2) Open Exchange Pro
          </Link>
        </div>

        <div className="mt-6 rounded-xl border border-amber-300/40 bg-amber-500/10 p-4 text-sm text-amber-100">
          Dissonance Guard: never share private keys. Wallet signatures happen client-side only.
        </div>
      </section>
      <WalletPanel />
    </div>
  );
}
