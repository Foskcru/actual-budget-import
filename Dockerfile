FROM node:22-slim

# Dependances de build (au cas ou un module natif doit se compiler)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Installer les dependances d'abord (cache Docker)
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copier le code
COPY server.mjs ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data
EXPOSE 3000
VOLUME ["/data"]

CMD ["node", "server.mjs"]
