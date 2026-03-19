FROM node:20-alpine AS builder
WORKDIR /app

# Copy all workspace package.json files for monorepo resolution
COPY package*.json ./
COPY services/x402-gateway/package*.json ./services/x402-gateway/
COPY services/order-engine/package*.json ./services/order-engine/
COPY services/wallet-service/package*.json ./services/wallet-service/
COPY services/background-worker/package*.json ./services/background-worker/
COPY services/oracle-service/package*.json ./services/oracle-service/
COPY services/risk-control/package*.json ./services/risk-control/
COPY services/indexer-service/package*.json ./services/indexer-service/
RUN npm ci --ignore-scripts

COPY tsconfig.base.json ./
COPY services/wallet-service ./services/wallet-service
RUN npm run build -w services/wallet-service

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/services/wallet-service/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 8082
CMD ["node", "dist/index.js"]
