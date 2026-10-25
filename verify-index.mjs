#!/usr/bin/env node
/**
 * Validate this marketplace: the catalog contract dshmarket enforces, plus the
 * four gates every plugin package must pass or the market uninstalls it.
 *
 * Transcribed from dshmarket@1.66.42 source, not guessed:
 *   - Registry / RegistryPlugin       src/registry.ts
 *   - asRegistry()                    src/registry.ts  (plugins non-empty, category usable)
 *   - parseSourceUrl() / REPO_RE      src/sources.ts
 *   - installTargetFor()              src/sources.ts   (npm > tarball > github:)
 *   - NPM_NAME_RE                     src/sources.ts
 *   - hasDshManifest()                src/profile.ts   (manifest.dsh !== undefined)
 *   - entryArtifactExists()           src/profile.ts   (main / exports['.'] / index.js)
 *   - conflictingEntryIds()           src/install.ts   (duplicate loader entry id)
 *
 * Network access: none. Exit 0 = pass, 1 = fail.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseYaml } from './tools/mini-yaml.mjs'

const here = dirname(fileURLToPath(import.meta.url))

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

/** Mirrors dshmarket/src/sources.ts parseSourceUrl(). */
function parseSourceUrl(url) {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\/tree\/[^/]+\/(.+?))?\/?$/.exec(url)
  if (m === null || !REPO_RE.test(m[1])) return null
  const subpath = m[2] ?? null
  if (subpath !== null) {
    if (!/^[A-Za-z0-9_./-]+$/.test(subpath)) return null
    if (subpath.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return null
  }
  return { repo: m[1], subpath }
}

/** Mirrors dshmarket/src/sources.ts installTargetFor(). */
function installTargetFor(entry) {
  const source = parseSourceUrl(String(entry.url ?? ''))
  if (source === null) return null
  if (typeof entry.npm === 'string' && NPM_NAME_RE.test(entry.npm)) return entry.npm
  if (typeof entry.tarball === 'string' && entry.tarball.trim() !== '') return entry.tarball
  return source.subpath !== null
    ? `github:${source.repo}#path:/${source.subpath}`
    : `github:${source.repo}`
}

let failures = 0
function check(label, ok, detail) {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

// ===========================================================================
// Part 1 — the catalog contract
// ===========================================================================

const indexPath = join(here, 'index.json')
let catalog
try {
  catalog = readJson(indexPath)
} catch (error) {
  console.log(`FAIL  index.json parses — ${error.message}`)
  process.exit(1)
}

check('plugins is a non-empty array', Array.isArray(catalog.plugins) && catalog.plugins.length > 0)
check('updated is a string', typeof catalog.updated === 'string' && catalog.updated.length > 0)
check('count matches plugins.length', catalog.count === catalog.plugins.length,
  `count=${String(catalog.count)} plugins=${String(catalog.plugins?.length)}`)
check('categories is an object', typeof catalog.categories === 'object' && catalog.categories !== null)

const seenNames = new Set()
const seenUrls = new Set()
const seenTargets = new Set()

for (const [index, plugin] of catalog.plugins.entries()) {
  const at = `plugins[${index}] (${String(plugin?.name ?? '?')})`

  check(`${at}.name is a non-empty string`, typeof plugin.name === 'string' && plugin.name.length > 0)
  check(`${at}.owner is a non-empty string`, typeof plugin.owner === 'string' && plugin.owner.length > 0)
  check(`${at}.name is unique`, !seenNames.has(plugin.name), 'already listed')
  seenNames.add(plugin.name)

  const url = typeof plugin.url === 'string' ? plugin.url : ''
  const source = parseSourceUrl(url)
  check(`${at}.url is a parseable GitHub repo url`, source !== null, url)

  // The install route matches by url: registry.plugins.find(p => p.url.toLowerCase() === url).
  // Two entries sharing a url resolve to the first one, so the second installs the wrong plugin.
  check(`${at}.url is unique`, !seenUrls.has(url.toLowerCase()), url)
  seenUrls.add(url.toLowerCase())

  if (source !== null) {
    check(`${at}.owner matches url repo owner`, source.repo.split('/')[0] === plugin.owner,
      `url=${source.repo} owner=${String(plugin.owner)}`)
  }

  const categories = Array.isArray(plugin.category) ? plugin.category : [plugin.category]
  const usable = categories.filter((value) => typeof value === 'string' && value !== '')
  check(`${at} carries a usable category`, usable.length > 0, JSON.stringify(plugin.category))
  for (const id of usable) {
    const declared = catalog.categories?.[id]
    check(`${at}.category "${id}" is declared in categories`,
      declared !== undefined && typeof declared === 'object')
  }

  check(`${at}.description is a non-empty localized record`,
    typeof plugin.description === 'object' && plugin.description !== null
    && Object.keys(plugin.description).length > 0)
  check(`${at}.description has zh`, typeof plugin.description?.zh === 'string'
    && plugin.description.zh.length > 0)
  check(`${at}.install is a non-empty string`, typeof plugin.install === 'string'
    && plugin.install.length > 0)
  check(`${at}.added is a date string`, /^\d{4}-\d{2}-\d{2}$/.test(String(plugin.added ?? '')))

  if (plugin.npm !== undefined && plugin.npm !== null) {
    check(`${at}.npm matches NPM_NAME_RE`, NPM_NAME_RE.test(String(plugin.npm)), String(plugin.npm))
  }

  const target = installTargetFor(plugin)
  check(`${at} resolves to an install target`, target !== null)
  if (target !== null) {
    // Two entries that resolve to the same pnpm target install the same package.
    check(`${at} install target is unique`, !seenTargets.has(target), target)
    seenTargets.add(target)
    console.log(`      → ${at} installs from ${target}`)
  }

  check(`${at}.capabilities is an array when present`,
    plugin.capabilities === undefined || Array.isArray(plugin.capabilities))
}

// ===========================================================================
// Part 2 — the four gates each plugin package must pass
// ===========================================================================

const pluginsRoot = join(here, 'plugins')
let packageDirs = []
if (existsSync(pluginsRoot)) {
  packageDirs = readdirSync(pluginsRoot)
    .map((name) => join(pluginsRoot, name))
    .filter((path) => statSync(path).isDirectory())
} else {
  check('plugins/ directory exists', false)
}

/** Every loader entry id declared anywhere in this marketplace. */
const allEntryIds = []

for (const dir of packageDirs) {
  const pkgName = dir.split(/[\\/]/).pop()
  const at = `plugins/${pkgName}`
  const manifestPath = join(dir, 'package.json')

  // Gate 1 — hasDshManifest(): manifest.dsh !== undefined
  if (!existsSync(manifestPath)) {
    check(`${at} has package.json`, false)
    continue
  }
  let manifest
  try {
    manifest = readJson(manifestPath)
  } catch (error) {
    check(`${at} package.json parses`, false, error.message)
    continue
  }
  check(`${at} declares the dsh field (gate 1: hasDshManifest)`,
    manifest.dsh !== undefined && typeof manifest.dsh === 'object')

  const patchRef = manifest.dsh?.bundle?.patch
  check(`${at} declares dsh.bundle.patch`, typeof patchRef === 'string' && patchRef !== '')

  // Gate 2 — entryArtifactExists(): main, then exports['.'], then index.js
  const candidates = []
  if (typeof manifest.main === 'string') candidates.push(manifest.main)
  const rootExport = manifest.exports?.['.']
  if (typeof rootExport === 'string') candidates.push(rootExport)
  if (candidates.length === 0) candidates.push('index.js')
  const entry = candidates.find((relative) => existsSync(join(dir, relative)))
  check(`${at} entry artifact exists (gate 2: entryArtifactExists)`, entry !== undefined,
    `none of ${candidates.join(', ')} found`)

  // Gate 3 — conflictingEntryIds(): a duplicate id fails the WHOLE profile boot
  if (typeof patchRef === 'string' && patchRef !== '') {
    const patchPath = join(dir, patchRef)
    if (!existsSync(patchPath)) {
      check(`${at} patch file exists`, false, patchRef)
      continue
    }
    let entries
    try {
      entries = parseYaml(readFileSync(patchPath, 'utf8'))
    } catch (error) {
      check(`${at} patch parses`, false, error.message)
      continue
    }
    const ids = []
    for (const block of Array.isArray(entries) ? entries : []) {
      for (const inserted of block?.insert ?? []) {
        if (typeof inserted?.id === 'string' && inserted.id !== '') ids.push(inserted.id)
      }
    }
    check(`${at} patch declares at least one insert id`, ids.length > 0)
    for (const id of ids) {
      check(`${at} entry id "${id}" is globally unique (gate 3: conflictingEntryIds)`,
        !allEntryIds.includes(id), 'already declared by another package in this marketplace')
      allEntryIds.push(id)
    }
  }

  // Gate 4 — the entry module must import cleanly. The two ways this fails in
  // practice: an import of a @deepseek-ai/* package, which a link: install
  // cannot resolve, and a missing vendored runtime.
  if (entry !== undefined) {
    const body = readFileSync(join(dir, entry), 'utf8')
    check(`${at} entry does not import @deepseek-ai/* (gate 4: link: resolution)`,
      !/@deepseek-ai\//.test(body))
  }

  const vendorDir = join(dir, 'vendor')
  check(`${at} vendors the MCP runtime`, existsSync(join(vendorDir, 'craft-mcp.cjs')))
  check(`${at} vendors the parser worker`, existsSync(join(vendorDir, 'craft-parser-worker.js')))

  // A Skill is what carries the usage discipline into the model's context.
  check(`${at} ships a SKILL.md`, existsSync(join(dir, 'skills', 'craft-context', 'SKILL.md')))

  // --- npm publishability ------------------------------------------------
  // The catalog entry names an npm package, so the package has to actually be
  // publishable and installable by a host that knows nothing about this repo.
  const npmName = manifest.name
  check(`${at} declares a publishable package name`,
    typeof npmName === 'string' && NPM_NAME_RE.test(npmName), npmName)
  check(`${at} publishConfig targets the public registry`,
    manifest.publishConfig?.registry === 'https://registry.npmjs.org'
    && manifest.publishConfig?.access === 'public',
    JSON.stringify(manifest.publishConfig))
  check(`${at} declares an engines.dsh range`,
    typeof manifest.engines?.dsh === 'string' && manifest.engines.dsh !== '',
    String(manifest.engines?.dsh))
  check(`${at} declares a repository`, typeof manifest.repository?.url === 'string')

  // A non-optional @deepseek-ai/cordis peer makes pnpm pull the host's whole
  // dependency tree into the user profile — measured at 165 packages and a
  // failed install on dsh-workbuddy-trae-qoder-connect. The plugin imports
  // nothing from that tree, so the peer is declared optional.
  const peers = manifest.peerDependencies ?? {}
  const optionalPeers = manifest.peerDependenciesMeta ?? {}
  const unoptional = Object.keys(peers).filter((name) => optionalPeers[name]?.optional !== true)
  check(`${at} marks every @deepseek-ai peer optional`,
    unoptional.length === 0, unoptional.join(', '))

  // The catalog entry must point at the same package the manifest declares,
  // or the market installs one thing and reports another.
  const catalogEntry = catalog.plugins.find((plugin) => plugin.npm === npmName)
  check(`${at} is referenced by a catalog entry with an npm field`, catalogEntry !== undefined, npmName)
}

console.log('')
if (failures === 0) {
  const pkgs = packageDirs.length
  console.log(`OK  ${catalog.plugins.length} catalog entr${catalog.plugins.length === 1 ? 'y' : 'ies'},`
    + ` ${pkgs} package${pkgs === 1 ? '' : 's'}, 0 failures`)
  process.exit(0)
}
console.log(`${failures} failure(s)`)
process.exit(1)
