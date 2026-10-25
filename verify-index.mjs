#!/usr/bin/env node
/**
 * Validate this marketplace.
 *
 * Part 1 — the index document. The official Discover index source is read by
 * `@deepseek-ai/dsh-plugin-market-index`, whose format 1 validator is what
 * produces "This index is not in a valid format". That validator is used
 * here directly, extracted from the installed DSH asar, so an index that
 * passes this passes the same check the Discover section runs.
 *
 * Part 2 — the four gates every plugin package must pass or the market
 * uninstalls it. Transcribed from dshmarket@1.66.42 source, not guessed:
 *   - hasDshManifest()                src/profile.ts   (manifest.dsh !== undefined)
 *   - entryArtifactExists()           src/profile.ts   (main / exports['.'] / index.js)
 *   - conflictingEntryIds()           src/install.ts   (duplicate loader entry id)
 *   - installTargetFor()              src/sources.ts   (npm > tarball > github:)
 *   - NPM_NAME_RE                     src/sources.ts
 *
 * Network access: none, except the optional npm reachability check.
 * Exit 0 = pass, 1 = fail.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseYaml } from './tools/mini-yaml.mjs'
import { parseMarketIndex, MarketIndexError, npmExists } from './tools/market-index-validator.mjs'

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
// Part 1 — the index document, validated by the market's own validator
// ===========================================================================

const indexPath = join(here, 'index.json')
let document
try {
  document = readJson(indexPath)
} catch (error) {
  console.log(`FAIL  index.json parses — ${error.message}`)
  process.exit(1)
}

const INDEX_URL = 'https://raw.githubusercontent.com/wdx9413/craft-dsh-marketplace/main/index.json'
let index = null
try {
  index = parseMarketIndex(document, INDEX_URL)
  check('the index satisfies the market format 1 validator', true)
} catch (error) {
  if (error instanceof MarketIndexError) {
    check('the index satisfies the market format 1 validator', false, `${error.path} ${error.reason}`)
  } else {
    check('the index satisfies the market format 1 validator', false, String(error?.message ?? error))
  }
  process.exit(1)
}

console.log(`      title: ${index.title.en}`)
console.log(`      plugins: ${index.plugins.length}`)

for (const plugin of index.plugins) {
  const at = `plugins (${plugin.name})`
  check(`${at} declares a valid npm package name`, NPM_NAME_RE.test(plugin.name), plugin.name)
  check(`${at} has at least one version`, plugin.versions.length > 0)

  for (const version of plugin.versions) {
    console.log(`      → ${at}@${version.version}  source=${version.source.type}`)

    if (version.source.type === 'npm') {
      // An npm-sourced version must exist in the registry, or the market's
      // version question answers 404 and the row reports "failed to fetch
      // market version".
      const registry = version.source.registry ?? 'https://registry.npmjs.org'
      const reachable = await npmExists(registry, plugin.name)
      check(`${at}@${version.version} npm package is published`, reachable, plugin.name)
    } else {
      check(`${at}@${version.version} pins a full commit SHA`,
        /^[0-9a-f]{40}$/.test(version.source.commit), version.source.commit)
      check(`${at}@${version.version} names a repository`,
        /^(?:\/[^/]+){2,}$/.test(new URL(version.source.url).pathname), version.source.url)
    }

    if (version.engines.dsh !== undefined) {
      check(`${at}@${version.version} declares a dsh engine range`, true, version.engines.dsh)
    }
  }
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

  // A non-optional @deepseek-ai/cordis peer makes pnpm pull the host's whole
  // dependency tree into the user profile — measured at 165 packages and a
  // failed install on dsh-workbuddy-trae-qoder-connect. The plugin imports
  // nothing from that tree, so the peer is declared optional.
  const peers = manifest.peerDependencies ?? {}
  const optionalPeers = manifest.peerDependenciesMeta ?? {}
  const unoptional = Object.keys(peers).filter((name) => optionalPeers[name]?.optional !== true)
  check(`${at} marks every @deepseek-ai peer optional`,
    unoptional.length === 0, unoptional.join(', '))

  // The index entry must name the same package the manifest declares, or the
  // market installs one thing and reports another.
  const named = index.plugins.find((plugin) => plugin.name === npmName)
  check(`${at} is named by an index entry`, named !== undefined, npmName)
}

console.log('')
if (failures === 0) {
  const pkgs = packageDirs.length
  console.log(`OK  ${index.plugins.length} index entr${index.plugins.length === 1 ? 'y' : 'ies'},`
    + ` ${pkgs} package${pkgs === 1 ? '' : 's'}, 0 failures`)
  process.exit(0)
}
console.log(`${failures} failure(s)`)
process.exit(1)
