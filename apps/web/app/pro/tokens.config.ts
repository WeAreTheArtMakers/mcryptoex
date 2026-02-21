export type TokenRiskFlag = 'wrapped' | 'experimental' | 'low-liquidity';

export type VenueTokenPreset = {
  key: string;
  preferredSymbols: string[];
  displaySymbol: string;
  aliases?: string[];
  logoUrl?: string;
  isWrapped?: boolean;
  underlyingSymbol?: string;
  riskFlags?: TokenRiskFlag[];
};

export type StaticChainToken = {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  source?: string;
  is_wrapped?: boolean;
  underlying_symbol?: string;
};

const DEFAULT_MARKET_BASES = ['WBNB', 'USDC', 'USDT', 'WETH', 'WBTC', 'WSOL', 'WAVAX', 'WZIL', 'MODX'];

export const MUSD_SYMBOL = 'MUSD';

export const TOKEN_PRESETS: VenueTokenPreset[] = [
  {
    key: MUSD_SYMBOL,
    preferredSymbols: ['MUSD', 'mUSD'],
    displaySymbol: 'mUSD',
    aliases: ['MUSD', 'mUSD', 'musd'],
    logoUrl: '/logos/musd.svg'
  },
  {
    key: 'WETH',
    preferredSymbols: ['WETH', 'ETH'],
    displaySymbol: 'ETH',
    aliases: ['eth', 'ethereum'],
    isWrapped: true,
    underlyingSymbol: 'ETH',
    riskFlags: ['wrapped']
  },
  {
    key: 'WBTC',
    preferredSymbols: ['WBTC', 'wBTC', 'BTC'],
    displaySymbol: 'BTC',
    aliases: ['btc', 'bitcoin'],
    isWrapped: true,
    underlyingSymbol: 'BTC',
    riskFlags: ['wrapped']
  },
  {
    key: 'WBNB',
    preferredSymbols: ['WBNB', 'BNB'],
    displaySymbol: 'BNB',
    aliases: ['bnb'],
    isWrapped: true,
    underlyingSymbol: 'BNB',
    riskFlags: ['wrapped']
  },
  {
    key: 'WSOL',
    preferredSymbols: ['WSOL', 'wSOL', 'SOL'],
    displaySymbol: 'SOL',
    aliases: ['sol', 'solana'],
    isWrapped: true,
    underlyingSymbol: 'SOL',
    riskFlags: ['wrapped']
  },
  {
    key: 'WAVAX',
    preferredSymbols: ['WAVAX', 'AVAX'],
    displaySymbol: 'AVAX',
    aliases: ['avax', 'avalanche'],
    isWrapped: true,
    underlyingSymbol: 'AVAX',
    riskFlags: ['wrapped']
  },
  {
    key: 'WZIL',
    preferredSymbols: ['WZIL', 'ZIL'],
    displaySymbol: 'ZIL',
    aliases: ['zil', 'zilliqa'],
    isWrapped: true,
    underlyingSymbol: 'ZIL',
    riskFlags: ['wrapped', 'experimental']
  },
  {
    key: 'USDC',
    preferredSymbols: ['USDC'],
    displaySymbol: 'USDC',
    aliases: ['usdc']
  },
  {
    key: 'USDT',
    preferredSymbols: ['USDT'],
    displaySymbol: 'USDT',
    aliases: ['usdt']
  },
  {
    key: 'MODX',
    preferredSymbols: ['MODX', 'modX'],
    displaySymbol: 'MODX',
    aliases: ['modx', 'modx token'],
    riskFlags: ['experimental']
  }
];

const STATIC_CHAIN_TOKENS: Record<number, StaticChainToken[]> = {
  97: [
    {
      symbol: 'MODX',
      name: 'modX Token',
      address: '0xB6322eD8561604Ca2A1b9c17e4d02B957EB242fe',
      decimals: 18,
      source: 'bsc-testnet-static',
      is_wrapped: false
    }
  ]
};

const PRESET_INDEX = new Map<string, VenueTokenPreset>();
for (const preset of TOKEN_PRESETS) {
  PRESET_INDEX.set(preset.key.toUpperCase(), preset);
  for (const symbol of preset.preferredSymbols) {
    PRESET_INDEX.set(symbol.toUpperCase(), preset);
  }
}

function parseCsvEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}

function dedupeUpper(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const upper = item.toUpperCase();
    if (seen.has(upper)) continue;
    seen.add(upper);
    out.push(upper);
  }
  return out;
}

export function resolveTokenPreset(symbol: string): VenueTokenPreset | null {
  return PRESET_INDEX.get(symbol.toUpperCase()) || null;
}

export function configuredMarketBaseKeys(): string[] {
  const extras = parseCsvEnv(process.env.NEXT_PUBLIC_EXTRA_MARKET_BASES);
  return dedupeUpper([...DEFAULT_MARKET_BASES, ...extras]).filter((key) => key !== MUSD_SYMBOL);
}

export function staticChainTokens(chainId: number): StaticChainToken[] {
  return STATIC_CHAIN_TOKENS[chainId] ? [...STATIC_CHAIN_TOKENS[chainId]] : [];
}

export function defaultMarketPair(): string {
  const raw = String(process.env.NEXT_PUBLIC_DEFAULT_MARKET || '').trim();
  if (!raw) return `MUSD/WBNB`;
  const normalized = raw.toUpperCase();
  if (normalized.includes('/')) return normalized;
  return `MUSD/${normalized}`;
}
