# Dev/test only (SPEC.md §11).
FROM node:24-alpine
WORKDIR /app
COPY server.js package.json ./
RUN chown -R node:node /app
USER node
EXPOSE 9000
CMD ["node", "server.js"]
