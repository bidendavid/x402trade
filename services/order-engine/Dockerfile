FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY services/order-engine/package*.json ./services/order-engine/
RUN npm ci --workspace=services/order-engine --ignore-scripts
COPY tsconfig.base.json ./
COPY services/order-engine ./services/order-engine
RUN npm run build -w services/order-engine

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/services/order-engine/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
CMD ["node", "dist/index.js"]
