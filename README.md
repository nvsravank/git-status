# git-status

A read-only git dashboard for Claude Code. A one-line row above the prompt shows where your repo stands, and **`/git-status`** opens a pane with branches, history, remotes, stashes, tags and worktrees. It never changes your repo and never writes a file.

Diffs aren't shown here: [multirepo-diff-mod](https://github.com/nvsravank/multirepo-diff-mod) covers those.

## The row above the prompt

The row appears only while the session's folder is inside a git repository. Anywhere else, it stays hidden.

```
⎇ main → origin/main ↑2 ↓1 · ⚠ REBASING 3/7 · ●3 staged ✚5 changed ?1 new · ≡2 stashed · fetched 2h ago   [ + ]
```

- **Branch**, or `detached at <sha>`, or `no commits yet`.
- **Upstream** with commits to push (↑) and to pull (↓), `✓ in sync`, or `(no upstream)`.
- **In progress**: a merge, rebase (with its step), patch apply, cherry-pick, revert or bisect left half done.
- **Working tree**: conflicts, staged, changed and untracked counts, or `✓ clean`.
- **Stashes** and **when the repo was last fetched**. Ahead/behind is only as fresh as that last fetch, and this mod never fetches.
- **`[ + ]`** opens the pane.

It updates after each of Claude's tool calls, at the end of each turn, and every 15 seconds for changes you make elsewhere.

## The pane: `/git-status`

The session's folder doesn't have to be the repository. The **Repository** picker lists:

- the repository the folder is in, even when the folder is deep inside it, and
- every repository directly inside the folder (handy for a folder of projects).

Tabs:

| Tab | Shows |
| --- | --- |
| **Overview** | Folder, linked-worktree origin, branch and commit, tracking and ahead/behind, last fetch, working-tree counts, default branch, latest tag, stash count, remotes, conflicted files, and how to finish an operation in progress |
| **Branches** | Local branches with upstream, ↑/↓, `gone on remote`, `merged` into the default branch, the worktree each is checked out in, age and last commit. Remote branches, newest first |
| **History** | The commit graph of HEAD and its upstream (60 commits), with ↑ marking commits not pushed yet and ↓ commits not pulled yet |
| **Remotes** | Fetch and push URLs (any user name or password removed) and a link to the web page on GitHub, GitLab and similar hosts |
| **Stashes** | Each stash, its age and message |
| **Tags** | The newest 50 tags |
| **Worktrees** | Every worktree of the repository, its branch, and whether it is locked or missing |

`↻` re-reads the repository. `☾`/`☀` switches light and dark. Plugins aren't told the app's theme, and the choice lasts for the session only, because remembering it would mean writing a file.

## What it runs and changes

**It sends nothing anywhere and makes no network calls.** It doesn't read the conversation. Its `tool.call` and `turn.complete` hooks pass every call through unchanged and only schedule a re-read of the repository.

**It writes nothing.** No files, no settings and no stored values. Git runs with `--no-optional-locks` (and `GIT_OPTIONAL_LOCKS=0`), so `git status` doesn't refresh `.git/index`. It also runs with `core.fsmonitor=false`, so no file-watcher daemon starts. Nothing ever fetches, so remote-tracking refs stay as they are.

Programs it runs (all `git`, in the repository's folder):

| Command | Why |
| --- | --- |
| `git rev-parse --show-toplevel --absolute-git-dir --git-common-dir --git-path FETCH_HEAD` | Find the repository a folder is in |
| `git status --porcelain=v2 --branch --show-stash -z` | Branch, upstream, ahead/behind, file counts, stash count |
| `git for-each-ref refs/heads refs/remotes` (and `--merged`) | Branches, their upstreams and whether they're merged |
| `git symbolic-ref refs/remotes/origin/HEAD`, `git rev-parse --verify` | The default branch |
| `git rev-list --left-right HEAD...@{u}` | Which commits are unpushed or not yet pulled |
| `git log --graph -n60` | History |
| `git remote -v` | Remotes |
| `git stash list` | Stashes |
| `git for-each-ref refs/tags`, `git describe --tags --abbrev=0` | Tags |
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
