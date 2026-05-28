FROM node:18-alpine

RUN apk add --no-cache nginx

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY proxy.js .
COPY nginx.conf /etc/nginx/nginx.conf
RUN mkdir -p /var/cache/nginx/images /var/lib/nginx/tmp

HEALTHCHECK --interval=3s --timeout=3s --retries=2 --start-period=2s \
  CMD node -e "require('http').get('http://localhost:9001/health', (r) => { r.resume(); process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1))"

EXPOSE 9001

ENV PORT=9002

CMD sh -c "PORT=9002 node --enable-source-maps /app/proxy.js & nginx -g 'daemon off;'"
