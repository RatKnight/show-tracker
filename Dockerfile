FROM node:22-alpine
# Pick up security fixes for the base system, and remove the package managers:
# the app has no dependencies to install, so npm, corepack and yarn (and the
# libraries they bundle) are only something to keep patched.
#
# The server reuses this step from its build cache, so fixes published after
# the last real run are not picked up by an ordinary deploy. Changing
# PATCHED_ON makes the next deploy run it again: set it to today's date when the
# image scan reports a fix available upstream.
ARG PATCHED_ON=2026-11-25
RUN echo "system packages refreshed for ${PATCHED_ON}" && apk upgrade --no-cache \
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
