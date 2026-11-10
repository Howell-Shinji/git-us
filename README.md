# GitUS - Git for Obsidian

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A VS Code-inspired Source Control plugin for Obsidian. GitUS provides staging, diffs, commits, branches, stashes, conflict resolution, and nested repository discovery without leaving your vault.

GitUS is a desktop-only plugin. It requires Obsidian 1.7.2 or later and a working local Git installation.

---

## Features

### Source Control Panel

Open with `GitUS: Open Source Control view` or the ribbon icon.

The sidebar has three collapsible sections: **Repositories** shows the selected repository with a clickable branch name, refresh, and repository menu; **Changes** holds the commit message and staged/working files, with commit and refresh actions in its header; and **Graph** shows interactive commit history with independent Pull and Push buttons in its header. Stash, undo, and history actions are available in the repository menu. In Graph, switch between all refs and the current branch, refresh the history, load more commits, or select a commit to inspect its diff. The graph refreshes after GitUS operations and every 30 seconds while the panel is open.

| Area | What you can do |
|---|---|
| **Inline commit** | Type a message, press **Ctrl+Enter** or the commit button |
| **Staged Changes** | Unstage all · Per-file: Diff, Unstage, Unstage Hunks…, Revert |
| **Changes** | Stage all · Per-file: Diff, Stage, Stage Hunks…, Discard |
| **Untracked Files** | Stage all · Per-file: Stage, Discard |
| **Merge Changes** | Per-file: Resolve… (conflict editor), Mark Resolved |

### Hunk-Level Staging

"Stage Hunks…" and "Unstage Hunks…" open a picker showing every `@@` hunk with a coloured preview. Tick the ones you want, click apply — GitUS writes a minimal patch file to a temp directory and runs `git apply --cached`.

### Conflict Resolver

"Resolve…" opens a side-by-side modal with **Current (HEAD)**, optional **Base**, and **Incoming** content extracted from conflict markers. Choose:

- **Accept Current** — keep ours, discard theirs
- **Accept Incoming** — keep theirs, discard ours
- **Accept Both** — concatenate both sides

The file is written back and staged automatically.

### Branch & Stash

- **Branch** button — switch to an existing branch or create + checkout a new one
- **Stash** button — push (with optional message), push staged-only, list all stashes with Pop / Apply / Drop
- **Undo** button — `git reset --soft HEAD~1` with confirmation

### History

**History** button shows the last 60 commits via `git log --oneline --decorate --graph` with commit hash highlighted in yellow.

### Diff Viewer

Every Diff button opens a coloured diff modal: additions in green, deletions in red, hunk headers in cyan, file headers in accent, metadata in muted.

### Status Bar

```
GitUS repo:branch S2 U1 ?0 C0 ↑1 ↓0
```
`S` staged · `U` unstaged · `?` untracked · `C` conflicts · ↑ ahead · ↓ behind

### Nested Repository Resolution

1. Take the absolute path of the active note.
2. Walk parent directories upward, stopping at vault root.
3. First directory with a `.git` directory **or** a `.git` file (`gitdir:`) becomes the active repo.
4. If no vault repo is found, resolve the note's symlink and match its real path against registered extra repository roots.

This means each note can belong to its own repo — monorepos, submodules, multi-project vaults all work correctly.

For a symlink to only part of a repository outside the vault, add that repository's absolute worktree root under **Extra repository roots** in GitUS settings. Enter one path per line, then select **Rebuild index**. Valid roots appear in **Switch repository context**; linked notes select the matching root automatically. Invalid paths are skipped and reported when you rebuild. Git actions in these repositories can change files outside the vault.

---

## Commands

| Command | Description |
|---|---|
| `GitUS: Open Source Control view` | Open the SCM panel |
| `GitUS: Refresh context` | Force-refresh status |
| `GitUS: Switch repository context` | Manually pick a repo from the index |
| `GitUS: Clear manual repository context` | Return to automatic (file-follows) mode |
| `GitUS: Rebuild repository index` | Re-scan vault and validate extra repository roots |
| `GitUS: Stage current file` | Stage the open note |
| `GitUS: Unstage current file` | Unstage the open note |
| `GitUS: Show diff for current file` | Open diff for the open note |
| `GitUS: Commit in current repo` | Commit with a message dialog |
| `GitUS: Pull in current repo` | Pull (warns on dirty tree) |
| `GitUS: Push in current repo` | Push (warns on dirty tree) |
| `GitUS: Checkout or create branch` | Switch or create branch |

---

## Settings

| Setting | Default | Description |
|---|---|---|
| Git binary | `git` | Executable or absolute path used to run Git |
| Auto-refresh interval | 5 seconds | Polling frequency for repository state |
| Git timeout | 30 seconds | Maximum time allowed for a Git operation |
| Visible changes limit | 250 | Initial file count rendered per section in large repositories |
| Extra repository roots | None | Absolute Git worktree roots, one per line; may be outside the vault |

---

## Installation

### Community plugins

After GitUS is accepted into the Obsidian Community directory:

1. Open **Settings → Community plugins** in Obsidian.
2. Select **Browse**, search for **GitUS**, and select **Install**.
3. Enable the plugin.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from a GitHub release.
2. Put the files in your vault's plugin folder:  
   `<vault>/.obsidian/plugins/gitus/`
3. Enable **GitUS** in *Settings → Community Plugins*.

---

## Development

```bash
npm ci
npm run dev   # watch mode
npm run build # production bundle
npm run check # TypeScript validation
```

Requires Node ≥ 18 and a local Git installation.

---

## Security and privacy

GitUS does not include telemetry, analytics, advertisements, or a remote service. To provide Git functionality, it:

- Executes the configured Git binary as a local child process.
- Reads repository metadata and can modify working-tree files when you explicitly stage, discard, resolve, stash, commit, or switch branches.
- Can access configured remotes only when you explicitly run network-capable Git operations such as pull or push. Authentication is handled by your Git installation.

Review changes before destructive actions and keep an external backup of important repositories.

---

## Releasing

1. Ensure `minAppVersion` in `manifest.json` is correct.
2. Run `npm version patch`, `npm version minor`, or `npm version major`.
3. Push the commit and the generated numeric tag, for example `1.0.5`.
4. GitHub Actions builds and validates the plugin, then creates a draft release containing `main.js`, `manifest.json`, and `styles.css`.
5. Review the generated draft release notes and publish the release.

---

## Architecture

```
main.ts
├── VsCodeLikeGitPlugin      Plugin lifecycle, git execution, repo discovery
├── SourceControlView         Sidebar panel with static shell / dynamic body
├── HunkPickerModal           Hunk-level stage / unstage
├── ConflictResolverModal     Side-by-side conflict editor
├── StashModal                Stash management
├── CommitHistoryModal        git log viewer
├── BranchPickerModal         Branch switch / create
├── CommitMessageModal        Commit message input (legacy commands)
├── ConfirmModal              Destructive action guard
└── RepoPickerModal           Manual repo context switcher
styles.css                    VS Code-inspired flat SCM styles
```

---

## License

[MIT](LICENSE) © 2026 Mr Stark Labs
