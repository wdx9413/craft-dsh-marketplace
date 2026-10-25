/**
 * Test a plugin's declared host compatibility against the running host.
 *
 *   node tools/check-host-compat.mjs [package dir]
 *
 * The host loader silently skips a bundle whose declared host contract the
 * running runtime fails, on every boot. That silence is why an installed
 * plugin can look installed and never appear. This asks the same question the
 * loader and the market ask, using the same modules.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { semver } from './market-index-validator.mjs'

const packageDir = process.argv[2] ?? 'plugins/craft-context'
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))

const RUNTIME_VERSION = process.env.DSH_RUNTIME_VERSION ?? '0.2.1-rc.2'

console.log(`package: ${manifest.name}@${manifest.version}`)
console.log(`runtime: ${RUNTIME_VERSION}`)
console.log(`engines.dsh: ${manifest.engines?.dsh ?? '(none)'}`)
console.log(`peerDependencies: ${JSON.stringify(manifest.peerDependencies ?? {})}`)
console.log(`peerDependenciesMeta: ${JSON.stringify(manifest.peerDependenciesMeta ?? {})}`)
console.log('')

// semver's own range check, with the prerelease semantics the host uses:
// every published host line is itself a prerelease.
const { satisfies } = semver
const range = manifest.engines?.dsh
if (range === undefined) {
  console.log('no engines.dsh declared — nothing for the loader to check')
} else {
  const ok = satisfies(RUNTIME_VERSION, range, { includePrerelease: true })
  console.log(`${ok ? 'PASS' : 'FAIL'}  the running runtime ${RUNTIME_VERSION} satisfies engines.dsh`)
  console.log(`      ${range}`)
  if (!ok) {
    console.log('')
    console.log('The host loader skips a bundle whose host contract the runtime')
    console.log('fails, on every boot, without saying so. This is what an')
    console.log('installed-but-never-loaded plugin looks like.')
  }
}
