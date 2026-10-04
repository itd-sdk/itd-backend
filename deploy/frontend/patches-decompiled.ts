/**
 * The same openitd changes as ./patches.ts for itd-frontend/decompiled (the readable copy of the bundle).
 * Nothing is built from it; it keeps the decompiled sources in sync with the patched bundle.
 */
import type { Patch } from './patches'

export function decompiledPatches(botUsername = 'openitd_bot'): Patch[] {
  const bot = botUsername.trim().replace(/^@/, '')
  const link = (h: string) => `${h}("a", { href: "https://t.me/${bot}", target: "_blank", rel: "noopener noreferrer", children: "@${bot}" })`
  const text = (from: string, to: string, name: string): Patch => ({
    name,
    find: new RegExp(`"${from}"`, 'g'),
    replace: () => `"${to}"`,
    done: new RegExp(`"${to}"`)
  })
  return [
    text('E-Mail', 'Telegram', 'login field label'),
    {
      name: 'login field type',
      find: /(\n\s*)type: "email",/g,
      replace: (_, indent) => `${indent}type: "text",${indent}autoComplete: "username",`,
      done: /type: "text",\s*autoComplete: "username",/
    },
    text('ilya@gmail\\.com', '@username', 'login placeholder'),
    text('Введите email', 'Введите ник в Telegram', 'empty login message'),
    text('Этот email уже зарегистрирован', 'Этот Telegram уже зарегистрирован', 'taken login message'),
    text('Неверный email или пароль', 'Неверный ник Telegram или пароль', 'invalid credentials message'),
    text('Введите корректный email', 'Введите корректный ник Telegram', 'invalid login message'),
    text('Код с почты', 'Код из Telegram', 'code input label'),
    {
      name: 'sign-up: open the bot first',
      find: /("Создание аккаунта",?\s*\}\),\s*(\w+)\("p", \{\s*className: \w+\.subtitle,\s*children: )"Пожалуйста, введите ваши данные"/g,
      replace: (_, head, h) =>
        `${head}[\n"Сначала откройте Telegram-бота ",\n${link(h)},\n" и нажмите «Старт» — туда придёт код подтверждения. Затем укажите ваш ник в Telegram и придумайте пароль.",\n]`,
      done: /"Сначала откройте Telegram-бота "/
    },
    {
      name: 'sign-in: the code comes from the bot',
      find: /("Вход",?\s*\}\),\s*(\w+)\("p", \{\s*className: \w+\.subtitle,\s*children: )"Пожалуйста, введите ваши данные"/g,
      replace: (_, head, h) => `${head}[\n"Введите ник в Telegram и пароль. Код для входа пришлёт бот ",\n${link(h)},\n".",\n]`,
      done: /"Введите ник в Telegram и пароль\. Код для входа пришлёт бот "/
    },
    {
      name: 'password recovery subtitle',
      find: /"Введите ваш E-Mail для восстановления"/g,
      replace: () => `"Введите ваш ник в Telegram — код придёт в бот @${bot}"`,
      done: /"Введите ваш ник в Telegram — код придёт в бот @/
    },
    {
      name: 'code screen: sent to the bot',
      find: /"Мы отправили шестизначный код на почту ",(\s*)(\w+),(\s*)", чтобы убедиться, что вы – настоящий её владелец\.",/g,
      replace: (_, a, v, b) => `"Мы отправили шестизначный код в Telegram-бот @${bot} для ",${a}${v},${b}".",`,
      done: /"Мы отправили шестизначный код в Telegram-бот @\w+ для ",\s*\w+,\s*"\.",/
    },
    {
      name: 'recovery code screen: sent to the bot',
      find: /\["Мы отправили шестизначный код на ", (\w+)\]/g,
      replace: (_, v) => `["Мы отправили шестизначный код в Telegram-бот @${bot} для ", ${v}]`,
      done: /\["Мы отправили шестизначный код в Telegram-бот @\w+ для ", \w+\]/
    },
    {
      // the form opened the captcha modal and submitted from its callback: submit right away instead
      name: 'skip the captcha step',
      find: /(\n\s*)(\w+)\(true\);(\n\s*\};\n\n\s*const (\w+) = \w+\(\n\s*async \(\w+\) => \{\n\s*)\2\(false\);/g,
      replace: (_, indent, open, middle, submit) => `${indent}${submit}(undefined);${middle}${open}(false);`,
      done: /(\w+)\(undefined\);\n\s*\};\n\n\s*const \1 = /
    },
    {
      name: 'icons: revalidate the browser cache',
      find: /([\w$]+) \? "no-cache" : "force-cache"/g,
      replace: () => '"no-cache"',
      done: /\? "reload"\s*: "no-cache"[,;]/
    },
    {
      name: 'bot username',
      find: new RegExp(`(t\\.me/|@)(?!${bot}\\b)\\w+_bot\\b(?=[" ])`, 'g'),
      replace: (_, prefix) => `${prefix}${bot}`,
      done: new RegExp(`t\\.me/${bot}"`)
    }
  ]
}
