FROM oven/bun:latest
WORKDIR /app

COPY package.json ./
COPY bun.lock ./

RUN bun install --frozen-lockfile --production
COPY . .

RUN addgroup --gid 1001 nodejs && \
    adduser --uid 1001 --ingroup nodejs --system botuser
RUN chown -R botuser:nodejs /app
USER botuser

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD bun -e "console.log('Bot is running')" || exit 1

CMD ["bun", "start"]
