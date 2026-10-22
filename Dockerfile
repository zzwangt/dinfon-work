FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY server ./server
COPY public ./public
COPY scripts/setup-local.mjs scripts/terminal-input.mjs scripts/manage-admin.mjs scripts/backup.mjs ./scripts/
COPY package.json ./package.json
RUN mkdir -p /app/config /app/data && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "server/standalone.mjs"]
