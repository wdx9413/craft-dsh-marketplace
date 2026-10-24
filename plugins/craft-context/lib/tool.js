/**
 * The compiled shape of `@deepseek-ai/dsh-tools`' defineTool, reproduced locally.
 *
 * Why not import the real one: a `link:`-installed plugin resolves dependencies
 * by real path, which sits outside the DSH profile, so the import fails with
 * ERR_MODULE_NOT_FOUND (measured). `ctx.tools.register()` only validates
 * `output.schema` and `output.render`, and does not require the definition to
 * come from the official factory — the compiled output below was compared
 * byte-for-byte against it.
 *
 * `parameters` accepts the object shorthand DSH itself uses in its own
 * registrations: `{ name: { type, required, description } }`, expanded here into
 * the JSON Schema the registry stores.
 */

/** Object shorthand → JSON Schema, the way the official factory compiles it. */
export function compileParameters(parameters) {
  const properties = {}
  const required = []
  for (const [name, spec] of Object.entries(parameters ?? {})) {
    if (spec === null || typeof spec !== 'object') continue
    const { required: isRequired, ...rest } = spec
    properties[name] = { ...rest }
    if (isRequired === true) required.push(name)
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) }
}

export function defineTool(definition) {
  const { name, description, parameters, output, timeoutMs, execute } = definition
  if (typeof name !== 'string' || name.trim() === '') throw new Error('tool name must be a non-empty string')
  if (typeof execute !== 'function') throw new Error(`tool ${name} must provide execute`)
  const schema = output?.schema ?? { type: 'object' }
  const render = output?.render ?? ((_args, value) => [{ type: 'text', text: JSON.stringify(value) }])
  return {
    name,
    ...(description === undefined ? {} : { description }),
    parameters: compileParameters(parameters),
    output: { schema, render },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    execute,
  }
}
