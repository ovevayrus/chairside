// npm run pack: builds the glasses app and packs it into chairside.ehpk with
// the pinned SDK version (evenhub-cli: evenhub pack).
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const SDK_VERSION = '0.0.16'
const windows = process.platform === 'win32'

function run(command, args, cwd) {
  const result = spawnSync([command, ...args].join(' '), {
    cwd,
    stdio: 'inherit',
    shell: windows,
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run('npm', ['run', 'build', '-w', '@chairside/glasses'], root)
run(
  'evenhub',
  [
    'pack',
    'app.json',
    'dist',
    '-o',
    '../../chairside.ehpk',
    '--sdk-ver',
    SDK_VERSION,
  ],
  fileURLToPath(new URL('../apps/glasses', import.meta.url)),
)
