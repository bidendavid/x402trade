# x402Trade MCP Server

让 Claude、Cursor 等 AI 助手直接在 x402Trade 上交易。

## 5 分钟快速接入

### 1. 安装

```bash
npm install -g @x402trade/mcp-server
```

或者直接用 npx（无需安装）：

```bash
npx @x402trade/mcp-server
```

### 2. 配置 Claude Desktop

打开 Claude Desktop 配置文件：

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

添加以下配置：

```json
{
  "mcpServers": {
    "x402trade": {
      "command": "npx",
      "args": ["@x402trade/mcp-server"],
      "env": {
        "PRIVATE_KEY": "0x你的以太坊钱包私钥"
      }
    }
  }
}
```

重启 Claude Desktop，即可使用。

### 3. 配置 Cursor

在 Cursor 设置 → MCP → Add Server：

```json
{
  "name": "x402trade",
  "command": "npx @x402trade/mcp-server",
  "env": {
    "PRIVATE_KEY": "0x你的以太坊钱包私钥"
  }
}
```

---

## 你能对 Claude 说什么

配置完成后，你可以直接用自然语言交易：

```
你: ETH 现在多少钱？
Claude: 调用 x402_get_price → ETH 当前价格 $2,247.50，24h 涨 +2.3%

你: 帮我用 $500 买 ETH，限价 $2200
Claude: 调用 x402_place_order → 订单已提交，订单号 abc-123，挂单中

你: 我现在有多少 USDC？
Claude: 调用 x402_get_balance → USDC 余额 $1,250.00，ETH 余额 0.45

你: 把刚才那个订单取消
Claude: 调用 x402_cancel_order → 订单已取消，$500 USDC 已解锁

你: 帮我看看 ETH-USDC 的买卖盘
Claude: 调用 x402_get_orderbook → 显示当前 bids 和 asks
```

---

## 可用工具

| 工具 | 说明 | 费用 |
|---|---|---|
| `x402_get_price` | 当前价格、24h 涨跌、成交量 | $0.001 |
| `x402_get_orderbook` | 实时买卖盘 | $0.001 |
| `x402_get_balance` | 你的 USDC + ETH 余额 | 免费 |
| `x402_place_order` | 下买单或卖单（限价/市价） | $0.01 |
| `x402_cancel_order` | 撤销挂单 | 免费 |
| `x402_get_orders` | 查看我的订单记录 | $0.001 |
| `x402_get_recent_trades` | 市场最近成交记录 | $0.001 |
| `x402_deposit_info` | 充值地址和说明 | 免费 |

---

## 充值 USDC

1. 调用 `x402_deposit_info` 获取充值地址
2. 在 Base L2 (Chain ID: 8453) 向该地址发送 USDC
3. 约 15 秒后余额自动更新

**注意：只支持 Base L2 上的 USDC，不支持其他网络。**

---

## 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `PRIVATE_KEY` | 你的以太坊钱包私钥（`0x...`） | 无（只读模式） |
| `X402_GATEWAY_URL` | 交易所 API 地址 | `https://api.getx402.trade` |

**私钥安全提示：** 私钥只在你的本地机器上使用，不会发送到任何服务器。MCP Server 用私钥在本地签名交易请求，签名后的数据发送给交易所验证。

---

## 本地开发

```bash
git clone https://github.com/bidendavid/x402trade.git
cd x402trade/services/x402-mcp
npm install
PRIVATE_KEY=0x... npm run dev
```

---

## 交易对

目前支持：
- `ETH-USDC` — ETH 对 USDC
- `BTC-USDC` — BTC 对 USDC

---

## 链接

- **交易所 API**: https://api.getx402.trade
- **官网**: https://getx402.trade
- **GitHub**: https://github.com/bidendavid/x402trade
- **x402 协议**: https://x402.org
