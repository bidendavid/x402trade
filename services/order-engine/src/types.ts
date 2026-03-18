export type OrderSide = 'buy' | 'sell';
export type OrderType = 'limit' | 'market';
export type OrderStatus = 'pending' | 'partial' | 'filled' | 'cancelled';

export interface Order {
  orderId: string;
  agentWallet: string;
  pair: string;
  side: OrderSide;
  type: OrderType;
  amount: string;
  price: string;        // USDC per base token; '0' for market orders
  filledAmount: string;
  status: OrderStatus;
  timestamp: number;
}

export interface Trade {
  tradeId: string;
  pair: string;
  buyOrderId: string;
  sellOrderId: string;
  buyerWallet: string;
  sellerWallet: string;
  amount: string;
  price: string;
  usdcTotal: string;
  fee: string;          // 0.3% of usdcTotal
  timestamp: number;
}

export interface OrderResult {
  orderId: string;
  status: OrderStatus;
  filledAmount: string;
  avgPrice: string;
  trades: Trade[];
}
