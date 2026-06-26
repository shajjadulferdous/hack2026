# QueueStorm Investigator — production Dockerfile
#
# Builds the SvelteKit app and serves it with Node. The HTTP API
# (GET /health, POST /analyze-ticket) is implemented in
# src/routes/health/+server.ts and src/routes/analyze-ticket/+server.ts,
# so this image is a single self-contained Node service — no FastAPI,
# no Python, no external LLM dependency at runtime.

# ---------- build stage ----------
FROM node:20-slim AS build
WORKDIR /app

# pnpm via corepack (project uses pnpm — see pnpm-lock.yaml / pnpm-workspace.yaml)
RUN corepack enable && corepack prepare pnpm@latest --activate

# Install deps (including dev deps) for the build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc* ./
RUN pnpm install --frozen-lockfile

# Build the app (vite build → .svelte-kit/output + build/)
COPY . .
RUN pnpm build

# Drop dev deps for the runtime image
RUN pnpm prune --prod

# ---------- runtime stage ----------
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8000

# Copy the built app + production node_modules from the build stage
COPY --from=build /app/build ./build
COPY --from=build /app/.svelte-kit/output ./build
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules

EXPOSE 8000

# Serve the SvelteKit server build on $HOST:$PORT (defaults above).
# Use the SvelteKit Node entry produced by the build.
CMD ["sh", "-c", "node build/index.js"]