FROM oven/bun:latest
WORKDIR /app
COPY package.json tsconfig.json ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install
COPY . .
EXPOSE 7001
CMD ["bun", "run", "server.ts"]
