'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactNode, useState } from 'react';
import { defineChain, http } from 'viem';
import { WagmiProvider, createConfig } from 'wagmi';
import { bscTestnet, sepolia } from 'wagmi/chains';
import { injected, walletConnect } from 'wagmi/connectors';

const localChainEnabled = process.env.NEXT_PUBLIC_ENABLE_LOCAL_CHAIN === 'true';

function normalizeBrowserRpcUrl(url: string): string {
  if (typeof window === 'undefined') return url;
  return url.replace('host.docker.internal', '127.0.0.1');
}

const localRpcUrl = normalizeBrowserRpcUrl(process.env.NEXT_PUBLIC_LOCAL_RPC_URL || 'http://127.0.0.1:8545');
const sepoliaRpcUrl = normalizeBrowserRpcUrl(
  process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com'
);
const bscTestnetRpcUrl = normalizeBrowserRpcUrl(
  process.env.NEXT_PUBLIC_BSC_TESTNET_RPC_URL || 'https://bsc-testnet-rpc.publicnode.com'
);

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
  [sepolia.id]: http(sepoliaRpcUrl),
  [bscTestnet.id]: http(bscTestnetRpcUrl)
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
