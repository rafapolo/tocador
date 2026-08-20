# Pinned, not floating (oven/bun:1-alpine) — a silent Bun patch bump broke
# Bun.S3Client's .stat() call against the Hetzner S3 endpoint on 2026-08-20,
# taking down covers and HEAD requests for hours before anyone traced it here.
# Bump deliberately, and re-run tests/cdn.spec.js's real-fetch checks after.
FROM oven/bun:1.4.0-alpine

RUN apk add --no-cache nginx

WORKDIR /app

COPY proxy.js .
COPY nginx.conf /etc/nginx/nginx.conf
RUN mkdir -p /var/cache/nginx/images /var/lib/nginx/tmp

EXPOSE 9001

ENV PORT=9002

CMD sh -c "PORT=9002 bun /app/proxy.js & nginx -g 'daemon off;'"
