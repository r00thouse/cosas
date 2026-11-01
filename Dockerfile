# Trivial on purpose (SPEC.md §10.5): no build step. The only install is the two
# runtime dependencies (QR encode/decode) from the lockfile.
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.js config.js oidc.js security.js store.js views.js html.js i18n.js code.js codes.js qrcode.js multipart.js photos.js ./
COPY db ./db
COPY public ./public
COPY tools/gen-codes.js ./tools/
# Files arrive 600 on some checkouts: hand them to the unprivileged user we run as.
RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 8080
CMD ["node", "server.js"]
