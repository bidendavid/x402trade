import { Router, Request, Response } from 'express';
import { getBalance, getOrCreateAgent } from '../lib/ledger';

const router = Router();

router.get('/balance', async (req: Request, res: Response) => {
  const wallet = (req.query.wallet as string) || (req.headers['x-agent-wallet'] as string);
  if (!wallet) {
    res.status(400).json({ error: 'wallet query param or X-Agent-Wallet header required' });
    return;
  }

  try {
    const balance = await getBalance(wallet);
    if (!balance) {
      await getOrCreateAgent(wallet);
      res.json({ wallet, usdc_balance: '0', usdc_locked: '0', eth_balance: '0', eth_locked: '0' });
      return;
    }
    res.json({
      wallet,
      usdc_balance: balance.usdc_balance,
      usdc_locked: balance.usdc_locked,
      eth_balance: balance.eth_balance,
      eth_locked: balance.eth_locked,
      updated_at: balance.updated_at,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get balance', message: (err as Error).message });
  }
});

export default router;
