# Развёртывание openitd

```
браузер ──HTTPS 443──▶ Caddy ──▶ /api, /uploads, /health ──▶ backend 127.0.0.1:3000 ──▶ PostgreSQL :5432
                         │                                         │
                         └──▶ остальное: файлы веб-клиента         └──▶ Redis :6379 ◀── Telegram-бот ◀──▶ Telegram
```

Наружу открыт только Caddy (порты 80 и 443). Backend, PostgreSQL и Redis слушают только localhost.
Бот не принимает входящих соединений: он сам опрашивает Telegram и берёт коды из Redis.

Вход: пользователь открывает бота и жмёт «Старт» (бот запоминает чат его ника) → на сайте вводит ник в
Telegram и пароль → backend кладёт код в Redis → бот присылает код в Telegram. Код нужен при регистрации,
при каждом входе (`LOGIN_CODE=true`) и при сбросе пароля.

## Где что настраивается

| Что | Где | Значение по умолчанию |
|---|---|---|
| домен сайта | `/etc/caddy/Caddyfile` (первая строка), `PUBLIC_URL` в `/opt/itd-backend/.env`, `SITE_URL` в `deploy/telegram-bot/.env` | `itd.example.com` |
| адрес и порт backend | `HOST` и `PORT` в `.env` **и** оба `reverse_proxy 127.0.0.1:3000` в Caddyfile — должны совпадать | `127.0.0.1:3000` |
| порты сайта | Caddy (или nginx, см. ниже): 80 (редирект на HTTPS) и 443 | — |
| PostgreSQL | `DATABASE_URL` в `.env` | `postgres://itd:ПАРОЛЬ@localhost:5432/itd` |
| Redis | `REDIS_URL` и `REDIS_PREFIX` в `.env` **и** в `deploy/telegram-bot/.env` — одинаковые | `redis://localhost:6379`, `itd:` |
| токен бота | `BOT_TOKEN` в `deploy/telegram-bot/.env` | — |
| ник бота | `TELEGRAM_BOT` в `.env` **и** `--telegram-bot` при сборке веб-клиента | `openitd_bot` |
| папка веб-клиента | `root` в Caddyfile | `/opt/itd-backend/deploy/frontend/dist` |
| администратор | `ADMIN_TELEGRAM`, `ADMIN_PASSWORD` в `.env` | — |
| код при каждом входе | `LOGIN_CODE` в `.env` | `true` |

Полный список настроек backend с комментариями — в [.env.example](../.env.example).

## Шаг 0. До сервера

1. **Сервер**: Ubuntu 24.04 или Debian 12, 1–2 vCPU, 2 ГБ RAM, 10+ ГБ диска. В файрволе провайдера
   откройте TCP 80 и 443 (и UDP 443 для HTTP/3).
2. **Домен**: A-запись (и AAAA, если есть IPv6) `itd.example.com → IP сервера`. Проверка:
   `ping itd.example.com` показывает IP сервера. Без этого Caddy не получит сертификат.
3. **Бот**: в [@BotFather](https://t.me/BotFather) `/newbot` → ник (например `openitd_bot`) → сохраните
   токен вида `123456789:AA...`.

Дальше все команды выполняются на сервере под пользователем с `sudo`.

## Шаг 1. Пакеты

```bash
sudo apt update
sudo apt install -y git curl unzip gnupg postgresql postgresql-contrib redis-server python3-venv

# Caddy из официального репозитория (нужен 2.8+, в репозитории дистрибутива версия старее)
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

# Bun в /usr/local/bin (этот путь прописан в systemd-юните)
curl -fsSL https://bun.sh/install | sudo BUN_INSTALL=/usr/local bash
bun --version

# Redis хранит привязки «ник → чат»: включите AOF, чтобы они переживали перезапуск
sudo sed -i 's/^appendonly no/appendonly yes/' /etc/redis/redis.conf
sudo systemctl restart redis-server
```

PostgreSQL и Redis после установки слушают только localhost — так и нужно.

## Шаг 2. Код

```bash
sudo useradd --system --create-home --home-dir /var/lib/itd --shell /usr/sbin/nologin itd
sudo git clone -b openitd https://github.com/itd-sdk/itd-backend /opt/itd-backend
sudo git clone https://github.com/itd-sdk/itd-frontend /opt/itd-frontend
sudo chown -R itd:itd /opt/itd-backend /opt/itd-frontend
cd /opt/itd-backend
sudo -u itd -H bun install --production --frozen-lockfile
```

Если репозитории приватные, используйте `https://<токен>@github.com/...` или SSH-ключ (deploy key).
Если в itd-frontend есть ветка `openitd`, можно клонировать её (`-b openitd`), результат сборки тот же.

## Шаг 3. База данных

```bash
DB_PASSWORD=$(openssl rand -hex 16); echo "пароль БД: $DB_PASSWORD"
sudo -u postgres psql -c "CREATE USER itd WITH PASSWORD '$DB_PASSWORD'"
sudo -u postgres psql -c "CREATE DATABASE itd OWNER itd"
sudo -u postgres psql -d itd -c "CREATE EXTENSION IF NOT EXISTS pg_trgm"
openssl rand -hex 32   # это будет JWT_SECRET
```

## Шаг 4. Настройки backend

```bash
cd /opt/itd-backend
sudo -u itd cp .env.example .env
sudo chmod 600 .env
sudo -u itd nano .env
```

Измените эти строки (остальное можно оставить):

```ini
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
PUBLIC_URL=https://itd.example.com
TRUST_PROXY=true
DATABASE_URL=postgres://itd:ПАРОЛЬ_БД@localhost:5432/itd
REDIS_URL=redis://localhost:6379
REDIS_PREFIX=itd:
JWT_SECRET=результат_openssl_rand_-hex_32
COOKIE_SECURE=true
DEV_EXPOSE_OTP=false
TELEGRAM_BOT=openitd_bot
ADMIN_TELEGRAM=ваш_ник_в_telegram
ADMIN_PASSWORD=пароль_администратора_от_10_символов
```

Проверка: `cd /opt/itd-backend && sudo -u itd bash -c 'set -a; . ./.env; bun src/db/migrate.ts && bun src/db/seed.ts'`
должна напечатать `migrations applied` и `reference data seeded (admin ...)`.

## Шаг 5. Telegram-бот

```bash
cd /opt/itd-backend/deploy/telegram-bot
sudo -u itd python3 -m venv .venv
sudo -u itd .venv/bin/pip install -r requirements.txt
sudo -u itd cp .env.example .env
sudo chmod 600 .env
sudo -u itd nano .env
```

```ini
BOT_TOKEN=123456789:AA...
REDIS_URL=redis://localhost:6379
REDIS_PREFIX=itd:
SITE_URL=https://itd.example.com
```

## Шаг 6. Веб-клиент

```bash
cd /opt/itd-backend
sudo -u itd -H bun deploy/frontend/build.ts --source /opt/itd-frontend --telegram-bot openitd_bot
```

Скрипт берёт JS/CSS из itd-frontend, докачивает с итд.com то, чего там нет (index.html, стили, данные
эмодзи, часть экранов, картинки, звуки, файлы CDN), убирает Sentry и трекеры и применяет правки openitd
(`deploy/frontend/patches.ts`): поле «Telegram» вместо e-mail, подсказки про бота, без капчи. Если правка
не применилась (бандл изменился), сборка остановится. Результат — `deploy/frontend/dist`, отчёт —
`dist/build-info.json`.

Если часть картинок не скачалась (`! N images/sounds could not be downloaded`), просто запустите сборку
ещё раз: уже скачанные файлы берутся из прошлой сборки, докачивается только недостающее; список — в
`dist/build-info.json` (`missing`). Файлы из `missing.notOnSite` отсутствуют и на самом итд.com.
Итд.com закрыт DDoS-Guard. Если с сервера он не открывается, соберите на своём компьютере (нужен Bun) и
скопируйте: `rsync -a deploy/frontend/dist/ root@сервер:/opt/itd-backend/deploy/frontend/dist/`, затем
`sudo chown -R itd:itd /opt/itd-backend/deploy/frontend/dist`. Режим `--offline` — только для проверки:
без данных эмодзи не пройти онбординг.

## Шаг 7. Запуск

```bash
sudo cp /opt/itd-backend/deploy/systemd/itd-backend.service /opt/itd-backend/deploy/systemd/itd-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now itd-backend itd-bot
systemctl status itd-backend itd-bot --no-pager
curl -s http://127.0.0.1:3000/health        # {"status":"ok","postgres":true,"redis":true}

sudo cp /opt/itd-backend/deploy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/itd.example.com/ВАШ.ДОМЕН/' /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

## Шаг 8. Проверка

1. `https://ВАШ.ДОМЕН/health` → `{"status":"ok",...}`; сертификат выдаётся за 10–60 секунд после reload.
2. В Telegram откройте бота, нажмите «Старт» — он ответит «Готово! Telegram @ник подключён».
3. На сайте «Создать аккаунт» → ник и пароль → код придёт в бота → онбординг.
4. Администратор: нажмите «Старт» в боте с аккаунта `ADMIN_TELEGRAM`, войдите с `ADMIN_PASSWORD`.

Логи: `journalctl -u itd-backend -f`, `journalctl -u itd-bot -f`, `journalctl -u caddy -f`.

| Симптом | Причина |
|---|---|
| сайт не открывается, в логе Caddy ошибки ACME | DNS ещё не указывает на сервер или закрыты 80/443 |
| 502 на `/api/...` | backend не запущен или `PORT` не совпадает с Caddyfile: `systemctl status itd-backend` |
| «Откройте Telegram-бота…» после «Старт» | разные `REDIS_URL`/`REDIS_PREFIX` у backend и бота, или бот не запущен |
| код не приходит | `journalctl -u itd-bot` — неверный `BOT_TOKEN` или пользователь заблокировал бота |
| после входа сразу выкидывает | `COOKIE_SECURE=true` при открытии сайта по http, или `PUBLIC_URL` не совпадает с доменом |

## nginx вместо Caddy

Caddy и nginx делают одно и то же (HTTPS, раздача сайта, прокси на backend) — нужен **один** из них,
оба занимают порты 80/443. Если nginx уже стоит на сервере, используйте его:

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo cp deploy/nginx/itd.conf /etc/nginx/sites-available/itd
sudo nano /etc/nginx/sites-available/itd        # server_name и root (папка с собранным сайтом)
sudo ln -s /etc/nginx/sites-available/itd /etc/nginx/sites-enabled/itd
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d ВАШ.ДОМЕН             # сертификат, HTTPS и редирект с http
```

Конфиги nginx: `/etc/nginx/nginx.conf` (общий), сайты — `/etc/nginx/sites-available/` (включаются ссылкой
в `sites-enabled/`) или `/etc/nginx/conf.d/*.conf`, логи — `/var/log/nginx/`. Сайт nginx читает от
пользователя `www-data`, поэтому собранный веб-клиент кладите в `/var/www/itd`, а не в домашнюю папку.

## Название, иконка и пины

**Название и иконка сайта** задаются при сборке веб-клиента (шаг 6):

```bash
bun deploy/frontend/build.ts --source ../itd-frontend --telegram-bot openitd_bot \
    --title "OpenITD" --icon ~/openitd-icon.png
```

Или один раз в `.env` (сборка читает его сама): `SITE_TITLE=OpenITD`, `SITE_ICON=/home/desi/openitd-icon.png`.
Иконка — `.png` (лучше квадратная, 512×512), `.svg`, `.ico` или `.webp`; меняются заголовок вкладки,
иконка вкладки и на экране «Домой», название в манифесте. Логотип внутри интерфейса — часть бандла, он не меняется.

**Правки стилей** — в `deploy/frontend/overrides.css`: сборка встраивает его в `index.html` после стилей веб-клиента
(свой файл: `--css путь` или `SITE_CSS`). Классы вида `.CmY2` — хэши этой версии бандла, после обновления
itd-frontend их стоит проверить.

**Пины** — значки возле имени. Веб-клиент рисует пин только по картинке (`url`), без неё пин не виден.
Всё делается из Swagger (`/swagger`, «Authorize» с токеном администратора, см. «Админка»):

1. Картинка: `POST /api/files/upload` (multipart, поле `file`) → в ответе `url` вида `/uploads/...`
   (или положите файл в любую папку, которую отдаёт nginx).
2. Пин: `POST /api/admin/pins` → `{"slug": "founder", "name": "Основатель", "description": "...", "url": "/uploads/..."}`;
   тот же запрос с существующим `slug` меняет пин. Список: `GET /api/admin/pins`.
3. Выдать: `POST /api/admin/users/<id или username>/pins` → `{"slug": "founder"}`; забрать:
   `DELETE /api/admin/users/<id или username>/pins/founder`.
4. Пользователь выбирает активный пин в настройках профиля.

**Список изменений** («Что нового» в меню) — тоже из Swagger с токеном администратора:

- добавить или изменить версию: `POST /api/admin/changelog` →
  `{"version": "1.2.0", "date": "5 октября", "changes": ["Добавили ивент", "Исправили уведомления"]}`
  (`date` можно не указывать — будет сегодняшняя; тот же `version` перезаписывает запись);
- удалить: `DELETE /api/admin/changelog/1.2.0`;
- посмотреть: `GET /api/platform/changelog` (новые записи сверху).

## Ивент

1. В `.env` backend: `EVENT_ENABLED=true` (по желанию `EVENT_ENDS_AT=2026-12-31T21:00:00Z`, иначе ивент идёт
   до начала следующего месяца). Портал включается вместе с ивентом, `PORTAL_*` трогать не нужно.
2. `sudo systemctl restart itd-backend` — переменные из `.env` читаются только при запуске.
3. Страница ивента (`/event/alice-ai`) — заглушка магазина из `deploy/frontend/event-app`: любые предметы
   ивента выдаются себе бесплатно и забираются обратно (API: `GET/POST /api/v1/aliceai/free`). Сборка кладёт её
   в `/public/events/aliceai/`; оригинальное мини-приложение итд.com можно скачать флагом `--mirror-event`.
   Пользуются предметами в обычном интерфейсе: тетрадки — кнопка «Оформление поста» в редакторе, ручка и
   корректор — в меню поста, наклейки, шарики, подушка и портфель — на баннере чужого профиля, кликуха и
   картинка клана — в настройках, пин — в профиле; звонок звенит у всех онлайн в момент выдачи.
4. В конфиге nginx нужен блок для мини-приложения (он есть в `deploy/nginx/itd.conf`, в Caddyfile тоже):

   ```nginx
   location ~ ^/public/events/([^/]+)/ {
       try_files $uri /public/events/$1/index.html =404;
       add_header Cache-Control "no-cache";
   }
   ```

Проверка: `curl -s https://ВАШ.ДОМЕН/api/v1/portal` → `{"active":true,...,"url":"/public/events/aliceai/"}`,
в меню появляется «Ивент», `/event/alice-ai` открывает мини-приложение во фрейме.

## Обновление

```bash
cd /opt/itd-backend
sudo -u itd git pull
sudo -u itd -H bun install --production --frozen-lockfile
sudo -u itd deploy/telegram-bot/.venv/bin/pip install -r deploy/telegram-bot/requirements.txt
sudo systemctl restart itd-backend itd-bot
```

Миграции применяются при старте backend. Веб-клиент: `cd /opt/itd-frontend && sudo -u itd git pull`,
затем команда из шага 6; файлы подменяются в конце сборки, перезапускать Caddy не нужно.

## Ветка openitd в itd-frontend

Правки веб-клиента хранятся в `deploy/frontend/patches.ts` и применяются при сборке, поэтому
подходит и `main` itd-frontend. Чтобы правки были видны и в самом itd-frontend (в `raw/` и `decompiled/`):

```bash
cd itd-frontend
git checkout -b openitd          # позже: git checkout openitd && git merge -X theirs main
bun ../itd-backend/deploy/frontend/patch-source.ts --source .
git commit -am "openitd: Telegram sign-in, no captcha" && git push -u origin openitd
```

Повторный запуск безопасен: уже применённые правки пропускаются.

## Локальный запуск (для проверки на своём компьютере)

Нужны Bun, PostgreSQL с `pg_trgm` и Redis.

```bash
cd itd-backend
bun install
cp .env.example .env            # DEV_EXPOSE_OTP=true: код приходит прямо в ответе API и в лог
bun run db:migrate && bun run db:seed
bun run dev                     # backend на http://localhost:3000, Swagger: /swagger

bun deploy/frontend/build.ts --source ../itd-frontend
BACKEND_URL=http://localhost:3000 PORT=8080 bun deploy/frontend/serve.ts   # сайт: http://localhost:8080
```

Без бота «нажмите Старт» вручную: `redis-cli hset itd:tg:chats ваш_ник 1`, код смотрите в логе backend
(`telegram message queued`). С ботом: заполните `deploy/telegram-bot/.env` и запустите
`deploy/telegram-bot/.venv/bin/python deploy/telegram-bot/bot.py`.

## Резервные копии

```bash
sudo -u postgres pg_dump itd | gzip > itd-$(date +%F).sql.gz        # база
sudo tar czf uploads-$(date +%F).tgz -C /opt/itd-backend uploads    # загруженные файлы
```

Восстановление базы: `gunzip -c itd-ДАТА.sql.gz | sudo -u postgres psql itd`.

## Ограничения

- магазин убран из веб-клиента (это фрейм с магазином самого ИТД); «Статус серверов» ведёт на статус.итд.com;
- подписки «НУКСТА» нет: видео и аватарки-картинки доступны всем, кнопки подписки убраны из веб-клиента;
- картинки эмодзи веб-клиент берёт с cdn.jsdelivr.net (как и оригинал);
- если itd-frontend отстанет от сайта и API поменяется, клиент и backend могут разойтись — обновите
  itd-frontend и пересоберите.

Веб-клиент, название и символика ИТД принадлежат их правообладателю; для публичного проекта
стоит заменить брендинг.
