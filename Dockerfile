# Trivial on purpose (SPEC.md §10.5): no npm install, no build step, no dependencies.
FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY server.js config.js oidc.js security.js store.js views.js html.js i18n.js code.js codes.js qrcode.js ./
COPY db ./db
COPY public ./public
COPY tools/gen-codes.js ./tools/
# Files arrive 600 on some checkouts: hand them to the unprivileged user we run as.
RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 8080
CMD ["node", "server.js"]
