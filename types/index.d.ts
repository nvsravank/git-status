/** The palette the pane draws in; plugins aren't told the app's theme. */
export type Theme = 'light' | 'dark'

export type Tab = 'overview' | 'branches' | 'history' | 'remotes' | 'stashes' | 'tags' | 'worktrees'

/** A repository the pane can show: the one holding the session folder, or one inside it. */
export type Repo = { name: string; path: string }

/** A merge, rebase, cherry-pick, revert or bisect left in progress. */
export type Operation = { kind: 'merge' | 'rebase' | 'am' | 'cherry-pick' | 'revert' | 'bisect'; step?: number; total?: number }

/** What `git status --porcelain=v2 --branch --show-stash` says. */
export type Status = {
  /** Branch name; null when HEAD is detached. */
  branch: string | null
  /** Short commit of HEAD; null before the first commit. */
  sha: string | null
  upstream: string | null
  ahead: number
  behind: number
  stashes: number
  staged: number
  modified: number
  untracked: number
  conflicted: string[]
}

/** Everything the one-row band shows for the session folder's repo. */
export type Band = Status & {
  repoName: string
  operation: Operation | null
  /** When FETCH_HEAD was last written, ms since the epoch; null if never fetched. */
  fetchedAt: number | null
}

export type Branch = {
  name: string
  isRemote: boolean
  isCurrent: boolean
  sha: string
  upstream: string | null
  ahead: number
  behind: number
  /** The upstream was deleted on the remote. */
  isGone: boolean
  /** Fully merged into the default branch. */
  isMerged: boolean
  committedAt: number
  subject: string
  /** Where it is checked out, if in another worktree. */
  worktree: string | null
}

/** One line of `git log --graph`: the graph glyphs, and the commit when the line has one. */
export type LogLine = {
  graph: string
  commit?: { sha: string; refs: string; subject: string; author: string; at: number; side: 'ahead' | 'behind' | null }
}

export type Remote = { name: string; fetch: string; push: string; web: string | null }

export type Stash = { name: string; at: number; subject: string }

export type Tag = { name: string; at: number; subject: string }

export type Worktree = { path: string; branch: string | null; sha: string; isBare: boolean; isLocked: boolean; isPrunable: boolean }

/** Everything the pane shows for one repository, read in one go. */
export type RepoInfo = {
  path: string
  /** The main checkout, when this is a linked worktree of it. */
  mainWorktree: string | null
  /** The branch merged-ness is measured against (origin/HEAD, else main or master). */
  defaultBranch: string | null
  band: Band
  branches: Branch[]
  log: LogLine[]
  remotes: Remote[]
  stashes: Stash[]
  tags: Tag[]
  latestTag: string | null
  worktrees: Worktree[]
  readAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'git-status': {
      /** The session folder's repo, for the band; null when the folder isn't in one. */
      band: Band | null
      repos: Repo[]
      /** Path of the repo the pane shows. */
      repo: string
      tab: Tab
      info: RepoInfo | null
      error: string
      isLoading: boolean
      theme: Theme
    }
  }
}
