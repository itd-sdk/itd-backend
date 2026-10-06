/**
 * Builds a servable copy of the official ITD web client for this backend.
 *
 *   bun deploy/frontend/build.ts --source ../itd-frontend            # JS/CSS from itd-frontend/raw, rest from the live site
 *   bun deploy/frontend/build.ts                                     # everything from the live site
 *   bun deploy/frontend/build.ts --source ../itd-frontend --offline  # no network: synthesized index.html, no images/sounds
 *
 * Options: --out <dir> (default deploy/frontend/dist), --origin <url>, --cdn-origin <url>,
 * --telegram-bot <username> (or TELEGRAM_BOT, default openitd_bot), --keep-cdn,
 * --title <text> (or SITE_TITLE): page title, --icon <file.png|svg|ico|webp> (or SITE_ICON): site icon,
 * --version <x.y.z> (or SITE_VERSION): the version next to the logo until the changelog loads (it shows the newest entry),
 * --css <file> (or SITE_CSS, default deploy/frontend/overrides.css): style fixes linked after the client's styles,
 * --mirror-event: download the site's own event app instead of the stub from deploy/frontend/event-app.
 *
 * openitd patches (./patches.ts) are applied on the fly, so --source may point at itd-frontend `main` or `openitd`.
 */
import { createHash } from 'node:crypto'
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib'
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { applyPatches, missingPatches, openitdPatches } from './patches'

const { values: args } = parseArgs({
  options: {
    source: { type: 'string' },
    out: { type: 'string', default: join(import.meta.dir, 'dist') },
    origin: { type: 'string', default: 'https://xn--d1ah4a.com' },
    'cdn-origin': { type: 'string', default: 'https://cdn.xn--d1ah4a.com' },
    'telegram-bot': { type: 'string', default: process.env.TELEGRAM_BOT ?? 'openitd_bot' },
    title: { type: 'string', default: process.env.SITE_TITLE ?? '' },
    icon: { type: 'string', default: process.env.SITE_ICON ?? '' },
    version: { type: 'string', default: process.env.SITE_VERSION ?? '' },
    css: { type: 'string', default: process.env.SITE_CSS ?? join(import.meta.dir, 'overrides.css') },
    offline: { type: 'boolean', default: false },
    'mirror-event': { type: 'boolean', default: false },
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

class NotFoundError extends Error {}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// the site throttles bursts (403/429) and has hiccups (5xx): retry those with growing pauses, 404 is final
async function download(url: string): Promise<Buffer> {
  let challenges = 0
  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await fetch(url, { headers: { 'user-agent': UA, cookie: cookieHeader() } })
    } catch (error) {
      if (attempt >= 4) throw error
      await sleep(1000 * 2 ** attempt)
      continue
    }
    rememberCookies(res)
    const body = Buffer.from(await res.arrayBuffer())
    const challenge = jar.get('__js_p_')
    if (challenge && body.subarray(0, 600).toString().includes('<html>') && body.includes('get_jhash')) {
      if (++challenges > 3) throw new Error(`DDoS-Guard challenge was not solved for ${url}`)
      jar.set('__jhash_', String(ddosGuardHash(Number(challenge.split(',')[0]))))
      jar.set('__jua_', encodeURIComponent(UA))
      continue
    }
    if (res.status === 404) throw new NotFoundError(`HTTP 404 for ${url}`)
    // an anti-bot page served with 200 instead of the file would be saved as the asset itself
    const htmlInsteadOfFile = res.ok && !isPage(url) && looksLikeHtml(body)
    if (res.ok && !htmlInsteadOfFile) return body
    if (attempt >= 4) throw new Error(htmlInsteadOfFile ? `got an HTML page instead of ${url}` : `HTTP ${res.status} for ${url}`)
    if (!htmlInsteadOfFile && ![403, 408, 425, 429, 500, 502, 503, 504].includes(res.status)) throw new Error(`HTTP ${res.status} for ${url}`)
    await sleep(Number(res.headers.get('retry-after')) * 1000 || 1000 * 2 ** attempt)
  }
}

/** A file kept from the previous build, so a rerun only downloads what is still missing */
async function previous(relativePath: string) {
  try {
    const body = await readFile(join(TARGET, relativePath))
    return looksLikeHtml(body) ? null : body
  } catch {
    return null
  }
}

const removed: string[] = []
const TRACKERS = /metrika|yandex|gtag|googletagmanager|google-analytics|clarity/i

/** Drops third-party scripts and trackers of the original site; every tag is matched on its own so app scripts stay */
function stripTrackers(page: string) {
  return page
    .replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (tag, attrs: string, body: string) => {
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
    .replace(/<noscript>([\s\S]*?)<\/noscript>/gi, (tag, body: string) => (TRACKERS.test(body) ? '' : tag))
    .replace(/<link[^>]*rel="(?:preconnect|dns-prefetch)"[^>]*>/gi, '')
}

/** Sentry off, CDN links to the local mirror */
function cleanCode(code: string) {
  let result = code.replace(/dsn:"https?:\/\/[^"]*@sentry\.[^"]*"/g, 'dsn:""')
  if (!args['keep-cdn']) result = result.replaceAll(CDN, '/cdn')
  return result
}

function looksLikeHtml(body: Buffer) {
  return /^\s*(<!doctype html|<html|<head|<body)/i.test(body.subarray(0, 512).toString())
}

const isPage = (url: string) => url.replace(/[?#].*$/, '').endsWith('/') || /\.html?$/.test(url)

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
// "./assets/x.png" are import.meta.glob keys (source paths), not URLs: the hashed URL sits in a variable next to them
const staticRe = new RegExp(`(?<![.\\w/])/?assets/((?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_.-]+\\.(?:${BINARY_EXT}))`, 'g')
for (const code of bundle.values()) for (const m of code.matchAll(staticRe)) staticRefs.add(m[1]!)
const rootRefs = new Set<string>()
for (const m of (html ?? '').matchAll(/(?:href|src|content)="\/(?!assets\/|\/)([^"?#]+\.[a-z0-9]+)"/gi)) rootRefs.add(m[1]!)

const missing: { static: string[]; notOnSite: string[]; cdn: string[] } = { static: [], notOnSite: [], cdn: [] }
let missingStatic = 0
if (args.offline) {
  missingStatic = staticRefs.size
} else {
  for (const name of staticRefs) {
    try {
      const body = (await previous(`assets/${name}`)) ?? (await download(`${ORIGIN}/assets/${name}`))
      // a few live in subfolders (assets/portal/…: the event tab icon)
      await mkdir(dirname(join(ASSETS, name)), { recursive: true })
      await writeFile(join(ASSETS, name), body)
    } catch (error) {
      missingStatic++
      ;(error instanceof NotFoundError ? missing.notOnSite : missing.static).push(name)
    }
  }
  for (const name of rootRefs) {
    try {
      await mkdir(dirname(join(OUT, name)), { recursive: true })
      // names without a hash can change on the site: download first, the previous build is only a fallback
      const body = await download(`${ORIGIN}/${name}`).catch(async (error) => (await previous(name)) ?? Promise.reject(error))
      await writeFile(join(OUT, name), body)
    } catch {
      warn(`could not download /${name}`)
    }
  }
}
if (args.offline && missingStatic) warn(`${missingStatic} images/sounds referenced by the bundle are not available (offline build)`)
if (missing.static.length) warn(`${missing.static.length} images/sounds could not be downloaded (run the build again later, see build-info.json)`)
if (missing.notOnSite.length) warn(`${missing.notOnSite.length} images/sounds referenced by the bundle are not on the site (404)`)

// ---------------------------------------------------------------- 4. CDN mirror (pins, error pictures, demo content)

const cdnRe = new RegExp(`${CDN.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(/[A-Za-z0-9_./%-]+\\.[a-z0-9]+)`, 'g')
const cdnPaths = new Set<string>()
for (const code of bundle.values()) for (const m of code.matchAll(cdnRe)) cdnPaths.add(m[1]!)
let mirrored = 0
const cdnDone = new Set<string>()
async function mirrorCdn(path: string) {
  if (args.offline || args['keep-cdn'] || cdnDone.has(path)) return
  cdnDone.add(path)
  try {
    const target = join(OUT, 'cdn', path)
    const body = (await previous(`cdn${path}`)) ?? (await download(`${CDN}${path}`))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, body)
    mirrored++
  } catch {
    missing.cdn.push(path)
  }
}
for (const path of cdnPaths) await mirrorCdn(path)

// UI icons are fetched at runtime from `${CDN}/public/assets/icons/<name>.svg` (the URL is built in code, so the
// mirror above does not see it); names come from calls like `X(Icon,{name:a?"liked":"like"})`
const ICONS = '/public/assets/icons'
const icons = { mirrored: 0, names: [] as string[] }
if (!args.offline && !args['keep-cdn'] && [...bundle.values()].some((code) => code.includes(`${CDN}${ICONS}`))) {
  const names = new Set(['like', 'liked', 'comment', 'share'])
  for (const code of bundle.values()) {
    for (const m of code.matchAll(/[(,][\w$]+,\{name:((?:[\w$.!]+\?)?"[a-z0-9_-]+"(?::"[a-z0-9_-]+")?)/g)) {
      for (const lit of m[1]!.matchAll(/"([a-z0-9_-]+)"/g)) names.add(lit[1]!)
    }
  }
  for (const name of names) {
    const path = `${ICONS}/${name}.svg`
    try {
      const target = join(OUT, 'cdn', path)
      const body = (await previous(`cdn${path}`)) ?? (await download(`${CDN}${path}`))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, body)
      icons.mirrored++
      icons.names.push(name)
    } catch (error) {
      // most candidates that are not icons simply do not exist
      if (!(error instanceof NotFoundError)) missing.cdn.push(path)
    }
  }
  if (!icons.names.includes('like')) warn('UI icons (like/comment/share) could not be mirrored, run the build again')
}
// ---------------------------------------------------------------- 4b. event mini-apps

// /event/alice-ai is a frame with a separate app the site serves from /public/events/<id>/ on the same origin.
// It is not part of itd-frontend: mirror its page and every file it references under that path.
const ASSET_REF = /["'`(]((?:\.{1,2}\/|\/)?[A-Za-z0-9_@~./-]+\.(?:m?js|css|png|svg|jpe?g|webp|gif|avif|ico|mp3|wav|ogg|mp4|webm|woff2?|ttf|otf|json))["'`)]/g
const eventApps: { base: string; files: number }[] = []
const eventBases = new Set<string>()
for (const code of bundle.values()) for (const m of code.matchAll(/"(\/public\/events\/[a-z0-9_-]+)"/g)) eventBases.add(m[1]!)

async function mirrorEventApp(base: string) {
  const origin = new URL(ORIGIN).origin
  const root = `${ORIGIN}${base}/`
  const page = (await download(root)).toString('utf8')
  if (!/<script\b/i.test(page)) throw new Error('the page has no scripts')
  const queue: string[] = []
  const add = (ref: string, from: string) => {
    let url: URL
    try {
      url = new URL(ref, from)
    } catch {
      return
    }
    if (url.origin === origin && url.pathname.startsWith(`${base}/`) && !url.pathname.endsWith('/')) queue.push(url.pathname)
  }
  for (const m of page.matchAll(/(?:src|href)="([^"]+)"/g)) add(m[1]!, root)
  const seen = new Set<string>()
  let files = 0
  while (queue.length) {
    const path = queue.shift()!
    if (seen.has(path)) continue
    seen.add(path)
    const code = /\.(m?js|css)$/.test(path)
    let body: Buffer
    try {
      body = (!code && (await previous(path.slice(1)))) || (await download(`${origin}${path}`))
    } catch (error) {
      // module-relative and base-relative guesses for the same reference: one of them is a 404
      if (!(error instanceof NotFoundError)) missing.static.push(path)
      continue
    }
    if (code) {
      const text = body.toString('utf8')
      for (const m of text.matchAll(ASSET_REF)) {
        add(m[1]!, `${origin}${path}`)
        add(m[1]!, root)
      }
      for (const m of text.matchAll(cdnRe)) await mirrorCdn(m[1]!)
      body = Buffer.from(cleanCode(text))
    }
    await mkdir(dirname(join(OUT, path)), { recursive: true })
    await writeFile(join(OUT, path), body)
    files++
  }
  for (const m of page.matchAll(cdnRe)) await mirrorCdn(m[1]!)
  await mkdir(join(OUT, base), { recursive: true })
  await writeFile(join(OUT, base, 'index.html'), stripTrackers(cleanCode(page)))
  return files
}

const EVENT_STUB = join(import.meta.dir, 'event-app')
if (!args['mirror-event'] && (await exists(EVENT_STUB))) {
  // our stub: free items, see src/modules/event/free.ts
  for (const base of eventBases) {
    await cp(EVENT_STUB, join(OUT, base), { recursive: true })
    eventApps.push({ base, files: (await readdir(EVENT_STUB)).length })
    console.log(`event app ${base}: stub from deploy/frontend/event-app`)
  }
} else if (!args.offline) {
  for (const base of eventBases) {
    try {
      const files = await mirrorEventApp(base)
      eventApps.push({ base, files })
      console.log(`event app ${base}: ${files} files`)
    } catch (error) {
      warn(`event app ${base} is not available (${(error as Error).message}); the event page will be empty`)
    }
  }
}

if (missing.cdn.length) warn(`${missing.cdn.length} CDN files could not be mirrored: ${missing.cdn.slice(0, 5).join(', ')}${missing.cdn.length > 5 ? ', …' : ''}`)

// ---------------------------------------------------------------- 5. patches

const BOT = args['telegram-bot']!.trim().replace(/^@/, '')
const PATCHES = openitdPatches(BOT)
const VERSION = args.version!.trim().replace(/^v/i, '')
// the label is a literal in the bundle (the release the client was built as): read it from the page instead,
// VERSION_SCRIPT in index.html fills it from the newest changelog entry
PATCHES.push({
  name: 'version next to the logo',
  find: /(title:"Что нового",children:\["v",)("[^"]*")\]/g,
  replace: (_, head, original) => `${head}globalThis.__openitdVersion||${VERSION ? JSON.stringify(VERSION) : original}]`,
  done: /title:"Что нового",children:\["v",globalThis\.__openitdVersion\|\|/
})

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

// ---------------------------------------------------------------- 5b. cache-safe file names

// /assets is served as immutable, but the patches change files under Vite's original names: a browser that cached
// the original (or a previous build) would never load the new code. Every js/css name gets a suffix derived from
// the final contents, and all references are rewritten.
const renamed = new Map<string, string>()
const assetFiles = (await readdir(ASSETS)).filter((f) => /\.(js|css)$/.test(f)).sort()
const contents = new Map<string, string>()
const digest = createHash('sha256')
for (const file of assetFiles) {
  const code = await readFile(join(ASSETS, file), 'utf8')
  contents.set(file, code)
  digest.update(file).update('\0').update(code).update('\0')
}
const buildTag = digest.digest('hex').slice(0, 8)
for (const file of assetFiles) renamed.set(file, file.replace(/\.(js|css)$/, `.${buildTag}.$1`))
const assetNames = new RegExp(`(?<![\\w.-])(${assetFiles.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w-])`, 'g')
const renameRefs = (text: string) => text.replace(assetNames, (name) => renamed.get(name)!)
for (const [file, code] of contents) {
  await writeFile(join(ASSETS, renamed.get(file)!), renameRefs(code))
  await rm(join(ASSETS, file))
}
const sourceEntry = entry
entry = renamed.get(entry)!

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
if (html && liveEntry && liveEntry !== sourceEntry) page = page.replace(`/assets/${liveEntry}`, `/assets/${entry}`)
page = renameRefs(page)

page = stripTrackers(page)
// ---- branding: title and icon
const escapeAttr = (value: string) => value.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
const TITLE_META = /\b(?:property|name)="(?:og:title|og:site_name|twitter:title|apple-mobile-web-app-title|application-name)"/i
const title = args.title!.trim()
if (title) {
  page = /<title>[\s\S]*?<\/title>/i.test(page)
    ? page.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeAttr(title)}</title>`)
    : page.replace(/<\/head>/i, `  <title>${escapeAttr(title)}</title>\n  </head>`)
  page = page.replace(/<meta\b[^>]*>/gi, (tag) => (TITLE_META.test(tag) ? tag.replace(/content="[^"]*"/i, `content="${escapeAttr(title)}"`) : tag))
}
const ICON_TYPES: Record<string, string> = { '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp' }
let iconPath: string | null = null
if (args.icon) {
  const ext = extname(args.icon).toLowerCase()
  const type = ICON_TYPES[ext]
  if (!type) throw new Error(`--icon must be a .png, .svg, .ico or .webp file: ${args.icon}`)
  const icon = await readFile(resolve(args.icon))
  // a name that changes with the picture, so browsers do not keep showing the old one
  iconPath = `/icon-${createHash('sha256').update(icon).digest('hex').slice(0, 8)}${ext}`
  await writeFile(join(OUT, iconPath), icon)
  if (ext === '.ico') await writeFile(join(OUT, 'favicon.ico'), icon)
  else await rm(join(OUT, 'favicon.ico'), { force: true })
  page = page.replace(/<link\b[^>]*\brel="(?:shortcut icon|icon|apple-touch-icon(?:-precomposed)?|mask-icon)"[^>]*>\s*/gi, '')
  page = page.replace(/<\/head>/i, `  <link rel="icon" type="${type}" href="${iconPath}">\n  <link rel="apple-touch-icon" href="${iconPath}">\n  </head>`)
}
// style fixes, placed last so they win over the client's own styles
let cssPath: string | null = null
if (args.css && (await exists(resolve(args.css)))) {
  const css = await readFile(resolve(args.css))
  // class names in the fixes are CSS-module hashes of one bundle version: report the ones this bundle lacks
  const bundleText = [...contents.values()].join('\n')
  const classes = new Set([...css.toString('utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]!))
  const stale = [...classes].filter((name) => !bundleText.includes(`"${name}"`) && !bundleText.includes(`.${name}`))
  if (stale.length) warn(`${args.css}: classes not found in this bundle, those fixes no longer apply: ${stale.map((c) => '.' + c).join(', ')}`)
  // inlined: a separate file could arrive after the first render and the broken styles would flash
  cssPath = resolve(args.css)
  const inline = css.toString('utf8').replace(/<\/style/gi, '<\\/style')
  page = page.replace(/<\/head>/i, () => `  <style id="openitd-overrides">\n${inline}\n</style>\n  </head>`)
} else if (args.css && args.css !== join(import.meta.dir, 'overrides.css')) {
  throw new Error(`--css file not found: ${args.css}`)
}
// installed-app name and icon
if (title || iconPath) {
  for (const file of await readdir(OUT)) {
    if (!/\.webmanifest$|^manifest\.json$/.test(file)) continue
    try {
      const manifest = JSON.parse(await readFile(join(OUT, file), 'utf8'))
      if (title) Object.assign(manifest, { name: title, short_name: title })
      if (iconPath) manifest.icons = [{ src: iconPath, sizes: 'any', type: ICON_TYPES[extname(iconPath)] }]
      await writeFile(join(OUT, file), JSON.stringify(manifest, null, 2))
    } catch {
      warn(`could not update ${file}`)
    }
  }
}
page = page.replace(/<\/head>/i, `  ${CAPTCHA_STUB}\n  </head>`)
// served for /public/events/… only when nginx falls back to the site: without this the whole site would load again
// inside the event frame
const EVENT_GUARD =
  '<script>(function(){var m=/^\\/public\\/events\\/[^/]+\\//.exec(location.pathname);if(!m)return;window.stop();' +
  // the nginx block for /public/events/ is missing: the file itself is still served as is
  "if(!/\\/index\\.html$/.test(location.pathname)){location.replace(m[0]+'index.html'+location.search);return}" +
  "document.documentElement.innerHTML='<body style=\"font:15px system-ui,sans-serif;padding:24px;color:#888\">Страница ивента не установлена: пересоберите веб-клиент и скопируйте его на сервер целиком (папка <code>public/events</code>).</body>'})()</script>"
page = page.replace(/<head>/i, `<head>\n    ${EVENT_GUARD}`)
// version next to the logo = newest changelog entry; cached so the next load shows it at once. The button's text
// node is updated in place: React keeps that node and writes the same value on its next render
const VERSION_SCRIPT = `<script>(function(){var K='openitd:version';try{window.__openitdVersion=localStorage.getItem(K)||''}catch(e){}
fetch('/api/platform/changelog').then(function(r){return r.ok?r.json():null}).then(function(d){
var v=d&&d.data&&d.data[0]&&String(d.data[0].version||'').replace(/^v/i,'');if(!v)return;
window.__openitdVersion=v;try{localStorage.setItem(K,v)}catch(e){}
var b=document.querySelector('button[title="Что нового"]');if(!b)return;
for(var i=0;i<b.childNodes.length;i++){var n=b.childNodes[i];if(n.nodeType===3&&n.nodeValue!=='v'&&n.nodeValue!==v)n.nodeValue=v}
}).catch(function(){})})()</script>`
page = page.replace(/<\/head>/i, () => `  ${VERSION_SCRIPT}\n  </head>`)
await writeFile(join(OUT, 'index.html'), page)

// ---------------------------------------------------------------- 7. report

const info = {
  builtAt: new Date().toISOString(),
  entry,
  source: args.source ? resolve(args.source) : ORIGIN,
  offline: args.offline,
  telegramBot: BOT,
  title: title || null,
  icon: iconPath,
  css: cssPath,
  patches: stats,
  cdnMirrored: mirrored,
  removedScripts: removed,
  missing,
  icons: icons.names,
  eventApps,
  warnings
}
await writeFile(join(OUT, 'build-info.json'), JSON.stringify(info, null, 2))

// precompressed copies (nginx gzip_static, Caddy precompressed): a weak server no longer compresses
// the bundle on every request
const COMPRESSIBLE = /\.(?:js|css|html|svg|json|webmanifest|txt|xml)$/i
let compressed = 0
async function precompress(dir: string) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await precompress(path)
    else if (COMPRESSIBLE.test(entry.name)) {
      const body = await readFile(path)
      if (body.length < 1024) continue
      await writeFile(`${path}.gz`, gzipSync(body, { level: 9 }))
      await writeFile(`${path}.br`, brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } }))
      compressed++
    }
  }
}
await precompress(OUT)
// replace the contents but keep the directory itself: a running Caddy container bind-mounts it
await mkdir(TARGET, { recursive: true })
for (const entry of await readdir(TARGET)) await rm(join(TARGET, entry), { recursive: true, force: true })
for (const entry of await readdir(OUT)) await rename(join(OUT, entry), join(TARGET, entry))
await rm(OUT, { recursive: true, force: true })

console.log(`\nbuilt ${TARGET}`)
console.log(`  entry ${entry}, ${bundle.size} js/css files, ${staticRefs.size - missingStatic}/${staticRefs.size} static files, ${mirrored} cdn files, ${icons.mirrored} icons`)
console.log(`  precompressed ${compressed} files (.gz, .br)`)
console.log(`  patched: sentry ${stats.sentry}, cdn urls ${stats.cdn}, telegram ${Object.values(stats.telegram).reduce((a, b) => a + b, 0)} (bot @${BOT})`)
if (removed.length) console.log(`  removed scripts: ${removed.join(', ')}`)
if (warnings.length) console.log(`  ${warnings.length} warning(s), see build-info.json`)
