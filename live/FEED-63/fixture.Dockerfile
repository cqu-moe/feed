# Append to crawler/Dockerfile in a temporary copy of crawler/.
# Isolated acceptance image only: synthetic school hosts resolve to local HTTPS.
USER root
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/* && \
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=fixture -addext 'subjectAltName=DNS:*.feed63.cqu.edu.cn' -keyout fixture.key -out fixture.pem && \
  openssl x509 -in fixture.pem -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary | openssl base64 -A > fixture.spki
COPY origin.mjs start-fixture.sh chrome-fixture.sh ./
RUN chmod 755 start-fixture.sh chrome-fixture.sh && chown node:node fixture.key
USER node
ENV CHROME_EXECUTABLE=/app/chrome-fixture.sh
CMD ["/app/start-fixture.sh"]
