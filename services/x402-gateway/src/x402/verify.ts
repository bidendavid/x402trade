import { ethers } from 'ethers';
import { getRedis } from '../lib/redis';
import { USDC_CONTRACT, BASE_RPC_URL, X402_PAYMENT_ADDRESS } from './config';

export interface X402Payment {
  wallet: string;
  signature: string;
  message: string;
  transactionHash: string;
  amount: string;
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

export async function verifySignature(payment: X402Payment): Promise<boolean> {
  try {
    const recovered = ethers.verifyMessage(payment.message, payment.signature);
    return recovered.toLowerCase() === payment.wallet.toLowerCase();
  } catch {
    return false;
  }
}

export async function verifyUSDCTransfer(
  txHash: string,
  expectedAmount: string,
  toAddress: string
): Promise<boolean> {
  // Skip on-chain check in dev mode (no payment address configured)
  if (!toAddress) return true;

  try {
    const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt || receipt.status !== 1) return false;

    const iface = new ethers.Interface([
      'event Transfer(address indexed from, address indexed to, uint256 value)',
    ]);

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== USDC_CONTRACT.toLowerCase()) continue;
      try {
        const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
        if (!parsed) continue;
        if (
          parsed.args.to.toLowerCase() === toAddress.toLowerCase() &&
          parsed.args.value.toString() === expectedAmount
        ) {
          return true;
        }
      } catch {
        // not a Transfer event
      }
    }
    return false;
  } catch {
    return false;
  }
}

export async function checkReplay(txHash: string): Promise<boolean> {
  const redis = getRedis();
  const exists = await redis.exists(`x402:used:${txHash}`);
  return exists === 1;
}

export async function markPaymentUsed(txHash: string): Promise<void> {
  const redis = getRedis();
  await redis.set(`x402:used:${txHash}`, '1', 'EX', 7 * 24 * 3600);
}

export async function checkBlacklist(wallet: string): Promise<boolean> {
  const redis = getRedis();
  const exists = await redis.exists(`blacklist:${wallet.toLowerCase()}`);
  return exists === 1;
}

export async function verifyX402Payment(header: string): Promise<VerifyResult> {
  let payment: X402Payment;
  try {
    payment = parseX402Header(header);
  } catch {
    return { valid: false, reason: 'Invalid payment header format' };
  }

  if (!payment.wallet || !payment.signature || !payment.message || !payment.transactionHash || !payment.amount) {
    return { valid: false, reason: 'Missing required payment fields' };
  }

  const sigValid = await verifySignature(payment);
  if (!sigValid) {
    return { valid: false, reason: 'Invalid signature' };
  }

  const isReplay = await checkReplay(payment.transactionHash);
  if (isReplay) {
    return { valid: false, reason: 'Payment already used' };
  }

  const isBlacklisted = await checkBlacklist(payment.wallet);
  if (isBlacklisted) {
    return { valid: false, reason: 'Agent blacklisted' };
  }

  const transferValid = await verifyUSDCTransfer(
    payment.transactionHash,
    payment.amount,
    X402_PAYMENT_ADDRESS
  );
  if (!transferValid) {
    return { valid: false, reason: 'USDC transfer not confirmed' };
  }

  await markPaymentUsed(payment.transactionHash);

  return { valid: true, payment };
}
