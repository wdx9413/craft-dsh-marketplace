/**
 * Ask the market's own activation check about an installed plugin.
 *
 *   node tools/check-activation.mjs [package name]
 *
 * The state a plugin row shows ("installed", "failed to enable", …) comes
 * from dshmarket's verifyActivation, and its reasons say exactly which rule
 * produced the verdict. Reading the code to guess the rule is slower and less
 * reliable than calling it.
 */

import { join } from 'node:path'

const profileDir = process.env.DSH_PROFILE_DIR
  ?? join(process.env.APPDATA, 'dsh-desktop', 'harness', 'profiles', 'web')
const packageName = process.argv[2] ?? 'dsh-craft-context'

const dshmarket = join(profileDir, 'node_modules', 'dshmarket', 'lib', 'verify.js')
const { verifyActivation } = await import(`file:///${dshmarket.replace(/\\/g, '/')}`)

const result = verifyActivation(profileDir, packageName, new Set(), profileDir)
console.log(`package: ${packageName}`)
console.log(`state:   ${result.state}`)
console.log(`bundle:  ${result.bundle}`)
console.log(`hot:     ${result.hot}`)
for (const reason of result.reasons ?? []) console.log(`  - ${reason}`)
if (result.loadedByProfile !== undefined) console.log(`loadedByProfile: ${result.loadedByProfile}`)
if (result.notAPlugin !== undefined) console.log(`notAPlugin: ${result.notAPlugin}`)
