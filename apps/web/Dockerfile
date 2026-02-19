FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY apps/web/package*.json ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY apps/web ./
ARG NEXT_PUBLIC_TEMPO_API_BASE=http://localhost:8500
ARG NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=
ARG NEXT_PUBLIC_ENABLE_LOCAL_CHAIN=false
ARG NEXT_PUBLIC_DEFAULT_CHAIN_ID=11155111
ARG NEXT_PUBLIC_LOCAL_RPC_URL=http://127.0.0.1:8545
ENV NEXT_PUBLIC_TEMPO_API_BASE=$NEXT_PUBLIC_TEMPO_API_BASE
ENV NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=$NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
ENV NEXT_PUBLIC_ENABLE_LOCAL_CHAIN=$NEXT_PUBLIC_ENABLE_LOCAL_CHAIN
ENV NEXT_PUBLIC_DEFAULT_CHAIN_ID=$NEXT_PUBLIC_DEFAULT_CHAIN_ID
ENV NEXT_PUBLIC_LOCAL_RPC_URL=$NEXT_PUBLIC_LOCAL_RPC_URL
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/next.config.mjs ./next.config.mjs
EXPOSE 3000
CMD ["npm", "run", "start"]
