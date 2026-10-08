/** The palette the pane draws in; plugins aren't told the app's theme. */
export type Theme = 'light' | 'dark'

/** The tabs on the right of the pane, for the branch picked on the left. */
export type Tab = 'overview' | 'history' | 'tags' | 'worktrees' | 'stashes'

/** Which parts of the summary row show, from the mod's preferences. */
export type Show = { branch: boolean; remote: boolean; status: boolean }

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

/** Everything the summary row shows for the session folder's repo. */
export type Band = Status & {
  repoName: string
  operation: Operation | null
  /** When FETCH_HEAD was last written, ms since the epoch; null if never fetched. */
  fetchedAt: number | null
}

export type Branch = {
  /** The full ref, `refs/heads/x` or `refs/remotes/origin/x`: what the pane selects by. */
  ref: string
  /** `x` for a local branch, `origin/x` for a remote one. */
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
  author: string
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

export type Tag = { name: string; at: number; subject: string }

/** A stash, and the branch it was made on (null when HEAD was detached). */
export type Stash = { name: string; at: number; subject: string; branch: string | null }

export type Worktree = { path: string; branch: string | null; sha: string; isBare: boolean; isLocked: boolean; isPrunable: boolean }

/** What the pane knows about one repository: its branches and everything shared by them. */
export type RepoInfo = {
  path: string
  /** The main checkout, when this is a linked worktree of it. */
  mainWorktree: string | null
  /** The branch merged-ness is measured against (origin/HEAD, else main or master). */
  defaultBranch: string | null
  band: Band
  branches: Branch[]
  remotes: Remote[]
  worktrees: Worktree[]
  /** Every stash in the repo, newest first; the pane shows each branch its own. */
  stashes: Stash[]
  readAt: number
}

/** What the right side shows for the branch picked on the left. */
export type BranchDetail = {
  ref: string
  log: LogLine[]
  /** Tags reachable from the branch, newest first. */
  tags: Tag[]
  /** How many tags are in the branch's history; `tags` holds the newest TAG_COUNT of them. */
  tagCount: number
  /** Commits the branch has that the default branch hasn't, and the other way round. */
  vsDefault: { ahead: number; behind: number } | null
}

declare module 'claude-code' {
  interface PluginState {
    'git-status': {
      /** The session folder's repo, for the summary row; null when the folder isn't in one. */
      band: Band | null
      repos: Repo[]
      /** Path of the repo the pane shows. */
      repo: string
      /** Full ref of the branch picked on the left. */
      branch: string
      tab: Tab
      info: RepoInfo | null
      detail: BranchDetail | null
      error: string
      isLoading: boolean
      /** Set by the ☀/☾ toggle; null follows the Claude Code theme setting. */
      theme: Theme | null
    }
  }
}
