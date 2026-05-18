import {
  App,
  FileSystemAdapter,
  ItemView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  setIcon
} from "obsidian";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SOURCE_CONTROL_VIEW_TYPE = "gitus-source-control-view";
const GITUS_ICON = "git-branch";

interface GitPluginSettings {
  gitBinary: string;
  autoRefreshSeconds: number;
  collapsedSections: Record<string, boolean>;
}

const DEFAULT_SETTINGS: GitPluginSettings = {
  gitBinary: "git",
  autoRefreshSeconds: 5,
  collapsedSections: {
    "Merge Changes": false,
    "Staged Changes": false,
    "Changes": false,
    "Untracked Files": false
  }
};

interface RepoStatus {
  branch: string;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
  ahead: number;
  behind: number;
}

interface FileChange {
  x: string;
  y: string;
  path: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

interface RepoSnapshot {
  repoRoot: string;
  repoName: string;
  status: RepoStatus;
  changes: FileChange[];
}

interface DisplayChange {
  path: string;
  mode: "staged" | "unstaged" | "untracked" | "conflict";
  statusCode: string;
}

interface DiffHunk {
  index: number;
  header: string;   // full "@@ ... @@" line
  content: string;  // header + body lines joined, ending with \n
}

function parseDiffHunks(diffOutput: string): { patchHeader: string; hunks: DiffHunk[] } {
  const lines = diffOutput.split("\n");
  const headerLines: string[] = [];
  const hunks: DiffHunk[] = [];
  let currentLines: string[] | null = null;

  for (const line of lines) {
    if (line.startsWith("@@ ")) {
      if (currentLines !== null && currentLines.length > 0) {
        const content = currentLines.join("\n") + "\n";
        hunks.push({ index: hunks.length, header: currentLines[0] ?? "", content });
      }
      currentLines = [line];
    } else if (currentLines !== null) {
      currentLines.push(line);
    } else {
      headerLines.push(line);
    }
  }

  if (currentLines !== null && currentLines.length > 0) {
    const content = currentLines.join("\n") + "\n";
    hunks.push({ index: hunks.length, header: currentLines[0] ?? "", content });
  }

  return { patchHeader: headerLines.join("\n") + "\n", hunks };
}

function normalizeToPosix(input: string): string {
  return input.split(path.sep).join(path.posix.sep);
}

class CommitMessageModal extends Modal {
  private onSubmit: (message: string) => Promise<void>;

  constructor(app: App, onSubmit: (message: string) => Promise<void>) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h3", { text: "Commit message" });
    const input = contentEl.createEl("input", {
      type: "text",
      placeholder: "feat: update note workflow"
    });
    input.addClass("vlg-input");

    const actions = contentEl.createDiv({ cls: "vlg-actions" });
    const commitBtn = actions.createEl("button", { text: "Commit" });
    const cancelBtn = actions.createEl("button", { text: "Cancel" });

    commitBtn.onclick = async () => {
      const message = input.value.trim();
      if (!message) {
        new Notice("Commit message is required");
        return;
      }
      await this.onSubmit(message);
      this.close();
    };

    cancelBtn.onclick = () => this.close();
    input.focus();
  }
}

class ConfirmModal extends Modal {
  private message: string;
  private onConfirm: () => Promise<void>;

  constructor(app: App, message: string, onConfirm: () => Promise<void>) {
    super(app);
    this.message = message;
    this.onConfirm = onConfirm;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", { text: this.message });

    const actions = contentEl.createDiv({ cls: "vlg-actions" });
    const yesBtn = actions.createEl("button", { text: "Continue" });
    const cancelBtn = actions.createEl("button", { text: "Cancel" });

    yesBtn.onclick = async () => {
      await this.onConfirm();
      this.close();
    };
    cancelBtn.onclick = () => this.close();
  }
}

class RepoPickerModal extends Modal {
  private repos: string[];
  private onPick: (repoRoot: string) => Promise<void>;

  constructor(app: App, repos: string[], onPick: (repoRoot: string) => Promise<void>) {
    super(app);
    this.repos = repos;
    this.onPick = onPick;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Select repository" });

    const list = contentEl.createDiv({ cls: "vlg-repo-list" });
    for (const repo of this.repos) {
      const btn = list.createEl("button", { text: repo });
      btn.addClass("vlg-repo-item");
      btn.onclick = async () => {
        await this.onPick(repo);
        this.close();
      };
    }
  }
}

class BranchPickerModal extends Modal {
  private branches: string[];
  private onCheckout: (branchName: string, create: boolean) => Promise<void>;

  constructor(
    app: App,
    branches: string[],
    onCheckout: (branchName: string, create: boolean) => Promise<void>
  ) {
    super(app);
    this.branches = branches;
    this.onCheckout = onCheckout;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Checkout or create branch" });

    const input = contentEl.createEl("input", {
      type: "text",
      placeholder: "feature/new-flow"
    });
    input.addClass("vlg-input");

    const actions = contentEl.createDiv({ cls: "vlg-actions" });
    const checkoutBtn = actions.createEl("button", { text: "Checkout" });
    const createBtn = actions.createEl("button", { text: "Create + Checkout" });

    checkoutBtn.onclick = async () => {
      const name = input.value.trim();
      if (!name) {
        new Notice("Branch name is required");
        return;
      }
      await this.onCheckout(name, false);
      this.close();
    };

    createBtn.onclick = async () => {
      const name = input.value.trim();
      if (!name) {
        new Notice("Branch name is required");
        return;
      }
      await this.onCheckout(name, true);
      this.close();
    };

    contentEl.createEl("h4", { text: "Local branches" });
    const list = contentEl.createDiv({ cls: "vlg-repo-list" });
    for (const branch of this.branches) {
      const btn = list.createEl("button", { text: branch });
      btn.addClass("vlg-repo-item");
      btn.onclick = async () => {
        await this.onCheckout(branch, false);
        this.close();
      };
    }

    input.focus();
  }
}

// ── Stash ──────────────────────────────────────────────────────────────────

interface StashEntry {
  index: number;
  label: string; // full "stash@{N}: ..." string
}

class StashModal extends Modal {
  private repoRoot: string;
  private plugin: VsCodeLikeGitPlugin;

  constructor(app: App, repoRoot: string, plugin: VsCodeLikeGitPlugin) {
    super(app);
    this.repoRoot = repoRoot;
    this.plugin = plugin;
    this.titleEl.setText("Stash");
  }

  async onOpen(): Promise<void> {
    await this.renderContent();
  }

  private async renderContent(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();

    // ── Push new stash ────────────────────────────────────────────────────
    contentEl.createEl("h4", { text: "Save stash" });
    const msgRow = contentEl.createDiv({ cls: "vlg-stash-input-row" });
    const msgInput = msgRow.createEl("input") as HTMLInputElement;
    msgInput.type = "text";
    msgInput.placeholder = "Stash message (optional)";
    msgInput.addClass("vlg-input");

    const pushActions = contentEl.createDiv({ cls: "vlg-actions" });
    const pushBtn = pushActions.createEl("button", { text: "Stash Changes" });
    const pushStagedBtn = pushActions.createEl("button", { text: "Stash Staged Only" });

    pushBtn.onclick = async () => {
      const msg = msgInput.value.trim();
      const args = msg ? ["stash", "push", "-m", msg] : ["stash", "push"];
      await this.plugin.runGitPublic(args, this.repoRoot);
      new Notice("Stash saved");
      await this.plugin.refreshContext();
      await this.renderContent();
    };

    pushStagedBtn.onclick = async () => {
      const msg = msgInput.value.trim();
      const args = msg
        ? ["stash", "push", "--staged", "-m", msg]
        : ["stash", "push", "--staged"];
      await this.plugin.runGitPublic(args, this.repoRoot);
      new Notice("Staged changes stashed");
      await this.plugin.refreshContext();
      await this.renderContent();
    };

    // ── Stash list ────────────────────────────────────────────────────────
    const stashes = await this.loadStashes();

    contentEl.createEl("h4", { text: `Stash list (${stashes.length})` });
    if (stashes.length === 0) {
      contentEl.createEl("p", { text: "No stashes.", cls: "vlg-change-empty" });
      return;
    }

    const stashList = contentEl.createDiv({ cls: "vlg-stash-list" });
    for (const stash of stashes) {
      const row = stashList.createDiv({ cls: "vlg-stash-row" });
      row.createEl("span", { text: stash.label, cls: "vlg-stash-label" });

      const rowActions = row.createDiv({ cls: "vlg-change-actions" });

      const popBtn = rowActions.createEl("button", { text: "Pop" });
      popBtn.onclick = async () => {
        await this.plugin.runGitPublic(["stash", "pop", `stash@{${stash.index}}`], this.repoRoot);
        new Notice(`Popped stash@{${stash.index}}`);
        await this.plugin.refreshContext();
        await this.renderContent();
      };

      const applyBtn = rowActions.createEl("button", { text: "Apply" });
      applyBtn.onclick = async () => {
        await this.plugin.runGitPublic(["stash", "apply", `stash@{${stash.index}}`], this.repoRoot);
        new Notice(`Applied stash@{${stash.index}}`);
        await this.plugin.refreshContext();
        await this.renderContent();
      };

      const dropBtn = rowActions.createEl("button", { text: "Drop" });
      dropBtn.addClass("vlg-btn-danger");
      dropBtn.onclick = async () => {
        await this.plugin.runGitPublic(["stash", "drop", `stash@{${stash.index}}`], this.repoRoot);
        new Notice(`Dropped stash@{${stash.index}}`);
        await this.renderContent();
      };
    }
  }

  private async loadStashes(): Promise<StashEntry[]> {
    try {
      const raw = await this.plugin.runGitPublic(["stash", "list"], this.repoRoot);
      return raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((label, index) => ({ index, label }));
    } catch {
      return [];
    }
  }
}

// ── Commit history ──────────────────────────────────────────────────────────

class CommitHistoryModal extends Modal {
  private repoRoot: string;
  private plugin: VsCodeLikeGitPlugin;

  constructor(app: App, repoRoot: string, plugin: VsCodeLikeGitPlugin) {
    super(app);
    this.repoRoot = repoRoot;
    this.plugin = plugin;
    this.titleEl.setText("Commit History");
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();

    let raw: string;
    try {
      raw = await this.plugin.runGitPublic(
        ["log", "--oneline", "--decorate", "--graph", "-60"],
        this.repoRoot
      );
    } catch (err) {
      contentEl.createEl("p", { text: `Failed to load history: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    if (!raw.trim()) {
      contentEl.createEl("p", { text: "No commits yet.", cls: "vlg-change-empty" });
      return;
    }

    const pre = contentEl.createEl("pre", { cls: "vlg-log-view" });
    for (const line of raw.split("\n")) {
      if (!line) continue;
      const span = pre.createEl("span");
      // hash is the first token after graph chars
      const hashMatch = line.match(/([0-9a-f]{6,})/);
      if (hashMatch) {
        const idx = line.indexOf(hashMatch[0]);
        span.createEl("span", { text: line.slice(0, idx), cls: "vlg-log-graph" });
        span.createEl("span", { text: hashMatch[0], cls: "vlg-log-hash" });
        span.createEl("span", { text: line.slice(idx + hashMatch[0].length), cls: "vlg-log-msg" });
      } else {
        span.setText(line);
      }
      span.createEl("br");
    }
  }
}

// ── Conflict resolver ───────────────────────────────────────────────────────

class ConflictResolverModal extends Modal {
  private repoRoot: string;
  private filePath: string;
  private plugin: VsCodeLikeGitPlugin;

  constructor(app: App, repoRoot: string, filePath: string, plugin: VsCodeLikeGitPlugin) {
    super(app);
    this.repoRoot = repoRoot;
    this.filePath = filePath;
    this.plugin = plugin;
    this.titleEl.setText(`Resolve conflict: ${filePath}`);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();

    const absPath = path.join(this.repoRoot, this.filePath);
    let content: string;
    try {
      content = await fs.readFile(absPath, "utf8");
    } catch (err) {
      contentEl.createEl("p", { text: `Cannot read file: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    const { ours, theirs, hasConflict } = parseConflictMarkers(content);

    if (!hasConflict) {
      contentEl.createEl("p", { text: "No conflict markers found. File may already be resolved." });
      const markBtn = contentEl.createEl("button", { text: "Mark as Resolved" });
      markBtn.onclick = async () => {
        await this.plugin.stageRepoFile(this.repoRoot, this.filePath);
        this.close();
      };
      return;
    }

    const sections = contentEl.createDiv({ cls: "vlg-conflict-sections" });

    const oursCol = sections.createDiv({ cls: "vlg-conflict-col" });
    oursCol.createEl("div", { text: "Current (HEAD)", cls: "vlg-conflict-col-title vlg-conflict-ours" });
    oursCol.createEl("pre", { text: ours, cls: "vlg-conflict-pre vlg-conflict-pre-ours" });

    const theirsCol = sections.createDiv({ cls: "vlg-conflict-col" });
    theirsCol.createEl("div", { text: "Incoming", cls: "vlg-conflict-col-title vlg-conflict-theirs" });
    theirsCol.createEl("pre", { text: theirs, cls: "vlg-conflict-pre vlg-conflict-pre-theirs" });

    const actions = contentEl.createDiv({ cls: "vlg-actions vlg-conflict-actions" });

    const acceptOursBtn = actions.createEl("button", { text: "Accept Current (Ours)" });
    acceptOursBtn.onclick = async () => {
      await this.applyResolution(content, "ours");
    };

    const acceptTheirsBtn = actions.createEl("button", { text: "Accept Incoming (Theirs)" });
    acceptTheirsBtn.onclick = async () => {
      await this.applyResolution(content, "theirs");
    };

    const acceptBothBtn = actions.createEl("button", { text: "Accept Both" });
    acceptBothBtn.onclick = async () => {
      await this.applyResolution(content, "both");
    };

    actions.createEl("button", { text: "Cancel" }).onclick = () => this.close();
  }

  private async applyResolution(content: string, choice: "ours" | "theirs" | "both"): Promise<void> {
    const resolved = resolveConflictMarkers(content, choice);
    const absPath = path.join(this.repoRoot, this.filePath);
    await fs.writeFile(absPath, resolved, "utf8");
    await this.plugin.stageRepoFile(this.repoRoot, this.filePath);
    new Notice(`Resolved with ${choice} and staged`);
    this.close();
  }
}

function parseConflictMarkers(content: string): { ours: string; theirs: string; hasConflict: boolean } {
  const oursLines: string[] = [];
  const theirsLines: string[] = [];
  let state: "normal" | "ours" | "theirs" = "normal";
  let hasConflict = false;

  for (const line of content.split("\n")) {
    if (line.startsWith("<<<<<<<")) {
      state = "ours";
      hasConflict = true;
    } else if (line.startsWith("=======")) {
      state = "theirs";
    } else if (line.startsWith(">>>>>>>")) {
      state = "normal";
    } else if (state === "ours") {
      oursLines.push(line);
    } else if (state === "theirs") {
      theirsLines.push(line);
    }
  }

  return { ours: oursLines.join("\n"), theirs: theirsLines.join("\n"), hasConflict };
}

function resolveConflictMarkers(content: string, choice: "ours" | "theirs" | "both"): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let state: "normal" | "ours" | "theirs" = "normal";

  for (const line of lines) {
    if (line.startsWith("<<<<<<<")) {
      state = "ours";
    } else if (line.startsWith("=======")) {
      state = "theirs";
    } else if (line.startsWith(">>>>>>>")) {
      state = "normal";
    } else if (state === "normal") {
      result.push(line);
    } else if (state === "ours" && (choice === "ours" || choice === "both")) {
      result.push(line);
    } else if (state === "theirs" && (choice === "theirs" || choice === "both")) {
      result.push(line);
    }
  }

  return result.join("\n");
}

// ── Hunk picker ─────────────────────────────────────────────────────────────

class HunkPickerModal extends Modal {
  private hunks: DiffHunk[];
  private patchHeader: string;
  private actionLabel: string;
  private onApply: (patch: string) => Promise<void>;

  constructor(
    app: App,
    hunks: DiffHunk[],
    patchHeader: string,
    title: string,
    actionLabel: string,
    onApply: (patch: string) => Promise<void>
  ) {
    super(app);
    this.hunks = hunks;
    this.patchHeader = patchHeader;
    this.titleEl.setText(title);
    this.actionLabel = actionLabel;
    this.onApply = onApply;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    const selected = new Set<number>(this.hunks.map((h) => h.index));

    const hunkList = contentEl.createDiv({ cls: "vlg-hunk-list" });

    for (const hunk of this.hunks) {
      const row = hunkList.createDiv({ cls: "vlg-hunk-row" });

      const checkbox = row.createEl("input") as HTMLInputElement;
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.addClass("vlg-hunk-check");
      checkbox.onchange = () => {
        if (checkbox.checked) {
          selected.add(hunk.index);
        } else {
          selected.delete(hunk.index);
        }
      };

      const body = row.createDiv({ cls: "vlg-hunk-body" });
      body.createEl("div", { text: hunk.header, cls: "vlg-hunk-header" });

      const pre = body.createEl("pre", { cls: "vlg-hunk-preview" });
      const diffLines = hunk.content.split("\n").slice(1); // skip header line
      for (const diffLine of diffLines.slice(0, 12)) {
        if (!diffLine) continue;
        const span = pre.createEl("span");
        span.setText(diffLine + "\n");
        if (diffLine.startsWith("+")) span.addClass("vlg-hunk-add");
        else if (diffLine.startsWith("-")) span.addClass("vlg-hunk-del");
      }
      if (diffLines.length > 13) {
        pre.createEl("span", { text: `… (${diffLines.length - 12} more lines)`, cls: "vlg-hunk-more" });
      }
    }

    const actions = contentEl.createDiv({ cls: "vlg-actions" });
    const applyBtn = actions.createEl("button", { text: this.actionLabel });
    const cancelBtn = actions.createEl("button", { text: "Cancel" });

    applyBtn.onclick = async () => {
      if (selected.size === 0) {
        new Notice("Select at least one hunk");
        return;
      }
      const selectedHunks = this.hunks.filter((h) => selected.has(h.index));
      const patch = this.patchHeader + selectedHunks.map((h) => h.content).join("");
      try {
        await this.onApply(patch);
        this.close();
      } catch (err) {
        new Notice(`Failed to apply patch: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    cancelBtn.onclick = () => this.close();
  }
}

class SourceControlView extends ItemView {
  private plugin: VsCodeLikeGitPlugin;
  private collapsedSections = new Map<string, boolean>();
  private lastRenderKey = "";
  private bodyEl: HTMLElement | null = null;
  private headlineEl: HTMLElement | null = null;
  private statsEl: HTMLElement | null = null;
  private commitInputEl: HTMLTextAreaElement | null = null;
  private commitBtnEl: HTMLButtonElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: VsCodeLikeGitPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return SOURCE_CONTROL_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "GitUS Source Control";
  }

  getIcon(): string {
    return GITUS_ICON;
  }

  async onOpen(): Promise<void> {
    this.containerEl.addClass("vlg-sc-view");
    this.initializeSectionCollapseState();
    await this.render();
  }

  async onClose(): Promise<void> {
    this.containerEl.empty();
  }

  async render(): Promise<void> {
    const snapshot = await this.plugin.getActiveRepoSnapshot();
    const key = this.buildSnapshotKey(snapshot);

    // Nothing changed — skip DOM work entirely to prevent flicker.
    if (key === this.lastRenderKey) return;
    this.lastRenderKey = key;

    const wrap = this.containerEl.children[1] as HTMLElement;

    // ── First render or repo changed: build the static shell ──────────────
    const shellKey = snapshot ? `${snapshot.repoRoot}` : "";
    const prevShellKey = wrap.dataset["shellKey"] ?? "";

    if (prevShellKey !== shellKey) {
      wrap.empty();
      this.bodyEl = null;
      this.headlineEl = null;
      this.statsEl = null;
      this.commitInputEl = null;
      this.commitBtnEl = null;
      wrap.dataset["shellKey"] = shellKey;

      if (!snapshot) {
        wrap.createEl("h4", { text: "SOURCE CONTROL", cls: "vlg-panel-title" });
        const emptyWrap = wrap.createDiv({ cls: "vlg-no-repo" });
        emptyWrap.createEl("p", {
          text: "No Git repository detected for the current file.",
          cls: "vlg-no-repo-msg"
        });

        const knownRepos = this.plugin.getKnownRepos();
        if (knownRepos.length > 0) {
          emptyWrap.createEl("p", { text: "Known repositories:", cls: "vlg-no-repo-label" });
          const repoList = emptyWrap.createDiv({ cls: "vlg-no-repo-list" });
          for (const repo of knownRepos) {
            const item = repoList.createDiv({ cls: "vlg-no-repo-item" });
            setIcon(item.createSpan({ cls: "vlg-no-repo-icon" }), "git-branch");
            item.createSpan({ text: path.basename(repo), cls: "vlg-no-repo-name" });
            item.createSpan({ text: repo, cls: "vlg-no-repo-path" });
            item.onclick = async () => {
              await this.plugin.selectRepo(repo);
            };
          }
        }

        const emptyActions = emptyWrap.createDiv({ cls: "vlg-no-repo-actions" });
        const rebuildBtn = emptyActions.createEl("button", { text: "Rebuild Index" });
        rebuildBtn.onclick = async () => {
          await this.plugin.rebuildIndex();
          await this.render();
        };
        return;
      }

      const panelTitle = wrap.createEl("h4", {
        text: "SOURCE CONTROL",
        cls: "vlg-panel-title"
      });
      panelTitle.setAttr("aria-label", "Source Control");

      const header = wrap.createDiv({ cls: "vlg-sc-header" });
      const headlineRow = header.createDiv({ cls: "vlg-headline-row" });
      this.headlineEl = headlineRow.createEl("div", {
        text: `${snapshot.repoName} • ${snapshot.status.branch}`,
        cls: "vlg-repo-headline"
      });
      const switchBtn = headlineRow.createEl("button", { text: "Switch Repo" });
      switchBtn.addClass("vlg-switch-repo-btn");

      const actions = header.createDiv({ cls: "vlg-sc-actions" });
      const refreshBtn = actions.createEl("button", { text: "Refresh" });
      const undoBtn = actions.createEl("button", { text: "Undo" });
      undoBtn.setAttr("title", "Undo last commit (--soft)");
      const pullBtn = actions.createEl("button", { text: "Pull" });
      const pushBtn = actions.createEl("button", { text: "Push" });
      const stashBtn = actions.createEl("button", { text: "Stash" });
      const historyBtn = actions.createEl("button", { text: "History" });
      const branchBtn = actions.createEl("button", { text: "Branch" });

      refreshBtn.onclick = async () => { await this.plugin.refreshContext(true); await this.render(); };
      undoBtn.onclick    = async () => { await this.plugin.undoLastCommit(); await this.render(); };
      pullBtn.onclick    = async () => { await this.plugin.pullCurrentRepo(); await this.render(); };
      pushBtn.onclick    = async () => { await this.plugin.pushCurrentRepo(); await this.render(); };
      stashBtn.onclick   = async () => { await this.plugin.openStashModal(); };
      historyBtn.onclick = async () => { await this.plugin.openHistoryModal(); };
      branchBtn.onclick  = async () => { await this.plugin.checkoutOrCreateBranch(); await this.render(); };
      switchBtn.onclick  = async () => { await this.plugin.switchRepositoryContext(); await this.render(); };

      // ── Inline commit area (VS Code style) ──────────────────────────────
      const commitArea = wrap.createDiv({ cls: "vlg-commit-area" });
      const ta = commitArea.createEl("textarea") as HTMLTextAreaElement;
      ta.placeholder = "Message (Ctrl+Enter to commit)";
      ta.addClass("vlg-commit-input");
      this.commitInputEl = ta;

      const commitBtn = commitArea.createEl("button") as HTMLButtonElement;
      commitBtn.addClass("vlg-commit-btn");
      commitBtn.disabled = true;
      this.commitBtnEl = commitBtn;

      ta.addEventListener("input", () => {
        if (this.commitBtnEl) {
          this.commitBtnEl.disabled = ta.value.trim().length === 0;
        }
      });

      ta.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          this.commitBtnEl?.click();
        }
      });

      commitBtn.onclick = async () => {
        const msg = ta.value.trim();
        if (!msg) { new Notice("Enter a commit message"); return; }
        const snap = await this.plugin.getActiveRepoSnapshot();
        if (!snap) return;
        await this.plugin.commitWithMessage(snap.repoRoot, msg);
        ta.value = "";
        if (this.commitBtnEl) this.commitBtnEl.disabled = true;
        await this.render();
      };

      this.statsEl = wrap.createEl("p", { cls: "vlg-sc-stats" });
      this.bodyEl  = wrap.createDiv({ cls: "vlg-sc-body" });
    }

    if (!snapshot) return;

    // ── Update mutable parts in-place (no flash) ──────────────────────────
    if (this.headlineEl) {
      this.headlineEl.setText(`${snapshot.repoName} • ${snapshot.status.branch}`);
    }
    if (this.commitBtnEl) {
      this.commitBtnEl.setText(`Commit to "${snapshot.status.branch}"`);
    }
    if (this.statsEl) {
      this.statsEl.setText(
        `Staged ${snapshot.status.staged} | Unstaged ${snapshot.status.unstaged} | Untracked ${snapshot.status.untracked} | Conflicts ${snapshot.status.conflicts} | ↑${snapshot.status.ahead} ↓${snapshot.status.behind}`
      );
    }

    const body = this.bodyEl!;
    body.empty();

    if (snapshot.changes.length === 0) {
      body.createEl("p", { text: "Working tree clean." });
      return;
    }

    const displayChanges = this.buildDisplayChanges(snapshot.changes);
    const conflictChanges = displayChanges.filter((change) => change.mode === "conflict");
    const stagedChanges   = displayChanges.filter((change) => change.mode === "staged");
    const unstagedChanges = displayChanges.filter((change) => change.mode === "unstaged");
    const untrackedChanges = displayChanges.filter((change) => change.mode === "untracked");

    this.renderChangeSection(body, snapshot.repoRoot, "Merge Changes", conflictChanges);
    this.renderChangeSection(body, snapshot.repoRoot, "Staged Changes", stagedChanges);
    this.renderChangeSection(body, snapshot.repoRoot, "Changes", unstagedChanges);
    this.renderChangeSection(body, snapshot.repoRoot, "Untracked Files", untrackedChanges);
  }

  private buildSnapshotKey(snapshot: RepoSnapshot | null): string {
    if (!snapshot) return "__empty__";
    const collapsed = [...this.collapsedSections.entries()]
      .map(([k, v]) => `${k}:${v}`)
      .join(",");
    const changes = snapshot.changes
      .map((c) => `${c.x}${c.y}${c.path}${c.staged}${c.unstaged}${c.untracked}${c.conflicted}`)
      .join("|");
    return `${snapshot.repoRoot}||${snapshot.status.branch}||${snapshot.status.ahead}:${snapshot.status.behind}||${changes}||${collapsed}`;
  }

  private renderChangeSection(
    list: HTMLElement,
    repoRoot: string,
    title: string,
    changes: DisplayChange[]
  ): void {
    const section = list.createDiv({ cls: "vlg-change-section" });
    const isCollapsed = this.collapsedSections.get(title) ?? false;

    const titleRow = section.createDiv({ cls: "vlg-change-section-head" });
    const toggle = titleRow.createDiv({ cls: "vlg-change-section-toggle" });
    toggle.setText(isCollapsed ? `▸ ${title.toUpperCase()} (${changes.length})` : `▾ ${title.toUpperCase()} (${changes.length})`);
    toggle.setAttr("role", "button");
    toggle.setAttr("tabindex", "0");
    toggle.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") (e.currentTarget as HTMLElement).click();
    });
    toggle.onclick = async () => {
      const nextCollapsed = !isCollapsed;
      this.collapsedSections.set(title, nextCollapsed);
      await this.plugin.setSectionCollapsed(title, nextCollapsed);
      await this.render();
    };

    const sectionActions = titleRow.createDiv({ cls: "vlg-change-section-actions" });
    if (title === "Changes" || title === "Untracked Files") {
      const stageAllBtn = sectionActions.createEl("button") as HTMLButtonElement;
      stageAllBtn.addClass("vlg-icon-btn");
      stageAllBtn.setAttr("title", "Stage all");
      setIcon(stageAllBtn, "plus");
      stageAllBtn.disabled = changes.length === 0;
      stageAllBtn.onclick = async () => {
        await this.plugin.stageRepoFiles(
          repoRoot,
          [...new Set(changes.map((change) => change.path))]
        );
        await this.render();
      };
    }

    if (title === "Staged Changes") {
      const unstageAllBtn = sectionActions.createEl("button") as HTMLButtonElement;
      unstageAllBtn.addClass("vlg-icon-btn");
      unstageAllBtn.setAttr("title", "Unstage all");
      setIcon(unstageAllBtn, "minus");
      unstageAllBtn.disabled = changes.length === 0;
      unstageAllBtn.onclick = async () => {
        await this.plugin.unstageRepoFiles(
          repoRoot,
          [...new Set(changes.map((change) => change.path))]
        );
        await this.render();
      };
    }

    if (isCollapsed) {
      return;
    }

    if (changes.length === 0) {
      const empty = section.createDiv({ cls: "vlg-change-empty" });
      empty.setText("No files");
      return;
    }

    for (const change of changes) {
      const row = section.createDiv({ cls: "vlg-change-row" });
      const state = row.createEl("span", {
        text: change.statusCode,
        cls: "vlg-change-state"
      });
      state.addClass(`vlg-change-state-${change.mode}`);
      state.setAttr("aria-label", "Git status code");

      row.createEl("span", { text: change.path, cls: "vlg-change-path" });

      const rowActions = row.createDiv({ cls: "vlg-change-actions" });
      const mkBtn = (icon: string, tooltip: string, danger = false): HTMLButtonElement => {
        const btn = rowActions.createEl("button") as HTMLButtonElement;
        btn.addClass("vlg-icon-btn");
        if (danger) btn.addClass("vlg-btn-danger");
        btn.setAttr("title", tooltip);
        setIcon(btn, icon);
        return btn;
      };

      const diffBtn = mkBtn("eye", "Show diff");
      diffBtn.onclick = async () => {
        await this.plugin.showDiffForRepoFile(
          repoRoot,
          change.path,
          change.mode === "staged"
        );
      };

      if (change.mode === "unstaged" || change.mode === "untracked") {
        const stageBtn = mkBtn("plus", "Stage");
        stageBtn.onclick = async () => {
          await this.plugin.stageRepoFile(repoRoot, change.path);
          await this.render();
        };

        if (change.mode === "unstaged") {
          const stageHunksBtn = mkBtn("layers", "Stage hunks…");
          stageHunksBtn.onclick = async () => {
            await this.plugin.openHunkStageModal(repoRoot, change.path);
            await this.render();
          };
        }

        const discardBtn = mkBtn("trash-2", "Discard changes", true);
        discardBtn.onclick = async () => {
          await this.plugin.discardRepoFileChanges(
            repoRoot,
            change.path,
            change.mode === "untracked"
          );
          await this.render();
        };
      }

      if (change.mode === "staged") {
        const unstageBtn = mkBtn("minus", "Unstage");
        unstageBtn.onclick = async () => {
          await this.plugin.unstageRepoFile(repoRoot, change.path);
          await this.render();
        };

        const unstageHunksBtn = mkBtn("layers", "Unstage hunks…");
        unstageHunksBtn.onclick = async () => {
          await this.plugin.openHunkUnstageModal(repoRoot, change.path);
          await this.render();
        };

        const revertBtn = mkBtn("rotate-ccw", "Revert to HEAD", true);
        revertBtn.onclick = async () => {
          await this.plugin.revertRepoFileToHead(repoRoot, change.path);
          await this.render();
        };
      }

      if (change.mode === "conflict") {
        const resolveBtn = mkBtn("git-merge", "Resolve conflict…");
        resolveBtn.onclick = async () => {
          await this.plugin.openConflictResolverModal(repoRoot, change.path);
          await this.render();
        };
        const markBtn = mkBtn("check", "Mark as resolved");
        markBtn.onclick = async () => {
          await this.plugin.stageRepoFile(repoRoot, change.path);
          await this.render();
        };
      }
    }
  }

  private initializeSectionCollapseState(): void {
    if (this.collapsedSections.size > 0) {
      return;
    }
    const persisted = this.plugin.getCollapsedSections();
    this.collapsedSections.set("Merge Changes", persisted["Merge Changes"] ?? false);
    this.collapsedSections.set("Staged Changes", persisted["Staged Changes"] ?? false);
    this.collapsedSections.set("Changes", persisted["Changes"] ?? false);
    this.collapsedSections.set("Untracked Files", persisted["Untracked Files"] ?? false);
  }

  private buildDisplayChanges(changes: FileChange[]): DisplayChange[] {
    const result: DisplayChange[] = [];

    for (const change of changes) {
      if (change.conflicted) {
        result.push({ path: change.path, mode: "conflict", statusCode: "!" });
        continue;
      }

      if (change.untracked) {
        result.push({ path: change.path, mode: "untracked", statusCode: "U" });
        continue;
      }

      if (change.staged) {
        result.push({ path: change.path, mode: "staged", statusCode: change.x });
      }

      if (change.unstaged) {
        result.push({ path: change.path, mode: "unstaged", statusCode: change.y });
      }
    }

    return result;
  }
}

class VsCodeLikeGitPlugin extends Plugin {
  settings: GitPluginSettings;
  private statusBarEl: HTMLElement | null = null;
  private currentRepoRoot: string | null = null;
  private currentFile: TFile | null = null;
  private refreshTimerId: number | null = null;
  private repoRegistry: Set<string> = new Set();
  private manualRepoRoot: string | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(
      SOURCE_CONTROL_VIEW_TYPE,
      (leaf) => new SourceControlView(leaf, this)
    );

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("vlg-status");

    this.addRibbonIcon(
      GITUS_ICON,
      "GitUS: Open Source Control view",
      async () => {
        await this.activateSourceControlView();
      }
    );

    this.addSettingTab(new GitSettingsTab(this.app, this));
    this.registerCommands();

    this.registerEvent(
      this.app.workspace.on("file-open", async (file) => {
        this.currentFile = file instanceof TFile ? file : null;
        this.manualRepoRoot = null;
        await this.refreshContext();
      })
    );

    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        if (this.currentFile && file.path === this.currentFile.path) {
          await this.refreshContext();
        }
      })
    );

    this.resetAutoRefresh();
    await this.rebuildRepoRegistry();
    await this.refreshContext();
  }

  onunload(): void {
    if (this.refreshTimerId !== null) {
      window.clearInterval(this.refreshTimerId);
      this.refreshTimerId = null;
    }

    this.app.workspace.detachLeavesOfType(SOURCE_CONTROL_VIEW_TYPE);
  }

  private registerCommands(): void {
    this.addCommand({
      id: "refresh-context",
      name: "Refresh context",
      callback: async () => {
        await this.refreshContext(true);
      }
    });

    this.addCommand({
      id: "open-source-control",
      name: "Open Source Control view",
      callback: async () => {
        await this.activateSourceControlView();
      }
    });

    this.addCommand({
      id: "switch-repository-context",
      name: "Switch repository context",
      callback: async () => {
        await this.switchRepositoryContext();
      }
    });

    this.addCommand({
      id: "clear-repository-context",
      name: "Clear manual repository context",
      callback: async () => {
        this.manualRepoRoot = null;
        await this.refreshContext(true);
      }
    });

    this.addCommand({
      id: "stage-current-file",
      name: "Stage current file",
      callback: async () => {
        await this.stageCurrentFile();
      }
    });

    this.addCommand({
      id: "unstage-current-file",
      name: "Unstage current file",
      callback: async () => {
        await this.unstageCurrentFile();
      }
    });

    this.addCommand({
      id: "show-current-file-diff",
      name: "Show diff for current file",
      callback: async () => {
        await this.showCurrentFileDiff();
      }
    });

    this.addCommand({
      id: "commit-current-repo",
      name: "Commit in current repo",
      callback: async () => {
        await this.commitCurrentRepo();
      }
    });

    this.addCommand({
      id: "pull-current-repo",
      name: "Pull in current repo",
      callback: async () => {
        await this.pullCurrentRepo();
      }
    });

    this.addCommand({
      id: "push-current-repo",
      name: "Push in current repo",
      callback: async () => {
        await this.pushCurrentRepo();
      }
    });

    this.addCommand({
      id: "checkout-branch",
      name: "Checkout or create branch",
      callback: async () => {
        await this.checkoutOrCreateBranch();
      }
    });

    this.addCommand({
      id: "rebuild-repository-index",
      name: "Rebuild repository index",
      callback: async () => {
        await this.rebuildRepoRegistry();
        await this.refreshContext(true);
      }
    });
  }

  private async stageCurrentFile(): Promise<void> {
    const context = await this.requireContext();
    if (!context) {
      return;
    }

    await this.runGit(["add", "--", context.repoRelativeFile], context.repoRoot);
    this.repoRegistry.add(context.repoRoot);
    new Notice("Staged current file");
    await this.refreshContext();
  }

  private async unstageCurrentFile(): Promise<void> {
    const context = await this.requireContext();
    if (!context) {
      return;
    }

    await this.runGit(["restore", "--staged", "--", context.repoRelativeFile], context.repoRoot);
    this.repoRegistry.add(context.repoRoot);
    new Notice("Unstaged current file");
    await this.refreshContext();
  }

  async showCurrentFileDiff(): Promise<void> {
    const context = await this.requireContext();
    if (!context) {
      return;
    }

    await this.showDiffForRepoFile(context.repoRoot, context.repoRelativeFile);
  }

  getCollapsedSections(): Record<string, boolean> {
    return this.settings.collapsedSections;
  }

  async setSectionCollapsed(sectionName: string, collapsed: boolean): Promise<void> {
    this.settings.collapsedSections[sectionName] = collapsed;
    await this.saveData(this.settings);
  }

  async showDiffForRepoFile(
    repoRoot: string,
    repoRelativeFile: string,
    preferCached = false
  ): Promise<void> {
    const primaryArgs = preferCached
      ? ["diff", "--cached", "--", repoRelativeFile]
      : ["diff", "--", repoRelativeFile];
    const fallbackArgs = preferCached
      ? ["diff", "--", repoRelativeFile]
      : ["diff", "--cached", "--", repoRelativeFile];

    const primary = await this.runGit(primaryArgs, repoRoot);
    if (primary.trim()) {
      const suffix = preferCached ? "(cached)" : "";
      this.openDiffModal(repoRelativeFile, primary, suffix);
      return;
    }

    const fallback = await this.runGit(fallbackArgs, repoRoot);
    if (!fallback.trim()) {
      new Notice("No changes for selected file");
      return;
    }

    const suffix = preferCached ? "(working tree)" : "(cached)";
    this.openDiffModal(repoRelativeFile, fallback, suffix);
  }

  async stageRepoFile(repoRoot: string, repoRelativeFile: string): Promise<void> {
    await this.runGit(["add", "--", repoRelativeFile], repoRoot);
    this.repoRegistry.add(repoRoot);
    new Notice(`Staged ${repoRelativeFile}`);
    await this.refreshContext();
  }

  async discardRepoFileChanges(
    repoRoot: string,
    repoRelativeFile: string,
    isUntracked: boolean
  ): Promise<void> {
    const message = isUntracked
      ? `Discard untracked file ${repoRelativeFile}? This will delete the file from disk.`
      : `Discard local changes for ${repoRelativeFile}?`;

    new ConfirmModal(this.app, message, async () => {
      if (isUntracked) {
        await this.runGit(["clean", "-f", "--", repoRelativeFile], repoRoot);
      } else {
        await this.runGit(["restore", "--", repoRelativeFile], repoRoot);
      }
      new Notice(`Discarded changes for ${repoRelativeFile}`);
      await this.refreshContext();
    }).open();
  }

  async stageRepoFiles(repoRoot: string, repoRelativeFiles: string[]): Promise<void> {
    if (repoRelativeFiles.length === 0) {
      return;
    }
    await this.runGit(["add", "--", ...repoRelativeFiles], repoRoot);
    this.repoRegistry.add(repoRoot);
    new Notice(`Staged ${repoRelativeFiles.length} files`);
    await this.refreshContext();
  }

  async unstageRepoFile(repoRoot: string, repoRelativeFile: string): Promise<void> {
    await this.runGit(["restore", "--staged", "--", repoRelativeFile], repoRoot);
    this.repoRegistry.add(repoRoot);
    new Notice(`Unstaged ${repoRelativeFile}`);
    await this.refreshContext();
  }

  async revertRepoFileToHead(repoRoot: string, repoRelativeFile: string): Promise<void> {
    const message = `Revert all changes for ${repoRelativeFile} to HEAD?`;
    new ConfirmModal(this.app, message, async () => {
      await this.runGit(
        ["restore", "--source=HEAD", "--staged", "--worktree", "--", repoRelativeFile],
        repoRoot
      );
      new Notice(`Reverted ${repoRelativeFile} to HEAD`);
      await this.refreshContext();
    }).open();
  }

  async unstageRepoFiles(repoRoot: string, repoRelativeFiles: string[]): Promise<void> {
    if (repoRelativeFiles.length === 0) {
      return;
    }
    await this.runGit(["restore", "--staged", "--", ...repoRelativeFiles], repoRoot);
    this.repoRegistry.add(repoRoot);
    new Notice(`Unstaged ${repoRelativeFiles.length} files`);
    await this.refreshContext();
  }

  async commitWithMessage(repoRoot: string, message: string): Promise<void> {
    const snapshot = await this.getRepoSnapshot(repoRoot);
    if (snapshot.status.staged === 0) {
      new Notice("No staged changes. Stage files before commit.");
      return;
    }
    await this.runGit(["commit", "-m", message], repoRoot);
    new Notice("Commit finished");
    await this.refreshContext();
  }

  async undoLastCommit(): Promise<void> {
    const repoRoot = await this.resolveActiveRepoRoot();
    if (!repoRoot) { new Notice("No active Git repository found"); return; }
    new ConfirmModal(this.app, "Undo last commit? Changes will be kept staged (--soft).", async () => {
      await this.runGit(["reset", "--soft", "HEAD~1"], repoRoot);
      new Notice("Last commit undone (changes kept staged)");
      await this.refreshContext();
    }).open();
  }

  async openStashModal(): Promise<void> {
    const repoRoot = await this.resolveActiveRepoRoot();
    if (!repoRoot) { new Notice("No active Git repository found"); return; }
    new StashModal(this.app, repoRoot, this).open();
  }

  async openHistoryModal(): Promise<void> {
    const repoRoot = await this.resolveActiveRepoRoot();
    if (!repoRoot) { new Notice("No active Git repository found"); return; }
    new CommitHistoryModal(this.app, repoRoot, this).open();
  }

  async openConflictResolverModal(repoRoot: string, filePath: string): Promise<void> {
    new ConflictResolverModal(this.app, repoRoot, filePath, this).open();
  }

  /** Exposed for use by Modals that need to run git commands. */
  async runGitPublic(args: string[], cwd: string): Promise<string> {
    return this.runGit(args, cwd);
  }

  async openHunkStageModal(repoRoot: string, filePath: string): Promise<void> {
    const diffOutput = await this.runGit(["diff", "--", filePath], repoRoot);
    if (!diffOutput.trim()) {
      new Notice("No unstaged changes to stage by hunk");
      return;
    }

    const { patchHeader, hunks } = parseDiffHunks(diffOutput);
    if (hunks.length === 0) {
      new Notice("No hunks found in diff");
      return;
    }

    new HunkPickerModal(
      this.app,
      hunks,
      patchHeader,
      `Stage Hunks: ${filePath}`,
      "Stage Selected",
      async (patch) => {
        await this.applyPatchCached(repoRoot, patch);
        new Notice(`Staged selected hunks in ${filePath}`);
        await this.refreshContext();
      }
    ).open();
  }

  async openHunkUnstageModal(repoRoot: string, filePath: string): Promise<void> {
    const diffOutput = await this.runGit(["diff", "--cached", "--", filePath], repoRoot);
    if (!diffOutput.trim()) {
      new Notice("No staged changes to unstage by hunk");
      return;
    }

    const { patchHeader, hunks } = parseDiffHunks(diffOutput);
    if (hunks.length === 0) {
      new Notice("No hunks found in diff");
      return;
    }

    new HunkPickerModal(
      this.app,
      hunks,
      patchHeader,
      `Unstage Hunks: ${filePath}`,
      "Unstage Selected",
      async (patch) => {
        await this.applyPatchCached(repoRoot, patch, true);
        new Notice(`Unstaged selected hunks in ${filePath}`);
        await this.refreshContext();
      }
    ).open();
  }

  private async applyPatchCached(repoRoot: string, patch: string, reverse = false): Promise<void> {
    const tmpPath = path.join(
      os.tmpdir(),
      `gitus_${Date.now()}_${Math.random().toString(36).slice(2)}.patch`
    );
    await fs.writeFile(tmpPath, patch, "utf8");
    try {
      const args = ["apply", "--cached"];
      if (reverse) args.push("--reverse");
      args.push(tmpPath);
      await this.runGit(args, repoRoot);
    } finally {
      try { await fs.rm(tmpPath); } catch { /* ignore cleanup error */ }
    }
  }

  async commitCurrentRepo(): Promise<void> {
    const repoRoot = await this.resolveActiveRepoRoot();
    if (!repoRoot) {
      new Notice("No active Git repository found");
      return;
    }

    const snapshot = await this.getRepoSnapshot(repoRoot);
    if (snapshot.status.staged === 0) {
      new Notice("No staged changes. Stage files before commit.");
      return;
    }

    new CommitMessageModal(this.app, async (message) => {
      await this.runGit(["commit", "-m", message], repoRoot);
      new Notice("Commit finished");
      await this.refreshContext();
    }).open();
  }

  async pullCurrentRepo(): Promise<void> {
    const repoRoot = await this.resolveActiveRepoRoot();
    if (!repoRoot) {
      new Notice("No active Git repository found");
      return;
    }

    const snapshot = await this.getRepoSnapshot(repoRoot);
    if (snapshot.status.unstaged > 0 || snapshot.status.untracked > 0) {
      new ConfirmModal(
        this.app,
        "Working tree has local changes. Continue pull anyway?",
        async () => {
          await this.runGit(["pull"], repoRoot);
          new Notice("Pull finished");
          await this.refreshContext();
        }
      ).open();
      return;
    }

    await this.runGit(["pull"], repoRoot);
    new Notice("Pull finished");
    await this.refreshContext();
  }

  async pushCurrentRepo(): Promise<void> {
    const repoRoot = await this.resolveActiveRepoRoot();
    if (!repoRoot) {
      new Notice("No active Git repository found");
      return;
    }

    const snapshot = await this.getRepoSnapshot(repoRoot);
    if (snapshot.status.unstaged > 0 || snapshot.status.untracked > 0) {
      new ConfirmModal(
        this.app,
        "Working tree has unstaged or untracked changes. Continue push anyway?",
        async () => {
          await this.runGit(["push"], repoRoot);
          new Notice("Push finished");
          await this.refreshContext();
        }
      ).open();
      return;
    }

    await this.runGit(["push"], repoRoot);
    new Notice("Push finished");
    await this.refreshContext();
  }

  async checkoutOrCreateBranch(): Promise<void> {
    const repoRoot = await this.resolveActiveRepoRoot();
    if (!repoRoot) {
      new Notice("No active Git repository found");
      return;
    }

    const branchesRaw = await this.runGit(["branch", "--list"], repoRoot);
    const branches = branchesRaw
      .split("\n")
      .map((line) => line.replace(/^\*/, "").trim())
      .filter((line) => line.length > 0)
      .sort((a, b) => a.localeCompare(b));

    new BranchPickerModal(this.app, branches, async (branchName, create) => {
      if (create) {
        await this.runGitWithFallback(
          ["switch", "-c", branchName],
          ["checkout", "-b", branchName],
          repoRoot
        );
      } else {
        await this.runGitWithFallback(
          ["switch", branchName],
          ["checkout", branchName],
          repoRoot
        );
      }
      new Notice(`Checked out ${branchName}`);
      await this.refreshContext(true);
    }).open();
  }

  private async requireContext(): Promise<{ repoRoot: string; repoRelativeFile: string } | null> {
    if (!this.currentFile) {
      new Notice("Open a note first");
      return null;
    }

    const repoRoot = await this.resolveRepoRootForCurrentFile();
    if (!repoRoot) {
      new Notice("Current file is not inside a Git repository");
      return null;
    }

    const absFilePath = this.getAbsolutePath(this.currentFile.path);
    const repoRelativeFile = normalizeToPosix(path.relative(repoRoot, absFilePath));

    return { repoRoot, repoRelativeFile };
  }

  async refreshContext(manual = false): Promise<void> {
    try {
      const repoRoot = await this.resolveActiveRepoRoot();
      this.currentRepoRoot = repoRoot;

      if (!repoRoot) {
        this.setStatusBarText("GitUS: no repo");
        return;
      }

      const status = (await this.getRepoSnapshot(repoRoot)).status;
      const repoName = path.basename(repoRoot);
      this.repoRegistry.add(repoRoot);
      const manualTag = this.manualRepoRoot ? " [manual]" : "";
      this.setStatusBarText(
        `GitUS ${repoName}:${status.branch} S${status.staged} U${status.unstaged} ?${status.untracked} C${status.conflicts} ↑${status.ahead} ↓${status.behind}${manualTag}`
      );

      if (manual) {
        new Notice(`Repo: ${repoName} (${status.branch})`);
      }
      await this.refreshSourceControlView();
    } catch (error) {
      this.setStatusBarText("GitUS: error");
      new Notice(`Git refresh failed: ${this.toErrorMessage(error)}`);
    }
  }

  private setStatusBarText(text: string): void {
    if (this.statusBarEl) {
      this.statusBarEl.setText(text);
    }
  }

  private async getRepoSnapshot(repoRoot: string): Promise<RepoSnapshot> {
    const branch = (await this.runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot)).trim();
    const porcelain = await this.runGit(["status", "--porcelain", "-uall"], repoRoot);
    const changes = this.parsePorcelainChanges(porcelain);

    let staged = 0;
    let unstaged = 0;
    let untracked = 0;
    let conflicts = 0;
    const { ahead, behind } = await this.getAheadBehind(repoRoot);

    for (const change of changes) {
      if (change.conflicted) {
        conflicts += 1;
      }
      if (change.untracked) {
        untracked += 1;
      }
      if (change.staged) {
        staged += 1;
      }
      if (change.unstaged) {
        unstaged += 1;
      }
    }

    return {
      repoRoot,
      repoName: path.basename(repoRoot),
      status: {
        branch,
        staged,
        unstaged,
        untracked,
        conflicts,
        ahead,
        behind
      },
      changes
    };
  }

  private async getAheadBehind(repoRoot: string): Promise<{ ahead: number; behind: number }> {
    try {
      const output = await this.runGit(
        ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
        repoRoot
      );
      const [aheadRaw, behindRaw] = output.trim().split(/\s+/);
      const ahead = Number.parseInt(aheadRaw ?? "0", 10) || 0;
      const behind = Number.parseInt(behindRaw ?? "0", 10) || 0;
      return { ahead, behind };
    } catch {
      return { ahead: 0, behind: 0 };
    }
  }

  async getActiveRepoSnapshot(): Promise<RepoSnapshot | null> {
    const repoRoot = await this.resolveActiveRepoRoot();
    if (!repoRoot) {
      return null;
    }
    return this.getRepoSnapshot(repoRoot);
  }

  private async resolveRepoRootForCurrentFile(): Promise<string | null> {
    if (!this.currentFile) {
      return null;
    }

    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      return null;
    }

    const basePath = adapter.getBasePath();
    const absolutePath = this.getAbsolutePath(this.currentFile.path);
    const repoRoot = await this.findNearestRepo(basePath, path.dirname(absolutePath));
    if (repoRoot) {
      this.repoRegistry.add(repoRoot);
    }
    return repoRoot;
  }

  private async resolveActiveRepoRoot(): Promise<string | null> {
    if (this.manualRepoRoot) {
      return this.manualRepoRoot;
    }

    const fromCurrentFile = await this.resolveRepoRootForCurrentFile();
    if (fromCurrentFile) {
      return fromCurrentFile;
    }

    if (this.repoRegistry.size === 1) {
      return [...this.repoRegistry][0] ?? null;
    }

    return null;
  }

  private async findNearestRepo(vaultRoot: string, startDir: string): Promise<string | null> {
    const vaultRootResolved = path.resolve(vaultRoot);
    let current = path.resolve(startDir);

    while (true) {
      const gitEntry = path.join(current, ".git");
      if (await this.isGitEntry(gitEntry)) {
        return current;
      }

      if (current === vaultRootResolved) {
        return null;
      }

      const parent = path.dirname(current);
      // Stop if traversal escapes the vault root due to symlinked or malformed paths.
      if (parent === current || !current.startsWith(vaultRootResolved)) {
        return null;
      }

      current = parent;
    }
  }

  private async isGitEntry(gitEntryPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(gitEntryPath);
      if (stat.isDirectory()) {
        return true;
      }
      if (!stat.isFile()) {
        return false;
      }

      const content = await fs.readFile(gitEntryPath, "utf8");
      return content.trimStart().startsWith("gitdir:");
    } catch {
      return false;
    }
  }

  private unquoteGitPath(raw: string): string {
    // git quotes paths containing non-ASCII or special chars as "path\303\274..."
    if (!raw.startsWith('"')) return raw;
    const inner = raw.slice(1, -1); // strip surrounding quotes
    // First pass: collect bytes / chars
    const bytes: number[] = [];
    let i = 0;
    while (i < inner.length) {
      if (inner[i] === "\\" && i + 1 < inner.length) {
        const next = inner[i + 1];
        if (next >= "0" && next <= "7") {
          // octal escape \nnn
          bytes.push(parseInt(inner.slice(i + 1, i + 4), 8));
          i += 4;
        } else {
          const map: Record<string, number> = { "\\": 92, n: 10, t: 9, r: 13, b: 8, '"': 34 };
          bytes.push(map[next] ?? next.charCodeAt(0));
          i += 2;
        }
      } else {
        bytes.push(inner.charCodeAt(i));
        i += 1;
      }
    }
    return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
  }

  private parsePorcelainChanges(porcelain: string): FileChange[] {
    const lines = porcelain
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 2);

    const changes: FileChange[] = [];
    for (const line of lines) {
      const x = line[0] ?? " ";
      const y = line[1] ?? " ";
      let filePath = this.unquoteGitPath(line.slice(3).trim());

      if (filePath.includes(" -> ")) {
        const parts = filePath.split(" -> ");
        filePath = parts[parts.length - 1] ?? filePath;
      }

      const untracked = x === "?" && y === "?";
      const conflicted =
        !untracked &&
        ((x === "U" || y === "U") ||
          (x === "A" && y === "A") ||
          (x === "D" && y === "D") ||
          (x === "A" && y === "D") ||
          (x === "D" && y === "A"));
      const staged = !untracked && x !== " ";
      const unstaged = !untracked && y !== " ";

      changes.push({
        x,
        y,
        path: filePath,
        staged,
        unstaged,
        untracked,
        conflicted
      });
    }

    return changes;
  }

  private openDiffModal(filePath: string, diffText: string, titleSuffix = ""): void {
    const modal = new Modal(this.app);
    const suffix = titleSuffix ? ` ${titleSuffix}` : "";
    modal.titleEl.setText(`Diff: ${filePath}${suffix}`);
    const pre = modal.contentEl.createEl("pre", { cls: "vlg-diff" });
    for (const line of diffText.split("\n")) {
      const span = pre.createEl("span");
      span.setText(line + "\n");
      if (line.startsWith("+++") || line.startsWith("---")) {
        span.addClass("vlg-diff-file");
      } else if (line.startsWith("+")) {
        span.addClass("vlg-hunk-add");
      } else if (line.startsWith("-")) {
        span.addClass("vlg-hunk-del");
      } else if (line.startsWith("@@")) {
        span.addClass("vlg-diff-hunk-head");
      } else if (line.startsWith("diff ") || line.startsWith("index ")) {
        span.addClass("vlg-diff-meta");
      }
    }
    modal.open();
  }

  private async activateSourceControlView(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(SOURCE_CONTROL_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: SOURCE_CONTROL_VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    await this.refreshSourceControlView();
  }

  private async refreshSourceControlView(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(SOURCE_CONTROL_VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof SourceControlView) {
        await view.render();
      }
    }
  }

  async switchRepositoryContext(): Promise<void> {
    await this.rebuildRepoRegistry();
    const repos = [...this.repoRegistry].sort((a, b) => a.localeCompare(b));
    if (repos.length === 0) {
      new Notice("No repository found in vault index");
      return;
    }

    new RepoPickerModal(this.app, repos, async (repoRoot) => {
      this.manualRepoRoot = repoRoot;
      await this.refreshContext(true);
    }).open();
  }

  getKnownRepos(): string[] {
    return [...this.repoRegistry].sort((a, b) => a.localeCompare(b));
  }

  async selectRepo(repoRoot: string): Promise<void> {
    this.manualRepoRoot = repoRoot;
    await this.refreshContext(true);
  }

  async rebuildIndex(): Promise<void> {
    await this.rebuildRepoRegistry();
    await this.refreshContext(true);
  }

  private async rebuildRepoRegistry(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      return;
    }

    const basePath = adapter.getBasePath();
    const markdownFiles = this.app.vault.getMarkdownFiles();
    const dirCache = new Map<string, string | null>();
    const nextRegistry = new Set<string>();

    for (const file of markdownFiles) {
      const absPath = this.getAbsolutePath(file.path);
      const dir = path.dirname(absPath);

      let repoRoot = dirCache.get(dir);
      if (repoRoot === undefined) {
        repoRoot = await this.findNearestRepo(basePath, dir);
        dirCache.set(dir, repoRoot);
      }

      if (repoRoot) {
        nextRegistry.add(repoRoot);
      }
    }

    if (this.currentFile) {
      const currentRepo = await this.resolveRepoRootForCurrentFile();
      if (currentRepo) {
        nextRegistry.add(currentRepo);
      }
    }

    this.repoRegistry = nextRegistry;
  }

  private getAbsolutePath(vaultRelativePath: string): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error("FileSystemAdapter is required for desktop Git operations");
    }

    return path.join(adapter.getBasePath(), vaultRelativePath);
  }

  private async runGit(args: string[], cwd: string): Promise<string> {
    try {
      const result = await execFileAsync(this.settings.gitBinary, args, {
        cwd,
        maxBuffer: 10 * 1024 * 1024
      });
      return (result.stdout ?? "").toString();
    } catch (error: unknown) {
      const message = this.toErrorMessage(error);
      throw new Error(`git ${args.join(" ")} failed: ${message}`);
    }
  }

  private async runGitWithFallback(primaryArgs: string[], fallbackArgs: string[], cwd: string): Promise<string> {
    try {
      return await this.runGit(primaryArgs, cwd);
    } catch {
      return this.runGit(fallbackArgs, cwd);
    }
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  private resetAutoRefresh(): void {
    if (this.refreshTimerId !== null) {
      window.clearInterval(this.refreshTimerId);
      this.refreshTimerId = null;
    }

    const seconds = Math.max(2, this.settings.autoRefreshSeconds);
    this.refreshTimerId = window.setInterval(() => {
      void this.refreshContext();
    }, seconds * 1000);

    this.registerInterval(this.refreshTimerId);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.resetAutoRefresh();
  }
}

class GitSettingsTab extends PluginSettingTab {
  plugin: VsCodeLikeGitPlugin;

  constructor(app: App, plugin: VsCodeLikeGitPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Git binary")
      .setDesc("Path to git executable. Example: git or /usr/bin/git")
      .addText((text) =>
        text
          .setPlaceholder("git")
          .setValue(this.plugin.settings.gitBinary)
          .onChange(async (value) => {
            this.plugin.settings.gitBinary = value.trim() || "git";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto refresh interval (seconds)")
      .setDesc("How often to refresh branch and change counts")
      .addSlider((slider) =>
        slider
          .setLimits(2, 30, 1)
          .setValue(this.plugin.settings.autoRefreshSeconds)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.autoRefreshSeconds = value;
            await this.plugin.saveSettings();
          })
      );
  }
}

export default VsCodeLikeGitPlugin;
