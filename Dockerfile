FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
# No external npm dependencies are required; native fetch is used.
COPY src ./src

RUN mkdir -p /data /state && chown -R node:node /app /data /state
USER node

ENV DATA_DIR=/data
ENV STATE_DIR=/state

CMD ["node", "src/bot.js"]
