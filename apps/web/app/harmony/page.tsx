'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useAccount, useSwitchChain } from 'wagmi';
import { WalletPanel } from '../../components/wallet-panel';

type TokenItem = {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
};

type TokensResponse = {
  chains: Record<string, TokenItem[]>;
};

type QuoteResponse = {
  chain_id: number;
  token_in: string;
  token_out: string;
  amount_in: string;
  expected_out: string;
  min_out: string;
  slippage_bps: number;
  route: string[];
  engine: string;
};

const API_BASE = process.env.NEXT_PUBLIC_TEMPO_API_BASE || 'http://localhost:8500';
const DEFAULT_TOKENS: TokenItem[] = [
  { symbol: 'mUSD', name: 'Musical USD', address: 'local-musd', decimals: 18 },
  { symbol: 'WETH', name: 'Wrapped Ether', address: 'local-weth', decimals: 18 }
];

export default function HarmonyPage() {
  const [chainId, setChainId] = useState<number>(31337);
  const [tokensByChain, setTokensByChain] = useState<Record<string, TokenItem[]>>({});
  const [tokenIn, setTokenIn] = useState<string>('mUSD');
  const [tokenOut, setTokenOut] = useState<string>('WETH');
  const [amountIn, setAmountIn] = useState<string>('100');
  const [slippageBps, setSlippageBps] = useState<number>(50);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');

  const { chainId: walletChainId, isConnected } = useAccount();
  const { chains, switchChain, isPending: isSwitching } = useSwitchChain();

  const chainTokens = useMemo(() => tokensByChain[String(chainId)] || DEFAULT_TOKENS, [tokensByChain, chainId]);

  useEffect(() => {
    let active = true;

    async function loadTokens() {
      try {
        const res = await fetch(`${API_BASE}/tokens`, { cache: 'no-store' });
        if (!res.ok) {
          throw new Error(`tokens fetch failed: ${res.status}`);
        }
        const payload = (await res.json()) as TokensResponse;
        if (!active) return;

        setTokensByChain(payload.chains || {});

        const preferred = payload.chains?.[String(chainId)] || DEFAULT_TOKENS;
        if (!preferred.some((x) => x.symbol === tokenIn)) {
          setTokenIn(preferred[0]?.symbol || 'mUSD');
        }
        if (!preferred.some((x) => x.symbol === tokenOut)) {
          setTokenOut(preferred[1]?.symbol || preferred[0]?.symbol || 'WETH');
        }
      } catch (fetchError) {
        if (active) {
          setError(fetchError instanceof Error ? fetchError.message : 'failed to load token registry');
        }
      }
    }

    loadTokens();
    return () => {
      active = false;
    };
  }, [chainId, tokenIn, tokenOut]);

  function onChainChange(nextChainId: number) {
    setChainId(nextChainId);
    const nextTokens = tokensByChain[String(nextChainId)] || DEFAULT_TOKENS;
    setTokenIn(nextTokens[0]?.symbol || 'mUSD');
    setTokenOut(nextTokens[1]?.symbol || nextTokens[0]?.symbol || 'WETH');
    setQuote(null);
    setError('');
  }

  async function requestQuote(event: FormEvent) {
    event.preventDefault();
    setQuote(null);
    setError('');

    if (!amountIn || Number(amountIn) <= 0) {
      setError('Amount in must be greater than zero.');
      return;
    }

    if (tokenIn === tokenOut) {
      setError('Token in and token out cannot be the same.');
      return;
    }

    const params = new URLSearchParams({
      chain_id: String(chainId),
      token_in: tokenIn,
      token_out: tokenOut,
      amount_in: amountIn,
      slippage_bps: String(slippageBps)
    });

    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/quote?${params.toString()}`, { cache: 'no-store' });
      if (!res.ok) {
        throw new Error(`quote failed: ${res.status}`);
      }

      const payload = (await res.json()) as QuoteResponse;
      setQuote(payload);
    } catch (quoteError) {
      setError(quoteError instanceof Error ? quoteError.message : 'quote request failed');
    } finally {
      setLoading(false);
    }
  }

  const canPromptSwitch =
    isConnected &&
    typeof walletChainId === 'number' &&
    walletChainId !== chainId &&
    chains.some((chain) => chain.id === chainId);

  return (
    <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
      <section className="rounded-2xl border border-slateblue/70 bg-slate-900/55 p-6 shadow-halo">
        <p className="text-xs uppercase tracking-[0.24em] text-brass">Harmony Engine</p>
        <h2 className="mt-2 text-2xl font-semibold">Swap Router Preview + Quote</h2>
        <p className="mt-2 text-sm text-slate-200">
          Read-only quote comes from Tempo API. Swap execution remains wallet-signed and non-custodial.
        </p>

        <form onSubmit={requestQuote} className="mt-5 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs uppercase tracking-[0.14em] text-slate-300">Chain</span>
              <select
                value={chainId}
                onChange={(event) => onChainChange(Number(event.target.value))}
                className="w-full rounded-xl border border-slateblue/80 bg-slate-950/80 px-3 py-2"
              >
                <option value={31337}>Hardhat Local (31337)</option>
                <option value={11155111}>Ethereum Sepolia (11155111)</option>
                <option value={97}>BNB Testnet (97)</option>
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-xs uppercase tracking-[0.14em] text-slate-300">Amount In</span>
              <input
                type="number"
                min="0"
                step="any"
                value={amountIn}
                onChange={(event) => setAmountIn(event.target.value)}
                className="w-full rounded-xl border border-slateblue/80 bg-slate-950/80 px-3 py-2"
              />
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs uppercase tracking-[0.14em] text-slate-300">Token In</span>
              <select
                value={tokenIn}
                onChange={(event) => setTokenIn(event.target.value)}
                className="w-full rounded-xl border border-slateblue/80 bg-slate-950/80 px-3 py-2"
              >
                {chainTokens.map((token) => (
                  <option key={`${token.address}-${token.symbol}`} value={token.symbol}>
                    {token.symbol}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-xs uppercase tracking-[0.14em] text-slate-300">Token Out</span>
              <select
                value={tokenOut}
                onChange={(event) => setTokenOut(event.target.value)}
                className="w-full rounded-xl border border-slateblue/80 bg-slate-950/80 px-3 py-2"
              >
                {chainTokens.map((token) => (
                  <option key={`${token.address}-${token.symbol}`} value={token.symbol}>
                    {token.symbol}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="space-y-1">
            <span className="text-xs uppercase tracking-[0.14em] text-slate-300">Slippage (bps)</span>
            <input
              type="number"
              min={1}
              max={3000}
              value={slippageBps}
              onChange={(event) => setSlippageBps(Number(event.target.value))}
              className="w-full rounded-xl border border-slateblue/80 bg-slate-950/80 px-3 py-2"
            />
          </label>

          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={loading}
              className="rounded-xl border border-mint/60 bg-mint/20 px-4 py-2 text-sm font-semibold text-mint hover:bg-mint/30 disabled:opacity-50"
            >
              {loading ? 'Calculating...' : 'Get Quote'}
            </button>

            {canPromptSwitch ? (
              <button
                type="button"
                onClick={() => switchChain({ chainId })}
                disabled={isSwitching}
                className="rounded-xl border border-brass/70 bg-brass/20 px-4 py-2 text-sm font-semibold text-amber-100 disabled:opacity-50"
              >
                {isSwitching ? 'Switching network...' : `Switch wallet to ${chainId}`}
              </button>
            ) : null}
          </div>
        </form>

        {error ? <p className="mt-4 text-sm text-rose-300">{error}</p> : null}

        {quote ? (
          <div className="mt-5 rounded-2xl border border-mint/50 bg-emerald-950/30 p-4 text-sm">
            <p>
              <span className="font-semibold text-mint">Expected out:</span> {quote.expected_out} {quote.token_out}
            </p>
            <p>
              <span className="font-semibold text-mint">Minimum out:</span> {quote.min_out} {quote.token_out}
            </p>
            <p>
              <span className="font-semibold text-mint">Route:</span> {quote.route.join(' -> ')}
            </p>
            <p>
              <span className="font-semibold text-mint">Engine:</span> {quote.engine}
            </p>
          </div>
        ) : null}
      </section>

      <div className="space-y-4">
        <WalletPanel />

        <section className="rounded-2xl border border-amber-400/35 bg-amber-500/10 p-4 text-sm text-amber-100">
          <p className="text-xs uppercase tracking-[0.22em] text-amber-300">Dissonance Guards</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Set strict slippage before execution.</li>
            <li>Bridged assets (wBTC/wSOL) inherit bridge trust assumptions.</li>
            <li>Quotes are indicative until wallet signs on-chain swap.</li>
            <li>If wallet chain mismatches, switch network before submit.</li>
          </ul>
        </section>
      </div>
    </div>
  );
}
