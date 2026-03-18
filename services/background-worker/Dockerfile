FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY services/background-worker/package*.json ./services/background-worker/
RUN npm ci --workspace=services/background-worker --ignore-scripts
COPY tsconfig.base.json ./
COPY services/background-worker ./services/background-worker
RUN npm run build -w services/background-worker

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/services/background-worker/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 8083
CMD ["node", "dist/index.js"]
