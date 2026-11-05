FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build
USER node
CMD ["node", "packages/server/dist/main.js"]
