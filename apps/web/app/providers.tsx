'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactNode, useState } from 'react';
import { defineChain, http } from 'viem';
import { WagmiProvider, createConfig } from 'wagmi';
import { bscTestnet, sepolia } from 'wagmi/chains';
import { injected, walletConnect } from 'wagmi/connectors';

const localChainEnabled = process.env.NEXT_PUBLIC_ENABLE_LOCAL_CHAIN === 'true';

const localRpcUrlRaw = process.env.NEXT_PUBLIC_LOCAL_RPC_URL || 'http://127.0.0.1:8545';
const localRpcUrl =
  typeof window === 'undefined' ? localRpcUrlRaw : localRpcUrlRaw.replace('host.docker.internal', '127.0.0.1');

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
      http: [localRpcUrl]
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

const chains = localChainEnabled ? ([hardhatLocal, sepolia, bscTestnet] as const) : ([sepolia, bscTestnet] as const);

const transports = {
  [hardhatLocal.id]: localChainEnabled ? http(localRpcUrl) : http(),
  [sepolia.id]: http(),
  [bscTestnet.id]: http()
} as const;

const config = createConfig({
  chains,
  connectors: connectors as never,
  transports,
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
