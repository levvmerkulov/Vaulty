FROM python:3.13-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1
ENV VAULTY_DB_PATH=/app/data/vaulty.db
ENV VAULTY_PORT=8000

COPY server.py ./server.py
COPY index.html ./index.html
COPY styles.css ./styles.css
COPY app.js ./app.js
COPY favicon.svg ./favicon.svg

VOLUME ["/app/data"]

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"

CMD ["python3", "server.py"]
