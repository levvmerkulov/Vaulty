# Vaulty

`Vaulty` - это "копилка фактов" команды: общий тотал, детализация по участникам, фильтры по времени и тегам, поиск, пагинация, добавление новых фактов и админ-панель для состава команды.

Теперь данные хранятся не в браузере, а в backend на `Python + SQLite`, поэтому они переживают перезапуск сервера. В Docker база хранится в отдельном volume.

## Запуск в один клик

Для macOS:

1. Убедись, что у тебя доступны `docker` и `docker compose` или `docker-compose`.
2. Дважды кликни по файлу `start.command`.
3. Приложение откроется на [http://localhost:8080](http://localhost:8080).

Остановка:

1. Дважды кликни по файлу `stop.command`.

## Запуск из терминала

Если у тебя есть `docker compose`:

```bash
docker compose build
docker compose up -d
```

Если у тебя есть `docker-compose`:

```bash
docker-compose build
docker-compose up -d
```

После запуска открой [http://localhost:8080](http://localhost:8080).

Остановка:

```bash
docker compose down
```

или

```bash
docker-compose down
```

## Что внутри

- `server.py` - backend, API и раздача статики
- `Dockerfile` - контейнер на базе `python:3.13-slim`
- `docker-compose.yml` - публикация на `localhost:8080` и volume для SQLite
- `index.html` - корневой HTML
- `styles.css` - интерфейс и адаптивность
- `app.js` - фронтенд, работающий через API
- `favicon.svg` - иконка сайта
- `start.command` - запуск в один клик
- `stop.command` - остановка контейнера
