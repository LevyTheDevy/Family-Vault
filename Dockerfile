# Stage 1 — compile native modules (better-sqlite3 needs build tools)
FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /build
COPY vault/package*.json ./
RUN npm install --omit=dev

# Stage 2 — lean runtime image
FROM node:20-alpine
WORKDIR /app
COPY --from=builder /build/node_modules ./node_modules
COPY vault/src ./src
COPY vault/package.json ./

RUN mkdir -p /data /storage/avatars

EXPOSE 3000

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV STORAGE_DIR=/storage

CMD ["node", "src/index.js"]
