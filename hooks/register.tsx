import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Band, Operation, Repo, RepoInfo, Tab, Theme } from '../types'
import {
  BRANCH_FORMAT,
  LOG_FORMAT,
  STASH_FORMAT,
  TAG_FORMAT,
  ago,
  baseName,
  join,
  parseBranches,
  parseLeftRight,
  parseLog,
  parseRemotes,
  parseStashes,
  parseStatus,
  parseTags,
  parseWorktrees,
  samePath,
  toSlash,
} from './parse'

type Engine = EngineInterface

const PANE = 'git-status'
const TITLE = 'Git status'
const COMMAND = 'git-status'
// How often the band re-reads the repo, for changes made outside this session.
const POLL_MS = 15000
// Commits the History tab shows.
const LOG_COUNT = 60
// Lists are capped: a desktop pane past ~300 rows stops redrawing and its buttons go dead.
// Local branches (two rows each) and remote branches listed before "+N more".
const LOCAL_BRANCHES = 40
const REMOTE_BRANCHES = 40

const band = atom({ plugin: 'git-status', key: 'band' } as const, null)
const repos = atom({ plugin: 'git-status', key: 'repos' } as const, [])
const repo = atom({ plugin: 'git-status', key: 'repo' } as const, '')
const tab = atom({ plugin: 'git-status', key: 'tab' } as const, 'overview')
const info = atom({ plugin: 'git-status', key: 'info' } as const, null)
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
  { value: 'branches', label: 'Branches' },
  { value: 'history', label: 'History' },
  { value: 'remotes', label: 'Remotes' },
  { value: 'stashes', label: 'Stashes' },
  { value: 'tags', label: 'Tags' },
  { value: 'worktrees', label: 'Worktrees' },
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

async function readInfo($: Engine, path: string): Promise<RepoInfo> {
  const at = await locate($, path)
  if (!at) throw new Error(`${path} is no longer a git repository`)
  const cwd = at.top
  const [head, base] = await Promise.all([readBand($, at), defaultBranch($, cwd)])
  const hasCommits = head.sha !== null

  const [merged, branches, sides, log, remotes, stashes, tags, latestTag, worktrees] = await Promise.all([
    base ? ok(git($, cwd, ['for-each-ref', `--merged=${base}`, '--format=%(refname:short)', 'refs/heads'])) : '',
    ok(git($, cwd, ['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes'])),
    head.upstream ? ok(git($, cwd, ['rev-list', '--left-right', '--max-count=1000', 'HEAD...@{u}'])) : '',
    hasCommits
      ? ok(git($, cwd, ['log', '--graph', '--decorate=short', `--format=${LOG_FORMAT}`, `-n${LOG_COUNT}`, 'HEAD', ...(head.upstream ? ['@{u}'] : [])]))
      : '',
    ok(git($, cwd, ['remote', '-v'])),
    ok(git($, cwd, ['stash', 'list', `--format=${STASH_FORMAT}`])),
    ok(git($, cwd, ['for-each-ref', '--sort=-creatordate', '--count=50', `--format=${TAG_FORMAT}`, 'refs/tags'])),
    hasCommits ? ok(git($, cwd, ['describe', '--tags', '--abbrev=0'])) : '',
    ok(git($, cwd, ['worktree', 'list', '--porcelain'])),
  ])
  const { ahead, behind } = parseLeftRight(sides)
  const mainWorktree = at.commonDir.endsWith('/.git') ? at.commonDir.slice(0, -'/.git'.length) : null

  return {
    path: cwd,
    mainWorktree: mainWorktree && !samePath(mainWorktree, cwd) ? mainWorktree : null,
    defaultBranch: base,
    band: head,
    branches: parseBranches(branches, new Set(merged.split('\n').filter(Boolean))),
    log: parseLog(log, ahead, behind),
    remotes: parseRemotes(remotes),
    stashes: parseStashes(stashes),
    tags: parseTags(tags),
    latestTag: latestTag.trim() || null,
    worktrees: parseWorktrees(worktrees),
    readAt: Date.now(),
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

/** Re-read the session folder's repo for the band, and the pane's repo while the pane is open. */
async function refresh($: Engine) {
  const at = await locate($, toSlash(await $.session.cwd()))
  const next = at ? await readBand($, at) : null
  if (!same(next, await read($, band))) await update($, band, () => next)

  if ((await $.ui.panes()).some(pane => pane.id === PANE)) await loadInfo($, true)
}

let isQueued = false
/** Coalesces a burst of tool calls into one refresh. */
function refreshSoon($: Engine) {
  if (isQueued) return
  isQueued = true
  $.clock.after(500, () => {
    isQueued = false
    void refresh($).catch(() => undefined)
  })
}

// Loads can overlap (a refresh while a repo is being picked): each takes a
// ticket, and only the newest one may write its result.
let ticket = 0

/** Reads the selected repo for the pane. Quiet: no loading line, and no redraw when nothing changed. */
async function loadInfo($: Engine, isQuiet = false) {
  const mine = ++ticket
  const path = await read($, repo)
  if (!path) {
    await update($, info, () => null)
    return
  }
  if (!isQuiet) await update($, isLoading, () => true)
  try {
    const next = await readInfo($, path)
    if (mine !== ticket) return
    const now = await read($, info)
    if (!now || !same({ ...now, readAt: 0 }, { ...next, readAt: 0 })) await update($, info, () => next)
    await update($, error, () => '')
  } catch (err) {
    if (mine === ticket) await update($, error, () => String(err instanceof Error ? err.message : err))
  } finally {
    if (!isQuiet && mine === ticket) await update($, isLoading, () => false)
  }
}

async function openPane($: Engine) {
  const found = await discover($)
  await update($, repos, () => found)
  const current = await read($, repo)
  if (!found.some(one => samePath(one.path, current))) await update($, repo, () => found[0]?.path ?? '')
  await $.ui.open({ id: PANE, title: TITLE })
  await loadInfo($)
}

const pick = async ($: Engine, path: string) => {
  await update($, repo, () => path)
  await loadInfo($)
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
  else if (key.startsWith('repo:')) await pick($, key.slice('repo:'.length))
}

// --- words -------------------------------------------------------------------

const OPERATION_LABEL: Record<Operation['kind'], string> = {
  merge: 'MERGING',
  rebase: 'REBASING',
  am: 'APPLYING PATCHES',
  'cherry-pick': 'CHERRY-PICKING',
  revert: 'REVERTING',
  bisect: 'BISECTING',
}

const OPERATION_HINT: Record<Operation['kind'], string> = {
  merge: 'git merge --continue, or git merge --abort',
  rebase: 'git rebase --continue, or git rebase --abort',
  am: 'git am --continue, or git am --abort',
  'cherry-pick': 'git cherry-pick --continue, or git cherry-pick --abort',
  revert: 'git revert --continue, or git revert --abort',
  bisect: 'git bisect good / bad, or git bisect reset',
}

const opLabel = (op: Operation) =>
  `${OPERATION_LABEL[op.kind]}${op.step !== undefined && op.total !== undefined ? ` ${op.step}/${op.total}` : ''}`

const headName = (b: Band) => b.branch ?? (b.sha ? `detached at ${b.sha}` : 'no commits yet')

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Open "Git status": branches, upstream, history, remotes, stashes, tags and worktrees (read-only)',
    })
    void refresh($).catch(() => undefined)
    $.clock.every(POLL_MS, () => void refresh($).catch(() => undefined))

    return next(e)
  })

  // Claude's own edits, commits and checkouts show up right after they happen.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    refreshSoon($)
    return result
  })

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
    await pick($, e.value)
    return { element: e.element, value: e.value }
  })
  // The band is shared with other plugins: answer only our own button.
  on('ui.press', { component: 'AbovePrompt' }, async ($, e, next) => {
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

  // --- the band above the prompt: only while the session folder is in a repo ---

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const b = await read($, band)
    if (e.props.hasSurvey || b === null) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const c = PALETTES[await read($, theme)]
    const isClean = b.staged + b.modified + b.untracked + b.conflicted.length === 0
    const sep = <Text dimColor> · </Text>

    return (
      <Box justifyContent="space-between" width={e.props.bodyColumns}>
        <Box flexShrink={1}>
          <Text wrap="truncate-end">
            <Text bold color={c.accent}>⎇ {headName(b)}</Text>
            {b.upstream ? (
              <Text>
                <Text dimColor> → {b.upstream}</Text>
                {b.ahead > 0 && <Text color={c.good}> ↑{b.ahead}</Text>}
                {b.behind > 0 && <Text color={c.warn}> ↓{b.behind}</Text>}
                {b.ahead + b.behind === 0 && <Text dimColor> ✓ in sync</Text>}
              </Text>
            ) : (
              b.branch && <Text dimColor> (no upstream)</Text>
            )}
            {b.operation && (
              <Text>
                {sep}
                <Text bold color={c.bad}>⚠ {opLabel(b.operation)}</Text>
              </Text>
            )}
            {sep}
            {isClean ? (
              <Text color={c.good}>✓ clean</Text>
            ) : (
              <Text>
                {b.conflicted.length > 0 && <Text bold color={c.bad}>✖{b.conflicted.length} conflicts </Text>}
                {b.staged > 0 && <Text color={c.good}>●{b.staged} staged </Text>}
                {b.modified > 0 && <Text color={c.warn}>✚{b.modified} changed </Text>}
                {b.untracked > 0 && <Text dimColor>?{b.untracked} new</Text>}
              </Text>
            )}
            {b.stashes > 0 && (
              <Text>
                {sep}
                <Text dimColor>≡{b.stashes} stashed</Text>
              </Text>
            )}
            {b.upstream && (
              <Text dimColor>
                {' · '}
                {b.fetchedAt ? `fetched ${ago(b.fetchedAt, Date.now())}` : 'never fetched'}
              </Text>
            )}
          </Text>
        </Box>
        <Button key={OPEN_KEY} label="+" onPress={() => void openPane($)} />
      </Box>
    )
  })

  // --- the pane ------------------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = ui
    const [found, path, current, data, failed, loading, colorTheme] = await Promise.all([
      read($, repos),
      read($, repo),
      read($, tab),
      read($, info),
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
        <ui.Select key="repo" label="Repository: " value={path} options={options} onSelect={value => void pick($, value)} />
      ) : (
        <Box flexDirection="column">
          {options.slice(0, 8).map(o => (
            <Button key={`repo:${o.value}`} plain dimColor={o.value !== path} onPress={() => void pick($, o.value)}>
              {o.label}
            </Button>
          ))}
        </Box>
      )

    const tabs = (
      <Box gap={1} flexWrap="wrap">
        {TABS.map(t =>
          t.value === current ? (
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

    const header = (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          {picker}
          {tools}
        </Box>
        <Box marginTop={1}>{tabs}</Box>
      </Box>
    )

    if (failed) {
      return (
        <Box flexDirection="column">
          {header}
          <Text color={c.bad} wrap="wrap">
            {failed}
          </Text>
        </Box>
      )
    }
    if (!data || (loading && !samePath(data.path, path))) {
      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor>Reading the repository…</Text>
        </Box>
      )
    }

    const b = data.band
    const row = (label: string, value: JSX.Element | string) => (
      <Box>
        <Box width={14} flexShrink={0}>
          <Text dimColor>{label}</Text>
        </Box>
        <Box flexShrink={1}>{typeof value === 'string' ? <Text wrap="wrap">{value}</Text> : value}</Box>
      </Box>
    )
    const section = (title: string) => (
      <Box marginTop={1}>
        <Text bold>{title}</Text>
      </Box>
    )
    const none = (text: string) => <Text dimColor>{text}</Text>

    const overview = () => (
      <Box flexDirection="column">
        {b.operation && (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold color={c.bad}>
              ⚠ {opLabel(b.operation)} in progress
            </Text>
            <Text dimColor wrap="wrap">
              Finish with {OPERATION_HINT[b.operation.kind]}.
            </Text>
          </Box>
        )}
        {row('Folder', data.path)}
        {data.mainWorktree && row('Worktree of', data.mainWorktree)}
        {row(
          'Branch',
          <Text>
            <Text bold color={c.accent}>
              {headName(b)}
            </Text>
            {b.branch && b.sha && <Text color={c.sha}> {b.sha}</Text>}
          </Text>,
        )}
        {row(
          'Tracking',
          b.upstream ? (
            <Text wrap="wrap">
              {b.upstream}
              {b.ahead > 0 && <Text color={c.good}> · ↑{plural(b.ahead, 'commit')} to push</Text>}
              {b.behind > 0 && <Text color={c.warn}> · ↓{plural(b.behind, 'commit')} to pull</Text>}
              {b.ahead + b.behind === 0 && <Text color={c.good}> · in sync</Text>}
            </Text>
          ) : b.branch ? (
            <Text dimColor wrap="wrap">
              no upstream: this branch hasn't been pushed, or isn't linked to a remote branch
            </Text>
          ) : (
            none('—')
          ),
        )}
        {row(
          'Last fetch',
          b.fetchedAt ? (
            <Text wrap="wrap">
              {ago(b.fetchedAt, now)}
              <Text dimColor> (ahead/behind is as of then; this view never fetches)</Text>
            </Text>
          ) : (
            none('never')
          ),
        )}
        {row(
          'Working tree',
          b.staged + b.modified + b.untracked + b.conflicted.length === 0 ? (
            <Text color={c.good}>✓ clean</Text>
          ) : (
            <Text wrap="wrap">
              {[
                b.conflicted.length && plural(b.conflicted.length, 'conflict'),
                b.staged && `${b.staged} staged`,
                b.modified && `${b.modified} changed`,
                b.untracked && `${b.untracked} untracked`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          ),
        )}
        {row('Default branch', data.defaultBranch ?? '—')}
        {row('Latest tag', data.latestTag ?? '—')}
        {row('Stashes', String(data.stashes.length))}
        {row(
          'Remotes',
          data.remotes.length ? data.remotes.map(r => r.name).join(', ') : none('none: this repo is local only'),
        )}
        {b.conflicted.length > 0 && (
          <Box flexDirection="column">
            {section('Conflicted files')}
            {b.conflicted.map(file => (
              <Text key={file} color={c.bad} wrap="truncate-middle">
                ✖ {file}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )

    const branches = () => {
      const local = data.branches
        .filter(br => !br.isRemote)
        .sort((x, y) => Number(y.isCurrent) - Number(x.isCurrent) || y.committedAt - x.committedAt)
      const remote = data.branches.filter(br => br.isRemote).sort((x, y) => y.committedAt - x.committedAt)
      return (
        <Box flexDirection="column">
          <Text bold>Local ({local.length})</Text>
          {local.length === 0 && none('No local branches yet.')}
          {local.slice(0, LOCAL_BRANCHES).map(br => (
            <Box key={br.name} flexDirection="column">
              <Text wrap="truncate-end">
                <Text bold={br.isCurrent} color={br.isCurrent ? c.accent : undefined}>
                  {br.isCurrent ? '● ' : '  '}
                  {br.name}
                </Text>
                <Text color={c.sha}> {br.sha}</Text>
                {br.upstream &&
                  (br.isGone ? (
                    <Text color={c.bad}> ⇢ {br.upstream} (gone on remote)</Text>
                  ) : (
                    <Text dimColor> ⇢ {br.upstream}</Text>
                  ))}
                {br.ahead > 0 && <Text color={c.good}> ↑{br.ahead}</Text>}
                {br.behind > 0 && <Text color={c.warn}> ↓{br.behind}</Text>}
                {br.isMerged && !br.isCurrent && <Text color={c.good}> merged</Text>}
                {br.worktree && <Text color={c.refs}> in worktree {baseName(br.worktree)}</Text>}
              </Text>
              <Text dimColor wrap="truncate-end">
                {'    '}
                {ago(br.committedAt, now)} · {br.subject}
              </Text>
            </Box>
          ))}
          {local.length > LOCAL_BRANCHES && none(`  +${local.length - LOCAL_BRANCHES} older`)}
          {section(`Remote (${remote.length})`)}
          {remote.length === 0 && none('No remote branches. Fetch or push to see some.')}
          {remote.slice(0, REMOTE_BRANCHES).map(br => (
            <Text key={br.name} wrap="truncate-end">
              <Text>  {br.name}</Text>
              <Text color={c.sha}> {br.sha}</Text>
              <Text dimColor>
                {' '}
                {ago(br.committedAt, now)} · {br.subject}
              </Text>
            </Text>
          ))}
          {remote.length > REMOTE_BRANCHES && none(`  +${remote.length - REMOTE_BRANCHES} more`)}
          <Box marginTop={1}>
            <Text dimColor wrap="wrap">
              ● checked out · ↑ commits to push · ↓ commits to pull · merged: already in {data.defaultBranch ?? 'the default branch'}
            </Text>
          </Box>
        </Box>
      )
    }

    const history = () => (
      <Box flexDirection="column">
        {b.upstream && (b.ahead > 0 || b.behind > 0) && (
          <Box marginBottom={1}>
            <Text dimColor wrap="wrap">
              <Text color={c.good}>↑</Text> on {headName(b)}, not pushed yet · <Text color={c.warn}>↓</Text> on {b.upstream},
              not pulled yet
            </Text>
          </Box>
        )}
        {data.log.length === 0 && none('No commits yet.')}
        {data.log.map((line, i) =>
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
        {data.log.length > 0 && <Box marginTop={1}>{none(`The newest ${LOG_COUNT} commits at most.`)}</Box>}
      </Box>
    )

    const remotes = () => (
      <Box flexDirection="column">
        {data.remotes.length === 0 && none('No remotes: this repository is local only.')}
        {data.remotes.map(r => (
          <Box key={r.name} flexDirection="column" marginBottom={1}>
            <Text bold color={c.accent}>
              {r.name}
              <Text dimColor>
                {' '}
                ({plural(data.branches.filter(br => br.isRemote && br.name.startsWith(`${r.name}/`)).length, 'branch', 'branches')})
              </Text>
            </Text>
            {row('Fetch', r.fetch)}
            {r.push && r.push !== r.fetch && row('Push', r.push)}
            {r.web && (
              <Box>
                <Box width={14} flexShrink={0}>
                  <Text dimColor>Web</Text>
                </Box>
                <Markdown text={`[${r.web}](${r.web})`} />
              </Box>
            )}
          </Box>
        ))}
        {row('Last fetch', b.fetchedAt ? ago(b.fetchedAt, now) : 'never')}
      </Box>
    )

    const stashes = () => (
      <Box flexDirection="column">
        {data.stashes.length === 0 && none('No stashes.')}
        {data.stashes.map(s => (
          <Text key={s.name} wrap="truncate-end">
            <Text color={c.sha}>{s.name}</Text>
            <Text dimColor> {ago(s.at, now)} </Text>
            {s.subject}
          </Text>
        ))}
      </Box>
    )

    const tags = () => (
      <Box flexDirection="column">
        {data.tags.length === 0 && none('No tags.')}
        {data.tags.map(t => (
          <Text key={t.name} wrap="truncate-end">
            <Text color={c.refs}>{t.name}</Text>
            <Text dimColor> {ago(t.at, now)} </Text>
            {t.subject}
          </Text>
        ))}
        {data.tags.length === 50 && <Box marginTop={1}>{none('The newest 50 tags.')}</Box>}
      </Box>
    )

    const worktrees = () => (
      <Box flexDirection="column">
        {data.worktrees.map(w => {
          const isHere = samePath(w.path, data.path)
          return (
            <Box key={w.path} flexDirection="column" marginBottom={1}>
              <Text wrap="truncate-middle" bold={isHere} color={isHere ? c.accent : undefined}>
                {isHere ? '● ' : '  '}
                {w.path}
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
        {data.worktrees.length <= 1 && none('Only the main checkout: no linked worktrees.')}
      </Box>
    )

    const body = { overview, branches, history, remotes, stashes, tags, worktrees }[current]()

    return (
      <Box flexDirection="column" width={width}>
        {header}
        <Box marginTop={1} flexDirection="column">
          {body}
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
