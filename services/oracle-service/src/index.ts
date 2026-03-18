import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import { fetchAndStorePrices, getPrices } from './prices';

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.ORACLE_PORT || 8083;
const POLL_INTERVAL_MS = parseInt(process.env.ORACLE_POLL_INTERVAL_MS || '30000');

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'oracle-service' });
});

// Current prices snapshot
app.get('/prices', async (_req: Request, res: Response) => {
  try {
    const prices = await getPrices();
    res.json({ prices, timestamp: Date.now() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.listen(PORT, () => {
  console.log(`oracle-service listening on port ${PORT}`);
});

// Initial fetch + polling loop
async function startPolling(): Promise<void> {
  // First fetch immediately
  try {
    await fetchAndStorePrices();
  } catch (err) {
    console.error('[oracle] Initial price fetch failed:', err);
  }

  // Then poll on interval
  setInterval(async () => {
    try {
      await fetchAndStorePrices();
    } catch (err) {
      console.error('[oracle] Price fetch error:', (err as Error).message);
    }
  }, POLL_INTERVAL_MS);

  console.log(`[oracle] Polling prices every ${POLL_INTERVAL_MS / 1000}s`);
}

startPolling().catch(console.error);
