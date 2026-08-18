# Deps stage: resolve production dependencies with Yarn 4.
# The node-modules linker is used here (instead of the PnP linker the repo uses
# locally) so the runtime stage is a plain `node` invocation with no loader.
FROM node:22-alpine AS deps
WORKDIR /app
ENV YARN_NODE_LINKER=node-modules \
    YARN_ENABLE_GLOBAL_CACHE=false
RUN corepack enable
COPY package.json yarn.lock ./
RUN yarn workspaces focus --production

# Runtime stage: Node 22 executes the .ts sources directly via type stripping.
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER node
EXPOSE 3000
CMD ["node", "src/server.ts"]
