import { Router, Request, Response } from 'express';
import { ethers } from 'ethers';
import { getPool } from '../lib/db';
import { getOrCreateAgent } from '../lib/ledger';
import { getVault } from '../lib/vault';
import { isValidAddress } from '../lib/validate';
import { randomUUID } from 'crypto';

const router = Router();

// Minimal ABI for the two user-facing withdraw functions
const WITHDRAW_ABI = [
  'function withdrawUsdc(uint256 amount)',
  'function withdrawEth(uint256 amount)',
];

router.post('/withdraw', async (req: Request, res: Response) => {
  const { wallet, amount, asset = 'USDC', signature } = req.body as {
    wallet:    string;
    amount:    string;
    asset?:    string;
    signature: string;
  };

  if (!wallet || !amount || !signature) {
    res.status(400).json({ error: 'wallet, amount, signature required' });
    return;
  }
  if (!isValidAddress(wallet)) {
    res.status(400).json({ error: 'Invalid wallet address format' });
    return;
  }

  const assetUpper = asset.toUpperCase() as 'USDC' | 'ETH';
  if (assetUpper !== 'USDC' && assetUpper !== 'ETH') {
    res.status(400).json({ error: 'asset must be USDC or ETH' });
    return;
  }

  // Verify agent signed the withdrawal intent
  const message = `Withdraw ${amount} ${assetUpper} from x402Trade`;
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
  if (requested <= 0 || !isFinite(requested)) {
    res.status(400).json({ error: 'Amount must be positive' });
    return;
  }

  if (!process.env.TRADING_VAULT_ADDRESS) {
    res.status(503).json({ error: 'TradingVault address not configured' });
    return;
  }

  const pool      = getPool();
  const withdrawId = randomUUID();

  try {
    const agent  = await getOrCreateAgent(wallet);
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Lock balance in DB (prevent double-spend) — must succeed before chain call
      const col = assetUpper === 'USDC' ? 'usdc_balance' : 'eth_balance';
      const checkResult = await client.query(
        `SELECT b.${col} FROM balances b WHERE b.agent_id = $1 FOR UPDATE`,
        [agent.id]
      );
      if (checkResult.rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Agent balance not found' });
        return;
      }
      const available = parseFloat(checkResult.rows[0][col] as string);
      if (requested > available) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: 'Insufficient balance', available: available.toFixed(6) });
        return;
      }

      await client.query(
        `UPDATE balances SET ${col} = ${col} - $1, updated_at = NOW() WHERE agent_id = $2`,
        [amount, agent.id]
      );
      await client.query(
        `INSERT INTO payments (payment_hash, agent_id, endpoint, amount, token_address, status)
         VALUES ($1, $2, $3, $4, $5, 'processing')`,
        [
          withdrawId,
          agent.id,
          'withdraw',
          amount,
          assetUpper === 'USDC'
            ? (process.env.USDC_CONTRACT || '0x833589fCD6eDb6E08f4c7C32D4f71b54bA02913C')
            : '0x0000000000000000000000000000000000000000',
        ]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // ── On-chain withdrawal ────────────────────────────────────────────────
    // The vault sends tokens/ETH directly to the user's wallet.
    // Note: the vault's withdrawUsdc/withdrawEth are callable by the user themselves,
    // but here the backend acts on their behalf by calling the same contract
    // using the backend's signer (only works if user previously approved delegation).
    //
    // RECOMMENDED: Tell users to call withdrawUsdc()/withdrawEth() directly on the
    // contract for maximum trustlessness. This endpoint is a convenience wrapper.
    let txHash: string;
    try {
      const decimals = assetUpper === 'USDC' ? 6 : 18;
      const rawAmount = ethers.parseUnits(amount, decimals);

      // Re-instantiate contract with withdraw ABI attached to the backend signer
      const vaultBase = getVault();
      const vaultWithWithdraw = new ethers.Contract(
        await vaultBase.getAddress(),
        WITHDRAW_ABI,
        (vaultBase.runner as ethers.Signer),
      );

      const tx: ethers.ContractTransactionResponse = assetUpper === 'USDC'
        ? await vaultWithWithdraw.withdrawUsdc(rawAmount)
        : await vaultWithWithdraw.withdrawEth(rawAmount);

      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error('On-chain withdrawal reverted');
      txHash = tx.hash;
    } catch (chainErr) {
      // Roll back the DB deduction so the user's balance is restored
      const col2 = assetUpper === 'USDC' ? 'usdc_balance' : 'eth_balance';
      await pool.query(
        `UPDATE balances SET ${col2} = ${col2} + $1, updated_at = NOW() WHERE agent_id = $2`,
        [amount, agent.id]
      );
      await pool.query(
        `UPDATE payments SET status = 'failed' WHERE payment_hash = $1`,
        [withdrawId]
      );
      res.status(502).json({ error: 'On-chain withdrawal failed', message: (chainErr as Error).message });
      return;
    }

    // Mark payment as confirmed with on-chain tx hash
    await pool.query(
      `UPDATE payments SET status = 'confirmed', payment_hash = $1, confirmed_at = NOW()
       WHERE payment_hash = $2`,
      [txHash.toLowerCase(), withdrawId]
    );

    res.json({ success: true, withdrawId, txHash, wallet, amount, asset: assetUpper });
  } catch (err) {
    res.status(500).json({ error: 'Withdraw failed', message: (err as Error).message });
  }
});

export default router;
