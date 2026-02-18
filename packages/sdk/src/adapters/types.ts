export type AdapterProtocol = 'evm' | 'btc' | 'sol';

export type WrappedAssetTrust = {
  endpoint: string;
  assetSymbol: string;
  bridgeModel: 'custodial' | 'multisig' | 'messaging-protocol' | 'unknown';
  riskLevel: 'low' | 'medium' | 'high';
  statement: string;
};

export type AdapterNetwork = {
  chainKey: string;
  chainId?: number;
  rpcUrlEnvKey: string;
};

export interface ChainAdapter {
  readonly protocol: AdapterProtocol;
  readonly network: AdapterNetwork;
  readonly wrappedAssets: WrappedAssetTrust[];
}

export interface EvmChainAdapter extends ChainAdapter {
  readonly protocol: 'evm';
  readonly routerAddress?: string;
  readonly stabilizerAddress?: string;
  readonly factoryAddress?: string;
}

export interface BtcBoundaryAdapter extends ChainAdapter {
  readonly protocol: 'btc';
  readonly wrappedTokenSymbol: 'wBTC';
  readonly settlementBoundary: 'wrapped-on-evm';
}

export interface SolBoundaryAdapter extends ChainAdapter {
  readonly protocol: 'sol';
  readonly wrappedTokenSymbol: 'wSOL';
  readonly settlementBoundary: 'wrapped-on-evm';
}
