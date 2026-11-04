#!/bin/sh
node /app/origin.mjs &
exec node /app/server.mjs
