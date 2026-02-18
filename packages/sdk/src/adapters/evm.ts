import { EvmChainAdapter } from './types';

export const createEvmAdapter = (input: EvmChainAdapter): EvmChainAdapter => ({
  ...input,
  protocol: 'evm'
});
