import { SolBoundaryAdapter } from './types';

export const createSolBoundaryAdapter = (input: SolBoundaryAdapter): SolBoundaryAdapter => ({
  ...input,
  protocol: 'sol',
  wrappedTokenSymbol: 'wSOL',
  settlementBoundary: 'wrapped-on-evm'
});
