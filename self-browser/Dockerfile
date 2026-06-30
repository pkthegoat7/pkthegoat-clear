# Imagem oficial do Playwright já traz o Chromium, Xvfb e libs de sistema.
# A tag DEVE casar com a versão do playwright no package.json (1.48.0).
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

# Áudio: PulseAudio (sink nulo) + ffmpeg (captura o monitor e encoda PCM).
RUN apt-get update \
    && apt-get install -y --no-install-recommends pulseaudio pulseaudio-utils ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .
RUN chmod +x start.sh && chown -R pwuser:pwuser /app

# Roda como usuário não-root (necessário para o PulseAudio por-usuário).
USER pwuser

ENV NODE_ENV=production
EXPOSE 8090

CMD ["./start.sh"]
