/**
 * openitd changes to the official web client: a Telegram username instead of an email on sign-up, sign-in
 * and password recovery, hints about the bot that sends the codes, no captcha step.
 *
 * Every patch is idempotent: it counts as applied when the original code matches (and gets replaced) or
 * when the patched code is already there, so the same list works on itd-frontend `main` and `openitd`.
 */

export type Patch = {
  name: string
  find: RegExp
  replace: (...m: string[]) => string
  // present once the patch is applied
  done: RegExp
}

const DEFAULT_BOT = 'openitd_bot'

export function openitdPatches(botUsername = DEFAULT_BOT): Patch[] {
  const bot = botUsername.trim().replace(/^@/, '')
  const link = (h: string) => `${h}("a",{href:"https://t.me/${bot}",target:"_blank",rel:"noopener noreferrer",children:"@${bot}"})`
  const text = (from: string, to: string, name: string): Patch => ({
    name,
    find: new RegExp(`"${from}"`, 'g'),
    replace: () => `"${to}"`,
    done: new RegExp(`"${to}"`)
  })
  return [
    {
      name: 'login field: Telegram instead of E-Mail',
      find: /children:"E-Mail"\}\),(\w+)\("input",\{type:"email"/g,
      replace: (_, h) => `children:"Telegram"}),${h}("input",{type:"text",autoComplete:"username",autoCapitalize:"off",spellcheck:false`,
      done: /children:"Telegram"\}\),\w+\("input",\{type:"text",autoComplete:"username"/
    },
    text('ilya@gmail\\.com', '@username', 'login placeholder'),
    text('Введите email', 'Введите ник в Telegram', 'empty login message'),
    text('Этот email уже зарегистрирован', 'Этот Telegram уже зарегистрирован', 'taken login message'),
    text('Неверный email или пароль', 'Неверный ник Telegram или пароль', 'invalid credentials message'),
    text('Аккаунт с таким email не найден', 'Аккаунт с таким Telegram не найден', 'unknown account message'),
    text('Введите корректный email', 'Введите корректный ник Telegram', 'invalid login message'),
    text('Код с почты', 'Код из Telegram', 'code input label'),
    {
      name: 'sign-up: open the bot first',
      find: /(\w+)\("h1",\{className:(\w+)\.title,children:"Создание аккаунта"\}\),\1\("p",\{className:\2\.subtitle,children:"Пожалуйста, введите ваши данные"\}\)/g,
      replace: (_, h, c) =>
        `${h}("h1",{className:${c}.title,children:"Создание аккаунта"}),${h}("p",{className:${c}.subtitle,children:["Сначала откройте Telegram-бота ",${link(h!)}," и нажмите «Старт» — туда придёт код подтверждения. Затем укажите ваш ник в Telegram и придумайте пароль."]})`,
      done: /"Сначала откройте Telegram-бота "/
    },
    {
      name: 'sign-in: the code comes from the bot',
      find: /(\w+)\("h1",\{className:(\w+)\.title,children:"Вход"\}\),\1\("p",\{className:\2\.subtitle,children:"Пожалуйста, введите ваши данные"\}\)/g,
      replace: (_, h, c) =>
        `${h}("h1",{className:${c}.title,children:"Вход"}),${h}("p",{className:${c}.subtitle,children:["Введите ник в Telegram и пароль. Код для входа пришлёт бот ",${link(h!)},"."]})`,
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
      find: /children:\["Мы отправили шестизначный код на почту ",(\w+),", чтобы убедиться, что вы – настоящий её владелец\."\]/g,
      replace: (_, v) => `children:["Мы отправили шестизначный код в Telegram-бот @${bot} для ",${v},"."]`,
      done: /children:\["Мы отправили шестизначный код в Telegram-бот @\w+ для ",\w+,"\."\]/
    },
    {
      name: 'recovery code screen: sent to the bot',
      find: /children:\["Мы отправили шестизначный код на ",(\w+)\]/g,
      replace: (_, v) => `children:["Мы отправили шестизначный код в Telegram-бот @${bot} для ",${v}]`,
      done: /children:\["Мы отправили шестизначный код в Telegram-бот @\w+ для ",\w+\]/
    },
    {
      // the form opens the captcha modal and submits from its callback: submit right away instead
      name: 'skip the captcha step',
      find: /return\}(\w+)\(!0\)\},(\w+)=(\w+)\(async (\w+)=>\{\1\(!1\)/g,
      replace: (_, open, submit, hook, arg) => `return}${submit}(void 0)},${submit}=${hook}(async ${arg}=>{${open}(!1)`,
      done: /return\}(\w+)\(void 0\)\},\1=\w+\(async \w+=>\{/
    },
    {
      // the shop is a frame with ITD's own store: removed from both menus and the router
      name: 'shop: desktop menu item',
      find: /[\w$]+\([\w$]+,\{href:"\/shop",icon:[\w$]+\([\w$]+,\{\}\),badge:[\w$]+,children:"Магаз"\}\),/g,
      replace: () => '',
      done: /children:"Поиск"\}\),\([\w$]+\.active/
    },
    {
      name: 'shop: mobile menu item',
      find: /\{id:"shop",label:"Магаз",icon:[\w$]+,href:"\/shop"\},/g,
      replace: () => '',
      done: /\{id:"feed",label:"Лента",icon:[\w$]+,href:"\/"\},\.\.\./
    },
    {
      name: 'shop: route',
      find: /,[\w$]+\([\w$]+,\{path:"\/shop\/:rest\*"\}\)/g,
      replace: () => '',
      done: /\{path:"\/search"\}\),[\w$]+\([\w$]+,\{path:"\/event\//
    },
    {
      // there is no НУКСТА subscription: its buttons and the payment settings go away
      name: 'nuksta: sidebar button',
      find: /![\w$]+\?\.subscription\?\.isActive&&[\w$]+\("button",\{className:[\w$.]+,onClick:\(\)=>[\w$]+\(!0\),children:\[[\w$]+\("span",\{children:"⭐"\}\),[\w$]+\("span",\{children:"ИТД НУКСТА"\}\)\]\}\),/g,
      replace: () => '',
      done: /children:\[[\w$]+\("button",\{className:[\w$.]+,onClick:[\w$]+,children:\[[\w$]+\([\w$]+,\{size:20\}\),[\w$]+\("span",\{children:"Выйти"\}\)/
    },
    {
      name: 'nuksta: profile button',
      find: /,![\w$]+&&[\w$]+\([\w$]+,\{variant:"secondary",onClick:\(\)=>[\w$]+\(!0\),fullWidth:[\w$]+,children:"ИТД НУКСТА"\}\)/g,
      replace: () => '',
      done: /children:"Редактировать"\}\)\]\}\)/
    },
    {
      name: 'nuksta: payment settings tab',
      find: /\{id:"payment",icon:[\w$]+,label:"Оплата",color:"#34c759"\},/g,
      replace: () => '',
      done: /\[\{id:"account",icon:[\w$]+,label:"Аккаунт",color:"#3b82f6"\},\{id:"appearance"/
    },
    {
      // icons were requested with cache:"force-cache" for 30 minutes, so a failed (404) response stuck in the
      // browser and Ctrl+F5 did not help; revalidate instead (4 small requests, usually 304)
      name: 'icons: revalidate the browser cache',
      find: /([\w$]+)\?"no-cache":"force-cache"/g,
      replace: () => '"no-cache"',
      done: /const ([\w$]+)=[\w$]+\?"reload":"no-cache",[\w$]+=fetch\(/
    },
    {
      // a source patched for another bot
      name: 'bot username',
      find: new RegExp(`(t\\.me/|@)(?!${bot}\\b)\\w+_bot\\b(?=[" ])`, 'g'),
      replace: (_, prefix) => `${prefix}${bot}`,
      done: new RegExp(`t\\.me/${bot}"`)
    }
  ]
}

export type PatchCounts = Record<string, number>

/** Applies the patches to one file; counts replacements and already-patched occurrences per patch */
export function applyPatches(code: string, patches: Patch[], counts: PatchCounts) {
  let result = code
  for (const patch of patches) {
    counts[patch.name] ??= 0
    // fresh RegExp objects: global regexes keep lastIndex between calls
    result = result.replace(new RegExp(patch.find.source, patch.find.flags), (...m: string[]) => {
      counts[patch.name]!++
      return patch.replace(...m)
    })
    if (counts[patch.name] === 0 && new RegExp(patch.done.source, patch.done.flags).test(result)) counts[patch.name] = 1
  }
  return result
}

export function missingPatches(patches: Patch[], counts: PatchCounts) {
  return patches.filter((p) => !counts[p.name]).map((p) => p.name)
}
