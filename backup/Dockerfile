FROM mongo:7

# mongo 映像沒有 curl，但備份要回報狀態給平台
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backup.sh /app/backup.sh
RUN chmod +x /app/backup.sh

CMD ["/app/backup.sh"]
