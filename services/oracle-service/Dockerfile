FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY services/oracle-service/package*.json ./services/oracle-service/
RUN npm ci --workspace=services/oracle-service --ignore-scripts
COPY tsconfig.base.json ./
COPY services/oracle-service ./services/oracle-service
RUN npm run build -w services/oracle-service

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/services/oracle-service/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 8083
CMD ["node", "dist/index.js"]
