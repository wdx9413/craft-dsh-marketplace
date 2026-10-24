/**
 * A long-lived stdio MCP client for the bundled Craft runtime.
 *
 * One child process serves every call: initialize plus the initialized
 * notification happen once, then each request is matched by id. The process is
 * started lazily on first use and reaped after an idle window, so an
 * installed-but-unused plugin costs nothing.
 *
 * No @deepseek-ai/* import on purpose. A link:-installed plugin resolves its
 * dependencies by real path, which sits outside the DSH profile, so importing
 * @deepseek-ai/dsh-tools here fails with ERR_MODULE_NOT_FOUND (measured).
 *
 * Design note: the handshake and the request loop share ONE stdout reader.
 * An earlier version registered a second reader after the handshake and the
 * first one kept consuming lines, so responses never reached the request map.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

const PROTOCOL_VERSIONS = ['2025-03-26', '2025-06-18', '2025-11-25']
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_BYTES = 8_000_000
const DEFAULT_IDLE_MS = 300_000

/** Where the bundled runtime lives, resolved from this file's own location. */
export function bundlePath(moduleUrl = import.meta.url) {
  const here = dirname(fileURLToPath(moduleUrl))
  const candidate = join(here, '..', 'vendor', 'craft-mcp.cjs')
  return existsSync(candidate) ? candidate : null
}

export function createCraftClient(options = {}) {
  const product = options.product ?? 'context'
  const command = options.command ?? process.execPath
  const bundle = options.bundle ?? bundlePath()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS

  if (bundle === null) {
    throw new Error('craft-context: the bundled craft-mcp.cjs runtime is missing')
  }

  const args = [bundle, '--product', product]
  const env = { ...process.env, ...(options.dataDir ? { CRAFT_DATA_DIR: options.dataDir } : {}) }

  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null
  let nextId = 1
  /** @type {Promise<void> | null} */
  let starting = null
  let idleTimer = null
  let disposed = false
  /** @type {Map<number, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
  const pending = new Map()

  /** One stdout line -> one JSON message, routed by id. */
  const route = (message) => {
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) {
      entry.reject(new Error(message.error.message ?? 'craft-context: MCP request rejected'))
    } else {
      entry.resolve(message.result)
    }
  }

  const kill = () => {
    if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null }
    if (child === null) return
    const target = child
    child = null
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      pending.delete(id)
      entry.reject(new Error(`craft-context: MCP process exited before answering request ${id}`))
    }
    try { target.stdin?.end() } catch { /* already gone */ }
    try { target.kill() } catch { /* already gone */ }
  }

  const scheduleIdle = () => {
    if (idleTimer !== null) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { if (pending.size === 0) kill() }, idleMs)
    // Never hold the event loop open just to reap an idle child.
    if (typeof idleTimer.unref === 'function') idleTimer.unref()
  }

  /**
   * Start the child and complete the MCP handshake. Concurrent callers share
   * one promise. The stdout reader installed here is the ONLY one: it serves
   * the handshake response and every later request alike.
   */
  const ensureStarted = () => {
    if (disposed) return Promise.reject(new Error('craft-context: client is disposed'))
    if (child !== null) return Promise.resolve()
    if (starting !== null) return starting

    starting = new Promise((resolve, reject) => {
      const spawned = spawn(command, args, {
        env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      })
      let buffer = ''
      let bytes = 0
      let handshakeDone = false
      let settled = false

      const fail = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { spawned.kill() } catch { /* ignore */ }
        reject(error)
      }

      const timer = setTimeout(() => fail(new Error('craft-context: MCP initialize timed out')), timeoutMs)

      spawned.on('error', (error) => fail(new Error(`craft-context: MCP launch failed - ${error.message}`)))
      spawned.on('exit', (code) => {
        if (!handshakeDone) {
          fail(new Error(`craft-context: MCP exited ${String(code)} before the handshake finished`))
          return
        }
        // After the handshake a death is per-request, not per-connection.
        for (const [id, entry] of pending) {
          clearTimeout(entry.timer)
          pending.delete(id)
          entry.reject(new Error(`craft-context: MCP process exited before answering request ${id}`))
        }
        child = null
        starting = null
      })

      spawned.stderr.resume()
      spawned.stdout.setEncoding('utf8')
      spawned.stdout.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk)
        buffer += chunk
        if (bytes > maxBytes) { fail(new Error('craft-context: MCP output exceeds budget')); return }
        let at
        while ((at = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, at)
          buffer = buffer.slice(at + 1)
          if (line.trim() === '') continue
          let message
          try { message = JSON.parse(line) } catch {
            if (!handshakeDone) fail(new Error('craft-context: MCP handshake returned invalid JSON'))
            continue
          }
          if (!handshakeDone) {
            if (message.id !== 1) continue
            if (message.error !== undefined || message.result === undefined) {
              fail(new Error('craft-context: MCP handshake was rejected'))
              return
            }
            const version = message.result.protocolVersion
            if (!PROTOCOL_VERSIONS.includes(version)) {
              fail(new Error(`craft-context: unsupported MCP protocol ${String(version)}`))
              return
            }
            handshakeDone = true
            settled = true
            clearTimeout(timer)
            child = spawned
            starting = null
            spawned.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
            scheduleIdle()
            resolve()
            continue
          }
          route(message)
        }
      })

      spawned.stdin.on('error', () => {
        for (const [, entry] of pending) {
          clearTimeout(entry.timer)
          entry.reject(new Error('craft-context: MCP stdin closed'))
        }
      })

      spawned.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'dsh-craft-context', version: '1' } },
      })}\n`)
    })

    return starting
  }

  /**
   * One JSON-RPC request. Rejects with a readable message on protocol failure,
   * timeout, budget overrun, or a tool-level isError result.
   */
  const request = (method, params = {}) => ensureStarted().then(() => new Promise((resolve, reject) => {
    if (child === null) {
      reject(new Error('craft-context: MCP process is not running'))
      return
    }
    const id = nextId++
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`craft-context: MCP ${method} timed out`))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    scheduleIdle()
  }))

  return {
    get product() { return product },
    /** The actual tool names and schemas the runtime exposes. */
    listTools: () => request('tools/list'),
    /** Call one discovered tool. */
    callTool: (name, args = {}) => request('tools/call', { name, arguments: args }),
    dispose: () => { disposed = true; kill() },
  }
}
