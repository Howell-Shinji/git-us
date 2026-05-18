# GitUS — Git for Obsidian

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A VS Code-inspired Source Control plugin for Obsidian that solves the **nested repository problem**: instead of treating the whole vault as one repository, GitUS resolves the nearest `.git` for every active file.

---

## Features

### Source Control Panel

Open with `GitUS: Open Source Control view` or the ribbon icon.

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

"Resolve…" opens a side-by-side modal with **Current (HEAD)** and **Incoming** content extracted from the conflict markers. Choose:

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

This means each note can belong to its own repo — monorepos, submodules, multi-project vaults all work correctly.

---

## Commands

| Command | Description |
|---|---|
| `GitUS: Open Source Control view` | Open the SCM panel |
| `GitUS: Refresh context` | Force-refresh status |
| `GitUS: Switch repository context` | Manually pick a repo from the index |
| `GitUS: Clear manual repository context` | Return to automatic (file-follows) mode |
| `GitUS: Rebuild repository index` | Re-scan vault for all `.git` roots |
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
| Git binary | `git` | Path to git executable |
| Auto-refresh interval | `5 s` | How often to poll for changes |

---

## Installation

### Manual

1. Run `npm install && npm run build`.
2. Copy `main.js`, `manifest.json`, and `styles.css` into your vault's plugin folder:  
   `<vault>/.obsidian/plugins/gitus/`
3. Enable **GitUS** in *Settings → Community Plugins*.

---

## Development

```bash
npm install
npm run dev   # watch mode
npm run build # production bundle
```

Requires Node ≥ 18 and a local Git installation.

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

[MIT](LICENSE) © 2026

