/**
 * Integration test — hits the live x402Trade API.
 *
 * Run: npm run test:integration
 * Optional: PRIVATE_KEY=0x... npm run test:integration  (uses funded wallet for market data)
 *
 * Market data endpoints (ticker, orderbook, trades) cost $0.001 USDC each.
 * Without a funded PRIVATE_KEY, those tests accept 402 Insufficient Balance as valid.
 * Auth flow tests (signature, replay, nonce) always run with a random wallet.
 */

import { ethers } from 'ethers';
import { buildPaymentHeader, callApi } from '../client.js';

const GATEWAY = process.env.X402_GATEWAY_URL || 'https://api.getx402.trade';

// Use provided key or generate a fresh throwaway wallet for tests
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const wallet = PRIVATE_KEY
  ? new ethers.Wallet(PRIVATE_KEY)
  : ethers.Wallet.createRandom();

const walletLabel = PRIVATE_KEY ? `provided (${wallet.address.slice(0, 8)}…)` : `random (${wallet.address.slice(0, 8)}…)`;

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  process.stdout.write(`  ${name} ... `);
  try {
    await fn();
    console.log('✓');
    passed++;
  } catch (err) {
    console.log(`✗  ${(err as Error).message}`);
    failed++;
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

// ── Run tests ─────────────────────────────────────────────────────────────────

console.log(`\nx402Trade Integration Tests`);
console.log(`Gateway : ${GATEWAY}`);
console.log(`Wallet  : ${walletLabel}\n`);

// Group 1: No-auth endpoints
console.log('── Public (no auth) ──────────────────────────────');

await test('GET /health returns ok', async () => {
  const res = await fetch(`${GATEWAY}/health`);
  assert(res.ok, `Expected 200, got ${res.status}`);
  const body = await res.json() as { status: string };
  assert(body.status === 'ok', `Expected status=ok, got ${JSON.stringify(body)}`);
});

// Group 2: Market data (requires $0.001 USDC balance per call)
// With a random wallet (no funds), 402 Insufficient Balance is the correct response.
console.log('\n── Market data (x402 payment required) ──────────');
console.log(PRIVATE_KEY ? '   (funded wallet — expecting data)' : '   (random wallet — expecting 402 Insufficient Balance)\n');

await test('GET /ticker?pair=ETH-USDC returns 200 or 402', async () => {
  const res = await fetch(`${GATEWAY}/ticker?pair=ETH-USDC`, {
    headers: { 'x402-payment': await buildPaymentHeader(wallet, '0.001') },
  });
  assert([200, 402].includes(res.status), `Expected 200 or 402, got ${res.status}`);
  if (res.status === 200) {
    const data = await res.json() as Record<string, unknown>;
    assert(typeof data.price === 'string', `Expected price string`);
    assert(parseFloat(data.price as string) > 0, `Expected price > 0`);
    console.log(`\n       ETH = $${parseFloat(data.price as string).toFixed(2)}`);
  }
});

await test('GET /ticker?pair=BTC-USDC returns 200 or 402', async () => {
  const res = await fetch(`${GATEWAY}/ticker?pair=BTC-USDC`, {
    headers: { 'x402-payment': await buildPaymentHeader(wallet, '0.001') },
  });
  assert([200, 402].includes(res.status), `Expected 200 or 402, got ${res.status}`);
});

await test('GET /orderbook?pair=ETH-USDC returns 200 or 402', async () => {
  const res = await fetch(`${GATEWAY}/orderbook?pair=ETH-USDC&depth=5`, {
    headers: { 'x402-payment': await buildPaymentHeader(wallet, '0.001') },
  });
  assert([200, 402].includes(res.status), `Expected 200 or 402, got ${res.status}`);
});

await test('GET /trades?pair=ETH-USDC returns 200 or 402', async () => {
  const res = await fetch(`${GATEWAY}/trades?pair=ETH-USDC`, {
    headers: { 'x402-payment': await buildPaymentHeader(wallet, '0.001') },
  });
  assert([200, 402].includes(res.status), `Expected 200 or 402, got ${res.status}`);
});

await test('Invalid pair returns 400 or 402', async () => {
  const res = await fetch(`${GATEWAY}/ticker?pair=INVALID`, {
    headers: { 'x402-payment': await buildPaymentHeader(wallet, '0.001') },
  });
  // 400 = invalid pair (funded wallet, validation ran); 402 = no balance (unfunded wallet)
  assert([400, 402].includes(res.status), `Expected 400 or 402, got ${res.status}`);
});

// Group 3: Auth validation
console.log('\n── Auth validation ────────────────────────────────');

await test('Missing x402-payment header returns 402', async () => {
  const res = await fetch(`${GATEWAY}/ticker?pair=ETH-USDC`);
  assert(res.status === 402, `Expected 402, got ${res.status}`);
});

await test('Invalid signature in payment header returns 402', async () => {
  const badHeader = Buffer.from(JSON.stringify({
    wallet: wallet.address,
    signature: '0x000000',
    amount: '0.001',
    nonce: Date.now().toString(),
  })).toString('base64');
  const res = await fetch(`${GATEWAY}/ticker?pair=ETH-USDC`, {
    headers: { 'x402-payment': badHeader },
  });
  assert(res.status === 402, `Expected 402, got ${res.status}`);
});

await test('Expired nonce (>5 min ago) returns 402', async () => {
  const expiredNonce = (Date.now() - 6 * 60 * 1000).toString(); // 6 minutes ago
  const signature = await wallet.signMessage(`x402:${expiredNonce}:0.001`);
  const badHeader = Buffer.from(JSON.stringify({
    wallet: wallet.address, signature, amount: '0.001', nonce: expiredNonce,
  })).toString('base64');
  const res = await fetch(`${GATEWAY}/ticker?pair=ETH-USDC`, {
    headers: { 'x402-payment': badHeader },
  });
  assert(res.status === 402, `Expected 402 for expired nonce, got ${res.status}`);
});

await test('Replay attack (same nonce twice) — second call returns 402', async () => {
  const header = await buildPaymentHeader(wallet, '0.001');
  // First call
  const res1 = await fetch(`${GATEWAY}/ticker?pair=ETH-USDC`, {
    headers: { 'x402-payment': header },
  });
  // Second call with same header (replay)
  const res2 = await fetch(`${GATEWAY}/ticker?pair=ETH-USDC`, {
    headers: { 'x402-payment': header },
  });
  // First might succeed (if wallet has balance) or fail with 402 insufficient
  // Second MUST fail with 402 nonce-already-used
  assert(res2.status === 402, `Replay should return 402, got ${res2.status}`);
  const body = await res2.json() as { reason?: string };
  assert(
    body.reason?.includes('Nonce') || body.reason?.includes('nonce') || body.error !== undefined,
    `Expected nonce-related error, got ${JSON.stringify(body)}`,
  );
});

// Group 4: Balance (requires auth, wallet may not have funds)
console.log('\n── Balance & orders (authenticated) ──────────────');

await test('GET /balance returns wallet info or 402 (new wallet)', async () => {
  const res = await fetch(`${GATEWAY}/balance`, {
    headers: { 'x402-payment': await buildPaymentHeader(wallet, '0') },
  });
  // 200 = has balance, 402 = no balance (new wallet), 404 = not registered yet
  assert(
    [200, 402, 404].includes(res.status),
    `Expected 200/402/404, got ${res.status}`,
  );
  if (res.status === 200) {
    const data = await res.json() as Record<string, unknown>;
    assert('usdc_balance' in data, 'Expected usdc_balance field');
    console.log(`\n       USDC balance: ${data.usdc_balance}`);
  }
});

await test('POST /trade without funds returns 402 Insufficient Balance', async () => {
  const res = await fetch(`${GATEWAY}/trade`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x402-payment': await buildPaymentHeader(wallet, '0.01'),
    },
    body: JSON.stringify({ pair: 'ETH-USDC', side: 'buy', type: 'limit', amount: '0.001', price: '1000' }),
  });
  // Should be 402 (insufficient balance to pay the API fee or place the order)
  assert(res.status === 402, `Expected 402 for unfunded wallet, got ${res.status}`);
});

await test('POST /trade with invalid pair returns 400 or 402', async () => {
  const res = await fetch(`${GATEWAY}/trade`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x402-payment': await buildPaymentHeader(wallet, '0.01'),
    },
    body: JSON.stringify({ pair: 'FAKE-COIN', side: 'buy', type: 'limit', amount: '1', price: '1' }),
  });
  // 400 = invalid pair (funded wallet, validation ran); 402 = no balance (unfunded wallet)
  assert([400, 402].includes(res.status), `Expected 400 or 402, got ${res.status}`);
});

await test('DELETE /orders/:id without auth returns 402', async () => {
  const res = await fetch(`${GATEWAY}/orders/nonexistent-order-id`, { method: 'DELETE' });
  assert(res.status === 402, `Expected 402, got ${res.status}`);
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('All tests passed ✓\n');
}
