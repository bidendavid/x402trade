export interface ClientConfig {
  privateKey?: string;      // wallet private key (optional if using apiKey)
  apiKey?: string;          // API key (optional if using privateKey)
  gatewayUrl?: string;      // default: 'https://api.getx402.trade'
}

export interface Order {
  pair: string;             // e.g. 'ETH-USDC'
  side: 'buy' | 'sell';
  type: 'limit' | 'market';
  amount: string;           // base token amount e.g. '0.1'
  price?: string;           // required for limit orders
}

export interface OrderResult {
  orderId: string;
  status: string;
  filledAmount: string;
  avgPrice: string;
}

export interface OrderBookEntry { price: string; amount: string; }
export interface OrderBook {
  pair: string;
  bids: [string, string][];   // [price, amount][]
  asks: [string, string][];
  timestamp: number;
}

export interface Ticker {
  pair: string;
  price: string;
  change24h: string;
  volume24h: string;
  high24h: string;
  low24h: string;
  timestamp: number;
}

export interface Balance {
  usdc_balance: string;
  usdc_locked: string;
  eth_balance: string;
  eth_locked: string;
}

export interface Trade {
  trade_id: string;
  pair: string;
  price: string;
  amount: string;
  side: string;
  timestamp: string;
}

export interface AgentOrder {
  order_id: string;
  pair: string;
  side: string;
  order_type: string;
  amount: string;
  price: string;
  filled_amount: string;
  status: string;
  fee_usdc: string;
  created_at: string;
}

export interface WithdrawResult {
  success: boolean;
  withdrawId: string;
  wallet: string;
  amount: string;
  asset: string;
  status: string;
  onchain: {
    to: string;
    data: string;
    chainId: number;
    network: string;
    note: string;
  };
  confirmUrl: string;
}

export interface ApiKey {
  apiKey: string;        // shown once only
  id: string;
  label: string;
  createdAt: string;
  permissions: string;
}
