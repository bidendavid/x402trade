import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ethers } from 'ethers';
import { buildPaymentHeader, callApi, getPrice } from '../client.js';

// Hardhat account #0 — known private key, safe for tests
const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_WALLET = new ethers.Wallet(TEST_PRIVATE_KEY);

// ── getPrice ──────────────────────────────────────────────────────────────────

describe('getPrice', () => {
  it('returns $0.01 for /trade', () => {
    expect(getPrice('/trade')).toBe('0.01');
  });
  it('returns $0.001 for /ticker', () => {
    expect(getPrice('/ticker?pair=ETH-USDC')).toBe('0.001');
  });
  it('returns $0.001 for /orderbook', () => {
    expect(getPrice('/orderbook?pair=ETH-USDC&depth=10')).toBe('0.001');
  });
  it('returns $0.001 for /orders', () => {
    expect(getPrice('/orders?limit=20')).toBe('0.001');
  });
  it('returns $0.001 for /trades', () => {
    expect(getPrice('/trades?pair=ETH-USDC')).toBe('0.001');
  });
  it('returns $0 for /balance', () => {
    expect(getPrice('/balance')).toBe('0');
  });
  it('returns $0 for /orders/:id (DELETE cancel)', () => {
    expect(getPrice('/orders/abc-123-uuid')).toBe('0');
  });
});

// ── buildPaymentHeader ────────────────────────────────────────────────────────

describe('buildPaymentHeader', () => {
  it('returns a base64 string', async () => {
    const header = await buildPaymentHeader(TEST_WALLET, '0.01');
    expect(typeof header).toBe('string');
    // Should be valid base64
    expect(() => Buffer.from(header, 'base64')).not.toThrow();
  });

  it('decoded JSON contains required fields', async () => {
    const header = await buildPaymentHeader(TEST_WALLET, '0.01');
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    expect(decoded).toMatchObject({
      wallet: TEST_WALLET.address,
      amount: '0.01',
    });
    expect(typeof decoded.nonce).toBe('string');
    expect(typeof decoded.signature).toBe('string');
  });

  it('signature can be recovered to the wallet address', async () => {
    const amount = '0.01';
    const header = await buildPaymentHeader(TEST_WALLET, amount);
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    const recovered = ethers.verifyMessage(
      `x402:${decoded.nonce}:${decoded.amount}`,
      decoded.signature,
    );
    expect(recovered.toLowerCase()).toBe(TEST_WALLET.address.toLowerCase());
  });

  it('nonce is a recent timestamp (within 5 seconds)', async () => {
    const before = Date.now();
    const header = await buildPaymentHeader(TEST_WALLET, '0');
    const after = Date.now();
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    const nonce = parseInt(decoded.nonce, 10);
    expect(nonce).toBeGreaterThanOrEqual(before);
    expect(nonce).toBeLessThanOrEqual(after + 100);
  });

  it('each call produces a unique nonce (replay resistance)', async () => {
    const h1 = await buildPaymentHeader(TEST_WALLET, '0.01');
    await new Promise(r => setTimeout(r, 5)); // ensure time difference
    const h2 = await buildPaymentHeader(TEST_WALLET, '0.01');
    const d1 = JSON.parse(Buffer.from(h1, 'base64').toString('utf8'));
    const d2 = JSON.parse(Buffer.from(h2, 'base64').toString('utf8'));
    expect(d1.nonce).not.toBe(d2.nonce);
    expect(d1.signature).not.toBe(d2.signature);
  });
});

// ── callApi ───────────────────────────────────────────────────────────────────

describe('callApi', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFetch(status: number, body: unknown) {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      json: async () => body,
    });
  }

  it('GET request includes x402-payment header when wallet provided', async () => {
    mockFetch(200, { price: '2200', change24h: '1.5' });

    await callApi('https://api.getx402.trade', TEST_WALLET, 'GET', '/ticker?pair=ETH-USDC');

    expect(fetch).toHaveBeenCalledOnce();
    const [_url, options] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = options.headers as Record<string, string>;
    expect(headers['x402-payment']).toBeDefined();

    // Verify the payment header is valid
    const decoded = JSON.parse(Buffer.from(headers['x402-payment'], 'base64').toString('utf8'));
    expect(decoded.wallet).toBe(TEST_WALLET.address);
    expect(decoded.amount).toBe('0.001'); // ticker price
  });

  it('POST /trade includes $0.01 in payment header', async () => {
    mockFetch(200, { orderId: 'abc', status: 'pending', filledAmount: '0', avgPrice: '0', trades: [] });

    await callApi('https://api.getx402.trade', TEST_WALLET, 'POST', '/trade', {
      pair: 'ETH-USDC', side: 'buy', type: 'limit', amount: '0.1', price: '2200',
    });

    const [, options] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = options.headers as Record<string, string>;
    const decoded = JSON.parse(Buffer.from(headers['x402-payment'], 'base64').toString('utf8'));
    expect(decoded.amount).toBe('0.01');
  });

  it('GET request with no wallet sends no payment header', async () => {
    mockFetch(200, { price: '2200' });

    await callApi('https://api.getx402.trade', null, 'GET', '/ticker?pair=ETH-USDC');

    const [, options] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = options.headers as Record<string, string>;
    expect(headers['x402-payment']).toBeUndefined();
  });

  it('calls the correct URL', async () => {
    mockFetch(200, { bids: [], asks: [] });

    await callApi('https://api.getx402.trade', TEST_WALLET, 'GET', '/orderbook?pair=ETH-USDC&depth=10');

    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.getx402.trade/orderbook?pair=ETH-USDC&depth=10');
  });

  it('throws on non-2xx response with error message', async () => {
    mockFetch(402, { error: 'Insufficient Balance' });

    await expect(
      callApi('https://api.getx402.trade', TEST_WALLET, 'POST', '/trade', {})
    ).rejects.toThrow('Insufficient Balance');
  });

  it('includes JSON body for POST requests', async () => {
    mockFetch(200, { orderId: 'xyz', status: 'pending', filledAmount: '0', avgPrice: '0', trades: [] });

    const body = { pair: 'ETH-USDC', side: 'buy', type: 'market', amount: '0.5' };
    await callApi('https://api.getx402.trade', TEST_WALLET, 'POST', '/trade', body);

    const [, options] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(options.body as string)).toEqual(body);
  });

  it('DELETE request has no body', async () => {
    mockFetch(200, { success: true, orderId: 'abc', remainingAmount: '0.1' });

    await callApi('https://api.getx402.trade', TEST_WALLET, 'DELETE', '/orders/abc-123');

    const [, options] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.body).toBeUndefined();
  });
});
