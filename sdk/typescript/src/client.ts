import { ethers } from 'ethers';
import type {
  ClientConfig,
  Order,
  OrderResult,
  OrderBook,
  Ticker,
  Balance,
  Trade,
  AgentOrder,
  WithdrawResult,
  ApiKey,
} from './types.js';
import { X402TradeError, InsufficientBalanceError } from './errors.js';

const DEFAULT_GATEWAY = 'https://api.getx402.trade';

export class X402TradeClient {
  private wallet?: ethers.Wallet;
  private apiKey?: string;
  private gatewayUrl: string;

  constructor(config: ClientConfig) {
    this.gatewayUrl = config.gatewayUrl ?? DEFAULT_GATEWAY;
    if (config.privateKey) {
      this.wallet = new ethers.Wallet(config.privateKey);
    }
    if (config.apiKey) {
      this.apiKey = config.apiKey;
    }
    if (!config.privateKey && !config.apiKey) {
      throw new Error('Either privateKey or apiKey is required');
    }
  }

  get walletAddress(): string | undefined {
    return this.wallet?.address;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    if (this.apiKey) {
      return { 'X-API-Key': this.apiKey };
    }
    // wallet signature — all endpoints are free (amount='0')
    const nonce = Date.now().toString();
    const signature = await this.wallet!.signMessage(`x402:${nonce}:0`);
    const header = Buffer.from(
      JSON.stringify({
        wallet: this.wallet!.address,
        signature,
        amount: '0',
        nonce,
      }),
    ).toString('base64');
    return { 'x402-payment': header };
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const auth = await this.authHeaders();
    const res = await fetch(`${this.gatewayUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...auth },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      if (res.status === 402 && data['error'] === 'Insufficient Balance') {
        throw new InsufficientBalanceError((data['available'] as string) ?? '0');
      }
      throw new X402TradeError(
        (data['error'] as string) ?? res.statusText,
        res.status,
        data['reason'] as string | undefined,
      );
    }
    return data as T;
  }

  // ── Trading ────────────────────────────────────────────────────────────────

  async placeOrder(order: Order): Promise<OrderResult> {
    return this.request<OrderResult>('POST', '/trade', order);
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.request('DELETE', `/orders/${orderId}`);
  }

  async getOrders(pair?: string, limit = 50): Promise<AgentOrder[]> {
    const q = new URLSearchParams({ limit: String(limit) });
    if (pair) q.set('pair', pair);
    const res = await this.request<{ orders: AgentOrder[] }>('GET', `/orders?${q.toString()}`);
    return res.orders;
  }

  // ── Market data ────────────────────────────────────────────────────────────

  async getOrderBook(pair: string, depth = 20): Promise<OrderBook> {
    return this.request<OrderBook>('GET', `/orderbook?pair=${pair}&depth=${depth}`);
  }

  async getTicker(pair: string): Promise<Ticker> {
    return this.request<Ticker>('GET', `/ticker?pair=${pair}`);
  }

  async getTrades(pair: string, limit = 50): Promise<Trade[]> {
    const res = await this.request<{ trades: Trade[] }>(
      'GET',
      `/trades?pair=${pair}&limit=${limit}`,
    );
    return res.trades;
  }

  // ── Wallet ─────────────────────────────────────────────────────────────────

  async getBalance(): Promise<Balance> {
    return this.request<Balance>('GET', '/balance');
  }

  async confirmDeposit(txHash: string, asset: 'USDC' | 'ETH' = 'USDC'): Promise<void> {
    if (!this.wallet) throw new Error('privateKey required for deposit confirmation');
    await this.request('POST', '/deposit', {
      wallet: this.wallet.address,
      txHash,
      asset,
    });
  }

  async requestWithdraw(amount: string, asset: 'USDC' | 'ETH' = 'USDC'): Promise<WithdrawResult> {
    if (!this.wallet) throw new Error('privateKey required for withdrawal');
    const message = `Withdraw ${amount} ${asset} from x402Trade`;
    const signature = await this.wallet.signMessage(message);
    return this.request<WithdrawResult>('POST', '/withdraw', {
      wallet: this.wallet.address,
      amount,
      asset,
      signature,
    });
  }

  async confirmWithdraw(withdrawId: string, txHash: string): Promise<void> {
    await this.request('POST', '/withdraw/confirm', { withdrawId, txHash });
  }

  // ── API Keys ───────────────────────────────────────────────────────────────

  async createApiKey(label: string): Promise<ApiKey> {
    if (!this.wallet) throw new Error('privateKey required to create API key');
    const message = `x402Trade: create API key\nwallet: ${this.wallet.address.toLowerCase()}\nlabel: ${label}`;
    const signature = await this.wallet.signMessage(message);
    return this.request<ApiKey>('POST', '/api-key/create', {
      wallet: this.wallet.address,
      signature,
      label,
    });
  }
}
