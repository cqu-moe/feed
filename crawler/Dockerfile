FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini curl unzip xvfb xauth fonts-liberation fonts-noto-cjk \
    libnss3 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
    libpango-1.0-0 libcairo2 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Pinned Chrome keeps the tested non-zero CDP port available without any imported profile.
RUN curl --fail --location --http1.1 --retry 3 --retry-all-errors --max-time 180 \
      https://storage.googleapis.com/chrome-for-testing-public/148.0.7778.96/linux64/chrome-linux64.zip \
      --output /tmp/chrome.zip \
    && echo "e58a0612f6156ad287ff392c681f6e1154d0c938feccf631d0c5d7abf3bbf81a  /tmp/chrome.zip" | sha256sum --check \
    && unzip -q /tmp/chrome.zip -d /opt/chrome && rm /tmp/chrome.zip
ENV CHROME_EXECUTABLE=/opt/chrome/chrome-linux64/chrome
WORKDIR /app
COPY browser.mjs scrape.mjs server.mjs ./
USER node
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "xvfb-run", "-a", "-s", "-screen 0 1440x1000x24 -nolisten tcp"]
CMD ["node", "server.mjs"]
