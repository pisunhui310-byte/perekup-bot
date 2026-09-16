FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY *.mjs ./
RUN mkdir -p /app/data
ENV NODE_NO_WARNINGS=1
CMD ["node", "--use-env-proxy", "bot.mjs"]
