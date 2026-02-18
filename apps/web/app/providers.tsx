'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactNode, useState } from 'react';
import { defineChain, http } from 'viem';
import { WagmiProvider, createConfig } from 'wagmi';
import { bscTestnet, sepolia } from 'wagmi/chains';
import { injected, walletConnect } from 'wagmi/connectors';

const hardhatLocal = defineChain({
  id: 31337,
  name: 'Hardhat Local',
  network: 'hardhat-local',
  nativeCurrency: {
    name: 'Ether',
    symbol: 'ETH',
    decimals: 18
  },
  rpcUrls: {
    default: {
      http: [process.env.NEXT_PUBLIC_LOCAL_RPC_URL || 'http://127.0.0.1:8545']
    }
  }
});

const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim() || '';

const connectors = [injected({ shimDisconnect: true })];
if (walletConnectProjectId) {
  connectors.push(
    walletConnect({
      projectId: walletConnectProjectId,
      showQrModal: true,
      metadata: {
        name: 'mCryptoEx Orchestra UI',
        description: 'Non-custodial DEX client',
        url: 'https://localhost',
        icons: []
      }
    }) as never
  );
}

const chains = [hardhatLocal, sepolia, bscTestnet] as const;

const config = createConfig({
  chains,
  connectors: connectors as never,
  transports: {
    [hardhatLocal.id]: http(process.env.NEXT_PUBLIC_LOCAL_RPC_URL || 'http://127.0.0.1:8545'),
    [sepolia.id]: http(),
    [bscTestnet.id]: http()
  },
  ssr: true
});

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
