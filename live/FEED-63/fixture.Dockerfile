# Append to crawler/Dockerfile in a temporary copy of crawler/.
USER root
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY origin.mjs start-fixture.sh chrome-fixture.sh ./
RUN chmod 755 start-fixture.sh chrome-fixture.sh
USER node
ENV CHROME_EXECUTABLE=/app/chrome-fixture.sh
CMD ["/app/start-fixture.sh"]
