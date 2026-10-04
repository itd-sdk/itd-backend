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
      name: 'shop: desktop menu item',
      find: /\n\s*[\w$]+\([\w$]+, \{\s*href: "\/shop",\s*icon: [\w$]+\([\w$]+, \{\}\),\s*badge: [\w$]+,\s*children: "Магаз",\s*\}\),/g,
      replace: () => '',
      done: /children: "Поиск",?\s*\}\),\s*\(\([\w$]+\.active/
    },
    {
      name: 'shop: mobile menu item',
      find: /\n\s*\{ id: "shop", label: "Магаз", icon: [\w$]+, href: "\/shop" \},/g,
      replace: () => '',
      done: /\{ id: "feed", label: "Лента", icon: [\w$]+, href: "\/" \},\s*\.\.\./
    },
    {
      name: 'shop: route',
      find: /\n\s*[\w$]+\([\w$]+, \{ path: "\/shop\/:rest\*" \}\),/g,
      replace: () => '',
      done: /\{ path: "\/search" \}\),\s*[\w$]+\([\w$]+, \{\s*path: "\/event\//
    },
    {
      name: 'nuksta: sidebar button',
      find: /\n\s*![\w$]+\?\.subscription\?\.isActive &&\s*[\w$]+\("button", \{\s*className: [\w$.]+,\s*onClick: \(\) => [\w$]+\(true\),\s*children: \[\s*[\w$]+\("span", \{ children: "⭐" \}\),\s*[\w$]+\("span", \{ children: "ИТД НУКСТА" \}\),\s*\],\s*\}\),/g,
      replace: () => '',
      done: /className: [\w$]+\.asideBottom,\s*children: [\w$]+\s*\?\s*[\w$]+\([\w$]+, \{\s*children: \[\s*[\w$]+\("button", \{\s*className: [\w$.]+,\s*onClick: [\w$]+,/
    },
    {
      name: 'nuksta: profile button',
      find: /\n\s*![\w$]+ &&\s*[\w$]+\([\w$]+, \{\s*variant: "secondary",\s*onClick: \(\) => [\w$]+\(true\),\s*fullWidth: [\w$]+,\s*children: "ИТД НУКСТА",\s*\}\),/g,
      replace: () => '',
      done: /children: "Редактировать",\s*\}\),\s*\],/
    },
    {
      name: 'nuksta: payment settings tab',
      find: /\n\s*\{ id: "payment", icon: [\w$]+, label: "Оплата", color: "#34c759" \},/g,
      replace: () => '',
      done: /\{ id: "account", icon: [\w$]+, label: "Аккаунт", color: "#3b82f6" \},\s*\{ id: "appearance"/
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
