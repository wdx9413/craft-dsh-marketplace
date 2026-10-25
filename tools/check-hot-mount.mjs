/**
 * Check whether a plugin's bundle patch can be hot-mounted.
 *
 *   node tools/check-hot-mount.mjs [package dir]
 *
 * The market's hot-mount parser accepts nothing but plain `id` / `name`
 * insert rows. A config block, a disabled row or an expression makes it
 * return null, and the plugin then activates on the next boot instead of
 * this session — reported as "the bundle patch contains config/expression
 * rows, hot-mount only supports plain inserts". The plugin's own patch is
 * read here with the market's own parser.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const packageDir = process.argv[2] ?? 'plugins/craft-context'
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
const patchRef = manifest.dsh?.bundle?.patch
if (typeof patchRef !== 'string') {
  console.log('FAIL  the package declares no dsh.bundle.patch')
  process.exit(1)
}

const profileDir = process.env.DSH_PROFILE_DIR
  ?? join(process.env.APPDATA, 'dsh-desktop', 'harness', 'profiles', 'web')
const dshmarket = join(profileDir, 'node_modules', 'dshmarket', 'lib', 'hot.js')
const { parseSimplePatch } = await import(`file:///${dshmarket.replace(/\\/g, '/')}`)

const patchText = readFileSync(join(packageDir, patchRef), 'utf8')
const rows = parseSimplePatch(patchText)

if (rows === null) {
  console.log('FAIL  the bundle patch cannot be hot-mounted')
  console.log('      the market accepts only plain id/name insert rows;')
  console.log('      a config block, a disabled row or an expression rejects the whole patch')
  process.exit(1)
}
console.log(`PASS  the bundle patch is hot-mountable`)
for (const row of rows) console.log(`      ${row.id}  ->  ${row.name}`)
