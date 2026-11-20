# Pinned, not floating (oven/bun:1-alpine) — a silent Bun patch bump broke
# Bun.S3Client's .stat() call against the Hetzner S3 endpoint on 2026-08-20,
# taking down covers and HEAD requests for hours before anyone traced it here.
# Bump deliberately, and re-run tests/cdn.spec.js's real-fetch checks after.
FROM oven/bun:1.4.2-alpine AS bun

# nginx from its official image, not Alpine's package: Alpine 3.22 shipped 1.28.3, open to the
# 25 advisories at nginx.org/en/security_advisories.html fixed in 1.30.7 (checked 2026-11-21).
# Pinned stable: bump it when that page lists a fix past this version.
FROM nginx:1.30.7-alpine

# Bun's musl build links libstdc++/libgcc, which the nginx image doesn't carry.
RUN apk add --no-cache libstdc++ libgcc
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

COPY proxy.js aquecer-capas.js ./
COPY lib ./lib
COPY js/acervo-format.js ./js/
COPY nginx.conf /etc/nginx/nginx.conf
# /var/cache/nginx/images is a haloy volume (haloy.yaml): the cover cache survives deploys.
RUN mkdir -p /var/cache/nginx/images

EXPOSE 9001

ENV PORT=9002

CMD sh -c "PORT=9002 bun /app/proxy.js & bun /app/aquecer-capas.js & nginx -g 'daemon off;'"
