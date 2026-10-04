"""Telegram bot for openitd.

/start remembers which chat belongs to a Telegram username; the backend then queues one-time codes
in Redis and this bot delivers them. Contract (shared REDIS_URL / REDIS_PREFIX with the backend):
  <prefix>tg:chats      hash  username (lowercase, no @) -> chat id
  <prefix>tg:usernames  hash  chat id -> username
  <prefix>tg:outbox     list  JSON {"chatId", "text", "expiresAt"} (ms), RPUSH by the backend
"""
import asyncio
import json
import logging
import os
import time

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ChatType, ParseMode
from aiogram.exceptions import TelegramBadRequest, TelegramForbiddenError, TelegramNetworkError, TelegramRetryAfter
from aiogram.filters import CommandStart
from aiogram.types import Message
from redis.asyncio import Redis

BOT_TOKEN = os.environ['BOT_TOKEN']
REDIS_URL = os.getenv('REDIS_URL', 'redis://localhost:6379')
PREFIX = os.getenv('REDIS_PREFIX', 'itd:')
SITE_URL = os.getenv('SITE_URL', '').rstrip('/')

CHATS = f'{PREFIX}tg:chats'
USERNAMES = f'{PREFIX}tg:usernames'
OUTBOX = f'{PREFIX}tg:outbox'

log = logging.getLogger('openitd-bot')
redis = Redis.from_url(REDIS_URL, decode_responses=True)
dp = Dispatcher()

NO_USERNAME = (
    'У вашего аккаунта Telegram нет имени пользователя (@username).\n\n'
    'Задайте его в настройках Telegram, затем снова нажмите /start и укажите этот ник на сайте.'
)


async def link(message: Message) -> str | None:
    """Remembers the chat of the sender; returns the username or None when there is none."""
    user = message.from_user
    if user is None or message.chat.type != ChatType.PRIVATE or not user.username:
        return None
    username = user.username.lower()
    chat_id = str(message.chat.id)
    previous = await redis.hget(USERNAMES, chat_id)
    # the old username may already belong to someone else: drop it only if it still points here
    if previous and previous != username and await redis.hget(CHATS, previous) == chat_id:
        await redis.hdel(CHATS, previous)
    await redis.hset(CHATS, username, chat_id)
    await redis.hset(USERNAMES, chat_id, username)
    return username


def site() -> str:
    return f' {SITE_URL}' if SITE_URL else ''


@dp.message(CommandStart())
async def on_start(message: Message) -> None:
    username = await link(message)
    if username is None:
        await message.answer(NO_USERNAME)
        return
    await message.answer(
        f'Готово! Telegram <b>@{username}</b> подключён.\n\n'
        f'Вернитесь на сайт{site()} и укажите ник <b>@{username}</b> — '
        'коды для регистрации и входа будут приходить сюда.'
    )


@dp.message()
async def on_message(message: Message) -> None:
    username = await link(message)
    if username is None:
        await message.answer(NO_USERNAME)
        return
    await message.answer(f'Я присылаю коды для входа в ИТД{site()}. Ваш ник для сайта: <b>@{username}</b>.')


async def deliver(bot: Bot) -> None:
    """Sends the codes queued by the backend."""
    while True:
        try:
            item = await redis.blpop([OUTBOX], timeout=5)
        except Exception:
            log.exception('redis is unavailable')
            await asyncio.sleep(3)
            continue
        if not item:
            continue
        raw = item[1]
        try:
            payload = json.loads(raw)
            chat_id, text = int(payload['chatId']), str(payload['text'])
        except (ValueError, KeyError, TypeError):
            log.error('malformed outbox item: %r', raw)
            continue
        if payload.get('expiresAt', 0) < time.time() * 1000:
            log.info('skipping an expired message for %s', chat_id)
            continue
        try:
            await bot.send_message(chat_id, text)
        except TelegramRetryAfter as error:
            await asyncio.sleep(error.retry_after)
            await redis.lpush(OUTBOX, raw)
        except TelegramNetworkError:
            log.warning('telegram is unreachable, retrying')
            await asyncio.sleep(3)
            await redis.lpush(OUTBOX, raw)
        except TelegramForbiddenError:
            # the user blocked the bot: forget the chat until they press /start again
            log.info('chat %s blocked the bot', chat_id)
            username = await redis.hget(USERNAMES, str(chat_id))
            if username and await redis.hget(CHATS, username) == str(chat_id):
                await redis.hdel(CHATS, username)
        except TelegramBadRequest as error:
            log.error('cannot send to %s: %s', chat_id, error)


async def main() -> None:
    logging.basicConfig(level=os.getenv('LOG_LEVEL', 'INFO'), format='%(asctime)s %(levelname)s %(name)s: %(message)s')
    bot = Bot(BOT_TOKEN, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    worker = asyncio.create_task(deliver(bot))
    try:
        await dp.start_polling(bot)
    finally:
        worker.cancel()
        await redis.aclose()
        await bot.session.close()


if __name__ == '__main__':
    asyncio.run(main())
