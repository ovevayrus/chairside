// Child processes for the e2e runner. Every process this run starts is tracked
// by PID, and only those trees are ever killed (tree-kill: taskkill /T /F on
// Windows, the descendant tree on POSIX).
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { connect } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import treeKill from 'tree-kill'

const tracked = []

/** Spawns without a shell unless options.shell is set, and tracks the process. */
export function start(name, command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
  // The last 200 output lines, kept in memory only (never written to disk).
  const proc = { name, child, lines: [], error: undefined, stopping: false }
  const keep = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue
      proc.lines.push(line)
      if (proc.lines.length > 200) proc.lines.shift()
    }
  }
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)
  child.on('error', (error) => {
    proc.error = error
    keep(`spawn failed: ${error.message}`)
  })
  tracked.push(proc)
  return proc
}

function exited(proc) {
  return proc.child.exitCode !== null || proc.child.signalCode !== null
}

export function describeExit(proc) {
  const how = proc.error
    ? proc.error.message
    : `exit ${proc.child.exitCode ?? proc.child.signalCode}`
  const tail = proc.lines
    .slice(-20)
    .map((line) => `  | ${line}`)
    .join('\n')
  return `${proc.name} stopped (${how})${tail ? `\n${tail}` : ''}`
}

/** Throws if a tracked process died while the run still needs it. */
export function assertAlive() {
  for (const proc of tracked) {
    if (!proc.stopping && (proc.error || exited(proc))) {
      throw new Error(describeExit(proc))
    }
  }
}

/** An error that stops waitFor() at once instead of being retried. */
export function fatal(message) {
  return Object.assign(new Error(message), { fatal: true })
}

function killTree(pid, signal) {
  return new Promise((resolve) => treeKill(pid, signal, () => resolve()))
}

function untrack(proc) {
  proc.stopping = true
  const index = tracked.indexOf(proc)
  if (index !== -1) tracked.splice(index, 1)
}

/** Kills one tracked process tree by PID and waits for the process to exit. */
export async function stop(proc) {
  untrack(proc)
  const { child } = proc
  if (child.pid === undefined || exited(proc)) return
  const exit = once(child, 'exit').catch(() => {})
  await killTree(child.pid, 'SIGTERM')
  const gone = await Promise.race([exit.then(() => true), delay(5000, false)])
  if (!gone) {
    await killTree(child.pid, 'SIGKILL')
    await Promise.race([exit, delay(2000)])
  }
}

/** Kills every process tree this run started (newest first). */
export async function stopAll() {
  await Promise.all(tracked.slice().reverse().map(stop))
}

/** Runs a tracked command to completion; rejects on a non-zero exit. */
export async function run(name, command, args, options = {}) {
  const proc = start(name, command, args, options)
  const [code] = await once(proc.child, 'exit')
  untrack(proc)
  if (code !== 0) throw new Error(describeExit(proc))
}

/** True when something already accepts connections on the port (IPv4 or IPv6 loopback). */
export async function portTaken(port) {
  const probe = (host) =>
    new Promise((resolve) => {
      const socket = connect({ port, host })
      const finish = (taken) => {
        socket.destroy()
        resolve(taken)
      }
      socket.once('connect', () => finish(true))
      socket.once('error', () => finish(false))
      socket.setTimeout(1000, () => finish(false))
    })
  const results = await Promise.all([probe('127.0.0.1'), probe('::1')])
  return results.some(Boolean)
}

/** Polls until probe() returns a truthy value; fails fast if a tracked process died. */
export async function waitFor(what, timeoutMs, probe, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs
  let lastError
  for (;;) {
    assertAlive()
    try {
      const value = await probe()
      if (value) return value
      lastError = undefined
    } catch (error) {
      if (error?.fatal) throw error
      lastError = error
    }
    if (Date.now() >= deadline) break
    await delay(intervalMs)
  }
  const detail = lastError ? ` (last error: ${lastError.message})` : ''
  throw new Error(
    `timed out after ${timeoutMs} ms waiting for ${what}${detail}`,
  )
}
