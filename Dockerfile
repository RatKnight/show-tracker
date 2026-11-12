FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY server ./server
COPY app ./app
RUN mkdir /data && chown node:node /data
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
VOLUME /data
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server.js"]
