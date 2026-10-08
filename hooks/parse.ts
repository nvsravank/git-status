// Pure helpers for git's output: no calls to Claude Code here. (The plugin
// validator follows `$` only within one file, so everything that runs git
// lives in register.tsx.)

import type { Band, Branch, LogLine, Operation, Remote, Show, Stash, Status, Tag, Worktree } from '../types'

// --- paths -----------------------------------------------------------------
// Paths are kept with forward slashes. Claude Code reports Windows folders as
// C:\Users\…, git as C:/Users/…, and Windows ignores case.

/** Forward slashes, no trailing slash (a bare root like `/` or `C:/` keeps it). */
export const toSlash = (p: string) => p.replace(/\\/g, '/').replace(/(?<!^|:)\/+$/, '')

const isWindowsPath = (p: string) => /^[A-Za-z]:[\\/]/.test(p)

const comparable = (p: string) => (isWindowsPath(p) ? toSlash(p).toLowerCase() : toSlash(p))

/** Whether two paths name the same place: separators ignored, case too on Windows. */
export const samePath = (a: string, b: string) => comparable(a) === comparable(b)

export const join = (dir: string, name: string) => {
  const base = toSlash(dir)
  return base.endsWith('/') ? base + name : `${base}/${name}`
}

export const baseName = (p: string) => toSlash(p).split('/').pop() || p

// --- time ------------------------------------------------------------------

/** "just now", "5m ago", "3h ago", "2d ago", "4mo ago", "1y ago". */
export function ago(at: number, now: number) {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.round(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.round(d / 365)}y ago`
}

// --- git status --porcelain=v2 --branch --show-stash -z ---------------------

/** Every field after the first `n` space-separated ones: a path may hold spaces. */
const after = (record: string, n: number) => record.split(' ').slice(n).join(' ')

export function parseStatus(out: string): Status {
  const status: Status = {
    branch: null,
    sha: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    stashes: 0,
    staged: 0,
    modified: 0,
    untracked: 0,
    conflicted: [],
  }
  const records = out.split('\0')
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!
    if (record.startsWith('# ')) {
      const [, key, ...rest] = record.split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') status.sha = value === '(initial)' ? null : value.slice(0, 7)
      else if (key === 'branch.head') status.branch = value === '(detached)' ? null : value
      else if (key === 'branch.upstream') status.upstream = value
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value)
        if (m) [status.ahead, status.behind] = [Number(m[1]), Number(m[2])]
      } else if (key === 'stash') status.stashes = Number(value) || 0
      continue
    }
    const kind = record[0]
    if (kind === '1' || kind === '2') {
      const [x, y] = [record[2], record[3]]
      if (x !== '.') status.staged++
      if (y !== '.') status.modified++
      if (kind === '2') i++ // a rename or copy is followed by its original path
    } else if (kind === 'u') status.conflicted.push(after(record, 10))
    else if (kind === '?') status.untracked++
  }
  return status
}

// --- branches: git for-each-ref ----------------------------------------------

export const BRANCH_FORMAT = [
  '%(refname)',
  '%(objectname:short)',
  '%(upstream:short)',
  '%(upstream:track,nobracket)',
  '%(committerdate:unix)',
  '%(HEAD)',
  '%(worktreepath)',
  '%(authorname)',
  '%(subject)',
].join('%00')

/** "ahead 2, behind 1", "ahead 2", "gone" or "" (git run with LC_ALL=C). */
export function parseTrack(track: string) {
  const ahead = /ahead (\d+)/.exec(track)
  const behind = /behind (\d+)/.exec(track)
  return { ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0, isGone: track === 'gone' }
}

export function parseBranches(out: string, merged: ReadonlySet<string>): Branch[] {
  const list: Branch[] = []
  for (const line of out.split('\n')) {
    if (!line) continue
    const [ref = '', sha = '', upstream = '', track = '', date = '', head = '', worktree = '', author = '', ...subject] = line.split('\0')
    const isRemote = ref.startsWith('refs/remotes/')
    // origin/HEAD only points at the remote's default branch.
    if (isRemote && ref.endsWith('/HEAD')) continue
    const name = ref.replace(/^refs\/(heads|remotes)\//, '')
    const isCurrent = head === '*'
    list.push({
      ref,
      name,
      isRemote,
      isCurrent,
      sha,
      upstream: upstream || null,
      ...parseTrack(track),
      isMerged: !isRemote && merged.has(name),
      committedAt: Number(date) * 1000,
      author,
      subject: subject.join('\0'),
      worktree: worktree && !isCurrent ? toSlash(worktree) : null,
    })
  }
  return list
}

// --- history: git log --graph -------------------------------------------------

/** A unit separator ahead of the fields splits the graph glyphs from the commit. */
export const LOG_FORMAT = '%x1f%H%x00%D%x00%s%x00%an%x00%ct'

/** `ahead`/`behind` hold full shas from `git rev-list --left-right HEAD...@{u}`. */
export function parseLog(out: string, ahead: ReadonlySet<string>, behind: ReadonlySet<string>): LogLine[] {
  const lines: LogLine[] = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const cut = line.indexOf('\x1f')
    if (cut < 0) {
      lines.push({ graph: line.trimEnd() })
      continue
    }
    const [sha = '', refs = '', subject = '', author = '', date = ''] = line.slice(cut + 1).split('\0')
    lines.push({
      graph: line.slice(0, cut),
      commit: {
        sha: sha.slice(0, 7),
        refs,
        subject,
        author,
        at: Number(date) * 1000,
        side: ahead.has(sha) ? 'ahead' : behind.has(sha) ? 'behind' : null,
      },
    })
  }
  return lines
}

/** `<sha` lines are only on the left (HEAD), `>sha` only on the right (upstream). */
export function parseLeftRight(out: string) {
  const ahead = new Set<string>()
  const behind = new Set<string>()
  for (const line of out.split('\n')) {
    if (line.startsWith('<')) ahead.add(line.slice(1).trim())
    else if (line.startsWith('>')) behind.add(line.slice(1).trim())
  }
  return { ahead, behind }
}

// --- remotes ---------------------------------------------------------------

/** Any user name or token is dropped, so it is never shown. */
export const hideCredentials = (url: string) => url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1')

/**
 * The web page of a remote hosted on a forge, from its fetch URL:
 * git@host:owner/repo.git, ssh://git@host:22/owner/repo, https://user@host/owner/repo.git.
 * Local paths and file:// give null.
 */
export function webUrl(url: string): string | null {
  const scp = /^[^@/\s]+@([^:/\s]+):(?!\/)(.+?)(?:\.git)?\/?$/.exec(url)
  if (scp) return `https://${scp[1]}/${scp[2]}`
  const full = /^(?:ssh|git|https?):\/\/(?:[^/@]*@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(url)
  if (full) return `https://${full[1]}/${full[2]}`
  return null
}

export function parseRemotes(out: string): Remote[] {
  const byName = new Map<string, Remote>()
  for (const line of out.split('\n')) {
    const m = /^(\S+)\t(.+) \((fetch|push)\)$/.exec(line)
    if (!m) continue
    const [, name, raw, kind] = m as unknown as [string, string, string, 'fetch' | 'push']
    const url = hideCredentials(raw)
    const remote = byName.get(name) ?? { name, fetch: '', push: '', web: null }
    remote[kind] = url
    if (kind === 'fetch') remote.web = webUrl(raw)
    byName.set(name, remote)
  }
  return [...byName.values()]
}

// --- stashes, tags, worktrees ---------------------------------------------------

export const STASH_FORMAT = '%gd%x00%ct%x00%gs'

/** `git stash list`; the branch comes from the message git writes, "WIP on <branch>:" or "On <branch>:". */
export function parseStashes(out: string): Stash[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [name = '', date = '', ...rest] = line.split('\0')
      const subject = rest.join('\0')
      const on = /^(?:WIP on|On) ([^:]+):/.exec(subject)?.[1]
      return { name, at: Number(date) * 1000, subject, branch: on && on !== '(no branch)' ? on : null }
    })
}


export const TAG_FORMAT = '%(refname:short)%00%(creatordate:unix)%00%(contents:subject)'

export function parseTags(out: string): Tag[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [name = '', date = '', ...subject] = line.split('\0')
      return { name, at: Number(date) * 1000, subject: subject.join('\0') }
    })
}

/** `git worktree list --porcelain`: blocks of `key value` lines split by a blank line. */
export function parseWorktrees(out: string): Worktree[] {
  const list: Worktree[] = []
  for (const block of out.split(/\n\n+/)) {
    const tree: Worktree = { path: '', branch: null, sha: '', isBare: false, isLocked: false, isPrunable: false }
    for (const line of block.split('\n')) {
      const [key = '', ...rest] = line.split(' ')
      const value = rest.join(' ')
      if (key === 'worktree') tree.path = toSlash(value)
      else if (key === 'HEAD') tree.sha = value.slice(0, 7)
      else if (key === 'branch') tree.branch = value.replace(/^refs\/heads\//, '')
      else if (key === 'bare') tree.isBare = true
      else if (key === 'locked') tree.isLocked = true
      else if (key === 'prunable') tree.isPrunable = true
    }
    if (tree.path) list.push(tree)
  }
  return list
}

// --- the branch list ------------------------------------------------------------

/**
 * Remote branches no local branch tracks: the ones the left list shows under
 * "Remote", so a branch never appears twice.
 */
export function untrackedRemotes(branches: readonly Branch[]): Branch[] {
  const tracked = new Set(branches.filter(b => !b.isRemote && b.upstream).map(b => b.upstream))
  return branches.filter(b => b.isRemote && !tracked.has(b.name))
}

/** The remote a remote branch belongs to: the longest remote name that prefixes it. */
export function remoteOf(name: string, remotes: readonly Remote[]): Remote | null {
  let best: Remote | null = null
  for (const remote of remotes) {
    if (name.startsWith(`${remote.name}/`) && (!best || remote.name.length > best.name.length)) best = remote
  }
  return best
}

/** The branch's page on a forge, for GitHub-style hosts (`/tree/<branch>`). */
export function branchWebUrl(web: string, branch: string) {
  return `${web}/tree/${branch.split('/').map(encodeURIComponent).join('/')}`
}

// --- the summary row --------------------------------------------------------------

const OPERATION_LABEL: Record<Operation['kind'], string> = {
  merge: 'MERGING',
  rebase: 'REBASING',
  am: 'APPLYING PATCHES',
  'cherry-pick': 'CHERRY-PICKING',
  revert: 'REVERTING',
  bisect: 'BISECTING',
}

export const opLabel = (op: Operation) =>
  `${OPERATION_LABEL[op.kind]}${op.step !== undefined && op.total !== undefined ? ` ${op.step}/${op.total}` : ''}`

export const headName = (b: Status) => b.branch ?? (b.sha ? `detached at ${b.sha}` : 'no commits yet')

export const isClean = (b: Status) => b.staged + b.modified + b.untracked + b.conflicted.length === 0

/** The summary as one plain line, for the status line: only the parts `show` asks for. */
export function summaryText(b: Band, show: Show, now: number): string {
  const parts: string[] = []
  if (show.branch) parts.push(`⎇ ${headName(b)}`)
  if (show.remote) {
    if (b.upstream) {
      const sync = `${b.ahead ? ` ↑${b.ahead}` : ''}${b.behind ? ` ↓${b.behind}` : ''}` || ' ✓'
      parts.push(`→ ${b.upstream}${sync}`)
      parts.push(b.fetchedAt ? `fetched ${ago(b.fetchedAt, now)}` : 'never fetched')
    } else if (b.branch) parts.push('no upstream')
  }
  if (show.status) {
    if (b.operation) parts.push(`⚠ ${opLabel(b.operation)}`)
    if (isClean(b)) parts.push('✓ clean')
    else {
      const counts = [
        b.conflicted.length && `✖${b.conflicted.length} conflicts`,
        b.staged && `●${b.staged} staged`,
        b.modified && `✚${b.modified} changed`,
        b.untracked && `?${b.untracked} new`,
      ].filter(Boolean)
      parts.push(counts.join(' '))
    }
    if (b.stashes) parts.push(`≡${b.stashes} stashed`)
  }
  return parts.join(' · ')
}
