# Развёртывание openitd на сервере

Схема: **Caddy** (HTTPS, статика веб-клиента, прокси `/api` и `/uploads`) → **backend** (Bun, systemd)
+ **Telegram-бот** (Python/aiogram, systemd) + **PostgreSQL** + **Redis**. Всё ставится прямо на сервер,
без Docker.

Как работает вход: пользователь открывает бота, нажимает «Старт» (бот запоминает чат его ника),
на сайте вводит ник в Telegram и пароль, бэкенд кладёт код в Redis (`tg:outbox`), бот присылает его
в Telegram. Код нужен при регистрации, при каждом входе (`LOGIN_CODE=true`) и при сбросе пароля.

Ниже команды для Ubuntu 24.04 / Debian 12; домен `itd.example.com` замените своим.

## 1. Что нужно

- VPS: 1–2 vCPU, 2 ГБ RAM, 10+ ГБ диска; открыты порты 80 и 443;
- домен с A/AAAA-записью на IP сервера;
- бот: в [@BotFather](https://t.me/BotFather) → `/newbot` → получите токен. Если ник бота не
  `openitd_bot`, укажите его в `TELEGRAM_BOT` (backend) и в `--telegram-bot` при сборке фронта;
- доступ к итд.com с сервера или с вашей машины — для сборки веб-клиента (шаг 6).

## 2. Пакеты

```bash
sudo apt update
sudo apt install -y git curl unzip gnupg postgresql postgresql-contrib redis-server python3-venv

# Caddy из официального репозитория (нужен 2.8+, в apt дистрибутива версия старее)
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

# Bun в /usr/local/bin (путь используется в systemd-юните)
curl -fsSL https://bun.sh/install | sudo BUN_INSTALL=/usr/local bash

# Redis хранит привязки «ник → чат» бота: включите AOF, чтобы они переживали перезапуск
sudo sed -i 's/^appendonly no/appendonly yes/' /etc/redis/redis.conf && sudo systemctl restart redis-server
```

## 3. Код и база

```bash
sudo useradd --system --create-home --home-dir /var/lib/itd --shell /usr/sbin/nologin itd
sudo git clone -b openitd https://github.com/itd-sdk/itd-backend /opt/itd-backend
sudo chown -R itd:itd /opt/itd-backend
cd /opt/itd-backend
sudo -u itd -H bun install --production --frozen-lockfile

DB_PASSWORD=$(openssl rand -hex 16); echo "$DB_PASSWORD"
sudo -u postgres psql -c "CREATE USER itd WITH PASSWORD '$DB_PASSWORD'"
sudo -u postgres psql -c "CREATE DATABASE itd OWNER itd"
sudo -u postgres psql -d itd -c "CREATE EXTENSION IF NOT EXISTS pg_trgm"
```

## 4. Настройки backend

```bash
sudo -u itd cp .env.example .env && sudo chmod 600 .env && sudo -u itd nano .env
```

Поменяйте:

```ini
NODE_ENV=production
HOST=127.0.0.1
PUBLIC_URL=https://itd.example.com
TRUST_PROXY=true
DATABASE_URL=postgres://itd:<DB_PASSWORD>@localhost:5432/itd
# openssl rand -hex 32
JWT_SECRET=
COOKIE_SECURE=true
DEV_EXPOSE_OTP=false
TELEGRAM_BOT=openitd_bot
# администратор: ваш ник в Telegram; перед первым входом нажмите «Старт» в боте
ADMIN_TELEGRAM=
ADMIN_PASSWORD=
```

## 5. Telegram-бот

```bash
cd /opt/itd-backend/deploy/telegram-bot
sudo -u itd python3 -m venv .venv
sudo -u itd .venv/bin/pip install -r requirements.txt
sudo -u itd cp .env.example .env && sudo chmod 600 .env && sudo -u itd nano .env   # BOT_TOKEN, SITE_URL
```

`REDIS_URL` и `REDIS_PREFIX` у бота и backend должны совпадать.

## 6. Веб-клиент

Скрипт берёт JS/CSS из [itd-frontend](https://github.com/itd-sdk/itd-frontend), докачивает с итд.com
то, чего в нём нет (index.html, стили, данные эмодзи, часть экранов, картинки и звуки, файлы CDN),
убирает Sentry и трекеры и вносит правки openitd: поле «Telegram» вместо e-mail, подсказку про бота,
вход без капчи. Если какая-то правка не применилась (бандл изменился), сборка останавливается.

```bash
sudo git clone https://github.com/itd-sdk/itd-frontend /opt/itd-frontend
cd /opt/itd-backend
sudo -u itd bun deploy/frontend/build.ts --source /opt/itd-frontend --telegram-bot openitd_bot
```

Результат — `deploy/frontend/dist` (в `build-info.json` список правок и предупреждений).
Итд.com закрыт DDoS-Guard; если с сервера он не открывается, соберите на своей машине и скопируйте:
`rsync -a deploy/frontend/dist/ server:/opt/itd-backend/deploy/frontend/dist/`.
Режим `--offline` годится только для проверки: без данных эмодзи не пройти онбординг.

## 7. Запуск

```bash
sudo cp /opt/itd-backend/deploy/systemd/itd-backend.service /opt/itd-backend/deploy/systemd/itd-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now itd-backend itd-bot

sudo cp /opt/itd-backend/deploy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/itd.example.com/ВАШ.ДОМЕН/' /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy сам получит сертификат. Проверка: `curl https://ВАШ.ДОМЕН/health`, логи —
`journalctl -u itd-backend -f`, `journalctl -u itd-bot -f`, `journalctl -u caddy -f`.
Backend при каждом старте применяет миграции и сид (пины, ченджлог, администратор).

## Обновление

```bash
cd /opt/itd-backend
sudo -u itd git pull
sudo -u itd -H bun install --production --frozen-lockfile
sudo -u itd deploy/telegram-bot/.venv/bin/pip install -r deploy/telegram-bot/requirements.txt
sudo systemctl restart itd-backend itd-bot
```

Веб-клиент пересобирается той же командой из шага 6; файлы подменяются в конце сборки,
перезапуск Caddy не нужен.

## Резервные копии

```bash
sudo -u postgres pg_dump itd | gzip > itd-$(date +%F).sql.gz        # база
sudo tar czf uploads-$(date +%F).tgz -C /opt/itd-backend uploads    # загруженные файлы
```

Восстановление базы: `gunzip -c itd-ДАТА.sql.gz | sudo -u postgres psql itd`.

## Ограничения

- магазин и страницы ивента грузятся с итд.com во фрейме, «Статус серверов» ведёт на статус.итд.com;
- оплата «НУКСТА» — тестовая заглушка;
- картинки эмодзи веб-клиент берёт с cdn.jsdelivr.net (как и оригинал);
- если itd-frontend отстанет от сайта и API поменяется, клиент и backend могут разойтись — тогда
  обновите itd-frontend и пересоберите.

Веб-клиент, название и символика ИТД принадлежат их правообладателю; для публичного проекта
стоит заменить брендинг.
