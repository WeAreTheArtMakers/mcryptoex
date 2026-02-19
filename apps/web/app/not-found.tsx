import Link from 'next/link';

export default function NotFound() {
  return (
    <section className="mx-auto max-w-3xl rounded-3xl border border-slateblue/70 bg-slate-950/60 p-8 shadow-halo">
      <p className="text-xs uppercase tracking-[0.24em] text-brass">404 Resource Missed</p>
      <h2 className="mt-2 text-3xl font-semibold text-ivory">Failed to load resource</h2>
      <p className="mt-3 text-sm text-slate-200">
        Requested page or asset returned <span className="font-mono">404 Not Found</span>. This usually means route,
        chain resource, or deployment registry is not aligned with the current environment.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Link
          href="/exchange"
          className="rounded-xl border border-mint/60 bg-mint/20 px-4 py-2 text-sm font-semibold text-mint"
        >
          Open Exchange Pro
        </Link>
        <Link
          href="/harmony"
          className="rounded-xl border border-cyan-300/60 bg-cyan-500/20 px-4 py-2 text-sm font-semibold text-cyan-100"
        >
          Open Harmony Swap
        </Link>
        <Link
          href="/pools"
          className="rounded-xl border border-brass/60 bg-brass/20 px-4 py-2 text-sm font-semibold text-amber-100"
        >
          Check Pools
        </Link>
      </div>
    </section>
  );
}
