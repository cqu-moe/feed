#!/bin/sh
set -eu
export FIXTURE_TLS_DIR="$(mktemp -d)"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=fixture -addext 'subjectAltName=DNS:*.feed63.cqu.edu.cn' \
  -keyout "$FIXTURE_TLS_DIR/key" -out "$FIXTURE_TLS_DIR/cert" 2>/dev/null
openssl x509 -in "$FIXTURE_TLS_DIR/cert" -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary | openssl base64 -A > "$FIXTURE_TLS_DIR/spki"
node /app/origin.mjs &
exec node /app/server.mjs
