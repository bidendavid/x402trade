export type TradingPair = {
  id: string;
  base: string;
  quote: string;
  active: boolean;
};

// 默认主板交易对配置（后续可扩展为从数据库加载）
export const DEFAULT_TRADING_PAIRS: TradingPair[] = [
  { id: "USDC/WETH", base: "WETH", quote: "USDC", active: true },
  { id: "USDC/WBTC", base: "WBTC", quote: "USDC", active: true },
  { id: "USDC/USDT", base: "USDT", quote: "USDC", active: true },
  { id: "USDC/LINK", base: "LINK", quote: "USDC", active: true },
  { id: "USDC/OP", base: "OP", quote: "USDC", active: true }
  // 将来可以在这里追加 MEME / 实验区交易对
];

