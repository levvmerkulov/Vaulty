#!/bin/zsh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker не найден."
  echo ""
  read "?Нажми Enter, чтобы закрыть окно..."
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(docker-compose)
else
  echo "Compose не найден."
  echo "Нужна команда docker compose или docker-compose."
  echo ""
  read "?Нажми Enter, чтобы закрыть окно..."
  exit 1
fi

echo "Останавливаю Vaulty..."
"${COMPOSE_CMD[@]}" down

echo "Vaulty остановлен."
read "?Нажми Enter, чтобы закрыть окно..."
