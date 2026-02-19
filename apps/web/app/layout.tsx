import './globals.css';
import { Providers } from './providers';
import { AppShell } from './app-shell';

export const metadata = {
  title: 'mCryptoEx Orchestra UI',
  description: 'Non-custodial musical DEX interface'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
