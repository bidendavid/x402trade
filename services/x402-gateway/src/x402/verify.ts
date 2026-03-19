import { ethers } from 'ethers';
import { getRedis } from '../lib/redis';

export interface X402Payment {
  wallet: string;
  signature: string;
  amount: string;
  nonce: string; // ms timestamp as string
}

export interface VerifyResult {
  valid: boolean;
  reason?: string;
  payment?: X402Payment;
}

export function parseX402Header(header: string): X402Payment {
  const decoded = Buffer.from(header, 'base64').toString('utf8');
  return JSON.parse(decoded) as X402Payment;
}

/** Agent signs: `x402:<nonce>:<amount>` */
export function buildSignMessage(nonce: string, amount: string): string {
  return `x402:${nonce}:${amount}`;
}

export async function verifySignature(payment: X402Payment): Promise<boolean> {
  try {
    const msg = buildSignMessage(payment.nonce, payment.amount);
    const recovered = ethers.verifyMessage(msg, payment.signature);
    return recovered.toLowerCase() === payment.wallet.toLowerCase();
  } catch {
    return false;
  }
}

/** Nonce must be within ±5 minutes of server time */
export function isNonceFresh(nonce: string): boolean {
  const ts = parseInt(nonce);
  if (isNaN(ts)) return false;
  return Math.abs(Date.now() - ts) < 5 * 60 * 1000;
}

export async function checkReplay(wallet: string, nonce: string): Promise<boolean> {
  const redis = getRedis();
  return (await redis.exists(`x402:nonce:${wallet.toLowerCase()}:${nonce}`)) === 1;
}

export async function markNonceUsed(wallet: string, nonce: string): Promise<void> {
  const redis = getRedis();
  await redis.set(`x402:nonce:${wallet.toLowerCase()}:${nonce}`, '1', 'EX', 600);
}

export async function checkBlacklist(wallet: string): Promise<boolean> {
  const redis = getRedis();
  return (await redis.exists(`blacklist:${wallet.toLowerCase()}`)) === 1;
}

export async function verifyX402Payment(header: string, requiredAmount: string): Promise<VerifyResult> {
  let payment: X402Payment;
  try {
    payment = parseX402Header(header);
  } catch {
    return { valid: false, reason: 'Invalid payment header format' };
  }

  if (!payment.wallet || !payment.signature || !payment.amount || !payment.nonce) {
    return { valid: false, reason: 'Missing required fields: wallet, signature, amount, nonce' };
  }

  if (!isNonceFresh(payment.nonce)) {
    return { valid: false, reason: 'Nonce expired — must be within 5 minutes of server time' };
  }

  if (parseFloat(payment.amount) < parseFloat(requiredAmount)) {
    return { valid: false, reason: `Insufficient payment: required ${requiredAmount} USDC, sent ${payment.amount}` };
  }

  const sigValid = await verifySignature(payment);
  if (!sigValid) {
    return { valid: false, reason: 'Invalid signature' };
  }

  const isReplay = await checkReplay(payment.wallet, payment.nonce);
  if (isReplay) {
    return { valid: false, reason: 'Nonce already used' };
  }

  const isBlacklisted = await checkBlacklist(payment.wallet);
  if (isBlacklisted) {
    return { valid: false, reason: 'Agent blacklisted' };
  }

  return { valid: true, payment };
}
