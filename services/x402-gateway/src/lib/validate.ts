export const VALID_PAIRS = new Set(['ETH-USDC', 'BTC-USDC']);

/** Validate that a pair string is in the supported list. */
export function isValidPair(pair: string): boolean {
  return VALID_PAIRS.has(pair);
}

/** Validate Ethereum wallet address format. */
export function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}
