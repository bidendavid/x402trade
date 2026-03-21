import { ethers } from 'ethers';

export const VALID_PAIRS = new Set(['ETH-USDC', 'BTC-USDC']);

/** Validate that a pair string is in the supported list. */
export function isValidPair(pair: string): boolean {
  return VALID_PAIRS.has(pair);
}

/** Validate Ethereum wallet address — checks format AND EIP-55 checksum. */
export function isValidAddress(addr: string): boolean {
  try {
    return ethers.isAddress(addr);
  } catch {
    return false;
  }
}
