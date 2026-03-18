FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY services/x402-gateway/package*.json ./services/x402-gateway/
RUN npm ci --workspace=services/x402-gateway --ignore-scripts
COPY tsconfig.base.json ./
COPY services/x402-gateway ./services/x402-gateway
RUN npm run build -w services/x402-gateway

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/services/x402-gateway/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 8080
CMD ["node", "dist/index.js"]
