import { Router, Request, Response } from 'express';
import { ethers } from 'ethers';
import { getPool } from '../lib/db';
import { creditBalance, getOrCreateAgent } from '../lib/ledger';

const router = Router();

const USDC_CONTRACT = process.env.USDC_CONTRACT || '0x833589fCD6eDb6E08f4c7C32D4f71b54bA02913C';
const DEPOSIT_ADDRESS = process.env.DEPOSIT_ADDRESS || '';
const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const USDC_DECIMALS = 6;

const TRANSFER_IFACE = new ethers.Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

router.post('/deposit', async (req: Request, res: Response) => {
  const { wallet, txHash } = req.body as { wallet: string; txHash: string };

  if (!wallet || !txHash) {
    res.status(400).json({ error: 'wallet and txHash required' });
    return;
  }
  if (!DEPOSIT_ADDRESS) {
    res.status(503).json({ error: 'Deposit address not configured' });
    return;
  }

  const pool = getPool();

  // Idempotency: reject already-processed tx
  const existing = await pool.query('SELECT id FROM payments WHERE payment_hash = $1', [txHash.toLowerCase()]);
  if (existing.rows.length > 0) {
    res.status(409).json({ error: 'Transaction already processed' });
    return;
  }

  try {
    const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
    const receipt = await provider.getTransactionReceipt(txHash);

    if (!receipt || receipt.status !== 1) {
      res.status(400).json({ error: 'Transaction failed or not found' });
      return;
    }

    let depositAmount: bigint | null = null;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== USDC_CONTRACT.toLowerCase()) continue;
      try {
        const parsed = TRANSFER_IFACE.parseLog({ topics: log.topics as string[], data: log.data });
        if (!parsed) continue;
        if (
          parsed.args.to.toLowerCase() === DEPOSIT_ADDRESS.toLowerCase() &&
          parsed.args.from.toLowerCase() === wallet.toLowerCase()
        ) {
          depositAmount = parsed.args.value as bigint;
          break;
        }
      } catch { /* not a Transfer event */ }
    }

    if (!depositAmount) {
      res.status(400).json({ error: 'No matching USDC transfer found in transaction' });
      return;
    }

    const amountDecimal = ethers.formatUnits(depositAmount, USDC_DECIMALS);
    const agent = await getOrCreateAgent(wallet);

    await pool.query(
      `INSERT INTO payments (payment_hash, agent_id, endpoint, amount, token_address, status, confirmed_at)
       VALUES ($1, $2, 'deposit', $3, $4, 'confirmed', NOW())`,
      [txHash.toLowerCase(), agent.id, amountDecimal, USDC_CONTRACT]
    );

    await creditBalance(wallet, amountDecimal, 'usdc');

    res.json({ success: true, wallet, txHash, amount: amountDecimal, asset: 'USDC' });
  } catch (err) {
    res.status(500).json({ error: 'Deposit processing failed', message: (err as Error).message });
  }
});

export default router;
