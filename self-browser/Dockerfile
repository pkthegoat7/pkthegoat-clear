# Imagem oficial do Playwright já traz o Chromium e TODAS as libs de sistema.
# A tag DEVE casar com a versão do playwright no package.json (1.48.0).
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

ENV NODE_ENV=production
# PORT é injetado pela plataforma (Railway) ou use 8090 por padrão.
EXPOSE 8090

CMD ["node", "server.js"]
