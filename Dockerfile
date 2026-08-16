FROM node:24-slim

WORKDIR /app

# Dependencies first so the layer caches across source edits. package-lock.json
# is committed, so this is a reproducible install rather than a fresh resolve.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY data.js ./
COPY intake-heuristics.js ./
COPY critic-checks.js ./
COPY production-heuristics.js ./
COPY view-model.js ./
COPY app-render.js ./
COPY app.js ./
COPY styles.css ./
COPY index.html ./
COPY lib ./lib
COPY docs ./docs

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
