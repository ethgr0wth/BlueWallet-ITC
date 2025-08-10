import * as interchained from 'interchainedjs-lib';

export function isValidBech32Address(address: string): boolean {
  try {
    interchained.address.fromBech32(address);    
    return true;
  } catch (e) {
    return false;
  }
}