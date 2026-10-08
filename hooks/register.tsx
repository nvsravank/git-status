import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Band, Branch, BranchDetail, Operation, Repo, RepoInfo, Show, Stash, Tab, Theme } from '../types'
import {
  BRANCH_FORMAT,
  LOG_FORMAT,
  STASH_FORMAT,
  TAG_FORMAT,
  ago,
  baseName,
  branchWebUrl,
  headName,
  isClean,
  join,
  opLabel,
  parseBranches,
  parseLeftRight,
  parseLog,
  parseRemotes,
  parseStashes,
  parseStatus,
  parseTags,
  parseWorktrees,
  remoteOf,
  samePath,
  summaryText,
  toSlash,
  untrackedRemotes,
} from './parse'

type Engine = EngineInterface

const PANE = 'git-status'
const TITLE = 'Git status'
const COMMAND = 'git-status'
// How often the summary re-reads the repo, for changes made outside this session:
// every 15 s while things change, doubling up to every 4 min while nothing does.
// Claude's tool calls and turns bring it back to 15 s.
const POLL_MIN_MS = 15000
const POLL_MAX_MS = 240000
// Lists are capped: a desktop pane past ~300 rows stops redrawing and its buttons go dead.
const LOG_COUNT = 60
const TAG_COUNT = 50
const LIST_COUNT = 40
// Below this many columns the branch list sits above the details instead of beside them.
const SIDE_BY_SIDE_MIN = 80

// --- preferences -------------------------------------------------------------
// From the plugin's settings; a change there reloads the module, so register sets them again.

type Placement = 'above-prompt' | 'status-line'
let show: Show = { branch: true, remote: true, status: true }
let placement: Placement = 'above-prompt'

const band = atom({ plugin: 'git-status', key: 'band' } as const, null)
const repos = atom({ plugin: 'git-status', key: 'repos' } as const, [])
const repo = atom({ plugin: 'git-status', key: 'repo' } as const, '')
const branch = atom({ plugin: 'git-status', key: 'branch' } as const, '')
const tab = atom({ plugin: 'git-status', key: 'tab' } as const, 'overview')
const info = atom({ plugin: 'git-status', key: 'info' } as const, null)
const detail = atom({ plugin: 'git-status', key: 'detail' } as const, null)
const error = atom({ plugin: 'git-status', key: 'error' } as const, '')
const isLoading = atom({ plugin: 'git-status', key: 'isLoading' } as const, false)
// Kept for the session only: saving it across sessions would write a file.
const theme = atom({ plugin: 'git-status', key: 'theme' } as const, 'light')

// Solid hex only: the desktop did not draw rgba().
type Palette = Record<'accent' | 'good' | 'warn' | 'bad' | 'sha' | 'refs' | 'graph', string>
const PALETTES: Record<Theme, Palette> = {
  light: { accent: '#0969da', good: '#1a7f37', warn: '#9a6700', bad: '#cf222e', sha: '#953800', refs: '#8250df', graph: '#57606a' },
  dark: { accent: '#79c0ff', good: '#7ee787', warn: '#e3b341', bad: '#ff7b72', sha: '#ffa657', refs: '#d2a8ff', graph: '#8b949e' },
}

const TABS: readonly { value: Tab; label: string }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'history', label: 'History' },
  { value: 'tags', label: 'Tags' },
  { value: 'worktrees', label: 'Worktrees' },
  { value: 'stashes', label: 'Stashes' },
]

// --- git, read-only ----------------------------------------------------------
// Nothing here writes. --no-optional-locks (and GIT_OPTIONAL_LOCKS) keeps
// `git status` from refreshing the index file; fsmonitor is off so no daemon
// starts; nothing fetches. LC_ALL=C keeps "ahead 2, behind 1" in English.

const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }

function git($: Engine, cwd: string, args: string[], timeoutMs = 10000) {
  return $.process.run(
    ['git', '--no-pager', '--no-optional-locks', '-c', 'color.ui=never', '-c', 'core.fsmonitor=false', ...args],
    { cwd, env: GIT_ENV, timeoutMs },
  )
}

const ok = async (run: ReturnType<typeof git>) => {
  const r = await run
  return r.exitCode === 0 ? r.stdout : ''
}

type Location = { top: string; gitDir: string; commonDir: string; fetchHead: string }

/** The repo a folder is in, wherever in it the folder is; null outside any. */
async function locate($: Engine, dir: string): Promise<Location | null> {
  const r = await git($, dir, [
    'rev-parse',
    '--path-format=absolute',
    '--show-toplevel',
    '--absolute-git-dir',
    '--git-common-dir',
    '--git-path',
    'FETCH_HEAD',
  ])
  const [top, gitDir, commonDir, fetchHead] = r.stdout.split('\n').map(toSlash)
  if (r.exitCode !== 0 || !top || !gitDir || !commonDir || !fetchHead) return null
  return { top, gitDir, commonDir, fetchHead }
}

const readNumber = async ($: Engine, path: string) => {
  try {
    return Number((await $.fs.read(path)).trim()) || undefined
  } catch {
    return undefined
  }
}

/** A merge, rebase, cherry-pick, revert or bisect left half done, from the files git keeps for it. */
async function operation($: Engine, gitDir: string): Promise<Operation | null> {
  const has = (name: string) => $.fs.exists(join(gitDir, name))
  if (await has('rebase-merge')) {
    const [step, total] = await Promise.all([
      readNumber($, join(gitDir, 'rebase-merge/msgnum')),
      readNumber($, join(gitDir, 'rebase-merge/end')),
    ])
    return { kind: 'rebase', step, total }
  }
  if (await has('rebase-apply')) {
    const [step, total] = await Promise.all([
      readNumber($, join(gitDir, 'rebase-apply/next')),
      readNumber($, join(gitDir, 'rebase-apply/last')),
    ])
    return { kind: (await has('rebase-apply/applying')) ? 'am' : 'rebase', step, total }
  }
  if (await has('MERGE_HEAD')) return { kind: 'merge' }
  if (await has('CHERRY_PICK_HEAD')) return { kind: 'cherry-pick' }
  if (await has('REVERT_HEAD')) return { kind: 'revert' }
  if (await has('BISECT_LOG')) return { kind: 'bisect' }
  return null
}

/** When FETCH_HEAD was last written; null if the repo was never fetched. */
async function fetchedAt($: Engine, fetchHead: string) {
  if (!(await $.fs.exists(fetchHead))) return null
  const stat = await $.fs.stat(fetchHead)
  return stat.mtimeMs
}

async function readBand($: Engine, at: Location): Promise<Band> {
  const [status, op, fetched] = await Promise.all([
    ok(git($, at.top, ['status', '--porcelain=v2', '--branch', '--show-stash', '-z'])),
    operation($, at.gitDir),
    fetchedAt($, at.fetchHead),
  ])
  return { ...parseStatus(status), repoName: baseName(at.top), operation: op, fetchedAt: fetched }
}

/** origin/HEAD, else the first of origin/main, origin/master, main, master that exists. */
async function defaultBranch($: Engine, cwd: string) {
  const remoteHead = (await ok(git($, cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']))).trim()
  if (remoteHead) return remoteHead
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if ((await git($, cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).exitCode === 0) return ref
  }
  return null
}

/** A summary just read for the session folder's repo, so the pane needn't read it again. */
type Known = { at: Location; band: Band }

async function readInfo($: Engine, path: string, known?: Known): Promise<RepoInfo> {
  const isKnown = known !== undefined && samePath(known.at.top, path)
  const at = isKnown ? known.at : await locate($, path)
  if (!at) throw new Error(`${path} is no longer a git repository`)
  const cwd = at.top
  const [head, base] = await Promise.all([isKnown ? known.band : readBand($, at), defaultBranch($, cwd)])
  const [merged, branches, remotes, worktrees, stashes] = await Promise.all([
    base ? ok(git($, cwd, ['for-each-ref', `--merged=${base}`, '--format=%(refname:short)', 'refs/heads'])) : '',
    ok(git($, cwd, ['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes'])),
    ok(git($, cwd, ['remote', '-v'])),
    ok(git($, cwd, ['worktree', 'list', '--porcelain'])),
    head.stashes ? ok(git($, cwd, ['stash', 'list', `--format=${STASH_FORMAT}`])) : '',
  ])
  const mainWorktree = at.commonDir.endsWith('/.git') ? at.commonDir.slice(0, -'/.git'.length) : null

  return {
    path: cwd,
    mainWorktree: mainWorktree && !samePath(mainWorktree, cwd) ? mainWorktree : null,
    defaultBranch: base,
    band: head,
    branches: parseBranches(branches, new Set(merged.split('\n').filter(Boolean))),
    remotes: parseRemotes(remotes),
    worktrees: parseWorktrees(worktrees),
    stashes: parseStashes(stashes),
    readAt: Date.now(),
  }
}

/** The branch's history (with its upstream's, marked), tags and standing against the default branch. */
async function readDetail($: Engine, data: RepoInfo, br: Branch): Promise<BranchDetail> {
  const cwd = data.path
  const upstream = !br.isRemote && br.upstream && !br.isGone ? br.upstream : null
  const isDefault = data.defaultBranch !== null && (br.name === data.defaultBranch || br.upstream === data.defaultBranch)
  const [log, sides, tags, tagNames, counts] = await Promise.all([
    ok(git($, cwd, ['log', '--graph', '--decorate=short', `--format=${LOG_FORMAT}`, `-n${LOG_COUNT}`, br.ref, ...(upstream ? [upstream] : [])])),
    upstream ? ok(git($, cwd, ['rev-list', '--left-right', '--max-count=1000', `${br.ref}...${upstream}`])) : '',
    ok(git($, cwd, ['for-each-ref', `--merged=${br.ref}`, '--sort=-creatordate', `--count=${TAG_COUNT}`, `--format=${TAG_FORMAT}`, 'refs/tags'])),
    ok(git($, cwd, ['for-each-ref', `--merged=${br.ref}`, '--format=%(refname)', 'refs/tags'])),
    data.defaultBranch && !isDefault
      ? ok(git($, cwd, ['rev-list', '--left-right', '--count', `${br.ref}...${data.defaultBranch}`]))
      : '',
  ])
  const { ahead, behind } = parseLeftRight(sides)
  const [mine, theirs] = counts.trim().split(/\s+/).map(Number)
  return {
    ref: br.ref,
    log: parseLog(log, ahead, behind),
    tags: parseTags(tags),
    tagCount: tagNames.split('\n').filter(Boolean).length,
    vsDefault: mine !== undefined && theirs !== undefined && !Number.isNaN(mine) ? { ahead: mine, behind: theirs } : null,
  }
}

/**
 * The repo the session folder is in (the folder may be anywhere inside it),
 * then every repo directly inside the folder.
 */
async function discover($: Engine): Promise<Repo[]> {
  const cwd = toSlash(await $.session.cwd())
  const found: Repo[] = []
  const at = await locate($, cwd)
  if (at) {
    const where = samePath(at.top, cwd) ? 'this folder' : 'holds this folder'
    found.push({ name: `${baseName(at.top)} (${where})`, path: at.top })
  }
  let names: string[] = []
  try {
    names = (await $.fs.list(cwd))
      // Symlinked folders list as `other`; the `.git` check below sorts them out.
      .filter(one => one.kind !== 'file' && !one.name.startsWith('.') && one.name !== 'node_modules')
      .map(one => one.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 300)
  } catch {
    // an unreadable folder just has no child repos
  }
  const hasGit = await Promise.all(names.map(name => $.fs.exists(join(join(cwd, name), '.git'))))
  names.forEach((name, i) => {
    const path = join(cwd, name)
    if (hasGit[i] && !found.some(one => samePath(one.path, path))) found.push({ name, path })
  })
  return found
}

// --- keeping it current ------------------------------------------------------

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Re-read the session folder's repo for the summary, and the pane's repo while
 * the pane is open. Says whether anything changed.
 */
async function refresh($: Engine): Promise<boolean> {
  const at = await locate($, toSlash(await $.session.cwd()))
  const next = at ? await readBand($, at) : null
  const isNew = !same(next, await read($, band))
  if (isNew) await update($, band, () => next)
  if (placement === 'status-line') $.ui.status(next ? summaryText(next, show, Date.now()) || '⎇ git' : undefined)

  const isPaneOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
  const isPaneNew = isPaneOpen ? await loadInfo($, true, at && next ? { at, band: next } : undefined) : false
  return isNew || isPaneNew
}

// The poll is one timer at a time, re-armed after each run with its new delay.
let pollMs = POLL_MIN_MS
let pollTimer: { cancel: () => void } | null = null

function schedulePoll($: Engine) {
  if (pollTimer) pollTimer.cancel()
  pollTimer = $.clock.after(pollMs, () => void poll($))
}

async function poll($: Engine) {
  const isChanged = await refresh($).catch(() => false)
  pollMs = isChanged ? POLL_MIN_MS : Math.min(POLL_MAX_MS, pollMs * 2)
  schedulePoll($)
}

let isQueued = false
/** Coalesces a burst of tool calls into one refresh, and brings the poll back to 15 s. */
function refreshSoon($: Engine) {
  if (isQueued) return
  isQueued = true
  $.clock.after(500, () => {
    isQueued = false
    pollMs = POLL_MIN_MS
    schedulePoll($)
    void refresh($).catch(() => undefined)
  })
}

// Loads can overlap (a refresh while a branch is being picked): each takes a
// ticket, and only the newest one may write its result.
let infoTicket = 0
let detailTicket = 0

/**
 * Reads the selected repo, keeps the picked branch if it still exists (else
 * the checked-out one), then reads that branch. Quiet: no loading line, and
 * no redraw when nothing changed.
 */
async function loadInfo($: Engine, isQuiet = false, known?: Known): Promise<boolean> {
  const mine = ++infoTicket
  const path = await read($, repo)
  if (!path) {
    await update($, info, () => null)
    return false
  }
  if (!isQuiet) await update($, isLoading, () => true)
  try {
    const next = await readInfo($, path, known)
    if (mine !== infoTicket) return false
    const now = await read($, info)
    const isNew = !now || !same({ ...now, readAt: 0 }, { ...next, readAt: 0 })
    if (isNew) await update($, info, () => next)
    await update($, error, () => '')
    const picked = await read($, branch)
    if (!next.branches.some(b => b.ref === picked)) {
      const fallback = next.branches.find(b => b.isCurrent) ?? next.branches[0]
      await update($, branch, () => fallback?.ref ?? '')
    }
    const isDetailNew = await loadDetail($, isQuiet)
    return isNew || isDetailNew
  } catch (err) {
    if (mine === infoTicket) await update($, error, () => String(err instanceof Error ? err.message : err))
    return false
  } finally {
    if (!isQuiet && mine === infoTicket) await update($, isLoading, () => false)
  }
}

async function loadDetail($: Engine, isQuiet = false): Promise<boolean> {
  const mine = ++detailTicket
  const [data, ref] = await Promise.all([read($, info), read($, branch)])
  const br = data?.branches.find(b => b.ref === ref)
  if (!data || !br) {
    await update($, detail, () => null)
    return false
  }
  if (!isQuiet) await update($, detail, () => null)
  const next = await readDetail($, data, br)
  if (mine !== detailTicket) return false
  const isNew = !same(next, await read($, detail))
  if (isNew) await update($, detail, () => next)
  return isNew
}

async function openPane($: Engine) {
  const found = await discover($)
  await update($, repos, () => found)
  const current = await read($, repo)
  if (!found.some(one => samePath(one.path, current))) {
    await update($, repo, () => found[0]?.path ?? '')
    await update($, branch, () => '')
  }
  await $.ui.open({ id: PANE, title: TITLE })
  await loadInfo($)
}

const pickRepo = async ($: Engine, path: string) => {
  await update($, repo, () => path)
  await update($, branch, () => '')
  await loadInfo($)
}

const pickBranch = async ($: Engine, ref: string) => {
  await update($, branch, () => ref)
  await loadDetail($)
}

const toggleTheme = async ($: Engine) => {
  await update($, theme, t => (t === 'light' ? 'dark' : 'light'))
}

// The desktop app often doesn't run a Button's onPress or a Select's onSelect
// closure, so every control is also answered here by its key, at the
// ui.press / ui.select events.
const OPEN_KEY = 'git-status-open'

async function handlePress($: Engine, key: string) {
  if (key === 'refresh' || key === OPEN_KEY) await openPane($)
  else if (key === 'theme') await toggleTheme($)
  else if (key.startsWith('tab:')) await update($, tab, () => key.slice('tab:'.length) as Tab)
  else if (key.startsWith('repo:')) await pickRepo($, key.slice('repo:'.length))
  else if (key.startsWith('branch:')) await pickBranch($, key.slice('branch:'.length))
}

// --- words -------------------------------------------------------------------

const OPERATION_HINT: Record<Operation['kind'], string> = {
  merge: 'git merge --continue, or git merge --abort',
  rebase: 'git rebase --continue, or git rebase --abort',
  am: 'git am --continue, or git am --abort',
  'cherry-pick': 'git cherry-pick --continue, or git cherry-pick --abort',
  revert: 'git revert --continue, or git revert --abort',
  bisect: 'git bisect good / bad, or git bisect reset',
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** A branch's label in the list: one plain string, as a Button takes. */
const branchLabel = (b: Branch) =>
  `${b.isCurrent ? '● ' : ''}${b.name}${b.ahead ? ` ↑${b.ahead}` : ''}${b.behind ? ` ↓${b.behind}` : ''}${b.isGone ? ' (gone)' : ''}`

export const register: Register = (on, options) => {
  show = { branch: options.showBranch !== false, remote: options.showRemote !== false, status: options.showStatus !== false }
  placement = options.placement === 'status-line' ? 'status-line' : 'above-prompt'

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Open "Git status": every branch, its history, tags and worktrees (read-only)',
    })
    // A reload after a preference change: drop the line the other placement left.
    if (placement === 'above-prompt') $.ui.status(undefined)
    void refresh($).catch(() => undefined)
    pollMs = POLL_MIN_MS
    schedulePoll($)

    return next(e)
  })

  // Claude's own edits, commits and checkouts show up right after they happen.
  // If this hook ever fails, the handler passes the call on as if the hook weren't
  // there (a tool that already ran is not run again), so a bug here can't block a tool.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    refreshSoon($)
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    refreshSoon($)
    return next(e)
  })

  on('ui.press', { requestId: PANE }, async ($, e) => {
    await handlePress($, e.element)
    return { element: e.element }
  })
  on('ui.select', { requestId: PANE }, async ($, e, next) => {
    if (e.element !== 'repo') return next(e)
    await pickRepo($, e.value)
    return { element: e.element, value: e.value }
  })
  // The row above the prompt is shared with other plugins: answer only our own button.
  on('ui.press', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.element !== OPEN_KEY) return next(e)
    await handlePress($, e.element)
    return { element: e.element }
  })
  on('ui.press', { component: 'SessionMode' }, async ($, e, next) => {
    if (e.element !== OPEN_KEY) return next(e)
    await handlePress($, e.element)
    return { element: e.element }
  })

  on('command.run', { command: COMMAND }, async $ => {
    await openPane($)
    const found = await read($, repos)
    return {
      text: found.length ? 'Opened "Git status".' : 'Opened "Git status". No git repository was found in or around this folder.',
    }
  })

  // --- the status line's + button --------------------------------------------
  // The status line itself takes plain text, so with placement status-line the
  // button goes in the prompt footer's mode labels, which a mod may draw as a
  // tree. The engine's labels (focus, memory paused, ...) are kept in front of it.

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (placement !== 'status-line' || (await read($, band)) === null) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box gap={1}>
        {e.props.modes.length > 0 && <Text dimColor>{e.props.modes.join(' & ')}</Text>}
        <Button key={OPEN_KEY} label="+" onPress={() => void openPane($)} />
      </Box>
    )
  })

  // --- the row above the prompt: only while the session folder is in a repo ---

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const b = await read($, band)
    if (placement !== 'above-prompt' || e.props.hasSurvey || b === null) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const c = PALETTES[await read($, theme)]
    const sep = <Text dimColor> · </Text>
    const isNothingShown = !show.branch && !show.remote && !show.status

    return (
      <Box justifyContent="space-between" width={e.props.bodyColumns}>
        <Box flexShrink={1}>
          <Text wrap="truncate-end">
            {isNothingShown && <Text dimColor>Git status</Text>}
            {show.branch && <Text bold color={c.accent}>⎇ {headName(b)} </Text>}
            {show.remote &&
              (b.upstream ? (
                <Text>
                  <Text dimColor>→ {b.upstream}</Text>
                  {b.ahead > 0 && <Text color={c.good}> ↑{b.ahead}</Text>}
                  {b.behind > 0 && <Text color={c.warn}> ↓{b.behind}</Text>}
                  {b.ahead + b.behind === 0 && <Text dimColor> ✓ in sync</Text>}
                  <Text dimColor> · {b.fetchedAt ? `fetched ${ago(b.fetchedAt, Date.now())}` : 'never fetched'} </Text>
                </Text>
              ) : (
                b.branch && <Text dimColor>(no upstream) </Text>
              ))}
            {show.status && (
              <Text>
                {(show.branch || show.remote) && sep}
                {b.operation && <Text bold color={c.bad}>⚠ {opLabel(b.operation)} </Text>}
                {isClean(b) ? (
                  <Text color={c.good}>✓ clean</Text>
                ) : (
                  <Text>
                    {b.conflicted.length > 0 && <Text bold color={c.bad}>✖{b.conflicted.length} conflicts </Text>}
                    {b.staged > 0 && <Text color={c.good}>●{b.staged} staged </Text>}
                    {b.modified > 0 && <Text color={c.warn}>✚{b.modified} changed </Text>}
                    {b.untracked > 0 && <Text dimColor>?{b.untracked} new</Text>}
                  </Text>
                )}
                {b.stashes > 0 && <Text dimColor> · ≡{b.stashes} stashed</Text>}
              </Text>
            )}
          </Text>
        </Box>
        <Button key={OPEN_KEY} label="+" onPress={() => void openPane($)} />
      </Box>
    )
  })

  // --- the pane: branches on the left, the picked branch on the right -------------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = ui
    const [found, path, picked, current, data, more, failed, loading, colorTheme] = await Promise.all([
      read($, repos),
      read($, repo),
      read($, branch),
      read($, tab),
      read($, info),
      read($, detail),
      read($, error),
      read($, isLoading),
      read($, theme),
    ])
    const c = PALETTES[colorTheme]
    const width = e.props.bodyColumns
    const now = Date.now()

    const tools = (
      <Box gap={1}>
        <Button key="refresh" plain onPress={() => void openPane($)}>
          ↻
        </Button>
        {/* Shows the mode a press switches to: ☾ while light, ☀ while dark. */}
        <Button key="theme" plain onPress={() => void toggleTheme($)}>
          {colorTheme === 'light' ? '☾' : '☀'}
        </Button>
      </Box>
    )

    if (found.length === 0) {
      return (
        <Box flexDirection="column">
          <Box justifyContent="space-between">
            <Text bold>No git repository here</Text>
            {tools}
          </Box>
          <Text wrap="wrap" dimColor>
            {toSlash(await $.session.cwd())} isn't inside a git repository, and none of the folders directly inside it is
            one.
          </Text>
        </Box>
      )
    }

    const options = found.map(one => ({ value: one.path, label: one.name }))
    // Mobile draws no Select: there the repos are buttons instead.
    const picker =
      'Select' in ui ? (
        <ui.Select key="repo" label="Repository: " value={path} options={options} onSelect={value => void pickRepo($, value)} />
      ) : (
        <Box flexDirection="column">
          {options.slice(0, 8).map(o => (
            <Button key={`repo:${o.value}`} plain dimColor={o.value !== path} onPress={() => void pickRepo($, o.value)}>
              {o.label}
            </Button>
          ))}
        </Box>
      )
    const header = (
      <Box justifyContent="space-between">
        {picker}
        {tools}
      </Box>
    )

    if (failed || !data || (loading && !samePath(data.path, path))) {
      return (
        <Box flexDirection="column">
          {header}
          {failed ? (
            <Text color={c.bad} wrap="wrap">
              {failed}
            </Text>
          ) : (
            <Text dimColor>Reading the repository…</Text>
          )}
        </Box>
      )
    }

    const none = (text: string) => <Text dimColor>{text}</Text>
    const row = (label: string, value: JSX.Element | string) => (
      <Box>
        <Box width={13} flexShrink={0}>
          <Text dimColor>{label}</Text>
        </Box>
        <Box flexShrink={1}>{typeof value === 'string' ? <Text wrap="wrap">{value}</Text> : value}</Box>
      </Box>
    )
    const link = (url: string) => <Markdown text={`[${url}](${url})`} />

    // --- left: local branches, then remote branches no local branch tracks ---

    const local = data.branches
      .filter(b => !b.isRemote)
      .sort((x, y) => Number(y.isCurrent) - Number(x.isCurrent) || y.committedAt - x.committedAt)
    const remote = untrackedRemotes(data.branches).sort((x, y) => y.committedAt - x.committedAt)
    const item = (b: Branch) =>
      b.ref === picked ? (
        <Text key={`branch:${b.ref}`} bold inverse color={b.isGone ? c.bad : c.accent} wrap="truncate-end">
          {branchLabel(b)}
        </Text>
      ) : (
        <Button key={`branch:${b.ref}`} plain dimColor={b.isMerged && !b.isCurrent} onPress={() => void pickBranch($, b.ref)}>
          {branchLabel(b)}
        </Button>
      )
    const isSideBySide = width >= SIDE_BY_SIDE_MIN
    const listWidth = isSideBySide ? Math.min(44, Math.max(26, Math.floor(width * 0.34))) : width
    const list = (
      <Box flexDirection="column" width={listWidth} flexShrink={0} paddingRight={isSideBySide ? 2 : 0}>
        <Text bold>Local ({local.length})</Text>
        {local.length === 0 && none('No local branches yet.')}
        {local.slice(0, LIST_COUNT).map(item)}
        {local.length > LIST_COUNT && none(`+${local.length - LIST_COUNT} older`)}
        <Box marginTop={1}>
          <Text bold>Remote only ({remote.length})</Text>
        </Box>
        {remote.length === 0 && none(data.remotes.length ? 'Every remote branch is tracked locally.' : 'No remotes.')}
        {remote.slice(0, LIST_COUNT).map(item)}
        {remote.length > LIST_COUNT && none(`+${remote.length - LIST_COUNT} older`)}
      </Box>
    )

    // --- right: the picked branch ---

    const br = data.branches.find(b => b.ref === picked)
    const detailWidth = isSideBySide ? width - listWidth : width
    const b = data.band

    // Counts for the tabs and the overview; a tab with nothing in it is left out.
    const isMore = more !== null && br !== undefined && more.ref === br.ref
    const ownStashes: Stash[] = br && !br.isRemote ? data.stashes.filter(st => st.branch === br.name) : []
    const counts: Partial<Record<Tab, number>> = {
      tags: isMore ? more.tagCount : 0,
      worktrees: data.worktrees.length > 1 ? data.worktrees.length : 0,
      stashes: ownStashes.length,
    }
    const shown = TABS.filter(t => counts[t.value] !== 0).map(t => ({
      ...t,
      label: counts[t.value] === undefined ? t.label : `${t.label} (${counts[t.value]})`,
    }))
    // A tab that emptied (another branch picked, the last stash dropped) shows the overview.
    const open: Tab = shown.some(t => t.value === current) ? current : 'overview'

    const tabs = (
      <Box gap={1} flexWrap="wrap">
        {shown.map(t =>
          t.value === open ? (
            <Text key={t.value} bold underline color={c.accent}>
              {t.label}
            </Text>
          ) : (
            <Button key={`tab:${t.value}`} plain dimColor onPress={() => void update($, tab, () => t.value)}>
              {t.label}
            </Button>
          ),
        )}
      </Box>
    )

    const overview = (br: Branch) => {
      const own = br.isRemote ? remoteOf(br.name, data.remotes) : br.upstream ? remoteOf(br.upstream, data.remotes) : null
      const onRemote = br.isRemote ? br.name : br.upstream && !br.isGone ? br.upstream : null
      const branchOnRemote = onRemote && own ? onRemote.slice(own.name.length + 1) : null
      const isDefault = data.defaultBranch !== null && (br.name === data.defaultBranch || br.upstream === data.defaultBranch)
      const checkedOutIn = data.worktrees.filter(w => w.branch === br.name)
      return (
        <Box flexDirection="column">
          {br.isCurrent && b.operation && (
            <Box flexDirection="column" marginBottom={1}>
              <Text bold color={c.bad}>
                ⚠ {opLabel(b.operation)} in progress
              </Text>
              <Text dimColor wrap="wrap">
                Finish with {OPERATION_HINT[b.operation.kind]}.
              </Text>
            </Box>
          )}
          {row('Kind', br.isRemote ? 'remote branch, no local branch tracks it' : br.isCurrent ? 'local, checked out here' : 'local')}
          {row(
            'Last commit',
            <Text wrap="wrap">
              <Text color={c.sha}>{br.sha}</Text> {br.subject}
              <Text dimColor>
                {' '}
                · {br.author}, {ago(br.committedAt, now)}
              </Text>
            </Text>,
          )}
          {!br.isRemote &&
            row(
              'Tracking',
              br.isGone ? (
                <Text color={c.bad} wrap="wrap">
                  {br.upstream} was deleted on the remote
                </Text>
              ) : br.upstream ? (
                <Text wrap="wrap">
                  {br.upstream}
                  {br.ahead > 0 && <Text color={c.good}> · ↑{plural(br.ahead, 'commit')} to push</Text>}
                  {br.behind > 0 && <Text color={c.warn}> · ↓{plural(br.behind, 'commit')} to pull</Text>}
                  {br.ahead + br.behind === 0 && <Text color={c.good}> · in sync</Text>}
                </Text>
              ) : (
                <Text dimColor wrap="wrap">
                  no upstream: not pushed, or not linked to a remote branch
                </Text>
              ),
            )}
          {data.defaultBranch &&
            row(
              `vs ${data.defaultBranch}`,
              isDefault ? (
                none('this is the default branch')
              ) : more && more.ref === br.ref && more.vsDefault ? (
                <Text wrap="wrap">
                  {plural(more.vsDefault.ahead, 'commit')} not in {data.defaultBranch} · {more.vsDefault.behind} behind it
                  {br.isMerged && <Text color={c.good}> · merged</Text>}
                </Text>
              ) : (
                none('…')
              ),
            )}
          {!br.isRemote &&
            row(
              'Checked out',
              br.isCurrent
                ? data.path
                : checkedOutIn.length
                  ? checkedOutIn.map(w => w.path).join(', ')
                  : none('not checked out in any worktree'),
            )}
          {own && row('Remote', `${own.name} · ${own.fetch}`)}
          {own?.web && branchOnRemote && row('On the web', link(branchWebUrl(own.web, branchOnRemote)))}
          {row(
            'Contents',
            <Text wrap="wrap">
              {isMore ? plural(more.tagCount, 'tag') : '… tags'} in its history
              {!br.isRemote && ` · ${plural(ownStashes.length, 'stash', 'stashes')} made on it`}
              {` · ${plural(data.worktrees.length, 'worktree')} in the repo`}
            </Text>,
          )}
          {(br.isRemote || br.upstream) && row('Last fetch', b.fetchedAt ? `${ago(b.fetchedAt, now)} (this view never fetches)` : 'never')}
          {br.isCurrent && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Working tree</Text>
              {row(
                'Files',
                isClean(b) ? (
                  <Text color={c.good}>✓ clean</Text>
                ) : (
                  [
                    b.conflicted.length && plural(b.conflicted.length, 'conflict'),
                    b.staged && `${b.staged} staged`,
                    b.modified && `${b.modified} changed`,
                    b.untracked && `${b.untracked} untracked`,
                  ]
                    .filter(Boolean)
                    .join(' · ')
                ),
              )}
              {row('Stashes', `${b.stashes} in the repo`)}
              {data.mainWorktree && row('Worktree of', data.mainWorktree)}
              {b.conflicted.slice(0, 20).map(file => (
                <Text key={`conflict:${file}`} color={c.bad} wrap="truncate-middle">
                  ✖ {file}
                </Text>
              ))}
            </Box>
          )}
        </Box>
      )
    }

    const history = (br: Branch) => {
      if (!more || more.ref !== br.ref) return none('Reading the history…')
      return (
        <Box flexDirection="column">
          {(br.ahead > 0 || br.behind > 0) && br.upstream && (
            <Box marginBottom={1}>
              <Text dimColor wrap="wrap">
                <Text color={c.good}>↑</Text> on {br.name}, not pushed yet · <Text color={c.warn}>↓</Text> on {br.upstream}, not
                pulled yet
              </Text>
            </Box>
          )}
          {more.log.length === 0 && none('No commits.')}
          {more.log.map((line, i) =>
            line.commit ? (
              <Text key={line.commit.sha} wrap="truncate-end">
                <Text color={c.graph}>{line.graph}</Text>
                {line.commit.side === 'ahead' && <Text color={c.good}>↑</Text>}
                {line.commit.side === 'behind' && <Text color={c.warn}>↓</Text>}
                <Text color={c.sha}>{line.commit.sha}</Text>
                {line.commit.refs && <Text color={c.refs}> ({line.commit.refs})</Text>}
                <Text> {line.commit.subject}</Text>
                <Text dimColor>
                  {' '}
                  · {line.commit.author}, {ago(line.commit.at, now)}
                </Text>
              </Text>
            ) : (
              <Text key={`graph-${i}`} color={c.graph}>
                {line.graph}
              </Text>
            ),
          )}
          {more.log.length >= LOG_COUNT && <Box marginTop={1}>{none(`The newest ${LOG_COUNT} commits.`)}</Box>}
        </Box>
      )
    }

    const tags = (br: Branch) => {
      if (!more || more.ref !== br.ref) return none('Reading the tags…')
      return (
        <Box flexDirection="column">
          {more.tags.length === 0 && none(`No tags on ${br.name}'s history.`)}
          {more.tags.map(t => (
            <Text key={`tag:${t.name}`} wrap="truncate-end">
              <Text color={c.refs}>{t.name}</Text>
              <Text dimColor> {ago(t.at, now)} </Text>
              {t.subject}
            </Text>
          ))}
          {more.tags.length >= TAG_COUNT && <Box marginTop={1}>{none(`The newest ${TAG_COUNT} tags.`)}</Box>}
        </Box>
      )
    }

    const stashes = (br: Branch) => (
      <Box flexDirection="column">
        {ownStashes.map(st => (
          <Text key={`stash:${st.name}`} wrap="truncate-end">
            <Text color={c.sha}>{st.name}</Text>
            <Text dimColor> {ago(st.at, now)} </Text>
            {st.subject.replace(/^(?:WIP on|On) [^:]+: /, '')}
          </Text>
        ))}
        <Box marginTop={1}>{none(`Stashes made while ${br.name} was checked out.`)}</Box>
      </Box>
    )

    const worktrees = (br: Branch) => (
      <Box flexDirection="column">
        {data.worktrees.map(w => {
          const isHere = samePath(w.path, data.path)
          const isThisBranch = !br.isRemote && w.branch === br.name
          return (
            <Box key={`wt:${w.path}`} flexDirection="column" marginBottom={1}>
              <Text wrap="truncate-middle" bold={isThisBranch} color={isThisBranch ? c.accent : undefined}>
                {isThisBranch ? '● ' : '  '}
                {w.path}
                {isHere && <Text dimColor> (this one)</Text>}
              </Text>
              <Text wrap="truncate-end">
                {'    '}
                {w.isBare ? <Text dimColor>bare</Text> : <Text>{w.branch ?? `detached at ${w.sha}`}</Text>}
                {!w.isBare && <Text color={c.sha}> {w.sha}</Text>}
                {w.isLocked && <Text color={c.warn}> locked</Text>}
                {w.isPrunable && <Text color={c.bad}> missing (prunable)</Text>}
              </Text>
            </Box>
          )
        })}
        <Box marginTop={1}>{none(`● has ${br.name} checked out`)}</Box>
      </Box>
    )

    const right = (
      <Box flexDirection="column" width={detailWidth} marginTop={isSideBySide ? 0 : 1}>
        {br ? (
          <Box flexDirection="column">
            <Text bold color={br.isGone ? c.bad : c.accent} wrap="truncate-end">
              {br.isRemote ? '☁ ' : '⎇ '}
              {br.name}
            </Text>
            <Box marginTop={1}>{tabs}</Box>
            <Box marginTop={1} flexDirection="column">
              {{ overview, history, tags, worktrees, stashes }[open](br)}
            </Box>
          </Box>
        ) : (
          none('Pick a branch on the left.')
        )}
      </Box>
    )

    return (
      <Box flexDirection="column" width={width}>
        {header}
        <Box marginTop={1} flexDirection={isSideBySide ? 'row' : 'column'}>
          {list}
          {right}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            Read {ago(data.readAt, now)} · read-only, nothing is written
            {loading ? ' · refreshing…' : ''}
          </Text>
        </Box>
      </Box>
    )
  })
}
