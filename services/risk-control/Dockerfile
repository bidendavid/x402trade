FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY services/risk-control/package*.json ./services/risk-control/
RUN npm ci --workspace=services/risk-control --ignore-scripts
COPY tsconfig.base.json ./
COPY services/risk-control ./services/risk-control
RUN npm run build -w services/risk-control

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/services/risk-control/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
CMD ["node", "dist/index.js"]
