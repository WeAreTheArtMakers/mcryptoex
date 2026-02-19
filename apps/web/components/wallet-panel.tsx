'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAccount, useConnect, useDisconnect } from 'wagmi';

function shortAddress(value?: string) {
  if (!value) return 'Not connected';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function WalletPanel() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending, error, variables } = useConnect();
  const { disconnect } = useDisconnect();
  const [availability, setAvailability] = useState<Record<string, boolean>>({});
  const connectingKey =
    ((variables?.connector as any)?.uid as string | undefined) ||
    ((variables?.connector as any)?.id as string | undefined) ||
    ((variables?.connector as any)?.name as string | undefined);

  const sortedConnectors = useMemo(() => {
    return (connectors as any[])
      .filter((connector) => connector.type !== 'injected' || connector.name)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [connectors]);

  useEffect(() => {
    let active = true;

    async function refreshAvailability() {
      const nextAvailability: Record<string, boolean> = {};

      for (const connector of sortedConnectors) {
        const key = (connector.uid || connector.id || connector.name) as string;
        if (connector.type !== 'injected') {
          nextAvailability[key] = true;
          continue;
        }

        try {
          if (typeof connector.getProvider === 'function') {
            const provider = await connector.getProvider();
            nextAvailability[key] = Boolean(provider);
          } else {
            nextAvailability[key] = false;
          }
        } catch {
          nextAvailability[key] = false;
        }
      }

      if (active) {
        setAvailability(nextAvailability);
      }
    }

    refreshAvailability();
    return () => {
      active = false;
    };
  }, [sortedConnectors]);

  const hasWalletConnect = sortedConnectors.some((connector) => connector.type === 'walletConnect');
  const hasInjectedInstalled = sortedConnectors.some((connector) => {
    if (connector.type !== 'injected') return false;
    const key = (connector.uid || connector.id || connector.name) as string;
    return availability[key];
  });

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
          {sortedConnectors.map((connector) => {
            // connector typing can vary between injected and walletconnect functions in wagmi v2
            // so we normalize an identifier for stable button rendering.
            // when an injected provider is missing, keep button disabled and show install guidance.
            const key = (connector.uid || connector.id || connector.name) as string;
            const isInjectedUnavailable = connector.type === 'injected' && availability[key] === false;
            const label = isInjectedUnavailable ? `${connector.name} (extension missing)` : connector.name;

            return (
              <button
                key={key}
                type="button"
                onClick={() => connect({ connector })}
                disabled={isPending || isInjectedUnavailable}
                className="rounded-xl border border-mint/50 bg-mint/15 px-3 py-2 text-sm font-semibold text-mint hover:bg-mint/20 disabled:opacity-50"
              >
                {isPending && connectingKey === key ? `Connecting ${connector.name}...` : label}
              </button>
            );
          })}
        </div>
      ) : null}

      {!isConnected && !hasInjectedInstalled ? (
        <p className="mt-3 text-xs text-amber-200">
          Injected wallet provider not detected. Install MetaMask/Trust/MathWallet extension, or enable WalletConnect by
          setting <code>NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID</code>.
        </p>
      ) : null}

      {!isConnected && !hasWalletConnect ? (
        <p className="mt-2 text-xs text-slate-300">
          WalletConnect is disabled in this environment (missing <code>NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID</code>).
        </p>
      ) : null}

      {error ? <p className="mt-3 text-sm text-rose-300">{error.message}</p> : null}
    </section>
  );
}
