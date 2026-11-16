# Security

If you find a security problem in this mod, please report it privately through
GitHub's **Report a vulnerability** button on the repository's **Security** tab,
rather than in a public issue.

The mod is meant to be read-only. It doesn't read the conversation, makes no
network calls, and writes no files, settings or stored values. It only runs
read-only `git` commands in your repositories (with optional locks and
fsmonitor turned off, and it never fetches), and reads a few files git keeps
for an operation in progress (see "What it runs and changes" in the README).
Reports about it changing your repository, writing anything, starting
background processes, touching the network, or running anything beyond the
commands listed there are especially welcome.
