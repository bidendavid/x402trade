/**
 * x402Trade API client for the market maker agent.
 * Signs every request with the agent's private key.
 */
import { ethers } from 'ethers';
import { config } from './config.js';

export const wallet = new ethers.Wallet(config.privateKey);

// All API calls are free — platform earns 0.1% on filled trades only
function getPrice(_path: string): string {
  return '0';
}

async function paymentHeader(amount: string): Promise<string> {
  const nonce = Date.now().toString();
  const signature = await wallet.signMessage(`x402:${nonce}:${amount}`);
  return Buffer.from(JSON.stringify({
    wallet: wallet.address,
    signature,
    amount,
    nonce,
  })).toString('base64');
}

export async function api<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const price = getPrice(path);
  const res = await fetch(`${config.gatewayUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x402-payment': await paymentHeader(price),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json() as T;
  if (!res.ok) {
    const msg = (data as Record<string, unknown>)?.error ?? res.statusText;
    throw new Error(`${res.status}: ${msg}`);
  }
  return data;
}

// ── Typed API calls ───────────────────────────────────────────────────────────

export interface Ticker {
  price: string;
  change24h: string;
  volume24h: string;
}

export interface Balance {
  usdc_balance: string;
  usdc_locked: string;
  eth_balance: string;
  eth_locked: string;
}

export interface OrderResult {
  orderId: string;
  status: string;
  filledAmount: string;
  avgPrice: string;
}

export interface OrderList {
  orders: Array<{
    order_id: string;
    side: string;
    status: string;
    amount: string;
    price: string;
    filled_amount: string;
  }>;
}

export const getTicker  = (pair: string)   => api<Ticker>('GET', `/ticker?pair=${pair}`);
export const getBalance = ()               => api<Balance>('GET', '/balance');
export const getOrders  = (pair: string)   => api<OrderList>('GET', `/orders?pair=${pair}&limit=50`);
export const cancelOrder = (orderId: string) => api('DELETE', `/orders/${orderId}`);
export const placeOrder = (order: {
  pair: string; side: 'buy' | 'sell'; type: 'limit';
  amount: string; price: string;
}) => api<OrderResult>('POST', '/trade', order);
