FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY services/wallet-service/package*.json ./services/wallet-service/
RUN npm ci --workspace=services/wallet-service --ignore-scripts
COPY tsconfig.base.json ./
COPY services/wallet-service ./services/wallet-service
RUN npm run build -w services/wallet-service

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/services/wallet-service/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 8082
CMD ["node", "dist/index.js"]
