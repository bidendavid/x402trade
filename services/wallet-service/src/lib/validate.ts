/** Validate Ethereum wallet address format (0x + 40 hex chars). */
export function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}
