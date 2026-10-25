/**
 * The market's own index validator, loaded from the installed DSH.
 *
 *   import { parseMarketIndex, MarketIndexError } from './market-index-validator.mjs'
 *
 * The official Discover index source is validated by
 * `@deepseek-ai/dsh-plugin-market-index`. Reimplementing that validator would
 * mean guessing at rules that are enforced in the host, and the failure mode
 * is a message that says nothing about which rule was broken. So the real
 * module is extracted from the DSH asar and imported instead.
 *
 * The asar is 369 MB, so extracting it per run is too slow. The extracted
 * files are cached under the OS temp directory; the cache is rebuilt whenever
 * the asar is newer than it.
 *
 * `semver` is a CommonJS package the validator imports as ESM, so a small
 * ESM wrapper is written next to it. The wrapper is what makes
 * `import semver from "semver"` resolve to the CommonJS default export.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const ASAR_PATH = process.env.ASAR_PATH ?? 'D:\\application\\dshdesktop\\DSH Desktop\\resources\\app.asar'
const CACHE_DIR = join(tmpdir(), 'dsh-index-validator')
const VALIDATOR_PATH = join(CACHE_DIR, 'plugin-market-index.mjs')
const SEMVER_DIR = join(CACHE_DIR, 'node_modules', 'semver')

const VALIDATOR_ENTRY = 'node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js'

/** Read one file out of the asar by its path. */
function readAsarFile(asarPath, target) {
  const buffer = readFileSync(asarPath)
  let start = 8
  while (start < 64 && buffer[start] !== 0x7b) start += 1
  const headerLength = buffer.readUInt32LE(4)
  const header = JSON.parse(buffer.subarray(start, start + headerLength).toString('utf8'))
  // An entry's offset is relative to the file DATA region, which begins after
  // the header and its 4-byte alignment padding — not at byte 0.
  const dataStart = 8 + Math.ceil(headerLength / 4) * 4

  let node = header
  for (const segment of target.split('/')) {
    node = node?.files?.[segment]
    if (node === undefined) return null
  }
  if (node === undefined || node.files !== undefined) return null
  const offset = Number(node.offset)
  const size = Number(node.size)
  return buffer.subarray(dataStart + offset, dataStart + offset + size)
}

/** The asar's header text, used to locate the semver files it carries. */
function asarHeaderText(asarPath) {
  const buffer = readFileSync(asarPath)
  let start = 8
  while (start < 64 && buffer[start] !== 0x7b) start += 1
  const headerLength = buffer.readUInt32LE(4)
  return buffer.subarray(start, start + headerLength).toString('utf8')
}

function asarIsNewerThanCache() {
  if (!existsSync(VALIDATOR_PATH)) return true
  if (statSync(ASAR_PATH).mtimeMs > statSync(VALIDATOR_PATH).mtimeMs) return true
  // The semver wrapper is written separately from the validator, and a stray
  // npm install into the cache replaces it. Both have to be present.
  return !existsSync(join(SEMVER_DIR, 'index.mjs'))
}

/**
 * The semver the validator needs, as an ESM module.
 *
 * The asar's copy is CommonJS and the validator imports it as ESM, so a
 * wrapper is required. The cache prefers an installed copy — npm has it in
 * seconds, while rebuilding it from the 369 MB asar takes minutes — and
 * falls back to extracting the host's own.
 */
async function loadSemver() {
  if (!existsSync(join(SEMVER_DIR, 'index.mjs'))) {
    try {
      extractSemver()
    } catch {
      // The asar path is a fallback, not the only way.
    }
  }
  return import(pathToFileURL(join(SEMVER_DIR, 'index.mjs')).href)
    .catch(() => import('semver'))
}

function extractValidator() {
  mkdirSync(CACHE_DIR, { recursive: true })
  const source = readAsarFile(ASAR_PATH, VALIDATOR_ENTRY)
  if (source === null) {
    throw new Error(`could not read ${VALIDATOR_ENTRY} out of ${ASAR_PATH}`)
  }
  writeFileSync(VALIDATOR_PATH, source)
}

function extractSemver() {
  // semver is a CommonJS package that the validator imports as ESM. The
  // asar's copy is used, with a wrapper that exposes its default export.
  // The directory is rebuilt from scratch: a stray npm install into this
  // cache replaces the wrapper with a package whose exports map has no
  // import condition, and the validator then fails to load.
  rmSync(SEMVER_DIR, { recursive: true, force: true })
  mkdirSync(SEMVER_DIR, { recursive: true })
  const header = asarHeaderText(ASAR_PATH)
  const at = header.indexOf('"semver":{"files"')
  if (at === -1) throw new Error('semver is not in the asar')
  const segment = header.slice(at, at + 12000)
  const files = [...segment.matchAll(/"([\w.-]+\.js)":\{"size":(\d+),"offset":"(\d+)"/g)]
  if (files.length === 0) throw new Error('no semver files found in the asar header')

  const buffer = readFileSync(ASAR_PATH)
  let start = 8
  while (start < 64 && buffer[start] !== 0x7b) start += 1
  const headerLength = buffer.readUInt32LE(4)
  const dataStart = 8 + Math.ceil(headerLength / 4) * 4

  for (const file of files) {
    const name = file[1]
    const size = Number(file[2])
    const offset = Number(file[3])
    writeFileSync(join(SEMVER_DIR, name), buffer.subarray(dataStart + offset, dataStart + offset + size))
  }
  writeFileSync(join(SEMVER_DIR, 'package.json'),
    '{ "name": "semver", "version": "7.7.0", "type": "commonjs", "main": "index.js",'
    + ' "exports": { ".": { "import": "./index.mjs", "require": "./index.js" } } }')
  const wrapper = `import semverCommon from './index.js'\n`
    + 'export const SemVer = semverCommon.SemVer\n'
    + 'export const Range = semverCommon.Range\n'
    + 'export const Comparator = semverCommon.Comparator\n'
    + 'export const valid = semverCommon.valid\n'
    + 'export const validRange = semverCommon.validRange\n'
    + 'export const rcompare = semverCommon.rcompare\n'
    + 'export const compare = semverCommon.compare\n'
    + 'export const gt = semverCommon.gt\n'
    + 'export const gte = semverCommon.gte\n'
    + 'export const lt = semverCommon.lt\n'
    + 'export const lte = semverCommon.lte\n'
    + 'export const eq = semverCommon.eq\n'
    + 'export const satisfies = semverCommon.satisfies\n'
    + 'export const major = semverCommon.major\n'
    + 'export const minor = semverCommon.minor\n'
    + 'export const patch = semverCommon.patch\n'
    + 'export const prerelease = semverCommon.prerelease\n'
    + 'export const clean = semverCommon.clean\n'
    + 'export const coerce = semverCommon.coerce\n'
    + 'export const diff = semverCommon.diff\n'
    + 'export const inc = semverCommon.inc\n'
    + 'export default semverCommon\n'
  writeFileSync(join(SEMVER_DIR, 'index.mjs'), wrapper)
}

if (asarIsNewerThanCache()) {
  extractValidator()
  extractSemver()
}

const module_ = await import(pathToFileURL(VALIDATOR_PATH).href)
export const parseMarketIndex = module_.parseMarketIndex
export const MarketIndexError = module_.MarketIndexError
export const marketInstallTarget = module_.marketInstallTarget

// The same semver the validator uses, so a range check here is the check the
// host's own loader makes.
export const semver = await loadSemver()

/**
 * Whether a package is actually in a registry.
 *
 * A catalog entry may name a package that was never published, and the market
 * then answers its version question with a 404 — the "failed to fetch market
 * version" report. This is the check that catches it before a user does.
 */
export async function npmExists(registry, name) {
  try {
    const res = await fetch(`${registry}/${encodeURIComponent(name)}`, {
      headers: { accept: 'application/json', 'user-agent': 'craft-dsh-marketplace-probe' },
    })
    if (!res.ok) return false
    const doc = await res.json()
    return typeof doc?.name === 'string' && doc.name === name
  } catch {
    return false
  }
}
