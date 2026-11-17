/**
 * Headless verification of the stuck "◐ syncing" chip — no browser, no GUI, no mock.
 *
 * The chip reads graft's own `stats.json`, so this drives the plugin's real status
 * computation and the plugin's real rebuild engine against a REAL graft index built in
 * scratch. Two scenarios:
 *
 *  1. the reported symptom: a `syncing` flag its builder no longer holds (dead build,
 *     failed spawn, or graft's query-time refresh that never touches stats.json) must
 *     read as drift, not as a sync that is never going to finish;
 *  2. the heal: the plugin's auto-sync spawns graft's own sync-run, and afterwards the
 *     flag is gone and the chip is no longer `syncing`.
 *
 * Scratch lives in `wedge-scratch/` (gitignored) — deliberately NOT under a dot
 * directory, because graft indexes nothing whose path contains one, and the heal
 * check needs a repo it can actually parse. Needs graft installed; skips with exit 0
 * when it is not, so a fresh clone cannot fail on a missing toolchain.
 *
 * Run:  npm run verify:wedge
 */
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { computeStatus } from '../src/index.js'
import { createAutoSync } from '../src/auto-sync.js'
import { resolveGraftCommand } from '../src/ensure-graft.js'

let failures = 0
const check = (label, ok, extra = '') => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  -> ' + extra : ''))
  if (!ok) failures += 1
}

const io = {
  exists: async (p) => { try { await access(p); return true } catch { return false } },
  readJson: async (p) => { try { return JSON.parse(await readFile(p, 'utf8')) } catch { return undefined } },
  readSavedTokens: async () => undefined,
}

const how = resolveGraftCommand()
if (how.prefix[0] === undefined) {
  console.log('SKIP  graft is not installed here — the headless check needs a real graft')
  process.exit(0)
}

const scratchDir = join(process.cwd(), 'wedge-scratch')
await mkdir(scratchDir, { recursive: true })
const scratch = await mkdtemp(join(scratchDir, 'wedge-'))
const repo = join(scratch, 'repo')
await mkdir(join(repo, 'src'), { recursive: true })
await mkdir(join(repo, 'graft', '.cache'), { recursive: true })
await writeFile(join(repo, 'src', 'app.js'), 'export const add = (a, b) => a + b\n')
// The scratch repo is its OWN git repo. graft resolves ignore rules from the enclosing
// repo, so a scratch dir that this plugin's `.gitignore` ignores indexes ZERO files —
// the heal would then pass on an empty graph and prove nothing.
try {
  execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' })
  execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@x', '-c', 'user.name=t', 'commit', '-q', '-m', 'fixture'], { stdio: 'ignore' })
} catch {
  console.log('SKIP  git is not available — the scratch repo needs its own ignore boundary')
  await rm(scratch, { recursive: true, force: true })
  process.exit(0)
}
const statsPath = join(repo, 'graft', '.cache', 'stats.json')
const lockPath = join(repo, 'graft', '.cache', '.sync.lock')
const writeStats = (v) => writeFile(statsPath, JSON.stringify(v))
const writeLock = () => writeFile(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }))

console.log('--- the wedge, read through the plugin ---')
// graft stamped the flag, then its builder died (or its refresh rebuilt the graph
// without touching stats.json). No lock exists, so nothing is syncing.
await writeStats({ nodeCount: 12, edgeCount: 4, dirty: true, syncing: true, syncStartedAt: '2026-11-16T00:00:00.000Z' })
const wedged = await computeStatus(repo, io)
check('a leftover flag reads as stale, not syncing', wedged.freshness === 'stale', wedged.freshness)

await writeLock()
check('a flag with graft\'s lock held still reads as syncing', (await computeStatus(repo, io)).freshness === 'syncing')
await rm(lockPath, { force: true })

console.log('\n--- the heal, through graft\'s own sync-run ---')
const sync = createAutoSync({ cliPath: how.prefix[0], nodePath: how.command })
check('auto-sync starts a rebuild for the wedged repo', (await sync.syncIfDirty(repo)) === 'started')

const deadline = Date.now() + 90_000
let stats = await io.readJson(statsPath)
while (stats?.syncing === true && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1000))
  stats = await io.readJson(statsPath)
}
check('graft cleared its own flag', stats?.syncing !== true, JSON.stringify(stats))
check('the chip is no longer syncing', (await computeStatus(repo, io)).freshness !== 'syncing')
check('and the graph is indexed', (await computeStatus(repo, io)).nodeCount > 0)

const live = process.env.GRAFT_VERIFY_LIVE
if (live) {
  const s = await computeStatus(live, io)
  check(`the live repo (${live}) is not reporting a sync that is not happening`, s.freshness !== 'syncing', s.freshness)
}

await rm(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nVERIFIED HEADLESS' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
