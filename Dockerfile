FROM node:24-bookworm

WORKDIR /app

ENV DEBIAN_FRONTEND=noninteractive \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    CHROME_BIN=/usr/bin/chromium \
    FB_HEADLESS=true

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    procps \
    tini \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --production

COPY src ./src

RUN mkdir -p /data /state && chown -R node:node /app /data /state
USER node

ENV DATA_DIR=/data \
    STATE_DIR=/state \
    NODE_ENV=production

ENTRYPOINT ["tini", "-s", "--"]
CMD ["node", "src/bot.js"]
