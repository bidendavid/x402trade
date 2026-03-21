import { ethers } from 'ethers';

/** Validate Ethereum wallet address — checks format AND EIP-55 checksum. */
export function isValidAddress(addr: string): boolean {
  try {
    return ethers.isAddress(addr);
  } catch {
    return false;
  }
}
