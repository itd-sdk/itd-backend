/**
 * Builds a servable copy of the official ITD web client for this backend.
 *
 *   bun deploy/frontend/build.ts --source ../itd-frontend            # JS/CSS from itd-frontend/raw, rest from the live site
 *   bun deploy/frontend/build.ts                                     # everything from the live site
 *   bun deploy/frontend/build.ts --source ../itd-frontend --offline  # no network: synthesized index.html, no images/sounds
 *
 * Options: --out <dir> (default deploy/frontend/dist), --origin <url>, --cdn-origin <url>,
 * --telegram-bot <username> (or TELEGRAM_BOT, default openitd_bot), --keep-cdn.
 *
 * openitd patches (./patches.ts) are applied on the fly, so --source may point at itd-frontend `main` or `openitd`.
 */
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { applyPatches, missingPatches, openitdPatches } from './patches'

const { values: args } = parseArgs({
  options: {
    source: { type: 'string' },
    out: { type: 'string', default: join(import.meta.dir, 'dist') },
    origin: { type: 'string', default: 'https://xn--d1ah4a.com' },
    'cdn-origin': { type: 'string', default: 'https://cdn.xn--d1ah4a.com' },
    'telegram-bot': { type: 'string', default: process.env.TELEGRAM_BOT ?? 'openitd_bot' },
    offline: { type: 'boolean', default: false },
    'keep-cdn': { type: 'boolean', default: false }
  }
})

const ORIGIN = args.origin!.replace(/\/$/, '')
const CDN = args['cdn-origin']!.replace(/\/$/, '')
const TARGET = resolve(args.out!)
// built next to the target and swapped in at the end, so a failed build never breaks a running site
const OUT = `${TARGET}.tmp`
const ASSETS = join(OUT, 'assets')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0'
const BINARY_EXT = 'png|svg|jpe?g|webp|gif|avif|ico|mp3|wav|ogg|mp4|webm|woff2?|ttf|otf|json|webmanifest'

const warnings: string[] = []
const warn = (message: string) => {
  warnings.push(message)
  console.warn(`! ${message}`)
}

// ---------------------------------------------------------------- http (with the DDoS-Guard JS challenge used by итд.com)

const jar = new Map<string, string>()
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ')

function rememberCookies(res: Response) {
  for (const line of res.headers.getSetCookie()) {
    const pair = line.split(';')[0]!
    const index = pair.indexOf('=')
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim())
  }
}

function ddosGuardHash(b: number) {
  let x = 123456789
  let k = 0
  for (let i = 0; i < 1677696; i++) {
    x = ((x + b) ^ (x + (x % 3) + (x % 17) + b) ^ i) % 16776960
    if (x % 117 === 0) k = (k + 1) % 1111
  }
  return k
}

async function download(url: string): Promise<Buffer> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { 'user-agent': UA, cookie: cookieHeader() } })
    rememberCookies(res)
    const body = Buffer.from(await res.arrayBuffer())
    const challenge = jar.get('__js_p_')
    if (challenge && body.subarray(0, 600).toString().includes('<html>') && body.includes('get_jhash')) {
      jar.set('__jhash_', String(ddosGuardHash(Number(challenge.split(',')[0]))))
      jar.set('__jua_', encodeURIComponent(UA))
      continue
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    return body
  }
  throw new Error(`DDoS-Guard challenge was not solved for ${url}`)
}

async function exists(path: string) {
  return stat(path).then(
    () => true,
    () => false
  )
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(entries.map((e) => (e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)])))
  return nested.flat()
}

// ---------------------------------------------------------------- 1. index.html

await rm(OUT, { recursive: true, force: true })
await mkdir(ASSETS, { recursive: true })

let html: string | null = null
if (!args.offline) {
  console.log(`fetching ${ORIGIN}/`)
  html = (await download(`${ORIGIN}/`)).toString('utf8')
}
const liveEntry = html?.match(/<script[^>]*type="module"[^>]*src="\/assets\/([^"]+\.js)"/)?.[1] ?? null

// ---------------------------------------------------------------- 2. JS / CSS

let entry: string
if (args.source) {
  const raw = join(resolve(args.source), 'raw')
  const files = (await listFiles(raw)).filter((f) => /\.(js|css)$/.test(f))
  for (const file of files) await cp(file, join(ASSETS, basename(file)))
  // lazy chunks may define __vite__mapDeps too; the entry is the one that mounts the app
  const entries = []
  for (const file of files.filter((f) => f.endsWith('.js'))) {
    const code = await readFile(file, 'utf8')
    if (code.includes('__vite__mapDeps=') && code.includes('getElementById("root")')) entries.push(basename(file))
  }
  if (entries.length !== 1) throw new Error(`expected one entry chunk in ${raw}, found: ${entries.join(', ') || 'none'}`)
  entry = entries[0]!
  console.log(`copied ${files.length} files from ${raw}, entry ${entry}`)
  if (liveEntry && liveEntry !== entry) {
    warn(`itd-frontend is behind the live site (live entry ${liveEntry}, raw ${entry}); using raw, entry CSS may not match — re-run itd-frontend/main.py`)
  }
} else {
  if (!liveEntry) throw new Error('--source is required in --offline mode (or the live index.html has no module entry)')
  entry = liveEntry
}

// download any chunk referenced by the bundle that is still missing (everything, when there is no --source)
if (!args.offline) {
  const queue = [entry, ...[...(html ?? '').matchAll(/href="\/assets\/([^"]+\.(?:css|js))"/g)].map((m) => m[1]!)]
  const seen = new Set<string>()
  while (queue.length) {
    const name = queue.shift()!
    if (seen.has(name)) continue
    seen.add(name)
    const path = join(ASSETS, name)
    if (!(await exists(path))) {
      console.log(`  + assets/${name}`)
      try {
        await writeFile(path, await download(`${ORIGIN}/assets/${name}`))
      } catch (error) {
        if (name === entry) throw error
        continue
      }
    }
    if (!name.endsWith('.js')) continue
    const code = await readFile(path, 'utf8')
    for (const m of code.matchAll(/"assets\/([A-Za-z0-9_.-]+\.(?:js|css))"/g)) queue.push(m[1]!)
    for (const m of code.matchAll(/["'`]\.\/([A-Za-z0-9_.-]+\.(?:js|css))["'`]/g)) queue.push(m[1]!)
  }
}

// Vite rejects a lazy import when one of its CSS deps fails to load, so a missing stylesheet would break
// whole screens (emoji picker, modals); an empty placeholder keeps them working, just unstyled
const missingCss: string[] = []
const missingJs: string[] = []
for (const file of (await readdir(ASSETS)).filter((f) => f.endsWith('.js'))) {
  const code = await readFile(join(ASSETS, file), 'utf8')
  const refs = [...code.matchAll(/"assets\/([A-Za-z0-9_.-]+\.(?:js|css))"/g), ...code.matchAll(/["'`]\.\/([A-Za-z0-9_.-]+\.(?:js|css))["'`]/g)]
  for (const [, name] of refs) {
    if (await exists(join(ASSETS, name!))) continue
    if (name!.endsWith('.css')) {
      await writeFile(join(ASSETS, name!), '/* not available at build time */\n')
      missingCss.push(name!)
    } else if (!missingJs.includes(name!)) {
      missingJs.push(name!)
    }
  }
}
if (missingCss.length) warn(`${missingCss.length} stylesheets are not available, replaced with empty files: ${missingCss.join(', ')}`)
if (missingJs.length) warn(`${missingJs.length} JS chunks are not available, screens using them will fail to load: ${missingJs.join(', ')}`)

// ---------------------------------------------------------------- 3. images, sounds, fonts

const bundleFiles = (await readdir(ASSETS)).filter((f) => /\.(js|css)$/.test(f))
const bundle = new Map<string, string>()
for (const file of bundleFiles) bundle.set(file, await readFile(join(ASSETS, file), 'utf8'))

const staticRefs = new Set<string>()
const staticRe = new RegExp(`/?assets/([A-Za-z0-9_.-]+\\.(?:${BINARY_EXT}))`, 'g')
for (const code of bundle.values()) for (const m of code.matchAll(staticRe)) staticRefs.add(m[1]!)
const rootRefs = new Set<string>()
for (const m of (html ?? '').matchAll(/(?:href|src|content)="\/(?!assets\/|\/)([^"?#]+\.[a-z0-9]+)"/gi)) rootRefs.add(m[1]!)

let missingStatic = 0
if (args.offline) {
  missingStatic = staticRefs.size
} else {
  for (const name of staticRefs) {
    try {
      await writeFile(join(ASSETS, name), await download(`${ORIGIN}/assets/${name}`))
    } catch {
      missingStatic++
    }
  }
  for (const name of rootRefs) {
    try {
      await mkdir(dirname(join(OUT, name)), { recursive: true })
      await writeFile(join(OUT, name), await download(`${ORIGIN}/${name}`))
    } catch {
      warn(`could not download /${name}`)
    }
  }
}
if (missingStatic) warn(`${missingStatic} images/sounds referenced by the bundle are not available (${args.offline ? 'offline build' : 'download failed'})`)

// ---------------------------------------------------------------- 4. CDN mirror (pins, error pictures, demo content)

const cdnRe = new RegExp(`${CDN.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(/[A-Za-z0-9_./%-]+\\.[a-z0-9]+)`, 'g')
const cdnPaths = new Set<string>()
for (const code of bundle.values()) for (const m of code.matchAll(cdnRe)) cdnPaths.add(m[1]!)
let mirrored = 0
if (!args.offline && !args['keep-cdn']) {
  for (const path of cdnPaths) {
    try {
      const target = join(OUT, 'cdn', path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, await download(`${CDN}${path}`))
      mirrored++
    } catch {
      warn(`could not mirror ${CDN}${path}`)
    }
  }
}

// ---------------------------------------------------------------- 5. patches

const BOT = args['telegram-bot']!.trim().replace(/^@/, '')
const PATCHES = openitdPatches(BOT)

const stats = { sentry: 0, cdn: 0, telegram: {} as Record<string, number> }
for (const [file, original] of bundle) {
  if (!file.endsWith('.js')) continue
  let code = original
  // error reports with user data must not go to ITD's Sentry
  code = code.replace(/dsn:"https?:\/\/[^"]*@sentry\.[^"]*"/g, () => {
    stats.sentry++
    return 'dsn:""'
  })
  code = applyPatches(code, PATCHES, stats.telegram)
  if (!args['keep-cdn']) {
    code = code.replaceAll(CDN, () => {
      stats.cdn++
      return '/cdn'
    })
  }
  if (code !== original) await writeFile(join(ASSETS, file), code)
}
if (!stats.sentry) warn('Sentry DSN was not found in the bundle (nothing patched) — check the bundle manually')
const unmatched = missingPatches(PATCHES, stats.telegram)
if (unmatched.length) {
  // markers of the screens the patches target, to tell a different bundle from a broken copy
  const probes = ['ilya@gmail.com', 'Создание аккаунта', 'Введите email', 'Код с почты']
  const jsFiles = [...bundle.keys()].filter((f) => f.endsWith('.js'))
  for (const probe of probes) {
    const found = jsFiles.filter((f) => bundle.get(f)!.includes(probe))
    console.error(`  "${probe}": ${found.length ? found.join(', ') : 'not found'}`)
  }
  console.error(`  ${jsFiles.length} js files checked, bun ${Bun.version}`)
  throw new Error(`the bundle changed, these patches did not apply: ${unmatched.join('; ')}`)
}

// ---------------------------------------------------------------- 6. index.html

const CAPTCHA_STUB =
  '<script id="cf-turnstile-script">/* openitd has no captcha: a leftover widget resolves at once instead of loading Cloudflare */' +
  "window.turnstile={render:function(e,o){setTimeout(function(){o&&o.callback&&o.callback('captcha-disabled')},0);return'stub'},remove:function(){},reset:function(){}};</script>"

let page =
  html ??
  `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <title>ИТД</title>
    <script type="module" crossorigin src="/assets/${entry}"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`
if (html && liveEntry && liveEntry !== entry) page = page.replace(`/assets/${liveEntry}`, `/assets/${entry}`)

const removed: string[] = []
const TRACKERS = /metrika|yandex|gtag|googletagmanager|google-analytics|clarity/i
// third-party scripts and trackers of the original site; every tag is matched on its own so the entry script stays
page = page.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (tag, attrs: string, body: string) => {
  const src = attrs.match(/\bsrc="([^"]+)"/)?.[1]
  if (src && /^(https?:)?\/\//.test(src) && !src.includes('challenges.cloudflare.com')) {
    removed.push(src)
    return ''
  }
  if (!src && TRACKERS.test(body)) {
    removed.push(`inline ${body.match(TRACKERS)![0]}`)
    return ''
  }
  return tag
})
page = page.replace(/<noscript>([\s\S]*?)<\/noscript>/gi, (tag, body: string) => (TRACKERS.test(body) ? '' : tag))
page = page.replace(/<link[^>]*rel="(?:preconnect|dns-prefetch)"[^>]*>/gi, '')
page = page.replace(/<\/head>/i, `  ${CAPTCHA_STUB}\n  </head>`)
await writeFile(join(OUT, 'index.html'), page)

// ---------------------------------------------------------------- 7. report

const info = {
  builtAt: new Date().toISOString(),
  entry,
  source: args.source ? resolve(args.source) : ORIGIN,
  offline: args.offline,
  telegramBot: BOT,
  patches: stats,
  cdnMirrored: mirrored,
  removedScripts: removed,
  warnings
}
await writeFile(join(OUT, 'build-info.json'), JSON.stringify(info, null, 2))
// replace the contents but keep the directory itself: a running Caddy container bind-mounts it
await mkdir(TARGET, { recursive: true })
for (const entry of await readdir(TARGET)) await rm(join(TARGET, entry), { recursive: true, force: true })
for (const entry of await readdir(OUT)) await rename(join(OUT, entry), join(TARGET, entry))
await rm(OUT, { recursive: true, force: true })

console.log(`\nbuilt ${TARGET}`)
console.log(`  entry ${entry}, ${bundle.size} js/css files, ${staticRefs.size - missingStatic}/${staticRefs.size} static files, ${mirrored} cdn files`)
console.log(`  patched: sentry ${stats.sentry}, cdn urls ${stats.cdn}, telegram ${Object.values(stats.telegram).reduce((a, b) => a + b, 0)} (bot @${BOT})`)
if (removed.length) console.log(`  removed scripts: ${removed.join(', ')}`)
if (warnings.length) console.log(`  ${warnings.length} warning(s), see build-info.json`)
