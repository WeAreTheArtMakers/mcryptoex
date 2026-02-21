'use client';

import { useEffect, useMemo, useState } from 'react';
import { Address, erc20Abi, formatUnits, isAddress, maxUint256, parseUnits } from 'viem';
import { useAccount, usePublicClient, useSwitchChain, useWalletClient } from 'wagmi';
import { WalletPanel } from '../../components/wallet-panel';

const API_BASE = process.env.NEXT_PUBLIC_TEMPO_API_BASE || 'http://localhost:8500';
const LOCAL_CHAIN_ENABLED = process.env.NEXT_PUBLIC_ENABLE_LOCAL_CHAIN === 'true';
const ENV_DEFAULT_CHAIN_ID = Number(process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID || (LOCAL_CHAIN_ENABLED ? '31337' : '97'));
const DEFAULT_CHAIN_ID = Number.isFinite(ENV_DEFAULT_CHAIN_ID) ? ENV_DEFAULT_CHAIN_ID : LOCAL_CHAIN_ENABLED ? 31337 : 97;

const harmonyRouterAbi = [
  {
    inputs: [
      { internalType: 'address', name: 'tokenA', type: 'address' },
      { internalType: 'address', name: 'tokenB', type: 'address' },
      { internalType: 'uint256', name: 'amountADesired', type: 'uint256' },
      { internalType: 'uint256', name: 'amountBDesired', type: 'uint256' },
      { internalType: 'uint256', name: 'amountAMin', type: 'uint256' },
      { internalType: 'uint256', name: 'amountBMin', type: 'uint256' },
      { internalType: 'address', name: 'to', type: 'address' },
      { internalType: 'uint256', name: 'deadline', type: 'uint256' }
    ],
    name: 'addLiquidity',
    outputs: [
      { internalType: 'uint256', name: 'amountA', type: 'uint256' },
      { internalType: 'uint256', name: 'amountB', type: 'uint256' },
      { internalType: 'uint256', name: 'liquidity', type: 'uint256' }
    ],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [
      { internalType: 'address', name: 'tokenA', type: 'address' },
      { internalType: 'address', name: 'tokenB', type: 'address' },
      { internalType: 'uint256', name: 'liquidity', type: 'uint256' },
      { internalType: 'uint256', name: 'amountAMin', type: 'uint256' },
      { internalType: 'uint256', name: 'amountBMin', type: 'uint256' },
      { internalType: 'address', name: 'to', type: 'address' },
      { internalType: 'uint256', name: 'deadline', type: 'uint256' }
    ],
    name: 'removeLiquidity',
    outputs: [
      { internalType: 'uint256', name: 'amountA', type: 'uint256' },
      { internalType: 'uint256', name: 'amountB', type: 'uint256' }
    ],
    stateMutability: 'nonpayable',
    type: 'function'
  }
] as const;

const pairAbi = [
  {
    inputs: [],
    name: 'getReserves',
    outputs: [
      { internalType: 'uint112', name: 'reserve0', type: 'uint112' },
      { internalType: 'uint112', name: 'reserve1', type: 'uint112' },
      { internalType: 'uint32', name: 'blockTimestampLast', type: 'uint32' }
    ],
    stateMutability: 'view',
    type: 'function'
  }
] as const;

type TokenItem = {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
};

type NetworkItem = {
  chain_id: number;
  name: string;
  router_address?: string;
  pair_count?: number;
  protocol_fee_receiver?: string;
};

type PairRow = {
  chain_id: number;
  pool_address: string;
  token0_symbol: string;
  token1_symbol: string;
  token0_address: string;
  token1_address: string;
  reserve0_decimal: string;
  reserve1_decimal: string;
  swaps: number;
  total_fee_usd: string;
  total_amount_in: string;
  last_swap_at?: string | null;
};

type TokensResponse = {
  chains: Record<string, TokenItem[]>;
  networks?: NetworkItem[];
};

type PairsResponse = {
  rows: PairRow[];
};

const DEFAULT_NETWORKS: NetworkItem[] = [
  { chain_id: 97, name: 'BNB Chain Testnet' },
  { chain_id: 11155111, name: 'Ethereum Sepolia' }
];
const BALANCE_PERCENT_PRESETS = [25, 50, 75, 100] as const;

function n(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function shortAmount(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  if (parsed === 0) return '0';
  if (parsed < 0.000001) return parsed.toExponential(2);
  return parsed.toFixed(6).replace(/\.?0+$/, '');
}

function formatInputAmount(value: number, decimals = 6): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  const precision = Math.max(0, Math.min(8, decimals));
  return value.toFixed(precision).replace(/\.?0+$/, '');
}

function normalizeNumericInput(value: string): string {
  return value.replace(/,/g, '.').trim();
}

function parseInputNumber(value: string): number {
  const parsed = Number(normalizeNumericInput(value));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function quoteByReserves(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  return (amountIn * reserveOut) / reserveIn;
}

function detail(status: number, body: unknown): string {
  if (body && typeof body === 'object') {
    const payload = body as { detail?: unknown };
    if (typeof payload.detail === 'string' && payload.detail.trim()) return payload.detail;
  }
  return `request failed: ${status}`;
}

export default function LiquidityPage() {
  const [queryPrefill, setQueryPrefill] = useState<{ tokenA: string; tokenB: string }>({ tokenA: '', tokenB: '' });
  const [chainId, setChainId] = useState<number>(DEFAULT_CHAIN_ID);
  const [networks, setNetworks] = useState<NetworkItem[]>(DEFAULT_NETWORKS);
  const [tokensByChain, setTokensByChain] = useState<Record<string, TokenItem[]>>({});
  const [pairs, setPairs] = useState<PairRow[]>([]);

  const [tokenA, setTokenA] = useState('USDC');
  const [tokenB, setTokenB] = useState('mUSD');
  const [amountA, setAmountA] = useState('10');
  const [amountB, setAmountB] = useState('10');
  const [slippageBps, setSlippageBps] = useState(50);

  const [removePairAddress, setRemovePairAddress] = useState('');
  const [removeLiquidityAmount, setRemoveLiquidityAmount] = useState('0.1');

  const [addStatus, setAddStatus] = useState('');
  const [addError, setAddError] = useState('');
  const [removeStatus, setRemoveStatus] = useState('');
  const [removeError, setRemoveError] = useState('');
  const [loading, setLoading] = useState(false);
  const [pairsError, setPairsError] = useState('');
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [lpBalance, setLpBalance] = useState('0');
  const [reloadNonce, setReloadNonce] = useState(0);

  const { address, isConnected, chainId: walletChainId } = useAccount();
  const publicClient = usePublicClient({ chainId });
  const { data: walletClient } = useWalletClient({ chainId });
  const { chains, switchChain, isPending: isSwitching } = useSwitchChain();

  const chainTokens = useMemo(() => tokensByChain[String(chainId)] || [], [tokensByChain, chainId]);
  const tokenMap = useMemo(() => {
    const map = new Map<string, TokenItem>();
    for (const token of chainTokens) map.set(token.symbol.toUpperCase(), token);
    return map;
  }, [chainTokens]);

  const selectedNetwork = useMemo(() => networks.find((x) => x.chain_id === chainId), [networks, chainId]);
  const tokenAInfo = useMemo(() => tokenMap.get(tokenA.toUpperCase()) || null, [tokenA, tokenMap]);
  const tokenBInfo = useMemo(() => tokenMap.get(tokenB.toUpperCase()) || null, [tokenB, tokenMap]);
  const addPair = useMemo(() => {
    const a = tokenA.toUpperCase();
    const b = tokenB.toUpperCase();
    return (
      pairs.find((pair) => {
        const p0 = pair.token0_symbol.toUpperCase();
        const p1 = pair.token1_symbol.toUpperCase();
        return (p0 === a && p1 === b) || (p0 === b && p1 === a);
      }) || null
    );
  }, [pairs, tokenA, tokenB]);
  const tokenABalance = useMemo(() => n(balances[tokenA] || '0'), [balances, tokenA]);
  const tokenBBalance = useMemo(() => n(balances[tokenB] || '0'), [balances, tokenB]);
  const selectedPair = useMemo(
    () => pairs.find((pair) => pair.pool_address.toLowerCase() === removePairAddress.toLowerCase()) || null,
    [pairs, removePairAddress]
  );

  const canPromptSwitch =
    isConnected && typeof walletChainId === 'number' && walletChainId !== chainId && chains.some((c) => c.id === chainId);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    setQueryPrefill({
      tokenA: (params.get('tokenA') || '').trim(),
      tokenB: (params.get('tokenB') || '').trim()
    });
  }, []);

  useEffect(() => {
    let active = true;
    async function loadTokens() {
      try {
        const res = await fetch(`${API_BASE}/tokens`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`token registry unavailable (${res.status})`);
        const payload = (await res.json()) as TokensResponse;
        if (!active) return;
        setTokensByChain(payload.chains || {});
        if (payload.networks?.length) setNetworks(payload.networks);
      } catch (error) {
        if (!active) return;
        setPairsError(error instanceof Error ? error.message : 'token registry unavailable');
      }
    }
    loadTokens();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!chainTokens.length) return;

    const qpTokenA = queryPrefill.tokenA;
    const qpTokenB = queryPrefill.tokenB;

    const hasTokenA = chainTokens.some((token) => token.symbol === tokenA);
    const hasTokenB = chainTokens.some((token) => token.symbol === tokenB);

    if (!hasTokenA) {
      const fromQuery = chainTokens.find((token) => token.symbol.toUpperCase() === qpTokenA.toUpperCase());
      const fallback =
        fromQuery || chainTokens.find((token) => token.symbol.toUpperCase() !== 'MUSD') || chainTokens[0] || null;
      if (fallback) setTokenA(fallback.symbol);
    }

    if (!hasTokenB) {
      const fromQuery = chainTokens.find((token) => token.symbol.toUpperCase() === qpTokenB.toUpperCase());
      const fallback = fromQuery || chainTokens.find((token) => token.symbol.toUpperCase() === 'MUSD') || chainTokens[1] || chainTokens[0] || null;
      if (fallback) setTokenB(fallback.symbol);
    }
  }, [chainTokens, tokenA, tokenB, queryPrefill.tokenA, queryPrefill.tokenB]);

  useEffect(() => {
    let active = true;
    async function loadPairs() {
      try {
        const res = await fetch(`${API_BASE}/pairs?chain_id=${chainId}&limit=100`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`pairs unavailable (${res.status})`);
        const payload = (await res.json()) as PairsResponse;
        if (!active) return;
        const rows = payload.rows || [];
        setPairs(rows);
        setPairsError('');
        if (!removePairAddress && rows.length) {
          setRemovePairAddress(rows[0].pool_address);
        }
      } catch (error) {
        if (!active) return;
        setPairs([]);
        setPairsError(error instanceof Error ? error.message : 'pairs unavailable');
      }
    }

    loadPairs();
    const timer = setInterval(loadPairs, 12_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [chainId, removePairAddress, reloadNonce]);

  useEffect(() => {
    let active = true;

    async function loadBalances() {
      if (!address || !publicClient) {
        setBalances({});
        setLpBalance('0');
        return;
      }

      const next: Record<string, string> = {};
      for (const token of chainTokens) {
        if (!isAddress(token.address)) continue;
        try {
          const raw = (await publicClient.readContract({
            address: token.address as Address,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [address]
          })) as bigint;
          next[token.symbol] = formatUnits(raw, token.decimals);
        } catch {
          next[token.symbol] = '0';
        }
      }

      let nextLpBalance = '0';
      if (selectedPair && isAddress(selectedPair.pool_address)) {
        try {
          const rawLp = (await publicClient.readContract({
            address: selectedPair.pool_address as Address,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [address]
          })) as bigint;
          nextLpBalance = formatUnits(rawLp, 18);
        } catch {
          nextLpBalance = '0';
        }
      }

      if (!active) return;
      setBalances(next);
      setLpBalance(nextLpBalance);
    }

    loadBalances();
    return () => {
      active = false;
    };
  }, [address, publicClient, chainTokens, selectedPair, reloadNonce]);

  async function ensureAllowance(token: TokenItem, spender: Address, amount: bigint) {
    if (!address || !publicClient || !walletClient) return;
    const allowance = (await publicClient.readContract({
      address: token.address as Address,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [address, spender]
    })) as bigint;
    if (allowance >= amount) return;

    const approveHash = await walletClient.writeContract({
      account: walletClient.account,
      address: token.address as Address,
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender, maxUint256]
    });
    const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
    if (approveReceipt.status !== 'success') {
      throw new Error(`Approve reverted on-chain for ${token.symbol}. Tx: ${approveHash}`);
    }
  }

  async function handleAddLiquidity() {
    setAddError('');
    setAddStatus('');

    if (!isConnected || !address) {
      setAddError('Connect wallet first.');
      return;
    }
    if (walletChainId !== chainId) {
      setAddError(`Wallet network mismatch. Switch wallet to chain ${chainId}.`);
      return;
    }
    if (!publicClient || !walletClient) {
      setAddError('Wallet client not ready.');
      return;
    }
    if (!selectedNetwork?.router_address || !isAddress(selectedNetwork.router_address)) {
      setAddError('Router address is missing in chain registry.');
      return;
    }
    if (tokenA.toUpperCase() === tokenB.toUpperCase()) {
      setAddError('Select two different tokens.');
      return;
    }

    if (!tokenAInfo || !tokenBInfo || !isAddress(tokenAInfo.address) || !isAddress(tokenBInfo.address)) {
      setAddError('Selected token address is not EVM-compatible on this chain.');
      return;
    }
    const normalizedAmountA = normalizeNumericInput(amountA);
    const normalizedAmountB = normalizeNumericInput(amountB);
    if (parseInputNumber(normalizedAmountA) <= 0 || parseInputNumber(normalizedAmountB) <= 0) {
      setAddError('Amounts must be greater than zero.');
      return;
    }

    const router = selectedNetwork.router_address as Address;

    try {
      setLoading(true);
      const amountARaw = parseUnits(normalizedAmountA, tokenAInfo.decimals);
      const amountBRaw = parseUnits(normalizedAmountB, tokenBInfo.decimals);
      let expectedAmountARaw = amountARaw;
      let expectedAmountBRaw = amountBRaw;

      if (addPair) {
        const pairToken0 = addPair.token0_symbol.toUpperCase();
        const pairToken1 = addPair.token1_symbol.toUpperCase();
        const pairToken0Info = tokenMap.get(pairToken0);
        const pairToken1Info = tokenMap.get(pairToken1);
        if (pairToken0Info && pairToken1Info) {
          const reserve0Raw = parseUnits(addPair.reserve0_decimal || '0', pairToken0Info.decimals);
          const reserve1Raw = parseUnits(addPair.reserve1_decimal || '0', pairToken1Info.decimals);
          const tokenAIsToken0 = tokenA.toUpperCase() === pairToken0;
          const reserveARaw = tokenAIsToken0 ? reserve0Raw : reserve1Raw;
          const reserveBRaw = tokenAIsToken0 ? reserve1Raw : reserve0Raw;

          if (reserveARaw > 0n && reserveBRaw > 0n) {
            const amountBOptimal = quoteByReserves(amountARaw, reserveARaw, reserveBRaw);
            if (amountBOptimal > 0n && amountBOptimal <= amountBRaw) {
              expectedAmountARaw = amountARaw;
              expectedAmountBRaw = amountBOptimal;
            } else {
              const amountAOptimal = quoteByReserves(amountBRaw, reserveBRaw, reserveARaw);
              if (amountAOptimal > 0n && amountAOptimal <= amountARaw) {
                expectedAmountARaw = amountAOptimal;
                expectedAmountBRaw = amountBRaw;
              }
            }
          }
        }
      }

      const amountAMin = (expectedAmountARaw * BigInt(10_000 - slippageBps)) / 10_000n;
      const amountBMin = (expectedAmountBRaw * BigInt(10_000 - slippageBps)) / 10_000n;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 1_200);

      if (expectedAmountARaw !== amountARaw || expectedAmountBRaw !== amountBRaw) {
        setAddStatus(
          `Pool ratio detected. Expected fill ~ ${shortAmount(formatUnits(expectedAmountARaw, tokenAInfo.decimals))} ${tokenAInfo.symbol} + ${shortAmount(formatUnits(expectedAmountBRaw, tokenBInfo.decimals))} ${tokenBInfo.symbol}`
        );
      }

      setAddStatus('Approving token A...');
      await ensureAllowance(tokenAInfo, router, amountARaw);
      setAddStatus('Approving token B...');
      await ensureAllowance(tokenBInfo, router, amountBRaw);

      setAddStatus('Submitting add-liquidity transaction...');
      const txHash = await walletClient.writeContract({
        account: walletClient.account,
        address: router,
        abi: harmonyRouterAbi,
        functionName: 'addLiquidity',
        args: [
          tokenAInfo.address as Address,
          tokenBInfo.address as Address,
          amountARaw,
          amountBRaw,
          amountAMin,
          amountBMin,
          address,
          deadline
        ]
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') {
        throw new Error(`Add liquidity reverted on-chain. Tx: ${txHash}`);
      }
      setAddStatus(`Liquidity added: ${txHash}`);
      setReloadNonce((v) => v + 1);
    } catch (error) {
      setAddError(error instanceof Error ? error.message : 'add liquidity failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleRemoveLiquidity() {
    setRemoveError('');
    setRemoveStatus('');

    if (!isConnected || !address) {
      setRemoveError('Connect wallet first.');
      return;
    }
    if (walletChainId !== chainId) {
      setRemoveError(`Wallet network mismatch. Switch wallet to chain ${chainId}.`);
      return;
    }
    if (!publicClient || !walletClient) {
      setRemoveError('Wallet client not ready.');
      return;
    }
    if (!selectedNetwork?.router_address || !isAddress(selectedNetwork.router_address)) {
      setRemoveError('Router address is missing in chain registry.');
      return;
    }
    if (!selectedPair || !isAddress(selectedPair.pool_address)) {
      setRemoveError('Select a valid pool first.');
      return;
    }
    const normalizedRemoveAmount = normalizeNumericInput(removeLiquidityAmount);
    if (parseInputNumber(normalizedRemoveAmount) <= 0) {
      setRemoveError('LP amount must be greater than zero.');
      return;
    }

    const token0Info = tokenMap.get(selectedPair.token0_symbol.toUpperCase());
    const token1Info = tokenMap.get(selectedPair.token1_symbol.toUpperCase());

    const tokenAAddress =
      isAddress(selectedPair.token0_address) ? (selectedPair.token0_address as Address) : ((token0Info?.address || '') as Address);
    const tokenBAddress =
      isAddress(selectedPair.token1_address) ? (selectedPair.token1_address as Address) : ((token1Info?.address || '') as Address);

    if (!isAddress(tokenAAddress) || !isAddress(tokenBAddress)) {
      setRemoveError('Pair token addresses cannot be resolved from registry.');
      return;
    }

    try {
      setLoading(true);
      const router = selectedNetwork.router_address as Address;
      const pairAddress = selectedPair.pool_address as Address;
      const liquidityRaw = parseUnits(normalizedRemoveAmount, 18);

      const reserves = (await publicClient.readContract({
        address: pairAddress,
        abi: pairAbi,
        functionName: 'getReserves'
      })) as [bigint, bigint, number];

      const totalSupply = (await publicClient.readContract({
        address: pairAddress,
        abi: erc20Abi,
        functionName: 'totalSupply'
      })) as bigint;

      if (totalSupply === 0n) {
        setRemoveError('Pool total supply is zero; cannot remove liquidity.');
        setLoading(false);
        return;
      }

      const expected0 = (liquidityRaw * reserves[0]) / totalSupply;
      const expected1 = (liquidityRaw * reserves[1]) / totalSupply;
      const amountAMin = (expected0 * BigInt(10_000 - slippageBps)) / 10_000n;
      const amountBMin = (expected1 * BigInt(10_000 - slippageBps)) / 10_000n;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 1_200);

      const allowance = (await publicClient.readContract({
        address: pairAddress,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [address, router]
      })) as bigint;

      if (allowance < liquidityRaw) {
        setRemoveStatus('Approving LP token allowance...');
        const approveHash = await walletClient.writeContract({
          account: walletClient.account,
          address: pairAddress,
          abi: erc20Abi,
          functionName: 'approve',
          args: [router, maxUint256]
        });
        const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
        if (approveReceipt.status !== 'success') {
          throw new Error(`LP approve reverted on-chain. Tx: ${approveHash}`);
        }
      }

      setRemoveStatus('Submitting remove-liquidity transaction...');
      const txHash = await walletClient.writeContract({
        account: walletClient.account,
        address: router,
        abi: harmonyRouterAbi,
        functionName: 'removeLiquidity',
        args: [tokenAAddress, tokenBAddress, liquidityRaw, amountAMin, amountBMin, address, deadline]
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') {
        throw new Error(`Remove liquidity reverted on-chain. Tx: ${txHash}`);
      }
      setRemoveStatus(`Liquidity removed: ${txHash}`);
      setReloadNonce((v) => v + 1);
    } catch (error) {
      setRemoveError(error instanceof Error ? error.message : 'remove liquidity failed');
    } finally {
      setLoading(false);
    }
  }

  const poolTotals = useMemo(() => {
    const totalSwaps = pairs.reduce((sum, row) => sum + n(row.swaps), 0);
    const totalFees = pairs.reduce((sum, row) => sum + n(row.total_fee_usd), 0);
    return { totalSwaps, totalFees };
  }, [pairs]);

  function applyAmountPreset(target: 'A' | 'B', percent: number) {
    if (target === 'A') {
      const next = (tokenABalance * percent) / 100;
      setAmountA(formatInputAmount(next, tokenAInfo?.decimals || 6));
      return;
    }
    const next = (tokenBBalance * percent) / 100;
    setAmountB(formatInputAmount(next, tokenBInfo?.decimals || 6));
  }

  function applyRemoveLpPreset(percent: number) {
    const next = (n(lpBalance) * percent) / 100;
    setRemoveLiquidityAmount(formatInputAmount(next, 18));
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[1.7fr_1fr]">
      <section className="space-y-4 rounded-3xl border border-slateblue/70 bg-gradient-to-br from-[#101e39]/95 via-[#132742]/90 to-[#174766]/80 p-5 shadow-halo">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-brass">Liquidity Section</p>
            <h2 className="text-2xl font-semibold">Add / Remove Liquidity</h2>
          </div>
          <div className="rounded-xl border border-slateblue/70 bg-slate-950/60 px-3 py-2 text-xs text-slate-200">
            Chain {chainId} | Pools {pairs.length}
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-3">
          <div className="rounded-xl border border-mint/45 bg-mint/10 p-3">
            <p className="text-[11px] uppercase tracking-[0.14em] text-mint">Discovered Pools</p>
            <p className="mt-1 font-mono">{pairs.length}</p>
          </div>
          <div className="rounded-xl border border-brass/45 bg-brass/10 p-3">
            <p className="text-[11px] uppercase tracking-[0.14em] text-amber-100">Total Swaps</p>
            <p className="mt-1 font-mono">{poolTotals.totalSwaps}</p>
          </div>
          <div className="rounded-xl border border-cyan-300/40 bg-cyan-500/10 p-3">
            <p className="text-[11px] uppercase tracking-[0.14em] text-cyan-100">Fee Volume (USD)</p>
            <p className="mt-1 font-mono">{poolTotals.totalFees.toFixed(4)}</p>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-2xl border border-slateblue/65 bg-slate-950/55 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-300">Add Liquidity</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <label className="space-y-1">
                <span className="text-xs uppercase tracking-[0.14em] text-slate-300">Chain</span>
                <select
                  value={chainId}
                  onChange={(event) => setChainId(Number(event.target.value))}
                  className="w-full rounded-lg border border-slateblue/70 bg-slate-950/80 px-3 py-2"
                >
                  {networks.map((network) => (
                    <option key={network.chain_id} value={network.chain_id}>
                      {network.name} ({network.chain_id})
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-xs uppercase tracking-[0.14em] text-slate-300">Slippage (bps)</span>
                <input
                  type="number"
                  min={1}
                  max={3000}
                  value={slippageBps}
                  onChange={(event) => setSlippageBps(Number(event.target.value))}
                  className="w-full rounded-lg border border-slateblue/70 bg-slate-950/80 px-3 py-2"
                />
              </label>
            </div>

            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <label className="space-y-1">
                <span className="text-xs uppercase tracking-[0.14em] text-slate-300">Token A</span>
                <select
                  value={tokenA}
                  onChange={(event) => setTokenA(event.target.value)}
                  className="w-full rounded-lg border border-slateblue/70 bg-slate-950/80 px-3 py-2"
                >
                  {chainTokens.map((token) => (
                    <option key={`tokenA-${token.symbol}-${token.address}`} value={token.symbol}>
                      {token.symbol}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-xs uppercase tracking-[0.14em] text-slate-300">Token B</span>
                <select
                  value={tokenB}
                  onChange={(event) => setTokenB(event.target.value)}
                  className="w-full rounded-lg border border-slateblue/70 bg-slate-950/80 px-3 py-2"
                >
                  {chainTokens.map((token) => (
                    <option key={`tokenB-${token.symbol}-${token.address}`} value={token.symbol}>
                      {token.symbol}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <label className="space-y-1">
                <span className="text-xs uppercase tracking-[0.14em] text-slate-300">Amount A</span>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={amountA}
                  onChange={(event) => setAmountA(event.target.value)}
                  className="w-full rounded-lg border border-slateblue/70 bg-slate-950/80 px-3 py-2"
                />
                <div className="flex items-center justify-between text-[11px] text-slate-300">
                  <span>
                    Wallet: <span className="font-mono">{shortAmount(String(tokenABalance))}</span> {tokenA}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {BALANCE_PERCENT_PRESETS.map((percent) => (
                    <button
                      key={`amountA-${percent}`}
                      type="button"
                      onClick={() => applyAmountPreset('A', percent)}
                      className="rounded-md border border-slateblue/60 bg-slate-900/50 px-2 py-1 text-[11px] text-slate-200 hover:border-mint/70 hover:text-mint"
                    >
                      %{percent}
                    </button>
                  ))}
                </div>
              </label>
              <label className="space-y-1">
                <span className="text-xs uppercase tracking-[0.14em] text-slate-300">Amount B</span>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={amountB}
                  onChange={(event) => setAmountB(event.target.value)}
                  className="w-full rounded-lg border border-slateblue/70 bg-slate-950/80 px-3 py-2"
                />
                <div className="flex items-center justify-between text-[11px] text-slate-300">
                  <span>
                    Wallet: <span className="font-mono">{shortAmount(String(tokenBBalance))}</span> {tokenB}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {BALANCE_PERCENT_PRESETS.map((percent) => (
                    <button
                      key={`amountB-${percent}`}
                      type="button"
                      onClick={() => applyAmountPreset('B', percent)}
                      className="rounded-md border border-slateblue/60 bg-slate-900/50 px-2 py-1 text-[11px] text-slate-200 hover:border-mint/70 hover:text-mint"
                    >
                      %{percent}
                    </button>
                  ))}
                </div>
              </label>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleAddLiquidity}
                disabled={loading}
                className="rounded-lg border border-mint/65 bg-mint/20 px-4 py-2 text-sm font-semibold text-mint disabled:opacity-50"
              >
                {loading ? 'Submitting...' : 'Add Liquidity'}
              </button>
              {canPromptSwitch ? (
                <button
                  type="button"
                  onClick={() => switchChain({ chainId })}
                  disabled={isSwitching}
                  className="rounded-lg border border-brass/70 bg-brass/20 px-4 py-2 text-sm font-semibold text-amber-100 disabled:opacity-50"
                >
                  {isSwitching ? 'Switching...' : `Switch Wallet to ${chainId}`}
                </button>
              ) : null}
            </div>
            {addError ? <p className="mt-2 text-sm text-rose-300">{addError}</p> : null}
            {addStatus ? <p className="mt-2 text-xs text-cyan-100">{addStatus}</p> : null}
          </section>

          <section className="rounded-2xl border border-slateblue/65 bg-slate-950/55 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-300">Remove Liquidity</p>
            <label className="mt-3 block space-y-1">
              <span className="text-xs uppercase tracking-[0.14em] text-slate-300">Pool</span>
              <select
                value={removePairAddress}
                onChange={(event) => setRemovePairAddress(event.target.value)}
                className="w-full rounded-lg border border-slateblue/70 bg-slate-950/80 px-3 py-2"
              >
                {pairs.map((pair) => (
                  <option key={pair.pool_address} value={pair.pool_address}>
                    {pair.token0_symbol}/{pair.token1_symbol} ({pair.pool_address.slice(0, 8)}...)
                  </option>
                ))}
              </select>
            </label>

            <label className="mt-3 block space-y-1">
              <span className="text-xs uppercase tracking-[0.14em] text-slate-300">LP Amount</span>
              <input
                type="number"
                min="0"
                step="any"
                value={removeLiquidityAmount}
                onChange={(event) => setRemoveLiquidityAmount(event.target.value)}
                className="w-full rounded-lg border border-slateblue/70 bg-slate-950/80 px-3 py-2"
              />
              <div className="mt-1 flex flex-wrap gap-1">
                {BALANCE_PERCENT_PRESETS.map((percent) => (
                  <button
                    key={`remove-lp-${percent}`}
                    type="button"
                    onClick={() => applyRemoveLpPreset(percent)}
                    className="rounded-md border border-slateblue/60 bg-slate-900/50 px-2 py-1 text-[11px] text-slate-200 hover:border-cyan-300/70 hover:text-cyan-200"
                  >
                    %{percent}
                  </button>
                ))}
              </div>
            </label>

            <div className="mt-3 rounded-lg border border-slateblue/50 bg-slate-900/50 p-3 text-xs text-slate-200">
              <p>
                Selected LP balance: <span className="font-mono">{shortAmount(lpBalance)}</span>
              </p>
              {selectedPair ? (
                <p className="mt-1 text-slate-300">
                  Reserves: {shortAmount(selectedPair.reserve0_decimal)} {selectedPair.token0_symbol} /{' '}
                  {shortAmount(selectedPair.reserve1_decimal)} {selectedPair.token1_symbol}
                </p>
              ) : null}
            </div>

            <button
              type="button"
              onClick={handleRemoveLiquidity}
              disabled={loading || !selectedPair}
              className="mt-4 rounded-lg border border-cyan-300/60 bg-cyan-500/20 px-4 py-2 text-sm font-semibold text-cyan-100 disabled:opacity-50"
            >
              {loading ? 'Submitting...' : 'Remove Liquidity'}
            </button>
            {removeError ? <p className="mt-2 text-sm text-rose-300">{removeError}</p> : null}
            {removeStatus ? <p className="mt-2 text-xs text-cyan-100">{removeStatus}</p> : null}
          </section>
        </div>

        {pairsError ? <p className="text-sm text-rose-300">{pairsError}</p> : null}

        <section className="rounded-2xl border border-slateblue/60 bg-slate-950/45 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-300">Pool Board</p>
          <div className="mt-2 overflow-x-auto">
            <table className="min-w-full text-left text-xs">
              <thead className="text-slate-300">
                <tr>
                  <th className="px-2 py-1">Pair</th>
                  <th className="px-2 py-1">Reserves</th>
                  <th className="px-2 py-1">Swaps</th>
                  <th className="px-2 py-1">Fee USD</th>
                  <th className="px-2 py-1">Last Swap</th>
                </tr>
              </thead>
              <tbody>
                {pairs.length === 0 ? (
                  <tr>
                    <td className="px-2 py-2 text-slate-300" colSpan={5}>
                      No pools discovered for this chain yet.
                    </td>
                  </tr>
                ) : (
                  pairs.map((pair) => (
                    <tr key={pair.pool_address} className="border-t border-slateblue/30">
                      <td className="px-2 py-2">
                        {pair.token0_symbol}/{pair.token1_symbol}
                      </td>
                      <td className="px-2 py-2 font-mono">
                        {shortAmount(pair.reserve0_decimal)} / {shortAmount(pair.reserve1_decimal)}
                      </td>
                      <td className="px-2 py-2">{pair.swaps}</td>
                      <td className="px-2 py-2 font-mono">{shortAmount(pair.total_fee_usd)}</td>
                      <td className="px-2 py-2">{pair.last_swap_at ? new Date(pair.last_swap_at).toLocaleString() : 'n/a'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </section>

      <div className="space-y-4">
        <WalletPanel />

        <section className="rounded-2xl border border-slateblue/70 bg-slate-950/55 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-300">Wallet Balances</p>
          {!isConnected ? (
            <p className="mt-2 text-sm text-slate-300">Connect wallet to load balances.</p>
          ) : (
            <div className="mt-2 space-y-2">
              {chainTokens.map((token) => (
                <div key={`${token.symbol}-${token.address}`} className="flex items-center justify-between rounded-lg border border-slateblue/50 bg-slate-900/50 px-3 py-2 text-sm">
                  <p>{token.symbol}</p>
                  <p className="font-mono text-xs">{shortAmount(balances[token.symbol] || '0')}</p>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-amber-400/35 bg-amber-500/10 p-4 text-sm text-amber-100">
          <p className="text-xs uppercase tracking-[0.22em] text-amber-300">Liquidity Safety Notes</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>All add/remove transactions are signed by your wallet only.</li>
            <li>Set slippage conservatively on thin pools.</li>
            <li>LP minimum lock remains burned at 0x...dEaD by pair design.</li>
            <li>Protocol fee receiver: {selectedNetwork?.protocol_fee_receiver || 'not configured'}.</li>
          </ul>
        </section>
      </div>
    </div>
  );
}
