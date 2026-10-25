#!/usr/bin/env node
/**
 * Fetch the published index and validate it the way the Discover section does.
 *
 *   node tools/catalog-probe.mjs [url]
 *
 * This covers the hop a local check cannot: the URL a user pastes into
 * Plugins -> Discover -> Index sources has to serve a document the market's
 * format 1 validator accepts, and the package it names has to exist in the
 * registry — otherwise the market answers its version question with a 404
 * and the row reports "failed to fetch market version".
 */

import { argv } from 'node:process'
import { parseMarketIndex, MarketIndexError, npmExists } from './market-index-validator.mjs'

const DEFAULT_URL = 'https://raw.githubusercontent.com/wdx9413/craft-dsh-marketplace/main/index.json'
const url = argv[2] ?? DEFAULT_URL

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`)
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
check('the body is under the market 128 MB ceiling', Buffer.byteLength(body) < 128 * 1024 * 1024,
  `${Buffer.byteLength(body)} bytes`)

let document
try {
  document = JSON.parse(body)
} catch (error) {
  console.log(`FAIL  the body parses as JSON — ${error.message}`)
  process.exit(1)
}

let index
try {
  index = parseMarketIndex(document, url)
  check('the published index satisfies the market format 1 validator', true)
} catch (error) {
  if (error instanceof MarketIndexError) {
    check('the published index satisfies the market format 1 validator', false,
      `${error.path} ${error.reason}`)
  } else {
    check('the published index satisfies the market format 1 validator', false, String(error))
  }
  process.exit(1)
}

console.log(`      title: ${index.title.en}`)
console.log(`      plugins: ${index.plugins.length}`)

for (const plugin of index.plugins) {
  for (const version of plugin.versions) {
    console.log(`      → ${plugin.name}@${version.version}  source=${version.source.type}`)

    if (version.source.type === 'npm') {
      const registry = version.source.registry ?? 'https://registry.npmjs.org'
      const reachable = await npmExists(registry, plugin.name)
      check(`${plugin.name} is published in ${registry}`, reachable, plugin.name)
    } else {
      // A git source is pinned to a commit; the market builds
      // `git+<url>.git#<commit>&path:/<dir>` from it.
      check(`${plugin.name}@${version.version} pins a full commit SHA`,
        /^[0-9a-f]{40}$/.test(version.source.commit), version.source.commit)
    }
  }
}

console.log('')
if (failures === 0) {
  console.log('OK  the published index satisfies the market')
  process.exit(0)
}
console.log(`${failures} failure(s)`)
process.exit(1)
