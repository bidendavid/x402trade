# Railway Deployment

Railway supports multi-service Docker deployments with managed PostgreSQL and Redis.

## Estimated Cost
- Starter plan: ~$5/mo base + usage
- For this stack: ~$30–50/mo (5 services + managed DB + Redis)

## Steps

### 1. Create a new Railway project
Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo → select `x402trade`

### 2. Add managed databases
In the Railway dashboard:
- Click **+ New** → **Database** → **PostgreSQL**
- Click **+ New** → **Database** → **Redis**

### 3. Deploy each service

For each service below, add a new service in Railway:
- **+ New** → **GitHub Repo** → select `x402trade`
- Set the **Root Directory** and **Dockerfile Path**

| Service | Root Directory | Dockerfile |
|---|---|---|
| `order-engine` | `.` | `services/order-engine/Dockerfile` |
| `wallet-service` | `.` | `services/wallet-service/Dockerfile` |
| `background-worker` | `.` | `services/background-worker/Dockerfile` |
| `x402-gateway` | `.` | `services/x402-gateway/Dockerfile` |

### 4. Set environment variables

For each service, add these variables in the Railway dashboard.
Use `${{Postgres.DATABASE_URL}}` and `${{Redis.REDIS_URL}}` to reference managed services.

**All services:**
```
DB_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
NATS_URL=<internal NATS URL if self-hosting, or use Railway's TCP proxy>
```

**background-worker:**
```
BACKGROUND_PORT=8083
BASE_RPC_URL=https://mainnet.base.org
PLATFORM_FEE_WALLET=0x...
```

**wallet-service:**
```
WALLET_PORT=8082
PLATFORM_FEE_WALLET=0x...
USDC_CONTRACT=0x833589fCD6eDb6E08f4c7C32D4f71b54bA02913C
```

**x402-gateway:**
```
PORT=8080
RISK_CONTROL_URL=<internal URL of background-worker service>
DEPOSIT_ADDRESS=0x...
PLATFORM_FEE_WALLET=0x...
USDC_CONTRACT=0x833589fCD6eDb6E08f4c7C32D4f71b54bA02913C
```

### 5. NATS on Railway

Railway doesn't have a managed NATS. Options:
- Self-host NATS as a Railway service using `nats:alpine` image with command `-js -m 8222`
- Use a managed NATS service like [Synadia Cloud](https://www.synadia.com) (free tier available)

### 6. Set custom domain
In x402-gateway service → Settings → Domains → Add `getx402.trade`

### 7. Run DB migration
After all services are up, open the Railway console for the `x402-gateway` service and run:
```bash
psql $DB_URL < db/migrations/001_init.sql
```
