FROM node:24-bookworm-slim AS base
WORKDIR /app
COPY package.json package-lock.json ./

FROM base AS build
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM build AS checks
COPY eslint.config.mjs .prettierrc.json tsconfig.test.json ./
COPY test ./test
COPY scripts ./scripts
COPY fixtures ./fixtures
CMD ["npm", "run", "test:e2e"]

FROM base AS runtime
ENV NODE_ENV=production
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
USER node
CMD ["node", "dist/main-api.js"]
