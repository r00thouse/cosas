# Trivial on purpose (SPEC.md §10.5): no build step. The only install is the three
# runtime dependencies (QR encode/decode and the photo cropper) from the lockfile.
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
# Every module, by glob: an explicit list silently drops the next new file.
COPY *.js ./
COPY db ./db
COPY public ./public
COPY tools/gen-codes.js ./tools/
# Files arrive 600 on some checkouts: hand them to the unprivileged user we run as.
RUN mkdir -p /data /photos && chown -R node:node /app /data /photos
USER node
EXPOSE 8080
CMD ["node", "server.js"]
