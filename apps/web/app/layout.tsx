import Link from 'next/link';
import './globals.css';
import { Providers } from './providers';

export const metadata = {
  title: 'mCryptoEx Orchestra UI',
  description: 'Non-custodial musical DEX interface'
};

const navItems = [
  { href: '/overture', label: 'Overture' },
  { href: '/harmony', label: 'Harmony Swap' },
  { href: '/liquidity', label: 'Liquidity' },
  { href: '/pools', label: 'Pools' },
  { href: '/ledger', label: 'Ledger' },
  { href: '/analytics', label: 'Analytics' }
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
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
        </Providers>
      </body>
    </html>
  );
}
