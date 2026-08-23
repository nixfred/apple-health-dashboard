FROM oven/bun:latest
WORKDIR /app
COPY server.ts .
COPY public ./public
RUN mkdir -p data
EXPOSE 8880
CMD ["bun", "run", "server.ts"]
