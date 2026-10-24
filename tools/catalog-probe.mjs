/**
 * Fetch the published catalog the way dshmarket does, and validate it with the
 * rules dshmarket enforces.
 *
 * This is the last hop that a local verify-index.mjs cannot cover: the URL a
 * user pastes into Plugins -> Discover -> Index sources has to serve this exact
 * document, and dshmarket rejects a catalog whose entries carry no usable
 * category before the UI ever sees it.
 *
 *   node tools/catalog-probe.mjs [url]
 */

import { argv } from 'node:process'

const DEFAULT_URL = 'https://raw.githubusercontent.com/wdx9413/craft-dsh-marketplace/main/index.json'
const url = argv[2] ?? DEFAULT_URL

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`)
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

/** dshmarket/src/sources.ts parseSourceUrl(), verbatim in behaviour. */
function parseSourceUrl(value) {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\/tree\/[^/]+\/(.+?))?\/?$/.exec(value)
  if (m === null || !REPO_RE.test(m[1])) return null
  const subpath = m[2] ?? null
  if (subpath !== null) {
    if (!/^[A-Za-z0-9_./-]+$/.test(subpath)) return null
    if (subpath.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return null
  }
  return { repo: m[1], subpath }
}

console.log(`fetching ${url}`)
let response
try {
  response = await fetch(url)
} catch (error) {
  console.log(`FAIL  the index url is reachable — ${error?.message ?? error}`)
  process.exit(1)
}
check('the index url responds 200', response.ok, `HTTP ${response.status}`)
if (!response.ok) process.exit(1)

const body = await response.text()
check('the body is under dshmarket 256 MB ceiling', Buffer.byteLength(body) < 256 * 1024 * 1024,
  `${Buffer.byteLength(body)} bytes`)

let catalog
try {
  catalog = JSON.parse(body)
} catch (error) {
  console.log(`FAIL  the body parses as JSON — ${error.message}`)
  process.exit(1)
}

// dshmarket/src/registry.ts asRegistry(): the two rules that make a catalog.
check('asRegistry: plugins is a non-empty array',
  Array.isArray(catalog.plugins) && catalog.plugins.length > 0)
check('asRegistry: every plugin carries a usable category',
  (catalog.plugins ?? []).every((plugin) => {
    const values = Array.isArray(plugin.category) ? plugin.category : [plugin.category]
    return values.some((value) => typeof value === 'string' && value !== '')
  }))

// dshmarket/src/sources.ts installTargetFor(): every entry needs a target.
for (const [index, plugin] of (catalog.plugins ?? []).entries()) {
  const at = `plugins[${index}] (${String(plugin?.name ?? '?')})`
  const source = parseSourceUrl(String(plugin?.url ?? ''))
  const hasNpm = typeof plugin.npm === 'string' && NPM_NAME_RE.test(plugin.npm)
  const hasTarball = typeof plugin.tarball === 'string' && plugin.tarball.trim() !== ''
  check(`${at} resolves to an install target`, source !== null || hasNpm || hasTarball)
  if (source !== null) {
    const target = source.subpath !== null
      ? `github:${source.repo}#path:/${source.subpath}`
      : `github:${source.repo}`
    console.log(`      → ${at} installs from ${target}`)
  }
}

// dshmarket/src/routes.ts install branch: lookup is by exact url, so a catalog
// with two entries sharing one url installs the first one twice.
const urls = (catalog.plugins ?? []).map((plugin) => String(plugin?.url ?? '').toLowerCase())
check('every catalog url is unique', new Set(urls).size === urls.length)

console.log('')
if (failures === 0) {
  console.log('OK  the published catalog satisfies dshmarket')
  process.exit(0)
}
console.log(`${failures} failure(s)`)
process.exit(1)
