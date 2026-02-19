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
    <div className="min-h-screen bg-[#06111d] text-slate-100">
      <header className="flex h-14 items-center justify-between border-b border-[#183344] bg-[#09141f] px-4">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-[#67e3d5]" />
          <span className="text-sm font-semibold">mCryptoEx</span>
        </div>
      </header>

      <div className="border-b border-[#1b3f4d] bg-[#091623] px-3 py-1.5">
        <nav className="flex flex-wrap items-center gap-1.5">
          {navItems.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded border px-2 py-1 text-[11px] ${
                  active
                    ? 'border-[#57d6ca] bg-[#123345] text-[#79e7dc]'
                    : 'border-[#21445b] bg-[#0c1a29] text-slate-300 hover:text-white'
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="h-8 border-b border-[#1b3f4d] bg-[#58d4c8] px-4 py-1 text-xs font-medium text-[#062428]">
        Wallet-first non-custodial trading. Tempo API is read-only; all executions are wallet-signed.
      </div>

      <main className="mx-auto w-full max-w-[1700px] px-3 py-3">{children}</main>
    </div>
  );
}
