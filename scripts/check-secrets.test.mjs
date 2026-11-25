import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { scanSecrets } from './check-secrets.mjs'

let root
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chairside-scan-'))
  execFileSync('git', ['init', '--quiet'], { cwd: root })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

it('passes an empty repository and ignores excluded files', () => {
  expect(scanSecrets(root)).toEqual([])
  writeFileSync(join(root, '.gitignore'), 'ignored.txt\n')
  writeFileSync(join(root, 'ignored.txt'), 'sk-' + 'a'.repeat(20))
  writeFileSync(join(root, 'clean.txt'), 'Chairside\n')
  expect(scanSecrets(root)).toEqual([])
})

it('exits zero when clean and exits one with a redacted location on a match', () => {
  mkdirSync(join(root, 'scripts'))
  const cli = join(root, 'scripts', 'check-secrets.mjs')
  copyFileSync(new URL('./check-secrets.mjs', import.meta.url), cli)
  const run = () => spawnSync(process.execPath, [cli], { encoding: 'utf8' })
  expect(run().status).toBe(0)

  writeFileSync(join(root, 'fixture.txt'), '\n' + 'sk-' + 'x'.repeat(24))
  const result = run()
  expect(result.status).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr.trim()).toBe('fixture.txt:2')
})

it('finds a bot token inside a Bot API URL', () => {
  const token = '123456789:' + 'u'.repeat(35)
  writeFileSync(
    join(root, 'notes.md'),
    `ok\nhttps://api.telegram.org/bot${token}/getMe\n`,
  )
  expect(scanSecrets(root)).toEqual(['notes.md:2'])
})

it('reports only locations for tracked files, untracked files and the built bundle', () => {
  const telegram = '123456:' + 't'.repeat(30)
  const openai = 'sk-' + 'o'.repeat(20)
  const google = 'AIza' + 'g'.repeat(30)
  const privateField = JSON.stringify({ private_key: 'fixture' }, null, 2)

  writeFileSync(join(root, 'tracked.txt'), 'first line\r\n' + telegram)
  execFileSync('git', ['add', '--', 'tracked.txt'], { cwd: root })
  writeFileSync(join(root, '.gitignore'), 'dist/\ntracked.txt\n')
  writeFileSync(join(root, 'with space.txt'), [openai, '', google].join('\n'))
  const assets = join(root, 'apps', 'glasses', 'dist', 'assets')
  mkdirSync(assets, { recursive: true })
  writeFileSync(join(assets, 'chunk.json'), privateField)

  expect(scanSecrets(root).sort()).toEqual([
    'apps/glasses/dist/assets/chunk.json:2',
    'tracked.txt:2',
    'with space.txt:1',
    'with space.txt:3',
  ])
})
