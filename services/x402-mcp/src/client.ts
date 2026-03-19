/**
 * x402Trade API client + payment signing.
 * Extracted as a separate module so it can be unit-tested independently.
 */
import { ethers } from 'ethers';

// Order matters: more specific prefixes must come before shorter ones
export function getPrice(path: string): string {
  if (path.startsWith('/trades'))    return '0.001'; // before /trade
  if (path.startsWith('/trade'))     return '0.01';
  if (path.startsWith('/ticker'))    return '0.001';
  if (path.startsWith('/orderbook')) return '0.001';
  if (path.startsWith('/orders/'))   return '0';     // DELETE /orders/:id — before /orders
  if (path.startsWith('/orders'))    return '0.001'; // GET /orders list
  if (path.startsWith('/balance'))   return '0';
  return '0';
}

export async function buildPaymentHeader(wallet: ethers.Wallet, amount: string): Promise<string> {
  const nonce = Date.now().toString();
  const signature = await wallet.signMessage(`x402:${nonce}:${amount}`);
  return Buffer.from(JSON.stringify({
    wallet: wallet.address,
    signature,
    amount,
    nonce,
  })).toString('base64');
}

export async function callApi(
  gatewayUrl: string,
  wallet: ethers.Wallet | null,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<unknown> {
  const price = getPrice(path);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (wallet) {
    headers['x402-payment'] = await buildPaymentHeader(wallet, price);
  }

  const res = await fetch(`${gatewayUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const data = await res.json() as unknown;

  if (!res.ok) {
    const msg = (data as Record<string, unknown>)?.error ?? res.statusText;
    throw new Error(`${res.status}: ${msg}`);
  }

  return data;
}
