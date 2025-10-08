FROM oven/bun:1

WORKDIR /app
COPY . .
RUN bun install
ENTRYPOINT [ "bun", "run", "index_v2.ts" ]
