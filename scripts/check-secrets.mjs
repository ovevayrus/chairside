import { execFileSync } from 'node:child_process'
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

// The Telegram token has no leading \b: inside a Bot API URL it follows "bot" directly.
const secretPattern =
  /\d{6,}:[A-Za-z0-9_-]{30,}\b|\bsk-[A-Za-z0-9_-]{20,}|\bAIza[0-9A-Za-z_-]{30,}|"private_key"\s*:/g

function collectBundleFiles(root, relativePath, files) {
  const path = join(root, relativePath)
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat?.isDirectory()) {
    for (const name of readdirSync(path)) {
      collectBundleFiles(root, posix.join(relativePath, name), files)
    }
  } else if (stat?.isFile() || stat?.isSymbolicLink()) {
    files.add(relativePath)
  }
}

export function scanSecrets(root) {
  const listing = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const files = new Set(listing.split('\0').filter(Boolean))
  collectBundleFiles(root, 'apps/glasses/dist', files)

  const findings = new Set()
  for (const file of files) {
    const path = join(root, file)
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (!stat?.isFile() && !stat?.isSymbolicLink()) continue

    // Git stores a symlink's target name as its contents.
    const contents = stat.isSymbolicLink()
      ? readlinkSync(path)
      : readFileSync(path, 'utf8')
    let line = 1
    let nextBreak = contents.indexOf('\n')
    for (const match of contents.matchAll(secretPattern)) {
      while (nextBreak !== -1 && nextBreak < match.index) {
        line++
        nextBreak = contents.indexOf('\n', nextBreak + 1)
      }
      findings.add(file + ':' + line)
    }
  }
  return [...findings]
}

if (import.meta.main) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const findings = scanSecrets(root)
  for (const location of findings) console.error(location)
  process.exitCode = findings.length ? 1 : 0
}
