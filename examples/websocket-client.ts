/**
 * x402Trade WebSocket Client Example
 *
 * Demonstrates how an AI Agent subscribes to real-time market data:
 *   - Order book updates for a trading pair
 *   - Trade feed (executions)
 *   - Price/ticker updates
 *
 * Usage:
 *   npx ts-node --project ../tsconfig.base.json examples/websocket-client.ts
 *
 * Environment:
 *   WS_URL=ws://localhost:8080/ws   (default)
 */

import WebSocket from 'ws';

const WS_URL = process.env.WS_URL || 'ws://localhost:8080/ws';
const PAIR = process.env.PAIR || 'ETH-USDC';

// ── Types ──────────────────────────────────────────────────────────────────────

interface WsMessage {
  type?: string;
  channel?: string;
  data?: unknown;
}

interface OrderBookData {
  bids: [string, string][];  // [price, amount][]
  asks: [string, string][];
  timestamp: number;
}

interface TradeData {
  tradeId: string;
  pair: string;
  buyerWallet: string;
  sellerWallet: string;
  amount: string;
  price: string;
  usdcTotal: string;
  fee: string;
  timestamp: number;
}

interface PriceData {
  price: string;
  change24h: string;
  volume24h: string;
  high24h: string;
  low24h: string;
}

// ── Client ─────────────────────────────────────────────────────────────────────

class X402TradeWSClient {
  private ws: WebSocket | null = null;
  private reconnectDelay = 1000;
  private pingInterval: NodeJS.Timeout | null = null;

  constructor(private url: string) {}

  connect(): void {
    console.log(`[ws] Connecting to ${this.url}...`);
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      console.log('[ws] Connected');
      this.reconnectDelay = 1000;

      // Subscribe to channels
      this.subscribe(`orderbook:${PAIR}`);
      this.subscribe(`trades:${PAIR}`);
      this.subscribe(`prices:${PAIR}`);

      // Keep-alive ping
      this.pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, 30_000);
    });

    this.ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as WsMessage;
        this.handleMessage(msg);
      } catch {
        console.warn('[ws] Unparseable message:', raw.toString());
      }
    });

    this.ws.on('close', (code, reason) => {
      console.log(`[ws] Disconnected (${code}: ${reason.toString()})`);
      if (this.pingInterval) clearInterval(this.pingInterval);
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error('[ws] Error:', err.message);
    });
  }

  private subscribe(channel: string): void {
    this.send({ type: 'subscribe', channel });
    console.log(`[ws] → subscribe ${channel}`);
  }

  unsubscribe(channel: string): void {
    this.send({ type: 'unsubscribe', channel });
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleMessage(msg: WsMessage): void {
    if (msg.type === 'subscribed') {
      console.log(`[ws] ✓ Subscribed to ${msg.channel}`);
      return;
    }

    if (!msg.channel || !msg.data) return;

    if (msg.channel.startsWith('orderbook:')) {
      this.onOrderBook(msg.channel.replace('orderbook:', ''), msg.data as OrderBookData);
    } else if (msg.channel.startsWith('trades:')) {
      this.onTrade(msg.data as TradeData);
    } else if (msg.channel.startsWith('prices:')) {
      this.onPrice(msg.channel.replace('prices:', ''), msg.data as PriceData);
    }
  }

  // ── Handlers (override these in your agent) ──────────────────────────────────

  onOrderBook(pair: string, book: OrderBookData): void {
    const topBid = book.bids?.[0];
    const topAsk = book.asks?.[0];

    if (topBid && topAsk) {
      const spread = (parseFloat(topAsk[0]) - parseFloat(topBid[0])).toFixed(2);
      console.log(
        `[orderbook:${pair}]  bid=${parseFloat(topBid[0]).toFixed(2)} (${topBid[1]} ETH)` +
        `  ask=${parseFloat(topAsk[0]).toFixed(2)} (${topAsk[1]} ETH)` +
        `  spread=${spread}`
      );
    }
  }

  onTrade(trade: TradeData): void {
    console.log(
      `[trade]  ${trade.amount} ETH @ ${parseFloat(trade.price).toFixed(2)} USDC` +
      `  total=${trade.usdcTotal}  fee=${trade.fee}`
    );
  }

  onPrice(pair: string, price: PriceData): void {
    console.log(
      `[price:${pair}]  $${parseFloat(price.price).toFixed(2)}` +
      `  24h: ${price.change24h}%` +
      `  vol: ${price.volume24h}`
    );
  }

  private scheduleReconnect(): void {
    setTimeout(() => {
      console.log(`[ws] Reconnecting in ${this.reconnectDelay}ms...`);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
      this.connect();
    }, this.reconnectDelay);
  }

  close(): void {
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.ws?.close();
  }
}

// ── Entry point ────────────────────────────────────────────────────────────────

const client = new X402TradeWSClient(WS_URL);
client.connect();

process.on('SIGINT', () => {
  console.log('\n[ws] Closing...');
  client.close();
  process.exit(0);
});
