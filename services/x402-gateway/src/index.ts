import dotenv from 'dotenv';
import http from 'http';
import express, { Request, Response, NextFunction } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import Redis from 'ioredis';
import { x402Middleware } from './x402/middleware';
import tradeRouter from './routes/trade';
import orderbookRouter from './routes/orderbook';
import ordersRouter from './routes/orders';
import tickerRouter from './routes/ticker';
import balanceRouter from './routes/balance';
import cancelRouter from './routes/cancel';
import {
  httpRequestDuration,
  httpRequestsTotal,
  wsConnectionsActive,
  wsMessagesTotal,
  registry,
} from './lib/metrics';

dotenv.config();

const app = express();
app.use(express.json());

// ── Prometheus HTTP instrumentation ───────────────────────────────────────────
app.use((req: Request, res: Response, next: NextFunction) => {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    const route = req.route?.path ?? req.path;
    const labels = { method: req.method, route, status_code: String(res.statusCode) };
    end(labels);
    httpRequestsTotal.inc(labels);
  });
  next();
});

// x402 payment verification middleware (per-endpoint config in x402/config.ts)
app.use(x402Middleware);

app.use(tradeRouter);
app.use(orderbookRouter);
app.use(ordersRouter);
app.use(tickerRouter);
app.use(balanceRouter);
app.use(cancelRouter);

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'x402-gateway' });
});

app.get('/metrics', async (_req: Request, res: Response) => {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
});

const PORT = process.env.PORT || 8080;
const server = http.createServer(app);

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });

// Track subscribers by channel (e.g. "orderbook:ETH-USDC", "trades:ETH-USDC", "prices")
const subscribers = new Map<string, Set<WebSocket>>();

function broadcast(channel: string, data: unknown): void {
  const clients = subscribers.get(channel);
  if (!clients) return;
  const msg = JSON.stringify({ channel, data });
  let sent = 0;
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) { ws.send(msg); sent++; }
  }
  if (sent > 0) wsMessagesTotal.inc({ channel: channel.split(':')[0] });
}

wss.on('connection', (ws: WebSocket) => {
  wsConnectionsActive.inc();
  const joined = new Set<string>();

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as { type: string; channel: string };
      if (msg.type === 'subscribe' && msg.channel) {
        if (!subscribers.has(msg.channel)) subscribers.set(msg.channel, new Set());
        subscribers.get(msg.channel)!.add(ws);
        joined.add(msg.channel);
        ws.send(JSON.stringify({ type: 'subscribed', channel: msg.channel }));
      } else if (msg.type === 'unsubscribe' && msg.channel) {
        subscribers.get(msg.channel)?.delete(ws);
        joined.delete(msg.channel);
      }
    } catch { /* ignore malformed */ }
  });

  ws.on('close', () => {
    wsConnectionsActive.dec();
    for (const ch of joined) subscribers.get(ch)?.delete(ws);
  });
});

// Redis pub/sub for real-time events from order-engine and oracle
function startRedisSub(): void {
  const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
  const sub = new Redis(REDIS_URL);
  sub.on('error', (e) => console.error('[ws] Redis sub error:', e));

  // Price updates from oracle-service
  sub.on('pmessage', (_pattern: string, channel: string, message: string) => {
    try {
      const data = JSON.parse(message);
      if (channel.startsWith('price_update:')) {
        const pair = channel.replace('price_update:', '');
        broadcast(`prices:${pair}`, data);
        broadcast('prices', { pair, ...data });
      } else if (channel.startsWith('orderbook:')) {
        const pair = channel.replace('orderbook:', '');
        broadcast(`orderbook:${pair}`, data);
      }
    } catch { /* ignore */ }
  });

  sub.on('message', (_channel: string, message: string) => {
    try {
      const trade = JSON.parse(message);
      broadcast(`trades:${(trade.pair as string)?.replace('/', '-')}`, trade);
      broadcast('trades', trade);
    } catch { /* ignore */ }
  });

  sub.psubscribe('price_update:*', 'orderbook:*');
  sub.subscribe('trades.filled');
  console.log('[ws] Redis subscriber ready');
}

server.listen(PORT, () => {
  console.log(`x402-gateway listening on port ${PORT} (HTTP + WS)`);
});

startRedisSub();
