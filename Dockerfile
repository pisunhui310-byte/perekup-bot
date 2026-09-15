FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY *.mjs ./
COPY start-docker.sh ./
RUN chmod +x start-docker.sh && mkdir -p /app/data
ENV NODE_NO_WARNINGS=1
CMD ["./start-docker.sh"]
