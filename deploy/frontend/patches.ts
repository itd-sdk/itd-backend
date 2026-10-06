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
    {
      // "@" is a fixed prefix on the left (like Flutter's prefixIcon): it cannot be erased, and a typed one is dropped
      name: 'login field: @ prefix',
      find: /(\w+)\("input",\{type:"text",autoComplete:"username",autoCapitalize:"off",spellcheck:false,className:(`[^`]*`),value:([\w$]+),onInput:([\w$]+=>\{[^}]*\}),placeholder:"@username",disabled:([\w$]+)\}\)/g,
      replace: (_, h, cls, value, onInput, disabled) =>
        `${h}("div",{style:{position:"relative"},children:[` +
        `${h}("span",{"aria-hidden":"true",style:{position:"absolute",left:17,top:"50%",transform:"translateY(-50%)",fontSize:16,lineHeight:1,color:"var(--text-secondary)",pointerEvents:"none"},children:"@"}),` +
        `${h}("input",{type:"text",autoComplete:"username",autoCapitalize:"off",spellcheck:false,className:${cls},style:{paddingLeft:35},value:${value},` +
        `onInput:ev=>{ev.target.value=ev.target.value.replace(/^@+/,"");(${onInput})(ev)},placeholder:"username",disabled:${disabled}})]})`,
      done: /placeholder:"username",disabled:/
    },
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
      // a double click on Windows selects the word with the space after it, and the red pen then refuses the
      // selection ("одно слово без пробелов") and locks its input: drop whitespace around the selection
      name: 'post tools: trim the selected word',
      find: /const ([\w$]+)=([\w$]+)\.toString\(\)\.length,([\w$]+)=([\w$]+)\.toString\(\),([\w$]+)=\1\+\3\.length;if\(([\w$]+)\.slice\(\1,\5\)!==\3\)return;/g,
      replace: (_, start, prefix, text, range, end, source) =>
        `let ${start}=${prefix}.toString().length,${text}=${range}.toString();${start}+=${text}.length-${text}.trimStart().length;${text}=${text}.trim();` +
        `const ${end}=${start}+${text}.length;if(!${text}||${source}.slice(${start},${end})!==${text})return;`,
      done: /\.trimStart\(\)\.length;[\w$]+=[\w$]+\.trim\(\);const [\w$]+=/
    },
    {
      // banners could only be drawn: a picture from disk goes through the same save as a drawn one (data URL)
      name: 'profile: upload a banner picture',
      find: /(([\w$]+)\("button",\{className:([\w$.]+),onClick:[\w$]+,title:"Нарисовать баннер",children:[\w$]+\([\w$]+,\{size:20\}\)\}\))([\s\S]{0,1200}?onSave:([\w$]+),mode:"banner")/g,
      replace: (_, drawButton, h, buttonClass, rest, save) =>
        `${drawButton},${h}("label",{className:${buttonClass},title:"Загрузить баннер",style:{cursor:"pointer"},children:[` +
        `${h}("svg",{width:20,height:20,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round",children:[` +
        `${h}("path",{d:"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"}),${h}("path",{d:"M17 8l-5-5-5 5"}),${h}("path",{d:"M12 3v12"})]}),` +
        `${h}("input",{type:"file",accept:"image/*",style:{display:"none"},onChange:ev=>{const f=ev.target.files&&ev.target.files[0];ev.target.value="";` +
        `if(!f)return;const r=new FileReader;r.onload=()=>{Promise.resolve(${save}(r.result)).catch(()=>{})};r.readAsDataURL(f)}})]})${rest}`,
      done: /title:"Загрузить баннер"/
    },
    {
      // no ITD copyright and legal documents: the page about this copy, the project's channel and its author instead
      name: 'sidebar: project links instead of legal ones',
      find: /([\w$]+)\("ul",\{className:([\w$]+)\.legalLinks,children:\[\1\("li",\{children:\1\("a",\{href:"https:\/\/статус\.итд\.com"[\s\S]*?children:"Политика Cookies"\}\)\}\)\]\}\),\1\("span",\{className:\2\.copyright,children:"© 2026 ООО «ИТД»"\}\)/g,
      replace: (_, h, c) => {
        const link = (href: string, text: string) => `${h}("li",{children:${h}("a",{href:"${href}",target:"_blank",rel:"noopener noreferrer",children:"${text}"})})`
        return (
          `${h}("ul",{className:${c}.legalLinks,children:[${h}("li",{children:${h}("a",{href:"/privacy",children:"О проекте"})}),` +
          `${link('https://t.me/openitd', 'Telegram проекта')}]})`
        )
      },
      done: /children:"О проекте"\}\)\}\),[\w$]+\("li",\{children:[\w$]+\("a",\{href:"https:\/\/t\.me\/openitd"/
    },
    {
      name: 'sign-up: no terms of use',
      find: /children:\["Продолжая, вы соглашаетесь с"," ",([\w$]+)\("a",\{href:"\/terms",target:"_blank",rel:"noopener noreferrer",children:"условиями использования"\}\)," и"," ",\1\("a",\{href:"\/privacy",target:"_blank",rel:"noopener noreferrer",children:"политикой конфиденциальности"\}\)\]/g,
      replace: (_, h) =>
        `children:["Это неофициальная копия для тестов. Продолжая, вы подтверждаете, что ознакомились с"," ",${h}("a",{href:"/privacy",target:"_blank",rel:"noopener noreferrer",children:"информацией о сайте"})]`,
      done: /"информацией о сайте"/
    },
    {
      name: 'privacy page: about this copy',
      find: /(([\w$]+)\("h1",\{className:([\w$]+)\.title,children:)"Политика конфиденциальности"\}\),[\s\S]*?children:"privacy@itd\.fun"\}\)\]\}\)\]\}\)/g,
      replace: (_, h1, h, c) => {
        const section = (title: string, ...paragraphs: string[]) =>
          `${h}("section",{className:${c}.section,children:[${h}("h2",{className:${c}.sectionTitle,children:${JSON.stringify(title)}}),` +
          paragraphs.map((text) => `${h}("p",{className:${c}.text,children:${text.startsWith('[') ? text : JSON.stringify(text)}})`).join(',') +
          ']})'
        const tg = (name: string) => `${h}("a",{href:"https://t.me/${name}",target:"_blank",rel:"noopener noreferrer",className:${c}.contact,children:"@${name}"})`
        return (
          `${h1}"Политика конфиденциальности"}),${h}("p",{className:${c}.updated,children:"Последнее обновление: 6 октября 2026"}),` +
          [
            section(
              '1. Общие положения',
              'Настоящий сайт (далее — «Сайт») является неофициальной копией социальной сети «итд». Сайт не связан с ООО «ИТД», не одобрен им и не поддерживается им.'
            ),
            section(
              '2. Права на объекты интеллектуальной собственности',
              'Все права на дизайн, интерфейс, наименования, логотипы, графические материалы и иные объекты интеллектуальной собственности социальной сети «итд» принадлежат ООО «ИТД». Администрация Сайта не претендует на указанные права.'
            ),
            section(
              '3. Назначение Сайта',
              'Сайт предназначен исключительно для тестирования и экспериментов. Сайт не является средством связи и не может использоваться для общения, а также для передачи личной или иной значимой информации.'
            ),
            section(
              '4. Ограничение ответственности',
              'Сайт предоставляется «как есть». Администрация не гарантирует бесперебойную работу Сайта и не несёт ответственности за сохранность аккаунтов, публикаций, комментариев, файлов и иных данных, а также за их утрату, изменение или раскрытие. Любые данные могут быть удалены в любой момент без предварительного уведомления.'
            ),
            section(
              '5. Данные пользователей',
              'Для работы Сайта хранятся ник в Telegram, хэш пароля, опубликованные материалы и технические сведения о сессиях (IP-адрес, сведения об устройстве). Не размещайте на Сайте персональные данные и сведения, утрата или раскрытие которых для вас нежелательны.'
            ),
            section(
              '6. Сведения о разработке',
              'Серверная часть (бэкенд) Сайта сгенерирована с помощью искусственного интеллекта. Клиентская часть (фронтенд) Сайта представляет собой декомпилированный бандл, полученный с сайта оригинальной социальной сети.'
            ),
            section(
              '7. Контактная информация',
              `["Канал проекта в Telegram: ",${tg('openitd')},"."]`,
              `["Связь с автором: ",${tg('nwokez')},"."]`
            )
          ].join(',')
        )
      },
      done: /"Серверная часть \(бэкенд\) Сайта сгенерирована с помощью искусственного интеллекта\."/
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
