/**
 * craft-context for DeepSeek Desktop.
 *
 * A cordis plugin that registers three tools over the bundled Craft MCP runtime:
 *
 *   craft_context_info      runtime identity and data space (cheap health probe)
 *   craft_context_tools     the actual tool names + schemas + the bundled Skill
 *   craft_context_call      call one discovered tool with its exact arguments
 *
 * Two tools rather than one opaque `craft_call`, and not the full 1:1 tool set:
 * schema text is re-sent on every request, so the full Context surface would be
 * paid for in tokens on every turn even when unused. Discovery + a fallback
 * keeps all of Craft reachable while the standing cost stays flat — the same
 * progressive disclosure the DSH skill mechanism uses.
 *
 * `inject: ['tools']` is the hard dependency. Skills and settings are optional
 * and read through `ctx.get`, so the plugin still loads on a host without them.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createCraftClient } from './mcp-client.js'
import { defineTool } from './tool.js'

const PRODUCT = 'context'

/** The bundled SKILL.md body, read once at apply time. */
function skillBody(moduleUrl = import.meta.url) {
  const here = dirname(fileURLToPath(moduleUrl))
  for (const candidate of [
    join(here, '..', 'skills', 'craft-context', 'SKILL.md'),
    join(here, '..', '..', 'skills', 'craft-context', 'SKILL.md'),
  ]) {
    try {
      return readFileSync(candidate, 'utf8')
    } catch {
      continue
    }
  }
  return null
}

// Compact on purpose. Indentation is for human eyes; every space here is a
// token the model pays for on each call, and the 91-tool listing measures
// 34.5 KB unindented against 57 KB at two-space indent.
const render = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]

export const name = 'craft-context'
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const clientOptions = {
    product: config.product ?? PRODUCT,
    ...(config.bundlePath ? { bundlePath: config.bundlePath } : {}),
    ...(config.dataDir ? { dataDir: config.dataDir } : {}),
    ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
  }

  // The child process is an effect so unload/restart reaps it; without this a
  // removed plugin leaves an orphan MCP process holding the SQLite handle.
  const client = ctx.effect
    ? ctx.effect(() => createCraftClient(clientOptions), 'craft-context: mcp client')
    : createCraftClient(clientOptions)

  const tools = ctx.get('tools')
  if (tools !== undefined) {
    tools.register(defineTool({
      name: 'craft_context_info',
      description: 'Craft runtime identity, version and data space id. Use it to confirm the plugin is installed and answering before calling other Craft tools.',
      parameters: {},
      output: { schema: { type: 'object' }, render },
      timeoutMs: 60_000,
      execute: async () => {
        const result = await client.callTool('craft_info', {})
        return result?.structuredContent ?? result
      },
    }))

    tools.register(defineTool({
      name: 'craft_context_tools',
      description: 'List the Craft Context tools this runtime exposes: name, one-line description and required arguments. Pass include_schemas=true for full JSON schemas and include_skill=true for the bundled craft-context Skill. Call this before craft_context_call to learn the exact tool name and arguments.',
      parameters: {
        include_schemas: { type: 'boolean', required: false, description: 'Include each tool full JSON inputSchema. Off by default: 91 schemas are tens of thousands of tokens.' },
        include_skill: { type: 'boolean', required: false, description: 'Include the bundled craft-context SKILL.md body.' },
      },
      output: { schema: { type: 'object' }, render },
      timeoutMs: 60_000,
      execute: async (params) => {
        const listed = await client.listTools()
        const tools = (listed?.tools ?? []).map((tool) => {
          const schema = tool.inputSchema ?? {}
          const required = Array.isArray(schema.required) ? schema.required : []
          const properties = schema.properties ?? {}
          const argList = Object.keys(properties).map((name) => ({
            name,
            required: required.includes(name),
            type: properties[name]?.type ?? 'any',
          }))
          return {
            name: tool.name,
            description: tool.description ?? '',
            args: argList,
            ...(params.include_schemas === true ? { inputSchema: schema } : {}),
          }
        })
        return {
          product: client.product,
          tool_count: tools.length,
          tools,
          ...(params.include_skill === true ? { skill: skillBody() } : {}),
        }
      },
    }))

    tools.register(defineTool({
      name: 'craft_context_call',
      description: 'Call one Craft Context tool discovered through craft_context_tools, passing its exact JSON arguments. Returns the tool result or a structured error.',
      parameters: {
        tool: { type: 'string', required: true, description: 'Craft MCP tool name, e.g. craft_context_open' },
        arguments_json: { type: 'string', required: false, description: 'JSON object matching the discovered inputSchema' },
      },
      output: { schema: { type: 'object' }, render },
      timeoutMs: 180_000,
      execute: async (args) => {
        if (!args.tool?.trim()) throw new Error('tool must be a non-empty Craft tool name')
        let parsed = {}
        if (args.arguments_json !== undefined && args.arguments_json !== null && String(args.arguments_json).trim() !== '') {
          try {
            parsed = JSON.parse(String(args.arguments_json))
          } catch {
            throw new Error('arguments_json must be valid JSON')
          }
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('arguments_json must contain a JSON object')
        }
        const result = await client.callTool(args.tool.trim(), parsed)
        if (result?.isError === true) {
          const text = result.content?.[0]?.text
          throw new Error(typeof text === 'string' && text !== '' ? text : 'Craft tool call failed')
        }
        return result?.structuredContent ?? result
      },
    }))
  }

  // Optional: the Skill carries the usage discipline that keeps Craft's gates
  // intact. Registered only where the host exposes a skills service.
  const skills = ctx.get('skills')
  if (skills !== undefined && typeof skills.register === 'function') {
    const body = skillBody()
    if (body !== null) {
      skills.register({
        name: 'craft-context',
        description: "Use Craft Context when an Agent needs governed knowledge, scoped memory, or a reproducible context pack without the complete Craft work runtime.",
        content: body,
        source: 'custom',
      })
    }
  }

  // Optional: surface the data directory and timeouts in the settings page.
  const settings = ctx.get('settings')
  if (settings !== undefined && typeof settings.register === 'function') {
    settings.register('craft-context', {
      dataDir: { type: 'string', default: '', description: 'CRAFT_DATA_DIR override. Empty uses the default ~/.craft_data.' },
      timeoutMs: { type: 'number', default: 120000, description: 'Per-request MCP timeout in milliseconds.' },
    })
  }
}
