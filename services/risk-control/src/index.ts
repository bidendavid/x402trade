import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import { connect, NatsConnection, StringCodec } from 'nats';
import {
  getScore, updateScore, isBlacklisted,
  addToBlacklist, removeFromBlacklist, checkRateLimit, SCORE_RULES,
} from './scoring';

dotenv.config();

const app = express();
app.use(express.json());
const PORT = process.env.RISK_PORT || 8084;

// ── HTTP API ──────────────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'risk-control' });
});

// GET /score/:wallet
app.get('/score/:wallet', async (req: Request, res: Response) => {
  const { wallet } = req.params;
  try {
    const [score, blacklisted] = await Promise.all([
      getScore(wallet),
      isBlacklisted(wallet),
    ]);
    res.json({ wallet, score, blacklisted });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /check — used by gateway to check before serving a request
app.post('/check', async (req: Request, res: Response) => {
  const { wallet } = req.body as { wallet: string };
  if (!wallet) {
    res.status(400).json({ error: 'wallet required' });
    return;
  }

  try {
    const [blacklisted, score] = await Promise.all([
      isBlacklisted(wallet),
      getScore(wallet),
    ]);

    if (blacklisted) {
      res.json({ allowed: false, reason: 'blacklisted', score });
      return;
    }
    if (score < 30) {
      res.json({ allowed: false, reason: 'score_too_low', score });
      return;
    }

    const withinLimit = await checkRateLimit(wallet, score);
    if (!withinLimit) {
      res.json({ allowed: false, reason: 'rate_limited', score });
      return;
    }

    res.json({ allowed: true, score });
  } catch (err) {
    // Fail open — don't block legitimate traffic if risk service is down
    res.json({ allowed: true, score: 100 });
  }
});

// POST /blacklist/:wallet  (admin)
app.post('/blacklist/:wallet', async (req: Request, res: Response) => {
  const { wallet } = req.params;
  const { reason = 'manual' } = req.body as { reason?: string };
  try {
    await addToBlacklist(wallet, reason);
    res.json({ success: true, wallet, reason });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /blacklist/:wallet  (admin)
app.delete('/blacklist/:wallet', async (req: Request, res: Response) => {
  const { wallet } = req.params;
  try {
    await removeFromBlacklist(wallet);
    res.json({ success: true, wallet });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PATCH /score/:wallet  (admin manual adjustment)
app.patch('/score/:wallet', async (req: Request, res: Response) => {
  const { wallet } = req.params;
  const { delta } = req.body as { delta: number };
  if (typeof delta !== 'number') {
    res.status(400).json({ error: 'delta (number) required' });
    return;
  }
  try {
    const newScore = await updateScore(wallet, delta);
    res.json({ wallet, score: newScore });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.listen(PORT, () => {
  console.log(`risk-control listening on port ${PORT}`);
});

// ── NATS subscriber ───────────────────────────────────────────────────────────

const sc = StringCodec();

async function startNatsSubscriber(): Promise<void> {
  let nc: NatsConnection;
  try {
    nc = await connect({ servers: process.env.NATS_URL || 'nats://localhost:4222' });
    console.log('risk-control NATS connected');

    // Listen to filled trades → reward both parties
    const tradeSub = nc.subscribe('trades.filled');
    (async () => {
      for await (const msg of tradeSub) {
        try {
          const trade = JSON.parse(sc.decode(msg.data)) as {
            buyerWallet: string;
            sellerWallet: string;
          };
          await Promise.all([
            updateScore(trade.buyerWallet,  SCORE_RULES.successfulTrade),
            updateScore(trade.sellerWallet, SCORE_RULES.successfulTrade),
          ]);
        } catch (err) {
          console.error('[risk] trades.filled error:', err);
        }
      }
    })();

    // Listen to cancelled orders → penalise
    const cancelSub = nc.subscribe('orders.cancelled');
    (async () => {
      for await (const msg of cancelSub) {
        try {
          const { agentWallet } = JSON.parse(sc.decode(msg.data)) as { agentWallet: string };
          await updateScore(agentWallet, SCORE_RULES.cancelledOrder);
        } catch (err) {
          console.error('[risk] orders.cancelled error:', err);
        }
      }
    })();

  } catch (err) {
    console.error('risk-control NATS unavailable:', err);
  }
}

startNatsSubscriber().catch(console.error);
