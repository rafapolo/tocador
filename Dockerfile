FROM oven/bun:1-alpine

RUN apk add --no-cache nginx

WORKDIR /app

COPY proxy.js .
COPY nginx.conf /etc/nginx/nginx.conf
RUN mkdir -p /var/cache/nginx/images /var/lib/nginx/tmp

EXPOSE 9001

ENV PORT=9002

CMD sh -c "PORT=9002 bun /app/proxy.js & nginx -g 'daemon off;'"
