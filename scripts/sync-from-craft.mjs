#!/usr/bin/env node
/**
 * Sync the vendored Craft runtime from a local craft checkout.
 *
 *   node scripts/sync-from-craft.mjs [path-to-craft]
 *
 * Defaults to the sibling `craft` directory, which is the layout on the machine
 * this was built on (mytest/craft-dsh-marketplace and mytest/craft). Pass an
 * explicit path anywhere else.
 *
 * Why a local checkout rather than a download: craft keeps dist/ out of Git,
 * and the networks that can reach GitHub here do so over SSH only, so there is
 * no HTTP artifact to fetch. A local checkout is the honest source.
 *
 * The script refuses to sync a runtime whose version does not match what the
 * plugin declares, because a silently older runtime is the failure mode that
 * is hardest to notice: the plugin would report one version and behave like
 * another.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const pluginDir = join(root, 'plugins', 'craft-context')
const vendorDir = join(pluginDir, 'vendor')

const craftArg = process.argv[2]
const craftRoot = resolve(craftArg ?? join(root, '..', 'craft'))

const ARTIFACTS = ['craft-mcp.cjs', 'craft-parser-worker.js']
const sha256 = (buffer) => `sha256:${createHash('sha256').update(buffer).digest('hex')}`

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

if (!existsSync(craftRoot)) fail(`no craft checkout at ${craftRoot}`)
if (!existsSync(join(craftRoot, 'package.json'))) fail(`${craftRoot} is not a craft checkout`)

const manifest = JSON.parse(readFileSync(join(craftRoot, 'package.json'), 'utf8'))
const craftVersion = manifest.version
const pluginManifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))

if (pluginManifest.version !== craftVersion) {
  fail(`version mismatch: plugin declares ${pluginManifest.version}, craft checkout is ${craftVersion}.\n`
    + `Update plugins/craft-context/package.json first so the two cannot drift silently.`)
}

mkdirSync(vendorDir, { recursive: true })
const artifacts = {}

for (const name of ARTIFACTS) {
  const source = join(craftRoot, 'dist', 'plugin', name)
  if (!existsSync(source)) fail(`missing ${source} — run \`pnpm run build:plugin\` in the craft checkout first`)
  const content = readFileSync(source)
  copyFileSync(source, join(vendorDir, name))
  artifacts[name] = { sha256: sha256(content), bytes: content.length }
  process.stdout.write(`synced ${name}  ${content.length} bytes  from ${source}\n`)
}

// The bundle computes its reported version at run time rather than embedding a
// literal, so the artifact cannot be checked for staleness by grepping it. What
// it CAN be checked for is the release constant it was built from; a bundle
// built before the last version bump still carries the older constant.
const bundle = readFileSync(join(vendorDir, 'craft-mcp.cjs'), 'utf8')
const constant = /CRAFT_RELEASE_VERSION\s*=\s*"(\d+\.\d+\.\d+)"/.exec(bundle)
if (constant === null) fail('could not find the release constant in the bundle')
if (constant[1] !== craftVersion) {
  fail(`the bundle was built from ${constant[1]} but the checkout is ${craftVersion} — rebuild before syncing`)
}
// The version the runtime actually reports is asserted at run time by
// plugins/craft-context/test/smoke.mjs, against the same number.

writeFileSync(join(vendorDir, 'SOURCE.json'), `${JSON.stringify({
  source: 'craft',
  synced_from: craftRoot,
  version: craftVersion,
  synced_at: new Date().toISOString(),
  artifacts,
}, null, 2)}\n`)

process.stdout.write(`\nOK  vendored craft ${craftVersion} (bundle built from ${constant[1]})\n`)
process.stdout.write('verify with: node plugins/craft-context/test/smoke.mjs\n')
