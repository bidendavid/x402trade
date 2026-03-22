/**
 * API integration tests for x402-gateway.
 *
 * Mocking strategy:
 *  - x402/middleware  → bypassed; always attaches req.agentWallet = '0xtest' and calls next()
 *  - lib/redis        → in-memory mock from __mocks__/redis.ts
 *  - lib/db           → in-memory mock from __mocks__/db.ts
 *  - nats             → fake connection whose request() returns a configurable OrderResult
 *  - ioredis          → stub so startRedisSub() doesn't attempt a real Redis connection
 *
 * supertest drives the express app; the http server is imported but never
 * actually binds to a port because supertest intercepts at the socket layer.
 */

// ── Mocks must be declared before any import that triggers module evaluation ──

jest.mock('../x402/middleware', () => ({
  x402Middleware: (req: any, _res: any, next: any) => {
    req.agentWallet = '0xtest';
    next();
  },
}));

jest.mock('../lib/redis', () => jest.requireActual('./__mocks__/redis'));
jest.mock('../lib/db',    () => jest.requireActual('./__mocks__/db'));

// Stub ioredis so startRedisSub() (which runs at module load) never dials Redis.
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    on:          jest.fn(),
    psubscribe:  jest.fn(),
    subscribe:   jest.fn(),
    get:         jest.fn(async () => null),
    set:         jest.fn(async () => 'OK'),
    exists:      jest.fn(async () => 0),
    hgetall:     jest.fn(async () => null),
    hset:        jest.fn(async () => 1),
    expire:      jest.fn(async () => 1),
    zrevrange:   jest.fn(async () => []),
    zrange:      jest.fn(async () => []),
    lrange:      jest.fn(async () => []),
    zrem:        jest.fn(async () => 1),
    del:         jest.fn(async () => 1),
    srem:        jest.fn(async () => 1),
  }));
});

// Fake NATS connection — request() returns a successful OrderResult by default.
const mockNatsRequest = jest.fn();
const mockNatsPublish  = jest.fn();

jest.mock('nats', () => ({
  connect: jest.fn(async () => ({
    isClosed:  jest.fn(() => false),
    request:   mockNatsRequest,
    publish:   mockNatsPublish,
  })),
  StringCodec: jest.fn(() => ({
    encode: (s: string) => Buffer.from(s),
    decode: (b: Buffer | Uint8Array) => Buffer.from(b).toString(),
  })),
}));

// ── Now import the app after all mocks are in place ───────────────────────────

import supertest      from 'supertest';
import http           from 'http';
import express        from 'express';

// We cannot import from index.ts directly without side-effects (server.listen +
// startRedisSub).  Instead we reconstruct the app the same way index.ts does,
// using the already-mocked middleware and route modules.
import { x402Middleware } from '../x402/middleware';
import tradeRouter        from '../routes/trade';
import orderbookRouter    from '../routes/orderbook';
import ordersRouter       from '../routes/orders';
import tickerRouter       from '../routes/ticker';
import balanceRouter      from '../routes/balance';
import cancelRouter       from '../routes/cancel';

import { getRedis }       from '../lib/redis';
import { poolMock }       from './__mocks__/db';

// Build the express app exactly as index.ts does, minus server.listen / WS / Redis sub.
const app = express();
app.use(express.json());
app.use(x402Middleware);
app.use(tradeRouter);
app.use(orderbookRouter);
app.use(ordersRouter);
app.use(tickerRouter);
app.use(balanceRouter);
app.use(cancelRouter);
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'x402-gateway' }));

const agent = supertest(app);

// ── Helpers ───────────────────────────────────────────────────────────────────

const WALLET = '0xtest';

/** Encode a fake OrderResult the way the trade route decodes it. */
function encodeNatsReply(payload: object): { data: Buffer } {
  return { data: Buffer.from(JSON.stringify(payload)) };
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  (getRedis() as any)._reset();
  poolMock.query.mockReset();
  poolMock.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

// 1. Health check ──────────────────────────────────────────────────────────────
describe('GET /health', () => {
  it('returns 200 { status: ok }', async () => {
    const res = await agent.get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('x402-gateway');
  });
});

// 2. POST /trade — validation ──────────────────────────────────────────────────
describe('POST /trade', () => {
  it('returns 400 when required fields are missing', async () => {
    const res = await agent
      .post('/trade')
      .set('x402-payment', 'dummy')
      .send({ side: 'buy', type: 'limit', amount: '1.0' }); // missing pair
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/missing/i);
  });

  it('returns 400 when limit order has no price', async () => {
    const res = await agent
      .post('/trade')
      .set('x402-payment', 'dummy')
      .send({ pair: 'ETH-USDC', side: 'buy', type: 'limit', amount: '1.0' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/price/i);
  });

  it('returns 200 with orderId for a valid limit order', async () => {
    const orderResult = { orderId: 'order-uuid-123', status: 'pending', pair: 'ETH-USDC' };
    mockNatsRequest.mockResolvedValueOnce(encodeNatsReply(orderResult));

    const res = await agent
      .post('/trade')
      .set('x402-payment', 'dummy')
      .send({ pair: 'ETH-USDC', side: 'buy', type: 'limit', amount: '1.0', price: '3000.00' });

    expect(res.status).toBe(200);
    expect(res.body.orderId).toBe('order-uuid-123');
    expect(res.body.status).toBe('pending');
  });

  it('returns 200 with orderId for a valid market order (no price required)', async () => {
    const orderResult = { orderId: 'order-uuid-456', status: 'filled', pair: 'ETH-USDC' };
    mockNatsRequest.mockResolvedValueOnce(encodeNatsReply(orderResult));

    const res = await agent
      .post('/trade')
      .set('x402-payment', 'dummy')
      .send({ pair: 'ETH-USDC', side: 'sell', type: 'market', amount: '0.5' });

    expect(res.status).toBe(200);
    expect(res.body.orderId).toBe('order-uuid-456');
  });

  it('returns 503 when NATS is unavailable', async () => {
    mockNatsRequest.mockRejectedValueOnce(new Error('Connection refused'));

    const res = await agent
      .post('/trade')
      .set('x402-payment', 'dummy')
      .send({ pair: 'ETH-USDC', side: 'buy', type: 'limit', amount: '1.0', price: '3000.00' });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/unavailable/i);
  });
});

// 3. GET /orderbook ────────────────────────────────────────────────────────────
describe('GET /orderbook', () => {
  it('returns 400 when pair query param is missing', async () => {
    const res = await agent
      .get('/orderbook')
      .set('x402-payment', 'dummy');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pair/i);
  });

  it('returns 200 with bids and asks arrays for a valid pair', async () => {
    const redis = getRedis() as any;
    // Stub sorted-set commands to return empty arrays (no open orders)
    redis.zrevrange = jest.fn(async () => []);
    redis.zrange    = jest.fn(async () => []);

    const res = await agent
      .get('/orderbook?pair=ETH-USDC&depth=20')
      .set('x402-payment', 'dummy');

    expect(res.status).toBe(200);
    expect(res.body.pair).toBe('ETH-USDC');
    expect(Array.isArray(res.body.bids)).toBe(true);
    expect(Array.isArray(res.body.asks)).toBe(true);
    expect(typeof res.body.timestamp).toBe('number');
  });

  it('returns 200 with populated bids and asks when Redis has data', async () => {
    const redis = getRedis() as any;
    // Single bid entry: "3000.00:1.000000:order-abc"
    redis.zrevrange = jest.fn(async () => ['3000.00:1.000000:order-abc']);
    redis.zrange    = jest.fn(async () => ['3001.00:0.500000:order-xyz']);
    // hgetall for each order — no filledAmount means full amount remains
    redis.hgetall   = jest.fn(async () => ({}));

    const res = await agent
      .get('/orderbook?pair=ETH-USDC')
      .set('x402-payment', 'dummy');

    expect(res.status).toBe(200);
    expect(res.body.bids.length).toBe(1);
    expect(res.body.asks.length).toBe(1);
    expect(res.body.bids[0][0]).toBe('3000.00');
    expect(res.body.asks[0][0]).toBe('3001.00');
  });
});

// 4. GET /balance ──────────────────────────────────────────────────────────────
describe('GET /balance', () => {
  it('returns 404 when agent is not in the database', async () => {
    poolMock.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await agent
      .get('/balance')
      .set('x402-payment', 'dummy');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('returns 200 with balance fields when agent exists', async () => {
    const balanceRow = {
      usdc_balance: '500.000000',
      usdc_locked:  '50.000000',
      eth_balance:  '1.000000',
      eth_locked:   '0.000000',
      updated_at:   new Date('2026-03-14T00:00:00Z'),
    };
    poolMock.query.mockResolvedValueOnce({ rows: [balanceRow], rowCount: 1 });

    const res = await agent
      .get('/balance')
      .set('x402-payment', 'dummy');

    expect(res.status).toBe(200);
    expect(res.body.wallet).toBe(WALLET);
    expect(res.body.usdc_balance).toBe('500.000000');
    expect(res.body.eth_balance).toBe('1.000000');
  });

  it('returns cached balance from Redis on second request', async () => {
    const redis = getRedis() as any;
    // Pre-populate the cache key the route uses
    redis._set(`balance:wallet:${WALLET.toLowerCase()}`, '');
    redis.hgetall = jest.fn(async () => ({
      usdc_balance: '999.000000',
      usdc_locked:  '0',
      eth_balance:  '2.000000',
      eth_locked:   '0',
      updated_at:   '2026-03-14T00:00:00.000Z',
    }));

    const res = await agent
      .get('/balance')
      .set('x402-payment', 'dummy');

    expect(res.status).toBe(200);
    expect(res.body.usdc_balance).toBe('999.000000');
    // DB must not have been queried
    expect(poolMock.query).not.toHaveBeenCalled();
  });
});

// 5. GET /ticker ───────────────────────────────────────────────────────────────
describe('GET /ticker', () => {
  it('returns 400 when pair query param is missing', async () => {
    const res = await agent
      .get('/ticker')
      .set('x402-payment', 'dummy');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pair/i);
  });

  it('returns 200 with ticker fields for a valid pair', async () => {
    const redis = getRedis() as any;
    redis.get = jest.fn(async (key: string) => {
      const values: Record<string, string> = {
        'price:ETH-USDC':     '3000.00',
        'change24h:ETH-USDC': '2.5',
        'volume24h:ETH-USDC': '1500000',
        'high24h:ETH-USDC':   '3100.00',
        'low24h:ETH-USDC':    '2900.00',
      };
      return values[key] ?? null;
    });

    const res = await agent
      .get('/ticker?pair=ETH-USDC')
      .set('x402-payment', 'dummy');

    expect(res.status).toBe(200);
    expect(res.body.pair).toBe('ETH-USDC');
    expect(res.body.price).toBe('3000.00');
    expect(res.body.change24h).toBe('2.5');
    expect(res.body.volume24h).toBe('1500000');
    expect(typeof res.body.timestamp).toBe('number');
  });

  it('returns default zero values when no ticker data exists in Redis', async () => {
    // redis.get already returns null by default (mock store is empty)
    const res = await agent
      .get('/ticker?pair=BTC-USDC')
      .set('x402-payment', 'dummy');

    expect(res.status).toBe(200);
    expect(res.body.price).toBe('0');
    expect(res.body.volume24h).toBe('0');
  });
});

// 6. GET /trades ───────────────────────────────────────────────────────────────
describe('GET /trades', () => {
  it('returns 400 when pair query param is missing', async () => {
    const res = await agent
      .get('/trades')
      .set('x402-payment', 'dummy');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pair/i);
  });

  it('returns 200 with an array of trades', async () => {
    const fakeTrade = { orderId: 'x', pair: 'ETH-USDC', price: '3000', amount: '0.1', side: 'buy' };
    const redis = getRedis() as any;
    redis.lrange = jest.fn(async () => [JSON.stringify(fakeTrade)]);

    const res = await agent
      .get('/trades?pair=ETH-USDC')
      .set('x402-payment', 'dummy');

    expect(res.status).toBe(200);
    expect(res.body.pair).toBe('ETH-USDC');
    expect(Array.isArray(res.body.trades)).toBe(true);
    expect(res.body.trades[0].price).toBe('3000');
  });
});

// 7. GET /orders ───────────────────────────────────────────────────────────────
describe('GET /orders', () => {
  it('returns 200 with orders array from DB', async () => {
    const fakeOrder = {
      order_id: 'order-1',
      pair: 'ETH-USDC',
      side: 'buy',
      order_type: 'limit',
      amount: '1.0',
      price: '3000.00',
      filled_amount: '0',
      status: 'pending',
      fee_usdc: '0.01',
      created_at: new Date(),
      filled_at: null,
    };
    poolMock.query.mockResolvedValueOnce({ rows: [fakeOrder], rowCount: 1 });

    const res = await agent
      .get('/orders?wallet=0xtest&page=1&limit=20')
      .set('x402-payment', 'dummy');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.orders)).toBe(true);
    expect(res.body.orders[0].order_id).toBe('order-1');
  });

  it('returns 200 with empty orders when none exist', async () => {
    poolMock.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await agent
      .get('/orders')
      .set('x402-payment', 'dummy');

    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(0);
  });
});

// 8. DELETE /orders/:orderId ───────────────────────────────────────────────────
describe('DELETE /orders/:orderId', () => {
  it('returns 404 when order does not exist', async () => {
    poolMock.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await agent
      .delete('/orders/nonexistent-id')
      .set('x402-payment', 'dummy');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('returns 403 when order belongs to a different wallet', async () => {
    poolMock.query.mockResolvedValueOnce({
      rows: [{
        order_id: 'order-1', pair: 'ETH-USDC', side: 'buy', order_type: 'limit',
        amount: '1.0', price: '3000.00', filled_amount: '0',
        status: 'pending',
        wallet_address: '0xother_wallet', // != '0xtest'
      }],
      rowCount: 1,
    });

    const res = await agent
      .delete('/orders/order-1')
      .set('x402-payment', 'dummy');

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not your order/i);
  });

  it('returns 400 when order status is already filled', async () => {
    poolMock.query.mockResolvedValueOnce({
      rows: [{
        order_id: 'order-2', pair: 'ETH-USDC', side: 'buy', order_type: 'limit',
        amount: '1.0', price: '3000.00', filled_amount: '1.0',
        status: 'filled',
        wallet_address: WALLET.toLowerCase(),
      }],
      rowCount: 1,
    });

    const res = await agent
      .delete('/orders/order-2')
      .set('x402-payment', 'dummy');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot cancel/i);
  });

  it('returns 200 with cancelled status for a pending order', async () => {
    const pendingOrder = {
      order_id: 'order-3', pair: 'ETH-USDC', side: 'buy', order_type: 'limit',
      amount: '1.0', price: '3000.00', filled_amount: '0',
      status: 'pending',
      wallet_address: WALLET.toLowerCase(),
    };
    // First query: SELECT; second query: UPDATE
    poolMock.query
      .mockResolvedValueOnce({ rows: [pendingOrder], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const redis = getRedis() as any;
    redis.zrem = jest.fn(async () => 1);
    redis.del  = jest.fn(async () => 1);
    redis.srem = jest.fn(async () => 1);

    const res = await agent
      .delete('/orders/order-3')
      .set('x402-payment', 'dummy');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.orderId).toBe('order-3');
    expect(res.body.status).toBe('cancelled');
  });
});
