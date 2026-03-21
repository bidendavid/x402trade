import { Router, Request, Response } from 'express';
import { getPool } from '../lib/db';
import { getOrCreateAgent } from '../lib/ledger';
import { verifyVaultDeposit } from '../lib/vault';
import { isValidAddress } from '../lib/validate';

const router = Router();

const USDC_CONTRACT = process.env.USDC_CONTRACT || '0x833589fCD6eDb6E08f4c7C32D4f71b54bA02913C';

router.post('/deposit', async (req: Request, res: Response) => {
  const { wallet, txHash } = req.body as { wallet: string; txHash: string };

  if (!wallet || !txHash) {
    res.status(400).json({ error: 'wallet and txHash required' });
    return;
  }
  if (!isValidAddress(wallet)) {
    res.status(400).json({ error: 'Invalid wallet address format' });
    return;
  }
  if (!process.env.TRADING_VAULT_ADDRESS) {
    res.status(503).json({ error: 'TradingVault address not configured' });
    return;
  }

  const pool = getPool();

  try {
    // Verify the on-chain deposit in TradingVault
    let depositResult: { amount: string; asset: 'USDC' | 'ETH' };
    try {
      depositResult = await verifyVaultDeposit(wallet, txHash);
    } catch (err) {
      const msg = (err as Error).message;
      // Surface expected user-facing errors; mask internal RPC/contract details
      const safe = ['failed or not found', 'No matching Deposited event', 'not configured']
        .some(s => msg.includes(s));
      res.status(400).json({ error: safe ? msg : 'Deposit verification failed' });
      return;
    }

    const { amount: amountDecimal, asset } = depositResult;
    const tokenAddress = asset === 'USDC' ? USDC_CONTRACT : '0x0000000000000000000000000000000000000000';

    const agent = await getOrCreateAgent(wallet);
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Idempotency guard — one txHash can only be credited once
      const insertResult = await client.query(
        `INSERT INTO payments (payment_hash, agent_id, endpoint, amount, token_address, status, confirmed_at)
         VALUES ($1, $2, 'deposit', $3, $4, 'confirmed', NOW())
         ON CONFLICT (payment_hash) DO NOTHING`,
        [txHash.toLowerCase(), agent.id, amountDecimal, tokenAddress]
      );

      if ((insertResult.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK');
        res.status(409).json({ error: 'Transaction already processed' });
        return;
      }

      // Mirror the on-chain vault balance change into the DB ledger
      const DEPOSIT_COL = { USDC: 'usdc_balance', ETH: 'eth_balance' } as const;
      const col = DEPOSIT_COL[asset];
      await client.query(
        `UPDATE balances b SET ${col} = ${col} + $1, updated_at = NOW()
         FROM agents a WHERE a.id = b.agent_id AND a.wallet_address = $2`,
        [amountDecimal, wallet.toLowerCase()]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({ success: true, wallet, txHash, amount: amountDecimal, asset });
  } catch (err) {
    console.error('[deposit] processing error:', (err as Error).message);
    res.status(500).json({ error: 'Deposit processing failed' });
  }
});

export default router;
