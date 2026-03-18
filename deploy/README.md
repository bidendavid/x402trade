# Deployment Guide

## Cost Overview

| 方案 | 月费 | 适用阶段 |
|---|---|---|
| `docker-compose.minimal.yml` | €6 (1台 CX21) | 测试/个人演示 |
| `deploy/2server/` | **€12** (2台 CX21) | **初期上线推荐** |
| `deploy/3server/` | €15 (3台 CX21) | 流量增长后 |
| `docker-compose.yml` (full) | $50+ | 生产多副本 |

> Hetzner CX21: 2 vCPU, 4 GB RAM, 40 GB SSD, 20 TB traffic — €5.83/mo

---

## 2-Server Setup (推荐初期)

### 架构
```
Internet → Server 1 (app) :80/:443
                ↓ NATS
           order-engine
           wallet-service
           background-worker (oracle + risk + indexer)
                ↓ TCP
           Server 2 (data) :5432 / :6379
           postgres + redis + prometheus + grafana
```

### 步骤

**1. 在两台服务器上都准备 .env**
```bash
DB_HOST=<data_server_ip>
DB_PASSWORD=your_secure_password
REDIS_HOST=<data_server_ip>
GITHUB_REPO=your_github_org/x402trade
X402_PAYMENT_ADDRESS=0x...your_usdc_wallet...
GRAFANA_PASSWORD=your_grafana_password
```

**2. 启动 data 服务器**
```bash
cd deploy/2server
docker compose -f data.yml up -d

# 初次部署运行 DB 迁移
docker exec -i $(docker ps -qf name=postgres) \
  psql -U agent agent_exchange < ../../db/migrations/001_init.sql
```

**3. 启动 app 服务器**
```bash
cd deploy/2server
docker compose -f app.yml up -d
```

**4. 验证**
```bash
curl http://<app_server_ip>/health
# → {"status":"ok","service":"x402-gateway"}
```

---

## 3-Server Setup (流量增长后)

### 架构
```
Internet → Server 1 (gateway) :80/:443   ← 可以多台水平扩展
                ↓ NATS (Server 2)
           Server 2 (engine)
           order-engine + wallet + background-worker + NATS
                ↓ TCP
           Server 3 (data)
           postgres + redis + monitoring
```

### 优势
- gateway 无状态，可随时加机器
- engine 独立，撮合逻辑不受外部流量影响
- data 独立，方便做 PostgreSQL 备份/只读副本

### 步骤
```bash
# Server 3 (data) — 先启动
cd deploy/3server && docker compose -f data.yml up -d

# Server 2 (engine)
ENGINE_HOST=<engine_server_ip>
REDIS_HOST=<data_server_ip>
DB_HOST=<data_server_ip>
cd deploy/3server && docker compose -f engine.yml up -d

# Server 1 (gateway)
ENGINE_HOST=<engine_server_ip>
REDIS_HOST=<data_server_ip>
DB_HOST=<data_server_ip>
cd deploy/3server && docker compose -f gateway.yml up -d
```

---

## 防火墙规则

**data 服务器**（只允许 app/engine 访问，不暴露公网）
```bash
ufw allow from <app_server_ip> to any port 5432   # PostgreSQL
ufw allow from <app_server_ip> to any port 6379   # Redis
ufw allow from <engine_server_ip> to any port 5432
ufw allow from <engine_server_ip> to any port 6379
ufw allow 3000   # Grafana (自己访问)
ufw allow 22     # SSH
```

**app/engine 服务器**
```bash
ufw allow 80 && ufw allow 443   # HTTP/HTTPS
ufw allow 22                    # SSH
ufw allow from <gateway_ip> to any port 4222   # NATS (3台方案)
```

---

## 升级流程 (CI/CD 已配置)

push 到 `main` 后，GitHub Actions 自动构建并推送镜像到 ghcr.io。
在服务器上拉取新镜像重启：

```bash
docker compose -f app.yml pull && docker compose -f app.yml up -d
```
