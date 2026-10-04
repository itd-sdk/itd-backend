FROM oven/bun:1.3 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    UPLOAD_DIR=/app/uploads
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY drizzle ./drizzle
COPY src ./src
RUN mkdir -p /app/uploads && chown -R bun:bun /app/uploads
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD bun -e "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["sh", "-c", "bun src/db/migrate.ts && bun src/db/seed.ts && exec bun src/index.ts"]
