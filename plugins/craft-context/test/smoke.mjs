/**
 * Offline smoke test for the craft-context DSH plugin.
 *
 * Runs the real bundled MCP runtime over stdio, so it proves the handshake,
 * the tool round trip and argument validation rather than only that files
 * exist. No DSH process is involved: this is the plugin's own contract, not a
 * DSH session.
 *
 * It also pins the vendored runtime to the version the plugin declares. The
 * bundle computes its reported version at run time instead of embedding a
 * literal, so a stale artifact cannot be caught by inspecting the file — this
 * assertion is what catches it.
 *
 *   node test/smoke.mjs
 *
 * Exit 0 = every assertion passed, 1 = at least one failed.
 */

import { readFileSync } from 'node:fs'
import { apply, name, inject } from '../lib/index.js'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`)
}

// ---------------------------------------------------------------------------
// A cordis-shaped context: enough surface for apply(), nothing else assumed.
// ---------------------------------------------------------------------------
const registered = new Map()
const effects = []
const services = {
  tools: { register: (tool) => registered.set(tool.name, tool) },
  skills: { register: (skill) => effects.push(`skill:${skill.name}`) },
  settings: { register: (ns) => effects.push(`settings:${ns}`) },
}
const ctx = {
  ...services,
  get: (key) => services[key],
  effect: (factory, label) => { effects.push(`effect:${label}`); return factory() },
}

check('plugin exports a name', typeof name === 'string' && name !== '')
check('plugin injects tools', Array.isArray(inject) && inject.includes('tools'))

apply(ctx, {})
check('registers three tools', registered.size === 3, [...registered.keys()].join(', '))
check('registers the Skill', effects.includes('skill:craft-context'))
check('registers settings', effects.includes('settings:craft-context'))
check('registers the MCP client as an effect', effects.some((entry) => entry.startsWith('effect:')))

for (const [toolName, tool] of registered) {
  const shapeOk = tool.parameters?.type === 'object'
    && typeof tool.parameters.properties === 'object'
    && typeof tool.output?.schema === 'object'
    && typeof tool.output.render === 'function'
    && typeof tool.execute === 'function'
  check(`${toolName} carries the compiled definition shape`, shapeOk)
}

// ---------------------------------------------------------------------------
// Real MCP round trips.
// ---------------------------------------------------------------------------
const info = registered.get('craft_context_info')
const list = registered.get('craft_context_tools')
const call = registered.get('craft_context_call')

try {
  const infoValue = await info.execute({})
  check('craft_context_info returns craft_info', infoValue?.version !== undefined,
    JSON.stringify(infoValue).slice(0, 120))

  // The runtime must report the version this plugin declares. A mismatch means
  // the vendored bundle was not re-synced after a Craft release.
  const here = dirname(fileURLToPath(import.meta.url))
  const declared = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version
  check('vendored runtime matches the declared version', infoValue?.version === declared,
    `runtime=${String(infoValue?.version)} declared=${declared}`)
} catch (error) {
  check('craft_context_info returns craft_info', false, error.message)
}

let listing
try {
  listing = await list.execute({})
  check('craft_context_tools lists the runtime surface', listing?.tool_count > 0,
    `count=${String(listing?.tool_count)}`)
  check('compact listing omits schemas', listing?.tools?.every((tool) => tool.inputSchema === undefined))
  check('compact listing carries argument names', listing?.tools?.every((tool) => Array.isArray(tool.args)))
} catch (error) {
  check('craft_context_tools lists the runtime surface', false, error.message)
}

try {
  const expanded = await list.execute({ include_schemas: true, include_skill: true })
  check('include_schemas adds inputSchema', expanded?.tools?.some((tool) => tool.inputSchema !== undefined))
  check('include_skill adds the Skill body',
    typeof expanded?.skill === 'string' && expanded.skill.includes('Craft Context'))
} catch (error) {
  check('opt-in flags expand the listing', false, error.message)
}

try {
  const called = await call.execute({ tool: 'craft_info', arguments_json: '{}' })
  check('craft_context_call reaches craft_info', called?.version !== undefined)
} catch (error) {
  check('craft_context_call reaches craft_info', false, error.message)
}

// ---------------------------------------------------------------------------
// Argument validation must reject junk instead of forwarding it.
// ---------------------------------------------------------------------------
const rejections = [
  ['an empty tool name', { tool: '' }],
  ['malformed arguments_json', { tool: 'craft_info', arguments_json: '{oops' }],
  ['a JSON array arguments_json', { tool: 'craft_info', arguments_json: '[1,2]' }],
  ['a JSON scalar arguments_json', { tool: 'craft_info', arguments_json: '42' }],
]
for (const [label, args] of rejections) {
  try {
    await call.execute(args)
    check(`craft_context_call rejects ${label}`, false, 'the call was accepted')
  } catch {
    check(`craft_context_call rejects ${label}`, true)
  }
}

// ---------------------------------------------------------------------------
// The effect must be disposable. The MCP child holds the event loop open, so a
// client that cannot be reaped would keep a DSH unload from completing.
// ---------------------------------------------------------------------------
let disposed = false
{
  const registeredOnce = new Map()
  const servicesOnce = { tools: { register: (tool) => registeredOnce.set(tool.name, tool) } }
  const ctxOnce = {
    get: (key) => servicesOnce[key],
    effect: (factory) => factory(),
  }
  apply(ctxOnce, {})
  const infoOnce = registeredOnce.get('craft_context_info')
  await infoOnce.execute({})

  // apply() keeps the client inside the effect closure, so the only handle the
  // host has is the disposer it registered. Reach it the same way cordis does.
  const effects = []
  const ctxWithEffects = {
    ...servicesOnce,
    get: (key) => servicesOnce[key],
    effect: (factory) => { const value = factory(); effects.push(value); return value },
  }
  apply(ctxWithEffects, {})
  for (const client of effects) client.dispose?.()
  disposed = effects.every((client) => typeof client.dispose === 'function')
}
check('the MCP client is disposable', disposed)

console.log('')
if (failures === 0) {
  console.log('OK  craft-context smoke test passed')
  process.exit(0)
}
console.log(`${failures} failure(s)`)
process.exit(1)
