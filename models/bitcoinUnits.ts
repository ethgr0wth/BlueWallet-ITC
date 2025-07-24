export const InterchainedUnit = {
  ITC: 'ITC',
  SATS: 'sats',
  LOCAL_CURRENCY: 'local_currency',
  MAX: 'MAX',
} as const;
export type InterchainedUnit = (typeof InterchainedUnit)[keyof typeof InterchainedUnit];

export const Chain = {
  ONCHAIN: 'ONCHAIN',
  OFFCHAIN: 'OFFCHAIN',
} as const;
export type Chain = (typeof Chain)[keyof typeof Chain];
