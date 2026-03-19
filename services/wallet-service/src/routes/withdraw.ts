import { Router, Request, Response } from 'express';
import { ethers } from 'ethers';
import { getPool } from '../lib/db';
import { getOrCreateAgent } from '../lib/ledger';
import { randomUUID } from 'crypto';

const router = Router();

router.post('/withdraw', async (req: Request, res: Response) => {
  const { wallet, amount, toAddress, signature } = req.body as {
    wallet: string;
    amount: string;
    toAddress: string;
    signature: string;
  };

  if (!wallet || !amount || !toAddress || !signature) {
    res.status(400).json({ error: 'wallet, amount, toAddress, signature required' });
    return;
  }

  // Verify the agent signed the withdrawal intent
  const message = `Withdraw ${amount} USDC to ${toAddress}`;
  try {
    const recovered = ethers.verifyMessage(message, signature);
    if (recovered.toLowerCase() !== wallet.toLowerCase()) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }
  } catch {
    res.status(401).json({ error: 'Signature verification failed' });
    return;
  }

  const requested = parseFloat(amount);
  if (requested <= 0) {
    res.status(400).json({ error: 'Amount must be positive' });
    return;
  }

  const pool = getPool();

  try {
    const agent = await getOrCreateAgent(wallet);
    const withdrawId = randomUUID();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Lock the balance row and check available funds atomically
      const balanceResult = await client.query(
        `SELECT b.usdc_balance FROM balances b WHERE b.agent_id = $1 FOR UPDATE`,
        [agent.id]
      );
      if (balanceResult.rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Agent balance not found' });
        return;
      }
      const available = parseFloat(balanceResult.rows[0].usdc_balance as string);
      if (requested > available) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: 'Insufficient balance', available: available.toFixed(6) });
        return;
      }

      await client.query(
        `UPDATE balances SET usdc_balance = usdc_balance - $1, updated_at = NOW() WHERE agent_id = $2`,
        [amount, agent.id]
      );
      await client.query(
        `INSERT INTO payments (payment_hash, agent_id, endpoint, amount, token_address, status)
         VALUES ($1, $2, 'withdraw', $3, $4, 'pending')`,
        [withdrawId, agent.id, amount, process.env.USDC_CONTRACT || '0x833589fCD6eDb6E08f4c7C32D4f71b54bA02913C']
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({ success: true, withdrawId, wallet, amount, toAddress, status: 'pending' });
  } catch (err) {
    res.status(500).json({ error: 'Withdraw failed', message: (err as Error).message });
  }
});

export default router;
