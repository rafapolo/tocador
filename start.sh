#!/bin/sh
set -e
mkdir -p /var/cache/nginx/images /var/lib/nginx/tmp
nginx -t
nginx -g "daemon off;" &
exec node --enable-source-maps proxy.js
