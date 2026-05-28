FROM node:18-alpine

RUN apk add --no-cache nginx

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY proxy.js .
COPY nginx.conf /etc/nginx/nginx.conf
COPY start.sh .
RUN chmod +x start.sh

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001 \
 && mkdir -p /var/cache/nginx/images /tmp/nginx \
 && chown -R nodejs:nodejs /var/cache/nginx /tmp/nginx /var/log/nginx /var/lib/nginx

USER nodejs

HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:9001/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)}).on('error', () => process.exit(1))"

EXPOSE 9001

ENV PORT=9002

CMD ["./start.sh"]
