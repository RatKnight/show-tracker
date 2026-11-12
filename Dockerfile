FROM node:22-alpine
# Pick up security fixes for the base system, and remove the package managers:
# the app has no dependencies to install, so npm, corepack and yarn (and the
# libraries they bundle) are only something to keep patched.
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg /root/.npm
WORKDIR /app
COPY package.json server.js ./
COPY server ./server
COPY app ./app
RUN mkdir /data && chown node:node /data
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
VOLUME /data
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://localhost:3000/healthz || exit 1
CMD ["node", "server.js"]
