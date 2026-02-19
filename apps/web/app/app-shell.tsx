'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const navItems = [
  { href: '/overture', label: 'Overture' },
  { href: '/pro', label: 'Exchange Pro' },
  { href: '/exchange', label: 'Exchange Classic' },
  { href: '/harmony', label: 'Harmony Swap' },
  { href: '/liquidity', label: 'Liquidity' },
  { href: '/pools', label: 'Pools' },
  { href: '/ledger', label: 'Ledger' },
  { href: '/analytics', label: 'Analytics' }
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isProShell = pathname.startsWith('/pro');

  if (isProShell) {
    return <div className="min-h-screen bg-[#06111d] text-slate-100">{children}</div>;
  }

  return (
    <div className="min-h-screen bg-stage text-ivory">
      <header className="border-b border-slateblue/60 bg-[#0f192d]/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-4 md:px-6">
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-brass">mCryptoEx</p>
            <h1 className="font-serif text-2xl">Orchestra UI</h1>
          </div>
          <nav className="flex flex-wrap gap-2 text-sm">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-full border border-slateblue/70 px-3 py-1.5 text-slate-200 transition hover:border-mint/70 hover:text-mint"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 md:px-6">{children}</main>
    </div>
  );
}
