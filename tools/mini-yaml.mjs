/**
 * The smallest YAML reader that can parse a cordis patch file.
 *
 * Only the shape a plugin package's cordis.patch.yml actually uses is supported:
 *
 *   - insert:
 *       - id: some-id
 *         name: some-package
 *         config:
 *           key: value
 *
 * That is: a top-level sequence of mappings, an insert key holding a nested
 * sequence, scalar leaves, and one level of nested mapping. Anything else,
 * such as anchors, multi-line scalars, flow collections or tag expressions,
 * is rejected rather than guessed at: a patch file that parses wrong is worse
 * than one that refuses to parse.
 *
 * The point of reading the patch here is to enumerate loader entry ids, which
 * is exactly this subset.
 *
 * Strategy: a two-pass indent walk. Pass one turns each line into a token
 * (sequence entry or mapping pair) with its indent. Pass two assembles them
 * with an explicit stack, so a key whose value turns out to be a sequence
 * instead of a mapping is decided by what actually follows it.
 */

/** @typedef {{ indent: number, kind: 'seq' | 'map', key?: string, value?: string }} Token */

function tokenize(source) {
  /** @type {Token[]} */
  const tokens = []
  for (const raw of source.split(/\r?\n/)) {
    // A '#' begins a comment only at the start of the token or after whitespace.
    const at = raw.search(/(^|\s)#/)
    const line = (at === -1 ? raw : raw.slice(0, at)).trimEnd()
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    const text = line.trim()

    if (text.startsWith('!!')) {
      throw new Error(`cordis patch: unsupported tag expression "${text}"`)
    }
    if (text === '-') {
      tokens.push({ indent, kind: 'seq' })
      continue
    }
    if (text.startsWith('- ')) {
      const rest = text.slice(2).trim()
      const pair = /^([\w.-]+):(.*)$/.exec(rest)
      if (pair === null) throw new Error(`cordis patch: unsupported sequence item "${text}"`)
      tokens.push({ indent, kind: 'seq' })
      tokens.push({ indent: indent + 2, kind: 'map', key: pair[1], value: pair[2].trim() })
      continue
    }
    const pair = /^([\w.-]+):(.*)$/.exec(text)
    if (pair === null) throw new Error(`cordis patch: unsupported line "${text}"`)
    tokens.push({ indent, kind: 'map', key: pair[1], value: pair[2].trim() })
  }
  return tokens
}

function scalar(text) {
  const value = text.trim()
  const unquoted = value.length >= 2
    && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ? value.slice(1, -1)
    : value
  if (unquoted === 'true') return true
  if (unquoted === 'false') return false
  if (unquoted === 'null' || unquoted === '~') return null
  if (/^-?\d+$/.test(unquoted)) return Number(unquoted)
  return unquoted
}

/**
 * @param {string} source the patch file body
 * @returns {Array<Record<string, unknown>>} the top-level sequence of mappings
 */
export function parseYaml(source) {
  const tokens = tokenize(source)
  if (tokens.length === 0) return []

  // frames: { indent, container, pendingKey }
  /** @type {{ indent: number, container: unknown, pendingKey: string | null }[]} */
  const frames = [{ indent: -1, container: [], pendingKey: null }]

  const currentFrame = () => frames[frames.length - 1]
  const parentFrameFor = (indent) => {
    while (frames.length > 1 && currentFrame().indent >= indent) frames.pop()
    return currentFrame()
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    const frame = parentFrameFor(token.indent)
    const container = frame.container

    if (token.kind === 'seq') {
      if (!Array.isArray(container)) {
        throw new Error(`cordis patch: sequence entry at indent ${token.indent} has no sequence to join`)
      }
      const item = {}
      container.push(item)
      frame.pendingKey = null
      frames.push({ indent: token.indent, container: item, pendingKey: null })
      continue
    }

    const key = token.key
    if (token.value !== '') {
      if (Array.isArray(container)) {
        throw new Error(`cordis patch: mapping pair "${key}" inside a sequence item`)
      }
      if (container === null || typeof container !== 'object') {
        throw new Error(`cordis patch: cannot assign "${key}"`)
      }
      container[key] = scalar(token.value)
      frame.pendingKey = null
      continue
    }

    // A key with no value: the next deeper token decides whether it opens a
    // mapping or a sequence. Reserve the slot now, fill it on the next token.
    if (Array.isArray(container) || container === null || typeof container !== 'object') {
      throw new Error(`cordis patch: cannot open "${key}" here`)
    }
    frame.pendingKey = key
    frames.push({ indent: token.indent, container: null, pendingKey: null })

    const next = tokens[index + 1]
    if (next !== undefined && next.indent > token.indent) {
      const opened = next.kind === 'seq' ? [] : {}
      const parent = frames[frames.length - 2] ?? frames[0]
      const target = parent.container
      if (Array.isArray(target) || target === null || typeof target !== 'object') {
        throw new Error(`cordis patch: cannot attach "${key}"`)
      }
      target[key] = opened
      frames[frames.length - 1] = { indent: token.indent, container: opened, pendingKey: null }
    }
  }

  return frames[0].container
}
