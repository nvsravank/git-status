import { describe, expect, test } from 'claude-code/testing'

import {
  ago,
  hideCredentials,
  parseBranches,
  parseLeftRight,
  parseLog,
  parseRemotes,
  parseStashes,
  parseStatus,
  parseTrack,
  parseWorktrees,
  remoteOf,
  samePath,
  summaryText,
  untrackedRemotes,
  webUrl,
} from '../hooks/parse'
import type { Band } from '../types'

const NUL = '\0'

describe('parseStatus', () => {
  test('reads the branch header, counts and conflicts', () => {
    const out = [
      '# branch.oid 1234567890abcdef',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '# stash 3',
      '1 M. N... 100644 100644 100644 aaa bbb staged only.txt',
      '1 .M N... 100644 100644 100644 aaa bbb changed only.txt',
      '1 MM N... 100644 100644 100644 aaa bbb both.txt',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt',
      'old name.txt',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc in conflict.txt',
      '? new file.txt',
      '? another.txt',
      '! ignored.log',
      '',
    ].join(NUL)
    expect(parseStatus(out)).toEqual({
      branch: 'main',
      sha: '1234567',
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
      stashes: 3,
      staged: 3,
      modified: 2,
      untracked: 2,
      conflicted: ['in conflict.txt'],
    })
  })

  test('a detached HEAD and a repo with no commits', () => {
    expect(parseStatus(['# branch.oid abcdef1234', '# branch.head (detached)', ''].join(NUL)).branch).toBe(null)
    const fresh = parseStatus(['# branch.oid (initial)', '# branch.head main', ''].join(NUL))
    expect(fresh.sha).toBe(null)
    expect(fresh.upstream).toBe(null)
  })
})

describe('branches', () => {
  test('track text', () => {
    expect(parseTrack('ahead 2, behind 1')).toEqual({ ahead: 2, behind: 1, isGone: false })
    expect(parseTrack('behind 4')).toEqual({ ahead: 0, behind: 4, isGone: false })
    expect(parseTrack('gone')).toEqual({ ahead: 0, behind: 0, isGone: true })
    expect(parseTrack('')).toEqual({ ahead: 0, behind: 0, isGone: false })
  })

  test('local and remote refs, origin/HEAD skipped, worktree only when elsewhere', () => {
    const line = (...fields: string[]) => fields.join(NUL)
    const out = [
      line('refs/heads/main', 'abc1234', 'origin/main', 'ahead 1', '1700000000', '*', '/repo', 'Ann', 'Fix it'),
      line('refs/heads/old', 'def5678', 'origin/old', 'gone', '1600000000', ' ', '', 'Ann', 'Old work'),
      line('refs/heads/side', '0001111', '', '', '1650000000', ' ', '/repo-side', 'Ann', 'Side'),
      line('refs/remotes/origin/HEAD', 'abc1234', '', '', '1700000000', ' ', '', 'Ann', 'Fix it'),
      line('refs/remotes/origin/main', 'abc1234', '', '', '1700000000', ' ', '', 'Ann', 'Fix it'),
    ].join('\n')
    const list = parseBranches(out, new Set(['main', 'old']))
    expect(list.map(b => b.name)).toEqual(['main', 'old', 'side', 'origin/main'])
    expect(list[0]).toMatchObject({ ref: 'refs/heads/main', author: 'Ann', subject: 'Fix it', isCurrent: true, ahead: 1, worktree: null, isMerged: true, committedAt: 1700000000000 })
    expect(list[1]).toMatchObject({ isGone: true, isMerged: true })
    expect(list[2]).toMatchObject({ upstream: null, worktree: '/repo-side', isMerged: false })
    expect(list[3]).toMatchObject({ isRemote: true, isMerged: false })
  })
})

describe('history', () => {
  test('graph-only lines and commits marked ahead or behind', () => {
    const full = (c: string) => c.repeat(40)
    const sides = parseLeftRight(['<' + full('a'), '>' + full('b'), ''].join('\n'))
    const commit = (graph: string, sha: string, refs: string) =>
      graph + '\x1f' + [sha, refs, 'Subject', 'Ann', '1700000000'].join(NUL)
    const out = [commit('* ', full('a'), 'HEAD -> main'), '|\\', commit('| * ', full('b'), 'origin/main'), commit('* ', full('c'), '')].join('\n')
    const lines = parseLog(out, sides.ahead, sides.behind)
    expect(lines).toHaveLength(4)
    expect(lines[0]!.commit).toMatchObject({ sha: 'aaaaaaa', refs: 'HEAD -> main', side: 'ahead' })
    expect(lines[1]).toEqual({ graph: '|\\' })
    expect(lines[2]!.commit!.side).toBe('behind')
    expect(lines[3]!.commit!.side).toBe(null)
  })
})

describe('remotes', () => {
  test('web pages for scp, ssh and https remotes; none for local paths', () => {
    expect(webUrl('git@github.com:nvsravank/git-status.git')).toBe('https://github.com/nvsravank/git-status')
    expect(webUrl('ssh://git@gitlab.com:22/group/sub/repo.git')).toBe('https://gitlab.com/group/sub/repo')
    expect(webUrl('https://user:secret@github.com/o/r.git')).toBe('https://github.com/o/r')
    expect(webUrl('/srv/git/repo.git')).toBe(null)
    expect(webUrl('file:///srv/git/repo.git')).toBe(null)
  })

  test('user names and passwords are never shown', () => {
    expect(hideCredentials('https://user:secret@github.com/o/r.git')).toBe('https://github.com/o/r.git')
    expect(hideCredentials('git@github.com:o/r.git')).toBe('git@github.com:o/r.git')
  })

  test('fetch and push URLs per remote', () => {
    const out = [
      'origin\thttps://me:pw@github.com/o/r.git (fetch)',
      'origin\thttps://me:pw@github.com/o/r.git (push)',
      'upstream\tgit@github.com:up/r.git (fetch)',
      'upstream\tno_push (push)',
    ].join('\n')
    expect(parseRemotes(out)).toEqual([
      { name: 'origin', fetch: 'https://github.com/o/r.git', push: 'https://github.com/o/r.git', web: 'https://github.com/o/r' },
      { name: 'upstream', fetch: 'git@github.com:up/r.git', push: 'no_push', web: 'https://github.com/up/r' },
    ])
  })
})

describe('worktrees', () => {
  test('main and linked worktrees', () => {
    const out = [
      'worktree /repo\nHEAD 1234567890\nbranch refs/heads/main',
      'worktree /repo-wt\nHEAD abcdef1234\ndetached\nlocked reason here',
      'worktree /gone\nHEAD 0000000000\nbranch refs/heads/x\nprunable gitdir file points to non-existent location',
      '',
    ].join('\n\n')
    expect(parseWorktrees(out)).toEqual([
      { path: '/repo', branch: 'main', sha: '1234567', isBare: false, isLocked: false, isPrunable: false },
      { path: '/repo-wt', branch: null, sha: 'abcdef1', isBare: false, isLocked: true, isPrunable: false },
      { path: '/gone', branch: 'x', sha: '0000000', isBare: false, isLocked: false, isPrunable: true },
    ])
  })
})

describe('helpers', () => {
  test('ago', () => {
    const now = 1_000_000_000_000
    expect(ago(now - 10_000, now)).toBe('just now')
    expect(ago(now - 5 * 60_000, now)).toBe('5m ago')
    expect(ago(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(ago(now - 2 * 86_400_000, now)).toBe('2d ago')
  })

  test('samePath ignores separators, and case on Windows', () => {
    expect(samePath('C:\\Users\\me\\repo', 'c:/users/me/repo/')).toBe(true)
    expect(samePath('/Users/me/Repo', '/Users/me/repo')).toBe(false)
  })
})

describe('the branch list', () => {
  const line = (...fields: string[]) => fields.join(NUL)
  const out = [
    line('refs/heads/main', 'a', 'origin/main', '', '1', '*', '', 'Ann', 'm'),
    line('refs/heads/topic', 'b', 'origin/topic', '', '2', ' ', '', 'Ann', 't'),
    line('refs/heads/local-only', 'c', '', '', '3', ' ', '', 'Ann', 'l'),
    line('refs/remotes/origin/main', 'a', '', '', '1', ' ', '', 'Ann', 'm'),
    line('refs/remotes/origin/topic', 'b', '', '', '2', ' ', '', 'Ann', 't'),
    line('refs/remotes/origin/someone-else', 'd', '', '', '4', ' ', '', 'Bo', 's'),
    line('refs/remotes/fork/main', 'e', '', '', '5', ' ', '', 'Bo', 'f'),
  ].join('\n')

  test('remote branches tracked by a local branch are left out', () => {
    expect(untrackedRemotes(parseBranches(out, new Set())).map(b => b.name)).toEqual(['origin/someone-else', 'fork/main'])
  })

  test('the remote a branch belongs to, longest name first', () => {
    const remotes = [
      { name: 'origin', fetch: '', push: '', web: null },
      { name: 'origin/mirror', fetch: '', push: '', web: null },
    ]
    expect(remoteOf('origin/x', remotes)!.name).toBe('origin')
    expect(remoteOf('origin/mirror/x', remotes)!.name).toBe('origin/mirror')
    expect(remoteOf('elsewhere/x', remotes)).toBe(null)
  })
})

describe('summaryText', () => {
  const band: Band = {
    repoName: 'r',
    branch: 'main',
    sha: 'abc1234',
    upstream: 'origin/main',
    ahead: 2,
    behind: 1,
    stashes: 1,
    staged: 3,
    modified: 0,
    untracked: 1,
    conflicted: [],
    operation: { kind: 'rebase', step: 3, total: 7 },
    fetchedAt: null,
  }
  const all = { branch: true, remote: true, status: true }

  test('every part', () => {
    expect(summaryText(band, all, 0)).toBe(
      '⎇ main · → origin/main ↑2 ↓1 · never fetched · ⚠ REBASING 3/7 · ●3 staged ?1 new · ≡1 stashed',
    )
  })

  test('only the parts the preferences ask for', () => {
    expect(summaryText(band, { branch: true, remote: false, status: false }, 0)).toBe('⎇ main')
    expect(summaryText(band, { branch: false, remote: true, status: false }, 0)).toBe('→ origin/main ↑2 ↓1 · never fetched')
    expect(summaryText({ ...band, upstream: null }, { branch: false, remote: true, status: false }, 0)).toBe('no upstream')
    expect(summaryText(band, { branch: false, remote: false, status: false }, 0)).toBe('')
  })

  test('a clean tree in sync', () => {
    const clean = { ...band, ahead: 0, behind: 0, staged: 0, untracked: 0, stashes: 0, operation: null }
    expect(summaryText(clean, { branch: false, remote: true, status: true }, 0)).toBe('→ origin/main ✓ · never fetched · ✓ clean')
  })
})

describe('stashes', () => {
  test('the branch each stash was made on', () => {
    const out = [
      ['stash@{0}', '1700000000', 'WIP on main: abc1234 Fix it'].join(NUL),
      ['stash@{1}', '1600000000', 'On feature/x: before rebase'].join(NUL),
      ['stash@{2}', '1500000000', 'WIP on (no branch): def5678 Detached'].join(NUL),
    ].join('\n')
    expect(parseStashes(out).map(s => [s.name, s.branch, s.at])).toEqual([
      ['stash@{0}', 'main', 1700000000000],
      ['stash@{1}', 'feature/x', 1600000000000],
      ['stash@{2}', null, 1500000000000],
    ])
  })
})
