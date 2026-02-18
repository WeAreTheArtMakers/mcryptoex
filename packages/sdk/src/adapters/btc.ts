import { BtcBoundaryAdapter } from './types';

export const createBtcBoundaryAdapter = (input: BtcBoundaryAdapter): BtcBoundaryAdapter => ({
  ...input,
  protocol: 'btc',
  wrappedTokenSymbol: 'wBTC',
  settlementBoundary: 'wrapped-on-evm'
});
