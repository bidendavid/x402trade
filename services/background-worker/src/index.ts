/**
 * background-worker
 *
 * Merges three lightweight services into a single process to reduce hosting cost:
 *   - oracle      → price polling (CoinGecko) + Redis pub/sub
 *   - risk-control → score/blacklist HTTP API + NATS subscriber
 *   - indexer     → Base L2 event polling
 *
 * All three run inside one Node.js process on one port (default 8083).
 * The gateway points RISK_CONTROL_URL here; oracle prices are also served here.
 *
 * Memory footprint at idle: ~80–120 MB
 */

import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response, NextFunction } from 'express';
import axios from 'axios';
import { ethers } from 'ethers';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { connect, NatsConnection, StringCodec } from 'nats';

// ── Shared infrastructure ──────────────────────────────────────────────────────

const DB_URL     = process.env.DB_URL     || 'postgresql://agent:agentpass@localhost:5432/agent_exchange';
const NATS_URL   = process.env.NATS_URL   || 'nats://localhost:4222';
const PORT       = parseInt(process.env.BACKGROUND_PORT || '8083');

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
});
const pool  = new Pool({ connectionString: DB_URL });
const sc    = StringCodec();

redis.on('error', (e) => console.error('[redis] error:', e.message));

// ── ─────────────────────────────────────────────────────────────────────────────
// ORACLE — price feeds
// ── ─────────────────────────────────────────────────────────────────────────────

const COINGECKO_IDS: Record<string, string> = {
  WETH: 'ethereum', WBTC: 'wrapped-bitcoin',
  USDT: 'tether',   LINK: 'chainlink', OP: 'optimism',
};
const PAIRS = ['USDC/WETH', 'USDC/WBTC', 'USDC/USDT', 'USDC/LINK', 'USDC/OP'];
const priceHistory: Record<string, number[]> = {};

async function fetchAndStorePrices(): Promise<void> {
  const ids = Object.values(COINGECKO_IDS).join(',');
  const response = await axios.get('https://api.coingecko.com/api/v3/coins/markets', {
    params: { vs_currency: 'usd', ids, price_change_percentage: '24h', per_page: 20, page: 1 },
    timeout: 10_000,
  });

  const coins: Array<{
    id: string; current_price: number; price_change_percentage_24h: number;
    total_volume: number; high_24h: number; low_24h: number;
  }> = response.data;

  const idToToken: Record<string, string> = {};
  for (const [tok, id] of Object.entries(COINGECKO_IDS)) idToToken[id] = tok;

  const pipe = redis.pipeline();
  for (const coin of coins) {
    const token = idToToken[coin.id];
    if (!token) continue;
    const pk = `USDC-${token}`;
    const price = coin.current_price;

    if (!priceHistory[pk]) priceHistory[pk] = [];
    const hist = priceHistory[pk];
    if (hist.length >= 2) {
      const avg = hist.slice(-5).reduce((a, b) => a + b, 0) / Math.min(hist.length, 5);
      if (Math.abs(price - avg) / avg > 0.20) {
        console.warn(`[oracle] manipulation alert ${pk}: avg=${avg.toFixed(2)} new=${price}`);
        continue;
      }
    }
    hist.push(price);
    if (hist.length > 20) hist.shift();

    const priceStr = price.toFixed(18);
    pipe.set(`price:${pk}`, priceStr);
    pipe.set(`change24h:${pk}`, (coin.price_change_percentage_24h ?? 0).toFixed(4));
    pipe.set(`volume24h:${pk}`, (coin.total_volume ?? 0).toFixed(2));
    pipe.set(`high24h:${pk}`, (coin.high_24h ?? price).toFixed(18));
    pipe.set(`low24h:${pk}`, (coin.low_24h ?? price).toFixed(18));
    pipe.publish(`price_update:${pk}`, JSON.stringify({ price: priceStr, change24h: (coin.price_change_percentage_24h ?? 0).toFixed(4) }));
  }
  await pipe.exec();
  console.log(`[oracle] prices updated ${new Date().toISOString()}`);
}

async function getPrices() {
  const result = [];
  for (const pair of PAIRS) {
    const pk = pair.replace('/', '-');
    const [price, change24h, volume24h, high24h, low24h] = await Promise.all([
      redis.get(`price:${pk}`), redis.get(`change24h:${pk}`),
      redis.get(`volume24h:${pk}`), redis.get(`high24h:${pk}`), redis.get(`low24h:${pk}`),
    ]);
    result.push({ pair, price: price || '0', change24h: change24h || '0',
      volume24h: volume24h || '0', high24h: high24h || '0', low24h: low24h || '0', updatedAt: Date.now() });
  }
  return result;
}

// ── ─────────────────────────────────────────────────────────────────────────────
// RISK CONTROL — scoring & rate limiting
// ── ─────────────────────────────────────────────────────────────────────────────

const SCORE_MIN = 0, SCORE_MAX = 100, CACHE_TTL = 60;
const SCORE_RULES = { successfulTrade: 1, cancelledOrder: -2 };

async function getScore(wallet: string): Promise<number> {
  const cached = await redis.get(`score:${wallet.toLowerCase()}`);
  if (cached !== null) {
    const parsed = parseInt(cached, 10);
    if (!isNaN(parsed)) return parsed;
  }
  const r = await pool.query<{ score: number }>('SELECT score FROM agents WHERE wallet_address = $1', [wallet.toLowerCase()]);
  const score = r.rows[0]?.score ?? 100;
  await redis.set(`score:${wallet.toLowerCase()}`, String(score), 'EX', CACHE_TTL);
  return score;
}

async function updateScore(wallet: string, delta: number): Promise<number> {
  const addr = wallet.toLowerCase();
  const r = await pool.query<{ score: number }>(
    `INSERT INTO agents (wallet_address, score, is_active, is_blacklisted)
     VALUES ($1, GREATEST($2, $3), true, false)
     ON CONFLICT (wallet_address) DO UPDATE
       SET score = GREATEST($3, LEAST($4, agents.score + $2)), updated_at = NOW()
     RETURNING score`,
    [addr, delta, SCORE_MIN, SCORE_MAX]
  );
  const newScore = r.rows[0].score;
  await redis.set(`score:${addr}`, String(newScore), 'EX', CACHE_TTL);
  return newScore;
}

async function isBlacklisted(wallet: string): Promise<boolean> {
  return (await redis.exists(`blacklist:${wallet.toLowerCase()}`)) === 1;
}

async function checkRateLimit(wallet: string, score: number): Promise<boolean> {
  const addr = wallet.toLowerCase();
  const minute = Math.floor(Date.now() / 60_000);
  const key = `rate:${addr}:${minute}`;
  const maxCalls = score >= 80 ? 120 : score >= 50 ? 60 : score >= 30 ? 20 : 5;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 90);
  return count <= maxCalls;
}

// ── ─────────────────────────────────────────────────────────────────────────────
// INDEXER — Base L2 event polling
// ── ─────────────────────────────────────────────────────────────────────────────

const BASE_RPC_URL     = process.env.BASE_RPC_URL     || 'https://mainnet.base.org';
const EXCHANGE_ADDRESS = process.env.AGENT_EXCHANGE_CORE_ADDRESS || '';
const WALLET_ADDRESS   = process.env.AGENT_WALLET_ADDRESS        || '';
const POLL_BLOCKS      = parseInt(process.env.INDEXER_POLL_BLOCKS || '100');
const INDEXER_INTERVAL = parseInt(process.env.INDEXER_INTERVAL_MS || '15000');

const EXCHANGE_ABI = [
  'event TradeExecuted(uint256 indexed tradeId, address indexed agent, bytes32 indexed pairId, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)',
];
const WALLET_ABI = [
  'event AgentRegistered(address indexed agent, uint256 stake)',
  'event AgentBlacklisted(address indexed agent, uint256 slashedStake)',
];

let lastProcessedBlock = 0;

async function indexerPoll(
  provider: ethers.JsonRpcProvider,
  exchangeContract: ethers.Contract | null,
  walletContract: ethers.Contract | null
): Promise<void> {
  const currentBlock = await provider.getBlockNumber();
  if (currentBlock <= lastProcessedBlock) return;

  const fromBlock = lastProcessedBlock + 1;
  const toBlock   = Math.min(fromBlock + POLL_BLOCKS - 1, currentBlock);

  if (exchangeContract) {
    const events = await exchangeContract.queryFilter(exchangeContract.filters.TradeExecuted(), fromBlock, toBlock);
    for (const e of events) {
      if (!('args' in e)) continue;
      const { tradeId, agent, pairId, amountIn, amountOut } = e.args as unknown as { tradeId: bigint; agent: string; pairId: string; amountIn: bigint; amountOut: bigint };
      const tradeIdStr = `onchain-${tradeId}`;
      try {
        await pool.query(`INSERT INTO agents (wallet_address) VALUES ($1) ON CONFLICT DO NOTHING`, [agent.toLowerCase()]);
        const ar = await pool.query<{ id: number }>('SELECT id FROM agents WHERE wallet_address = $1', [agent.toLowerCase()]);
        const agentId = ar.rows[0]?.id;
        if (!agentId) continue;
        const orderId = `onchain-order-${tradeId}`;
        await pool.query(
          `INSERT INTO orders (order_id, agent_id, pair, side, order_type, amount, price, filled_amount, status)
           VALUES ($1,$2,$3,'buy','market',$4,0,$4,'filled') ON CONFLICT DO NOTHING`,
          [orderId, agentId, pairId, ethers.formatUnits(amountIn, 18)]
        );
        await pool.query(
          `INSERT INTO trades (trade_id, agent_id, order_id, pair, side, amount, price, fee_usdc, gas_used, tx_hash)
           VALUES ($1,$2,$3,$4,'buy',$5,$6,0,0,$7) ON CONFLICT DO NOTHING`,
          [tradeIdStr, agentId, orderId, pairId, ethers.formatUnits(amountIn, 18), ethers.formatUnits(amountOut, 18), e.transactionHash]
        );
        console.log(`[indexer] trade ${tradeId} indexed`);
      } catch (err) { console.error('[indexer] trade error:', err); }
    }
  }

  if (walletContract) {
    const [regEvents, blkEvents] = await Promise.all([
      walletContract.queryFilter(walletContract.filters.AgentRegistered(), fromBlock, toBlock),
      walletContract.queryFilter(walletContract.filters.AgentBlacklisted(), fromBlock, toBlock),
    ]);
    for (const e of regEvents) {
      if (!('args' in e)) continue;
      const { agent, stake } = e.args as unknown as { agent: string; stake: bigint };
      await pool.query(
        `INSERT INTO agents (wallet_address, stake_usdc, is_active) VALUES ($1,$2,true)
         ON CONFLICT (wallet_address) DO UPDATE SET stake_usdc=$2, is_active=true, updated_at=NOW()`,
        [agent.toLowerCase(), ethers.formatUnits(stake, 6)]
      );
    }
    for (const e of blkEvents) {
      if (!('args' in e)) continue;
      const { agent } = e.args as unknown as { agent: string };
      await pool.query(`UPDATE agents SET is_blacklisted=true, is_active=false, updated_at=NOW() WHERE wallet_address=$1`, [agent.toLowerCase()]);
    }
  }

  lastProcessedBlock = toBlock;
}

// ── HTTP server ────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'background-worker' });
});

// Oracle endpoints
app.get('/prices', async (_req: Request, res: Response) => {
  try { res.json({ prices: await getPrices(), timestamp: Date.now() }); }
  catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// Risk endpoints (consumed by x402-gateway)
app.get('/score/:wallet', async (req: Request, res: Response) => {
  const { wallet } = req.params;
  try {
    const [score, blacklisted] = await Promise.all([getScore(wallet), isBlacklisted(wallet)]);
    res.json({ wallet, score, blacklisted });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.post('/check', async (req: Request, res: Response) => {
  const { wallet } = req.body as { wallet: string };
  if (!wallet) { res.status(400).json({ error: 'wallet required' }); return; }
  try {
    const [blacklisted, score] = await Promise.all([isBlacklisted(wallet), getScore(wallet)]);
    if (blacklisted)  { res.json({ allowed: false, reason: 'blacklisted', score }); return; }
    if (score < 30)   { res.json({ allowed: false, reason: 'score_too_low', score }); return; }
    const ok = await checkRateLimit(wallet, score);
    res.json(ok ? { allowed: true, score } : { allowed: false, reason: 'rate_limited', score });
  } catch (err) { console.error('[risk] /check error:', err); res.status(500).json({ allowed: false, reason: 'risk_service_error' }); }
});

// ── Admin auth middleware ──────────────────────────────────────────────────
// ADMIN_SECRET must be set to enable these endpoints.
// Called internally only (not internet-facing), but defense-in-depth.
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    res.status(503).json({ error: 'Admin endpoints disabled — set ADMIN_SECRET to enable' });
    return;
  }
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

app.post('/blacklist/:wallet', requireAdmin, async (req: Request, res: Response) => {
  const { wallet } = req.params;
  const { reason = 'manual' } = req.body as { reason?: string };
  try {
    await pool.query(`UPDATE agents SET is_blacklisted=true, is_active=false, updated_at=NOW() WHERE wallet_address=$1`, [wallet.toLowerCase()]);
    await redis.set(`blacklist:${wallet.toLowerCase()}`, reason, 'EX', 30 * 24 * 3600);
    res.json({ success: true, wallet, reason });
  } catch (err) { console.error('[admin] blacklist error:', (err as Error).message); res.status(500).json({ error: 'Operation failed' }); }
});

app.delete('/blacklist/:wallet', requireAdmin, async (req: Request, res: Response) => {
  const { wallet } = req.params;
  try {
    await pool.query(`UPDATE agents SET is_blacklisted=false, is_active=true, score=50, updated_at=NOW() WHERE wallet_address=$1`, [wallet.toLowerCase()]);
    await redis.del(`blacklist:${wallet.toLowerCase()}`);
    res.json({ success: true, wallet });
  } catch (err) { console.error('[admin] unblacklist error:', (err as Error).message); res.status(500).json({ error: 'Operation failed' }); }
});

app.patch('/score/:wallet', requireAdmin, async (req: Request, res: Response) => {
  const { wallet } = req.params;
  const { delta } = req.body as { delta: number };
  if (typeof delta !== 'number') { res.status(400).json({ error: 'delta required' }); return; }
  try { res.json({ wallet, score: await updateScore(wallet, delta) }); }
  catch (err) { console.error('[admin] score error:', (err as Error).message); res.status(500).json({ error: 'Operation failed' }); }
});

app.listen(PORT, () => console.log(`background-worker listening on port ${PORT}`));

// ── NATS subscriber (risk scoring updates) ────────────────────────────────────

async function startNats(): Promise<void> {
  let nc: NatsConnection;
  try {
    nc = await connect({ servers: NATS_URL });
    console.log('[nats] background-worker connected');

    const tradeSub  = nc.subscribe('trades.filled');
    const cancelSub = nc.subscribe('orders.cancelled');

    (async () => {
      for await (const msg of tradeSub) {
        try {
          const t = JSON.parse(sc.decode(msg.data)) as { buyerWallet: string; sellerWallet: string };
          await Promise.all([
            updateScore(t.buyerWallet,  SCORE_RULES.successfulTrade),
            updateScore(t.sellerWallet, SCORE_RULES.successfulTrade),
          ]);
        } catch (err) { console.error('[risk] trades.filled:', err); }
      }
    })();

    (async () => {
      for await (const msg of cancelSub) {
        try {
          const { agentWallet } = JSON.parse(sc.decode(msg.data)) as { agentWallet: string };
          await updateScore(agentWallet, SCORE_RULES.cancelledOrder);
        } catch (err) { console.error('[risk] orders.cancelled:', err); }
      }
    })();
  } catch (err) {
    console.error('[nats] background-worker unavailable:', err);
  }
}

// ── Oracle polling ─────────────────────────────────────────────────────────────

async function startOracle(): Promise<void> {
  const interval = parseInt(process.env.ORACLE_POLL_INTERVAL_MS || '30000');
  try { await fetchAndStorePrices(); } catch (err) { console.error('[oracle] initial fetch failed:', err); }
  setInterval(async () => {
    try { await fetchAndStorePrices(); } catch (err) { console.error('[oracle] fetch error:', err); }
  }, interval);
  console.log(`[oracle] polling every ${interval / 1000}s`);
}

// ── Indexer polling ────────────────────────────────────────────────────────────

async function startIndexer(): Promise<void> {
  if (!EXCHANGE_ADDRESS && !WALLET_ADDRESS) {
    console.log('[indexer] standby (no contract addresses configured)');
    return;
  }
  const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
  try {
    const r = await pool.query<{ value: string }>(`SELECT details->>'value' AS value FROM activity_log WHERE action_type='indexer_checkpoint' ORDER BY created_at DESC LIMIT 1`);
    lastProcessedBlock = r.rows.length > 0 ? parseInt(r.rows[0].value || '0') : await provider.getBlockNumber();
  } catch { lastProcessedBlock = 0; }

  const exchangeContract = EXCHANGE_ADDRESS ? new ethers.Contract(EXCHANGE_ADDRESS, EXCHANGE_ABI, provider) : null;
  const walletContract   = WALLET_ADDRESS   ? new ethers.Contract(WALLET_ADDRESS,   WALLET_ABI,   provider) : null;

  setInterval(() => indexerPoll(provider, exchangeContract, walletContract).catch(console.error), INDEXER_INTERVAL);
  console.log(`[indexer] polling every ${INDEXER_INTERVAL / 1000}s from block ${lastProcessedBlock}`);
}

// ── Boot ───────────────────────────────────────────────────────────────────────

Promise.all([startNats(), startOracle(), startIndexer()])
  .then(() => console.log('[background-worker] all modules started'))
  .catch(console.error);
