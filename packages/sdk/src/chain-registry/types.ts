export type RegistryToken = {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  source: string;
};

export type RegistryTrustAssumption = {
  endpoint: string;
  asset_symbol: string;
  category: 'native' | 'wrapped';
  risk_level: 'low' | 'medium' | 'high';
  statement: string;
};

export type RegistryChain = {
  chain_key: string;
  chain_id: number;
  name: string;
  network: string;
  rpc_env_key: string;
  default_rpc_url: string;
  contracts: {
    musd: string;
    stabilizer: string;
    oracle: string;
    harmony_factory: string;
    harmony_router: string;
  };
  indexer: {
    pair_addresses: string[];
    stabilizer_addresses: string[];
    start_block: string | number;
    confirmation_depth: number;
  };
  tokens: RegistryToken[];
  trust_assumptions: RegistryTrustAssumption[];
};

export type ChainRegistry = {
  version: number;
  generated_at: string;
  source: string;
  chains: RegistryChain[];
};
