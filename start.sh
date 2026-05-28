#!/bin/sh
set -e
mkdir -p /var/cache/nginx/images
nginx -g "daemon off;" &
exec node --enable-source-maps proxy.js
