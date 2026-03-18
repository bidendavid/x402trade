FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY services/indexer-service/package*.json ./services/indexer-service/
RUN npm ci --workspace=services/indexer-service --ignore-scripts
COPY tsconfig.base.json ./
COPY services/indexer-service ./services/indexer-service
RUN npm run build -w services/indexer-service

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/services/indexer-service/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
CMD ["node", "dist/index.js"]
