# git-status

A read-only git dashboard for Claude Code. A summary row shows where your repo stands, and **`/git-status`** opens a pane listing every branch, with each branch's overview, history, tags and worktrees. It never changes your repo and never writes a file.

Diffs aren't shown here: [multirepo-diff-mod](https://github.com/nvsravank/multirepo-diff-mod) covers those.

## The summary row

The summary shows only while the session's folder is inside a git repository. Anywhere else it stays hidden.

```
⎇ main → origin/main ↑2 ↓1 · fetched 2h ago · ⚠ REBASING 3/7 ●3 staged ✚5 changed ?1 new · ≡2 stashed   [ + ]
```

- **Branch**, or `detached at <sha>`, or `no commits yet`.
- **Remote**: the upstream with commits to push (↑) and to pull (↓), or `(no upstream)`, plus when the repo was last fetched. Ahead/behind is only as fresh as that last fetch, and this mod never fetches.
- **Status**: an operation in progress (merge, rebase with its step, patch apply, cherry-pick, revert, bisect), conflicted, staged, changed and untracked files, or `✓ clean`, and stashes.
- **`[ + ]`** opens the pane.

It updates after each of Claude's tool calls, at the end of each turn, and every 15 seconds for changes you make elsewhere.

## Preferences

Set them in `/config` (or under `pluginConfigs` → `git-status` in settings):

| Preference | Default | |
| --- | --- | --- |
| Show branch | on | The checked-out branch |
| Show remote | on | Upstream, ↑/↓ and last fetch |
| Show status | on | Files, operation in progress, stashes |
| Where the summary shows | `above-prompt` | `above-prompt` is the row above the prompt, with the `[ + ]` button. Only one mod can draw that row at a time. `status-line` is a line under the prompt that sits beside other mods' lines, with no button: open the pane with `/git-status` |

With all three parts off, the row above the prompt still shows `Git status [ + ]`.

## The pane: `/git-status`

The session's folder doesn't have to be the repository. The **Repository** picker lists the repository the folder is in (even from deep inside it) and every repository directly inside the folder.

**On the left**, every branch once:

- **Local**: your branches, the checked-out one first (●), with ↑/↓ and `(gone)` when the upstream was deleted. Branches already merged into the default branch are dimmed.
- **Remote only**: remote branches that no local branch tracks. A remote branch you track shows as its local branch instead, so nothing is listed twice.

**On the right**, the branch you pick:

| Tab | Shows |
| --- | --- |
| **Overview** | Last commit, tracking and ↑/↓ (or "deleted on the remote"), commits ahead of and behind the default branch, merged or not, the worktree it's checked out in, its remote and a link to the branch on GitHub, GitLab and similar hosts, and last fetch. For the checked-out branch, also the working tree, stashes, conflicted files and how to finish an operation in progress |
| **History** | The branch's commit graph with its upstream (60 commits), ↑ marking commits not pushed yet and ↓ commits not pulled yet |
| **Tags** | Tags in the branch's history, newest 50 |
| **Worktrees** | Every worktree of the repository, with the ones that have this branch checked out marked |

`↻` re-reads the repository. `☾`/`☀` switches light and dark. Plugins aren't told the app's theme, and the choice lasts for the session only, because remembering it would mean writing a file. Below 80 columns the branch list sits above the details.

## What it runs and changes

**It sends nothing anywhere and makes no network calls.** It doesn't read the conversation. Its `tool.call` and `turn.complete` hooks pass every call through unchanged and only schedule a re-read of the repository.

**It writes nothing.** No files, no settings and no stored values (your preferences are kept by Claude Code's own settings). Git runs with `--no-optional-locks` (and `GIT_OPTIONAL_LOCKS=0`), so `git status` doesn't refresh `.git/index`. It also runs with `core.fsmonitor=false`, so no file-watcher daemon starts. Nothing ever fetches, so remote-tracking refs stay as they are.

Programs it runs (all `git`, in the repository's folder):

| Command | Why |
| --- | --- |
| `git rev-parse --show-toplevel --absolute-git-dir --git-common-dir --git-path FETCH_HEAD` | Find the repository a folder is in |
| `git status --porcelain=v2 --branch --show-stash -z` | Branch, upstream, ahead/behind, file counts, stash count |
| `git rev-list --left-right --count <branch>...<default>` | A branch's commits ahead of and behind the default branch |
| `git for-each-ref refs/heads refs/remotes` (and `--merged`) | Branches, their upstreams and whether they're merged |
| `git symbolic-ref refs/remotes/origin/HEAD`, `git rev-parse --verify` | The default branch |
| `git rev-list --left-right <branch>...<upstream>` | Which commits are unpushed or not yet pulled |
| `git log --graph -n60 <branch> <upstream>` | History |
| `git remote -v` | Remotes |
| `git for-each-ref --merged=<branch> refs/tags` | Tags in a branch's history |
| `git worktree list --porcelain` | Worktrees |

Files it reads: what git keeps for an operation in progress (`MERGE_HEAD`, `rebase-merge/`, `rebase-apply/`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG`), the date of `FETCH_HEAD`, and the folder listing used to find repositories inside it.

There's nothing to clean up after removing it.

## Install (local)

```bash
claude --plugin-dir /path/to/git-status
```

For the Desktop app, add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json` (separate several folders with `:`), then restart the app.

## Development

```bash
claude plugin validate .
claude plugin test .
```

`hooks/parse.ts` holds the pure parsers of git's output, which the tests cover. Everything that runs git is in `hooks/register.tsx`.

## License

MIT
