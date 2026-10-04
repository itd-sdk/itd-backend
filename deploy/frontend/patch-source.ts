/**
 * Applies the openitd patches in place to an itd-frontend checkout (raw/ and decompiled/).
 * This is how the `openitd` branch of itd-frontend is produced; after itd-frontend `main` is updated:
 *
 *   cd ../itd-frontend && git checkout openitd && git merge -X theirs main
 *   bun ../itd-backend/deploy/frontend/patch-source.ts --source . && git commit -am "openitd patches"
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { applyPatches, missingPatches, openitdPatches, type PatchCounts } from './patches'
import { decompiledPatches } from './patches-decompiled'

const { values: args } = parseArgs({
  options: {
    source: { type: 'string', default: '../itd-frontend' },
    'telegram-bot': { type: 'string', default: process.env.TELEGRAM_BOT ?? 'openitd_bot' }
  }
})

const root = resolve(args.source!)
const bot = args['telegram-bot']!

async function jsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((e) => (e.isDirectory() ? jsFiles(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : []))
  )
  return nested.flat()
}

for (const [dir, patches] of [
  ['raw', openitdPatches(bot)],
  ['decompiled', decompiledPatches(bot)]
] as const) {
  const counts: PatchCounts = {}
  let changed = 0
  for (const file of await jsFiles(join(root, dir))) {
    const code = await readFile(file, 'utf8')
    const patched = applyPatches(code, patches, counts)
    if (patched !== code) {
      await writeFile(file, patched)
      changed++
      console.log(`  patched ${relative(root, file)}`)
    }
  }
  const missing = missingPatches(patches, counts)
  if (missing.length) throw new Error(`${dir}: these patches did not apply: ${missing.join('; ')}`)
  console.log(`${dir}: ${changed} files changed, all ${patches.length} patches present`)
}
