'use client';

import { useMemo } from 'react';
import { useAccount, useConnect, useDisconnect } from 'wagmi';

function shortAddress(value?: string) {
  if (!value) return 'Not connected';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function WalletPanel() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending, error, variables } = useConnect();
  const { disconnect } = useDisconnect();
  const connectingKey =
    ((variables?.connector as any)?.uid as string | undefined) ||
    ((variables?.connector as any)?.id as string | undefined) ||
    ((variables?.connector as any)?.name as string | undefined);

  const sortedConnectors = useMemo(() => {
    return (connectors as any[])
      .filter((connector) => connector.type !== 'injected' || connector.name)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [connectors]);

  return (
    <section className="rounded-2xl border border-slateblue/70 bg-slate-950/55 p-4 shadow-halo">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-brass">Wallet Section</p>
          <h3 className="text-lg font-semibold text-ivory">Self-Custody Connection</h3>
        </div>
        {isConnected ? (
          <button
            type="button"
            onClick={() => disconnect()}
            className="rounded-xl border border-rose-400/50 bg-rose-900/30 px-3 py-2 text-sm font-semibold text-rose-100"
          >
            Disconnect
          </button>
        ) : null}
      </div>

      <div className="mt-3 space-y-2 text-sm text-slate-200">
        <p>
          Address: <span className="font-mono">{shortAddress(address)}</span>
        </p>
        <p>Network: {chainId ? <span className="font-semibold">{chainId}</span> : 'Read-only mode'}</p>
      </div>

      {!isConnected ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {sortedConnectors.map((connector) => (
            // connector typing can vary between injected and walletconnect functions in wagmi v2
            // so we normalize an identifier for stable button rendering.
            <button
              key={(connector.uid || connector.id || connector.name) as string}
              type="button"
              onClick={() => connect({ connector })}
              disabled={isPending}
              className="rounded-xl border border-mint/50 bg-mint/15 px-3 py-2 text-sm font-semibold text-mint hover:bg-mint/20 disabled:opacity-50"
            >
              {isPending && connectingKey === (connector.uid || connector.id || connector.name)
                ? `Connecting ${connector.name}...`
                : connector.name}
            </button>
          ))}
        </div>
      ) : null}

      {error ? <p className="mt-3 text-sm text-rose-300">{error.message}</p> : null}
    </section>
  );
}
