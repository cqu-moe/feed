#!/bin/sh
exec /opt/chrome/chrome-linux64/chrome --no-proxy-server '--host-resolver-rules=MAP *.feed63.cqu.edu.cn 127.0.0.1:8443' "--ignore-certificate-errors-spki-list=$(cat /app/fixture.spki)" "$@"
