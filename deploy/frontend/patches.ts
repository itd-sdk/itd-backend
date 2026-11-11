/**
 * openitd changes to the official web client: a Telegram username (or a phone shared with the bot) instead of an
 * email, hints about the bot that sends the codes, no captcha step, no shop or НУКСТА.
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
  const botErrors = () =>
    [
      ['PHONE_NOT_SHARED', `Сначала откройте бота @${bot} и нажмите «Поделиться номером» с этим номером.`],
      ['TELEGRAM_NOT_STARTED', `Откройте бота @${bot} с этого Telegram и нажмите «Старт».`],
      ['TELEGRAM_USERNAME_REQUIRED', `Задайте имя пользователя в настройках Telegram и отправьте боту @${bot} /start.`],
      ['INVALID_TELEGRAM', 'Проверьте ник в Telegram.'],
      ['INVALID_PHONE', 'Проверьте номер телефона.'],
      ['IDENTIFIER_TAKEN', 'Этот номер или Telegram уже привязан к другому аккаунту.']
    ]
      .map(([code, message]) => `${code}:${JSON.stringify(message)},`)
      .join('')
  const link = (h: string) => `${h}("a",{href:"https://t.me/${bot}",target:"_blank",rel:"noopener noreferrer",children:"@${bot}"})`
  const text = (from: string, to: string, name: string): Patch => ({
    name,
    find: new RegExp(`"${from}"`, 'g'),
    replace: () => `"${to}"`,
    done: new RegExp(`"${to}"`)
  })
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  // an exact piece of code (a whole string literal with its quotes, or part of a template literal)
  const swap = (from: string, to: string, name: string): Patch => ({
    name,
    find: new RegExp(escape(from), 'g'),
    replace: () => to,
    done: new RegExp(escape(to))
  })
  const say = (from: string, to: string) => swap(JSON.stringify(from), JSON.stringify(to), `text: ${from}`)
  const botLink = `@${bot}`
  const telegramSignUp = (h: string) => {
    const field = (label: string, input: string) => `${h}("label",{className:__pa.field,children:[${JSON.stringify(label)},${h}("input",${input})]})`
    return (
      `const __tgErrors={INVALID_PASSWORD:"Пароль: от 8 до 128 символов без пробелов.",INVALID_OTP:"Неверный код.",INVALID_OTP_FORMAT:"Введите код из Telegram.",` +
      `OTP_ATTEMPTS_EXCEEDED:"Слишком много попыток. Начните заново.",INVALID_FLOW_TOKEN:"Время вышло. Начните заново.",RATE_LIMIT_EXCEEDED:"Слишком много попыток. Подождите немного."};` +
      `async function __tgSubmit(ev){ev.preventDefault();const f=ev.currentTarget,el=f.elements,err=f.querySelector("[data-error]"),btn=f.querySelector("button[type=submit]");` +
      `const show=m=>{err.textContent=m||"";err.hidden=!m};show("");` +
      `const post=(path,body)=>fetch("/api/v1/auth"+path,{method:"POST",credentials:"include",headers:{"Content-Type":"application/json","X-Requested-With":"XMLHttpRequest"},body:JSON.stringify(body)})` +
      `.then(async r=>{const j=await r.json().catch(()=>({}));if(!r.ok){const e=j.error||{};throw new Error(__tgErrors[e.code]||e.message||"Не удалось выполнить запрос")}return j});` +
      `const nick=el.telegram.value.trim();btn.disabled=!0;` +
      `try{if(!f.dataset.flow){const r=await post("/sign-up",{email:nick,password:el.password.value});if(r.accessToken){location.href="/onboarding";return}` +
      `f.dataset.flow=r.flowToken;f.querySelector("[data-step=credentials]").hidden=!0;f.querySelector("[data-step=code]").hidden=!1;el.otp.focus()}` +
      `else{await post("/verify-otp",{email:nick,otp:el.otp.value.trim(),flowToken:f.dataset.flow});location.href="/onboarding"}}` +
      `catch(e){show(e.message)}finally{btn.disabled=!1}}` +
      `function __TgSignUp(){return ${h}("div",{className:__pa.card,children:[` +
      `${h}("div",{className:__pa.brand,children:${h}(__Logo,{})}),` +
      `${h}("h1",{children:"Регистрация"}),` +
      `${h}("p",{className:__pa.description,children:["Откройте бота ",${h}("a",{href:"https://t.me/${bot}",target:"_blank",rel:"noopener noreferrer",children:"@${bot}"}),` +
      `" и нажмите «Старт». Затем укажите ник в Telegram и придумайте пароль — код подтверждения придёт в бот."]}),` +
      `${h}("form",{className:__pa.form,onSubmit:__tgSubmit,children:[` +
      `${h}("div",{"data-step":"credentials",children:[` +
      field('Ник в Telegram', '{name:"telegram",placeholder:"@username",autoComplete:"username",autoCapitalize:"off",spellCheck:!1,maxLength:64,required:!0}') + ',' +
      field('Пароль', '{name:"password",type:"password",autoComplete:"new-password",minLength:8,maxLength:128,required:!0}') + ']}),' +
      `${h}("div",{"data-step":"code",hidden:!0,children:` +
      field('Код из Telegram', '{name:"otp",inputMode:"numeric",autoComplete:"one-time-code",maxLength:8}') + '}),' +
      `${h}("p",{className:__pa.error,role:"alert","data-error":!0,hidden:!0}),` +
      `${h}(__Btn,{type:"submit",fullWidth:!0,size:"lg",children:"Продолжить"})]}),` +
      `${h}("p",{className:__pa.terms,children:["Номер телефона необязателен. ",${h}("a",{href:"/register?phone",children:"Зарегистрироваться по номеру"})]}),` +
      `${h}("p",{className:__pa.terms,children:["Есть аккаунт? ",${h}("a",{href:"/login",children:"Войти"})]}),` +
      `${h}("p",{className:__pa.terms,children:["Регистрируясь, вы подтверждаете, что прочитали ",${h}("a",{href:"/privacy",target:"_blank",rel:"noopener noreferrer",children:"информацию о проекте"}),"."]})` +
      `]})}`
    )
  }
  return [
    {
      name: 'login field: Telegram instead of E-Mail',
      find: /children:"E-Mail"\}\),(\w+)\("input",\{type:"email"/g,
      replace: (_, h) => `children:"Telegram или телефон"}),${h}("input",{type:"text",autoComplete:"username",autoCapitalize:"off",spellcheck:false`,
      done: /children:"Telegram или телефон"\}\),\w+\("input",\{type:"text",autoComplete:"username"/
    },
    text('ilya@gmail\\.com', '@username', 'login placeholder'),
    {
      // "@" is a fixed prefix on the left (like Flutter's prefixIcon): it cannot be erased, and a typed one is dropped;
      // it hides while a phone number is typed (+ or a digit first)
      name: 'login field: @ prefix',
      find: /(\w+)\("input",\{type:"text",autoComplete:"username",autoCapitalize:"off",spellcheck:false,className:(`[^`]*`),value:([\w$]+),onInput:([\w$]+=>\{[^}]*\}),placeholder:"@username",disabled:([\w$]+)\}\)/g,
      replace: (_, h, cls, value, onInput, disabled) =>
        `${h}("div",{style:{position:"relative"},children:[` +
        `!/^[+\\d]/.test(${value})&&${h}("span",{"aria-hidden":"true",style:{position:"absolute",left:17,top:"50%",transform:"translateY(-50%)",fontSize:16,lineHeight:1,color:"var(--text-secondary)",pointerEvents:"none"},children:"@"}),` +
        `${h}("input",{type:"text",autoComplete:"username",autoCapitalize:"off",spellcheck:false,className:${cls},style:{paddingLeft:/^[+\\d]/.test(${value})?16:35},value:${value},` +
        `onInput:ev=>{ev.target.value=ev.target.value.replace(/^@+/,"");(${onInput})(ev)},placeholder:"username или +7…",disabled:${disabled}})]})`,
      done: /placeholder:"username или \+7…",disabled:/
    },
    text('Введите email', 'Введите ник в Telegram или номер', 'empty login message'),
    text('Неверный email или пароль', 'Неверный ник Telegram или пароль', 'invalid credentials message'),
    text('Аккаунт с таким email не найден', 'Аккаунт с таким Telegram не найден', 'unknown account message'),
    text('Введите корректный email', 'Введите корректный ник Telegram', 'invalid login message'),
    text('Код с почты', 'Код из Telegram', 'code input label'),
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
          `${link('https://t.me/openitd', 'Наш Telegram')}]})`
        )
      },
      done: /children:"О проекте"\}\)\}\),[\w$]+\("li",\{children:[\w$]+\("a",\{href:"https:\/\/t\.me\/openitd"/
    },
    // ---- phone sign-in and sign-up (the code comes from the bot, to the Telegram that shared the number)
    say(
      'Создайте аккаунт по номеру телефона. Номер подтвердим проверочным кодом.',
      `Откройте бота ${botLink}, нажмите «Старт» и «Поделиться номером», затем введите этот номер. Код придёт в Telegram, ник для аккаунта возьмём оттуда.`
    ),
    say('Войдите или создайте аккаунт. Номер подтвердим проверочным кодом.', `Введите номер, которым вы поделились с ботом ${botLink}. Код придёт в Telegram.`),
    say('Код отправлен в приложение ИТД.', `Код отправлен в Telegram, в чат с ботом ${botLink}.`),
    say('Облачный пароль', 'Пароль'),
    say('Для этого аккаунта включена дополнительная защита.', 'Введите пароль от аккаунта.'),
    say('Неверный облачный пароль.', 'Неверный пароль.'),
    say('Восстановить через почту', 'Восстановить по нику Telegram'),
    say('Вернуться ко входу по почте', 'Вернуться ко входу по нику'),
    // ---- attaching a phone (the dialog of the main bundle) and the code channel: "push" is a Telegram message
    say(
      'Позвоним и сразу сбросим. Подтвердите номер, чтобы публиковать посты, оставлять комментарии и писать в чатах.',
      `Сначала откройте бота ${botLink} и нажмите «Поделиться номером». Затем введите тот же номер — код придёт в Telegram.`
    ),
    say('Получить звонок', 'Получить код'),
    say('Позвонить снова', 'Отправить код снова'),
    say('Звонок бесплатный. Номер не появится в профиле.', 'Номер не появится в профиле.'),
    swap('`Повторный звонок через ${w} с`', '`Повторная отправка через ${w} с`', 'text: phone resend timer'),
    say('Отправили уведомление', 'Отправили код в Telegram'),
    say('Посмотрите код в уведомлении на устройстве, где вы уже вошли в ИТД.', `Код пришёл в Telegram, которым вы поделились номером с ботом ${botLink}.`),
    say('Позвоним на него, чтобы убедиться, что номер ваш.', `Сначала поделитесь этим номером с ботом ${botLink}: код придёт в тот Telegram.`),
    // ---- settings: the "email" sign-in method is the Telegram username
    say('Почта', 'Telegram'),
    say('Почта не привязана', 'Telegram не привязан'),
    say('Привязать почту', 'Привязать Telegram'),
    say('Подтвердите почту', 'Подтвердите Telegram'),
    say('Подтвердить почту', 'Подтвердить Telegram'),
    say('Пришлём код подтверждения на эту почту.', 'Пришлём код в этот Telegram.'),
    say('Новая почта', 'Новый Telegram'),
    say('Смена почты', 'Смена Telegram'),
    say('Почта изменена', 'Telegram изменён'),
    swap('`Теперь входите по почте ${f}`', '`Теперь входите по нику ${f}`', 'text: signed in by the new Telegram'),
    say('Почта останется прежней', 'Telegram останется прежним'),
    say('Почта уже изменилась. Откройте настройки заново.', 'Telegram уже изменился. Откройте настройки заново.'),
    say('Пришлём на неё код, чтобы убедиться, что почта ваша.', `Откройте бота ${botLink} с нового Telegram и нажмите «Старт»: пришлём туда код.`),
    say('Проверьте адрес почты.', 'Проверьте ник в Telegram.'),
    say('Другая почта', 'Другой Telegram'),
    say('Это ваша текущая почта.', 'Это ваш текущий Telegram.'),
    say('Эта почта уже используется другим аккаунтом.', 'Этот Telegram уже привязан к другому аккаунту.'),
    say('Сначала привяжите почту.', 'Сначала привяжите Telegram.'),
    say('К аккаунту уже привязана почта.', 'К аккаунту уже привязан Telegram.'),
    say('Код из письма', 'Код из Telegram'),
    say('Неверный код. Проверьте письмо и попробуйте ещё раз.', 'Неверный код. Проверьте сообщение в Telegram и попробуйте ещё раз.'),
    say('Не удалось отправить письмо. Попробуйте ещё раз.', 'Не удалось отправить код. Попробуйте ещё раз.'),
    say('Создайте пароль, чтобы входить по почте и по номеру без кода.', 'Создайте пароль, чтобы входить по нику Telegram и по номеру.'),
    say('С паролем можно входить по почте и по номеру без кода.', 'С паролем можно входить по нику Telegram и по номеру.'),
    say('Теперь можно входить с паролем по почте и по номеру.', 'Теперь можно входить с паролем по нику Telegram и по номеру.'),
    swap('`Код на почту ${o.email}`', '`Код в Telegram ${o.email}`', 'text: proof by the Telegram'),
    swap('`Код на старую почту ${o.email}`', '`Код в текущий Telegram ${o.email}`', 'text: proof by the current Telegram'),
    swap('`Код на старый номер ${o.phone}`', '`Код в Telegram текущего номера ${o.phone}`', 'text: proof by the current phone'),
    swap('`Код на номер ${o.phone}`', '`Код в Telegram номера ${o.phone}`', 'text: proof by the phone'),
    {
      // the new value of the "email" is a Telegram username
      name: 'settings: Telegram field instead of email',
      find: /\("input",\{type:"email",autoComplete:"email",placeholder:"you@example\.com",maxLength:\d+/g,
      replace: () => '("input",{type:"text",autoComplete:"off",autoCapitalize:"off",spellcheck:false,placeholder:"@username",maxLength:33',
      done: /placeholder:"@username",maxLength:33/
    },
    {
      name: 'settings: Telegram username check',
      find: /=([\w$]+)=>\/\^\[\^\\s@\]\+@\[\^\\s@\]\+\\\.\[\^\\s@\]\+\$\/\.test\(\1\)/g,
      replace: (_, v) => `=${v}=>/^@?[a-z][a-z0-9_]{3,31}$/.test(${v})`,
      done: /=([\w$]+)=>\/\^@\?\[a-z\]\[a-z0-9_\]\{3,31\}\$\/\.test\(\1\)/
    },
    // ---- error texts for the bot codes: the client shows its own text by code, the server message is dropped
    {
      name: 'errors: phone sign-in',
      find: /TOO_MANY_ATTEMPTS:"Слишком много попыток\. Попробуйте позже\.",/g,
      replace: (m) => `${m}${botErrors()}`,
      done: /TOO_MANY_ATTEMPTS:"[^"]*",PHONE_NOT_SHARED:/
    },
    {
      name: 'errors: phone attach dialog',
      find: /NO_CHANNEL_AVAILABLE:"Повторный звонок пока недоступен\. Попробуйте позже\.",/g,
      replace: (m) => `${m}${botErrors()}`,
      done: /NO_CHANNEL_AVAILABLE:"[^"]*",PHONE_NOT_SHARED:/
    },
    {
      name: 'errors: settings',
      find: /SAME_PHONE:"Это ваш текущий номер\.",/g,
      replace: (m) => `${m}${botErrors()}`,
      done: /SAME_PHONE:"[^"]*",PHONE_NOT_SHARED:/
    },
    {
      // the phone is optional: /register signs up with a Telegram nick and a password (the code comes from the bot),
      // the client's phone sign-up stays at /register?phone. Plain DOM handlers: the chunk has no React hooks
      name: 'sign-up: Telegram nick, phone optional',
      find: /import\{u as ([\w$]+)\}from"(\.\/index-[\w-]+\.js)";import\{P as ([\w$]+)\}from"(\.\/index-[\w-]+\.js)";([\s\S]*?)import"(\.\/PhoneAccess\.module-[\w-]+\.js)";([\s\S]*?)const ([\w$]+)=[\w$]+=>\1\(\3,\{intent:"sign-up"\}\);/g,
      replace: (_, h, main, phoneFlow, phoneFile, between, styles, rest, register) =>
        `import{u as ${h},B as __Btn,af as __Logo}from"${main}";import{P as ${phoneFlow}}from"${phoneFile}";${between}` +
        `import{s as __pa}from"${styles}";${rest}${telegramSignUp(h)}` +
        `const ${register}=e=>new URLSearchParams(location.search).has("phone")?${h}(${phoneFlow},{intent:"sign-up"}):${h}(__TgSignUp,{});`,
      done: /function __TgSignUp\(\)/
    },
    {
      name: 'sign-up by phone: link to the Telegram sign-up',
      find: /children:\["Уже есть аккаунт\? ",([\w$]+)\("a",\{href:"\/login",children:"Войти"\}\)\]/g,
      replace: (_, h) => `children:["Уже есть аккаунт? ",${h}("a",{href:"/login",children:"Войти"})," · ",${h}("a",{href:"/register",children:"Без номера, по нику Telegram"})]`,
      done: /children:"Без номера, по нику Telegram"/
    },
    {
      // the phone is attached through the bot (/phone): the button opens it, the rows reload when the user is back
      name: 'settings: attach the phone in the bot',
      find: /([\w$]+)=async\(\)=>\{try\{const\[([\w$]+),([\w$]+)\]=await Promise\.all\(\[([\w$]+)\.methods\(\),\4\.pending\(\)\]\)([\s\S]{0,6000}?)onClick:\(\)=>([\w$]+)\(([\w$]+)\?\.phone\?\{change:"phone"\}:"attachPhone"\)/g,
      replace: (_, load, a, b, api, middle, open, methods) =>
        `${load}=async()=>{try{const[${a},${b}]=await Promise.all([${api}.methods(),${api}.pending()])${middle}` +
        `onClick:()=>{if(${methods}?.phone)return ${open}({change:"phone"});window.addEventListener("focus",()=>${load}(),{once:!0});` +
        `window.open("https://t.me/${bot}?start=phone","_blank","noopener,noreferrer")}`,
      done: /\?start=phone","_blank","noopener,noreferrer"\)\}/
    },
    say('Номер не привязан', 'Не привязан — можно привязать в боте'),
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
