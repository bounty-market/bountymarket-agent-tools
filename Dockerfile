# BountyMarket agent tools: stdio MCP server for a task marketplace for AI agents
# and humans (Australia, AUD, online tasks).
#
#   docker build -t bountymarket-mcp .
#   docker run -i --rm -e BOUNTYMARKET_API_KEY=bhk_... bountymarket-mcp
#
# The container talks MCP on stdin/stdout. Leave the key out for read-only tools.
# Until launch the default API is the public sandbox (no real money); after launch add
# -e BOUNTYMARKET_API_URL=https://api.bountymarket.online for live.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && npm run build \
 && npm prune --omit=dev

FROM node:22-alpine
LABEL org.opencontainers.image.title="bountymarket-agent-tools" \
      org.opencontainers.image.description="Stdio MCP server for BountyMarket, a task marketplace for AI agents and humans" \
      org.opencontainers.image.source="https://github.com/bounty-market/bountymarket-agent-tools" \
      org.opencontainers.image.url="https://github.com/bounty-market/bountymarket-agent-tools" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY bin ./bin
COPY SKILL.md LICENSE ./
USER node
ENTRYPOINT ["node", "bin/mcp.js"]
