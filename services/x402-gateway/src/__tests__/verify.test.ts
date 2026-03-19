/**
 * x402 payment verification unit tests.
 * Mocks Redis and ethers — no network or infrastructure required.
 */

jest.mock('../lib/redis', () => require('./__mocks__/redis'));

// Mock ethers so we can control signature verification
jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers') as Record<string, unknown>;
  return {
    ...actual,
    ethers: {
      ...(actual.ethers as Record<string, unknown>),
      verifyMessage: jest.fn(),
    },
  };
});

import { ethers } from 'ethers';
import {
  parseX402Header,
  verifySignature,
  checkReplay,
  markNonceUsed,
  checkBlacklist,
  verifyX402Payment,
  X402Payment,
} from '../x402/verify';
import { getRedis } from '../lib/redis';

// ── Helpers ────────────────────────────────────────────────────────────────────

const WALLET = '0xabcdef1234567890abcdef1234567890abcdef12';
const NONCE = String(Date.now());
const AMOUNT = '0.01';
const REQUIRED_AMOUNT = '0.01';

function makePayment(overrides: Partial<X402Payment> = {}): X402Payment {
  return {
    wallet: WALLET,
    signature: '0xsig',
    nonce: NONCE,
    amount: AMOUNT,
    ...overrides,
  };
}

function encodePayment(p: X402Payment): string {
  return Buffer.from(JSON.stringify(p)).toString('base64');
}

beforeEach(() => {
  (getRedis() as any)._reset();
  jest.clearAllMocks();
});

// ── parseX402Header ────────────────────────────────────────────────────────────

describe('parseX402Header', () => {
  it('decodes base64 JSON correctly', () => {
    const payment = makePayment();
    const header = encodePayment(payment);
    const parsed = parseX402Header(header);
    expect(parsed.wallet).toBe(WALLET);
    expect(parsed.amount).toBe(AMOUNT);
    expect(parsed.nonce).toBe(NONCE);
  });

  it('throws on malformed base64', () => {
    expect(() => parseX402Header('not-valid-json-base64!!')).toThrow();
  });
});

// ── verifySignature ────────────────────────────────────────────────────────────

describe('verifySignature', () => {
  it('returns true when recovered address matches wallet', async () => {
    (ethers.verifyMessage as jest.Mock).mockReturnValue(WALLET);
    const result = await verifySignature(makePayment());
    expect(result).toBe(true);
  });

  it('returns false when recovered address differs', async () => {
    (ethers.verifyMessage as jest.Mock).mockReturnValue('0x0000000000000000000000000000000000000001');
    const result = await verifySignature(makePayment());
    expect(result).toBe(false);
  });

  it('returns false when ethers throws', async () => {
    (ethers.verifyMessage as jest.Mock).mockImplementation(() => { throw new Error('bad sig'); });
    const result = await verifySignature(makePayment());
    expect(result).toBe(false);
  });
});

// ── checkReplay / markNonceUsed ────────────────────────────────────────────────

describe('replay prevention', () => {
  it('returns false for unseen nonce', async () => {
    expect(await checkReplay(WALLET, NONCE)).toBe(false);
  });

  it('returns true after marking nonce used', async () => {
    await markNonceUsed(WALLET, NONCE);
    expect(await checkReplay(WALLET, NONCE)).toBe(true);
  });
});

// ── checkBlacklist ─────────────────────────────────────────────────────────────

describe('checkBlacklist', () => {
  it('returns false for non-blacklisted wallet', async () => {
    expect(await checkBlacklist(WALLET)).toBe(false);
  });

  it('returns true when blacklist key exists in Redis', async () => {
    (getRedis() as any)._set(`blacklist:${WALLET.toLowerCase()}`, 'fraud');
    expect(await checkBlacklist(WALLET)).toBe(true);
  });
});

// ── verifyX402Payment (full flow) ──────────────────────────────────────────────

describe('verifyX402Payment', () => {
  beforeEach(() => {
    (ethers.verifyMessage as jest.Mock).mockReturnValue(WALLET);
  });

  it('returns valid=true for a correct payment', async () => {
    const result = await verifyX402Payment(encodePayment(makePayment()), REQUIRED_AMOUNT);
    expect(result.valid).toBe(true);
    expect(result.payment?.wallet).toBe(WALLET);
  });

  it('returns valid=false for malformed header', async () => {
    const result = await verifyX402Payment('!!!', REQUIRED_AMOUNT);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/format/i);
  });

  it('returns valid=false when required fields are missing', async () => {
    const bad = encodePayment({ wallet: WALLET, signature: '', amount: '', nonce: '' });
    const result = await verifyX402Payment(bad, REQUIRED_AMOUNT);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/missing/i);
  });

  it('returns valid=false on bad signature', async () => {
    (ethers.verifyMessage as jest.Mock).mockReturnValue('0x0000000000000000000000000000000000000001');
    const result = await verifyX402Payment(encodePayment(makePayment()), REQUIRED_AMOUNT);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/signature/i);
  });

  it('returns valid=false on replay attack', async () => {
    const payment = makePayment();
    await markNonceUsed(payment.wallet, payment.nonce);
    const result = await verifyX402Payment(encodePayment(payment), REQUIRED_AMOUNT);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/already used/i);
  });

  it('returns valid=false for blacklisted wallet', async () => {
    (getRedis() as any)._set(`blacklist:${WALLET.toLowerCase()}`, 'fraud');
    const result = await verifyX402Payment(encodePayment(makePayment()), REQUIRED_AMOUNT);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/blacklisted/i);
  });
});
