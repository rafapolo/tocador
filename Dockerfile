FROM node:18-alpine

RUN apk add --no-cache nginx supervisor

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY proxy.js .
COPY nginx.conf /etc/nginx/nginx.conf
COPY supervisord.conf /etc/supervisord.conf
RUN mkdir -p /var/cache/nginx/images /var/lib/nginx/tmp

HEALTHCHECK --interval=10s --timeout=5s --retries=3 --start-period=20s \
  CMD node -e "require('http').get('http://localhost:9001/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)}).on('error', () => process.exit(1))"

EXPOSE 9001

ENV PORT=9002

CMD ["supervisord", "-c", "/etc/supervisord.conf"]
