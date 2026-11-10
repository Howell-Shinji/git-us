import {
  App,
  FileSystemAdapter,
  ItemView,
  Menu,
  Modal,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  setIcon
} from "obsidian";

type ExecFileAsync = (
  file: string,
  args: readonly string[],
  options: import("node:child_process").ExecFileOptionsWithStringEncoding
) => Promise<{ stdout: string; stderr: string }>;

let execFileAsync: ExecFileAsync;
let fs: typeof import("node:fs/promises");
let os: typeof import("node:os");
let path: typeof import("node:path");

function loadDesktopModules(): void {
  if (!Platform.isDesktopApp) {
    throw new Error("GitUS requires the desktop version of Obsidian");
  }

  const childProcess = require("child_process") as typeof import("node:child_process");
  fs = require("fs/promises") as typeof import("node:fs/promises");
  os = require("os") as typeof import("node:os");
  path = require("path") as typeof import("node:path");
  execFileAsync = (file, args, options) => new Promise((resolve, reject) => {
    childProcess.execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        Reflect.set(error, "stdout", stdout);
        Reflect.set(error, "stderr", stderr);
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

const SOURCE_CONTROL_VIEW_TYPE = "gitus-source-control-view";
const GITUS_ICON = "git-branch";

interface GitPluginSettings {
  gitBinary: string;
  autoRefreshSeconds: number;
  gitTimeoutSeconds: number;
  maxVisibleChanges: number;
  extraRepos: string[];
  collapsedSections: Record<string, boolean>;
}

const DEFAULT_SETTINGS: GitPluginSettings = {
  gitBinary: "git",
  autoRefreshSeconds: 5,
  gitTimeoutSeconds: 30,
  maxVisibleChanges: 250,
  extraRepos: [],
  collapsedSections: {
    "Repositories": false,
    "Source Control Changes": false,
    "Graph": false,
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
  originalPath?: string;
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
  originalPath?: string;
  mode: "staged" | "unstaged" | "untracked" | "conflict";
  statusCode: string;
}

interface SourceControlState {
  snapshot: RepoSnapshot | null;
  loading: boolean;
  operation: string | null;
  error: string | null;
}

function updateCommitButtonState(
  button: HTMLButtonElement | null,
  input: HTMLTextAreaElement | null,
  state: SourceControlState
): void {
  if (!button) return;
  const status = state.snapshot?.status;
  button.setText(status?.staged ? `Commit (${status.staged})` : "Commit");
  button.disabled =
    (input?.value.trim().length ?? 0) === 0 ||
    !status?.staged ||
    status.conflicts > 0 ||
    Boolean(state.operation);
}

interface ConflictBlock {
  ours: string;
  base: string;
  theirs: string;
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

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function toLiteralPathspec(filePath: string): string {
  return `:(literal)${filePath}`;
}

function resolveInsideRoot(root: string, filePath: string): string {
  const absolute = path.resolve(root, filePath);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes repository root: ${filePath}`);
  }
  return absolute;
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
      commitBtn.disabled = true;
      try {
        await this.onSubmit(message);
        this.close();
      } catch (error) {
        new Notice(`Commit failed: ${error instanceof Error ? error.message : String(error)}`);
        commitBtn.disabled = false;
      }
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
      yesBtn.disabled = true;
      try {
        await this.onConfirm();
        this.close();
      } catch (error) {
        new Notice(`Operation failed: ${error instanceof Error ? error.message : String(error)}`);
        yesBtn.disabled = false;
      }
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
    const msgInput = msgRow.createEl("input");
    msgInput.type = "text";
    msgInput.placeholder = "Stash message (optional)";
    msgInput.addClass("vlg-input");

    const pushActions = contentEl.createDiv({ cls: "vlg-actions" });
    const pushBtn = pushActions.createEl("button", { text: "Stash Changes" });
    const pushStagedBtn = pushActions.createEl("button", { text: "Stash Staged Only" });

    pushBtn.onclick = async () => {
      const msg = msgInput.value.trim();
      const args = msg ? ["stash", "push", "-m", msg] : ["stash", "push"];
      const saved = await this.plugin.runSourceControlAction("Stashing changes…", async () => {
        await this.plugin.runGitPublic(args, this.repoRoot);
        new Notice("Stash saved");
      });
      if (saved) await this.renderContent();
    };

    pushStagedBtn.onclick = async () => {
      const msg = msgInput.value.trim();
      const args = msg
        ? ["stash", "push", "--staged", "-m", msg]
        : ["stash", "push", "--staged"];
      const saved = await this.plugin.runSourceControlAction("Stashing staged changes…", async () => {
        await this.plugin.runGitPublic(args, this.repoRoot);
        new Notice("Staged changes stashed");
      });
      if (saved) await this.renderContent();
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
        const popped = await this.plugin.runSourceControlAction("Popping stash…", async () => {
          await this.plugin.runGitPublic(["stash", "pop", `stash@{${stash.index}}`], this.repoRoot);
          new Notice(`Popped stash@{${stash.index}}`);
        });
        if (popped) await this.renderContent();
      };

      const applyBtn = rowActions.createEl("button", { text: "Apply" });
      applyBtn.onclick = async () => {
        const applied = await this.plugin.runSourceControlAction("Applying stash…", async () => {
          await this.plugin.runGitPublic(["stash", "apply", `stash@{${stash.index}}`], this.repoRoot);
          new Notice(`Applied stash@{${stash.index}}`);
        });
        if (applied) await this.renderContent();
      };

      const dropBtn = rowActions.createEl("button", { text: "Drop" });
      dropBtn.addClass("vlg-btn-danger");
      dropBtn.onclick = async () => {
        const dropped = await this.plugin.runSourceControlAction("Dropping stash…", async () => {
          await this.plugin.runGitPublic(["stash", "drop", `stash@{${stash.index}}`], this.repoRoot);
          new Notice(`Dropped stash@{${stash.index}}`);
        });
        if (dropped) await this.renderContent();
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

    const absPath = resolveInsideRoot(this.repoRoot, this.filePath);
    let content: string;
    try {
      content = await fs.readFile(absPath, "utf8");
    } catch (err) {
      contentEl.createEl("p", { text: `Cannot read file: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    const { blocks, malformed } = parseConflictMarkers(content);

    if (blocks.length === 0) {
      contentEl.createEl("p", { text: "No conflict markers found. File may already be resolved." });
      const markBtn = contentEl.createEl("button", { text: "Mark as Resolved" });
      markBtn.onclick = async () => {
        await this.plugin.stageRepoFile(this.repoRoot, this.filePath);
        this.close();
      };
      return;
    }

    if (malformed) {
      contentEl.createEl("p", {
        text: "Conflict markers are incomplete or nested. Resolve this file manually before staging.",
        cls: "vlg-inline-error"
      });
      return;
    }

    const blockList = contentEl.createDiv({ cls: "vlg-conflict-block-list" });
    for (const [index, block] of blocks.entries()) {
      const blockEl = blockList.createDiv({ cls: "vlg-conflict-block" });
      blockEl.createEl("div", { text: `Conflict ${index + 1} of ${blocks.length}`, cls: "vlg-conflict-block-title" });
      const sections = blockEl.createDiv({ cls: block.base ? "vlg-conflict-sections has-base" : "vlg-conflict-sections" });

      const oursCol = sections.createDiv({ cls: "vlg-conflict-col" });
      oursCol.createEl("div", { text: "Current (HEAD)", cls: "vlg-conflict-col-title vlg-conflict-ours" });
      oursCol.createEl("pre", { text: block.ours, cls: "vlg-conflict-pre vlg-conflict-pre-ours" });

      if (block.base) {
        const baseCol = sections.createDiv({ cls: "vlg-conflict-col" });
        baseCol.createEl("div", { text: "Base", cls: "vlg-conflict-col-title vlg-conflict-base" });
        baseCol.createEl("pre", { text: block.base, cls: "vlg-conflict-pre vlg-conflict-pre-base" });
      }

      const theirsCol = sections.createDiv({ cls: "vlg-conflict-col" });
      theirsCol.createEl("div", { text: "Incoming", cls: "vlg-conflict-col-title vlg-conflict-theirs" });
      theirsCol.createEl("pre", { text: block.theirs, cls: "vlg-conflict-pre vlg-conflict-pre-theirs" });
    }

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
    try {
      const resolved = resolveConflictMarkers(content, choice);
      const absPath = resolveInsideRoot(this.repoRoot, this.filePath);
      await fs.writeFile(absPath, resolved, "utf8");
      const staged = await this.plugin.stageRepoFile(this.repoRoot, this.filePath);
      if (staged) {
        new Notice(`Resolved with ${choice} and staged`);
        this.close();
      }
    } catch (error) {
      this.plugin.reportSourceControlError("Resolve conflict", error);
    }
  }
}

function parseConflictMarkers(content: string): { blocks: ConflictBlock[]; malformed: boolean } {
  const blocks: ConflictBlock[] = [];
  let state: "normal" | "ours" | "base" | "theirs" = "normal";
  let current: { ours: string[]; base: string[]; theirs: string[] } | null = null;
  let malformed = false;

  for (const line of content.split(/\r?\n/)) {
    if (/^<{7,}(?:\s|$)/.test(line)) {
      if (state !== "normal") malformed = true;
      current = { ours: [], base: [], theirs: [] };
      state = "ours";
    } else if (/^\|{7,}(?:\s|$)/.test(line)) {
      if (state !== "ours" || !current) malformed = true;
      else state = "base";
    } else if (/^={7,}$/.test(line)) {
      if ((state !== "ours" && state !== "base") || !current) malformed = true;
      else state = "theirs";
    } else if (/^>{7,}(?:\s|$)/.test(line)) {
      if (state !== "theirs" || !current) {
        malformed = true;
      } else {
        blocks.push({
          ours: current.ours.join("\n"),
          base: current.base.join("\n"),
          theirs: current.theirs.join("\n")
        });
      }
      current = null;
      state = "normal";
    } else if (current && state === "ours") {
      current.ours.push(line);
    } else if (current && state === "base") {
      current.base.push(line);
    } else if (current && state === "theirs") {
      current.theirs.push(line);
    }
  }

  if (state !== "normal" || current) malformed = true;
  return { blocks, malformed };
}

function resolveConflictMarkers(content: string, choice: "ours" | "theirs" | "both"): string {
  const parsed = parseConflictMarkers(content);
  if (parsed.malformed) {
    throw new Error("Conflict markers are malformed; automatic resolution was cancelled");
  }

  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const result: string[] = [];
  let state: "normal" | "ours" | "base" | "theirs" = "normal";

  for (const line of lines) {
    if (/^<{7,}(?:\s|$)/.test(line)) {
      state = "ours";
    } else if (/^\|{7,}(?:\s|$)/.test(line)) {
      state = "base";
    } else if (/^={7,}$/.test(line)) {
      state = "theirs";
    } else if (/^>{7,}(?:\s|$)/.test(line)) {
      state = "normal";
    } else if (state === "normal") {
      result.push(line);
    } else if (state === "ours" && (choice === "ours" || choice === "both")) {
      result.push(line);
    } else if (state === "theirs" && (choice === "theirs" || choice === "both")) {
      result.push(line);
    }
  }

  return result.join(newline);
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

      const checkbox = row.createEl("input");
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
  private bannerEl: HTMLElement | null = null;
  private commitHintEl: HTMLElement | null = null;
  private commitInputEl: HTMLTextAreaElement | null = null;
  private commitBtnEl: HTMLButtonElement | null = null;
  private commitActionEl: HTMLButtonElement | null = null;
  private commitMoreEl: HTMLButtonElement | null = null;
  private changesCountEl: HTMLElement | null = null;
  private graphEl: HTMLElement | null = null;
  private graphScope: "all" | "current" = "all";
  private graphLimit = 80;
  private graphRequestId = 0;
  private graphCacheKey = "";
  private graphRenderedKey = "";
  private graphRaw: string | null = null;
  private graphTimerId: number | null = null;
  private commitDrafts = new Map<string, string>();
  private sectionRenderLimits = new Map<string, number>();

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
    this.graphTimerId = window.setInterval(() => {
      const repoRoot = this.plugin.getSourceControlState().snapshot?.repoRoot;
      if (repoRoot && !this.collapsedSections.get("Graph")) {
        void this.loadGraph(repoRoot, true);
      }
    }, 30000);
  }

  async onClose(): Promise<void> {
    if (this.graphTimerId !== null) window.clearInterval(this.graphTimerId);
    this.graphTimerId = null;
    this.graphRequestId += 1;
    this.graphEl = null;
    this.graphRaw = null;
    this.graphRenderedKey = "";
    this.lastRenderKey = "";
    this.contentEl.empty();
  }

  async render(): Promise<void> {
    const state = this.plugin.getSourceControlState();
    const snapshot = state.snapshot;
    const key = this.buildSnapshotKey(state);

    // Nothing changed — skip DOM work entirely to prevent flicker.
    if (key === this.lastRenderKey) return;
    this.lastRenderKey = key;

    const wrap = this.contentEl;

    // ── First render or repo changed: build the static shell ──────────────
    const shellKey = snapshot
      ? snapshot.repoRoot + ":" + this.plugin.getKnownRepos().join("|")
      : `__empty__:${state.loading}:${Boolean(state.error)}:${this.plugin.getKnownRepos().join("|")}`;
    const prevShellKey = wrap.dataset["shellKey"] ?? "";

    if (prevShellKey !== shellKey) {
      wrap.empty();
      this.bodyEl = null;
      this.headlineEl = null;
      this.statsEl = null;
      this.bannerEl = null;
      this.commitHintEl = null;
      this.commitInputEl = null;
      this.commitBtnEl = null;
      this.commitActionEl = null;
      this.commitMoreEl = null;
      this.changesCountEl = null;
      this.graphEl = null;
      this.graphCacheKey = "";
      this.graphRenderedKey = "";
      this.graphRaw = null;
      this.graphRequestId += 1;
      this.sectionRenderLimits.clear();
      wrap.dataset["shellKey"] = shellKey;

      const guard = async (label: string, action: () => Promise<void>): Promise<void> => {
        try {
          await action();
        } catch (error) {
          this.plugin.reportSourceControlError(label, error);
        }
      };
      const repositories = this.createWorkbenchSection(wrap, "REPOSITORIES", "Repositories");
      if (!snapshot) {
        const emptyWrap = repositories.body.createDiv({ cls: "vlg-no-repo" });
        const emptyIcon = emptyWrap.createDiv({ cls: state.loading ? "vlg-empty-icon is-loading" : "vlg-empty-icon" });
        setIcon(emptyIcon, state.loading ? "refresh-cw" : state.error ? "circle-alert" : "git-branch");
        emptyWrap.createEl("p", {
          text: state.loading
            ? "Finding Git repositories…"
            : state.error ?? "Open a file inside a Git repository or select a known repository.",
          cls: "vlg-no-repo-msg"
        });

        const knownRepos = this.plugin.getKnownRepos();
        if (knownRepos.length > 0) {
          emptyWrap.createEl("p", { text: "Known repositories:", cls: "vlg-no-repo-label" });
          const repoList = emptyWrap.createDiv({ cls: "vlg-no-repo-list" });
          for (const repo of knownRepos) {
            const item = repoList.createEl("button", { cls: "vlg-no-repo-item" });
            item.setAttr("title", repo);
            setIcon(item.createSpan({ cls: "vlg-no-repo-icon" }), "git-branch");
            item.createSpan({ text: path.basename(repo), cls: "vlg-no-repo-name" });
            item.createSpan({ text: repo, cls: "vlg-no-repo-path" });
            item.onclick = async () => {
              await this.plugin.selectRepo(repo);
            };
          }
        }

        const changes = this.createWorkbenchSection(wrap, "CHANGES", "Source Control Changes");
        const emptyActions = changes.body.createDiv({ cls: "vlg-no-repo-actions" });
        const refreshBtn = emptyActions.createEl("button", { text: "Refresh" });
        refreshBtn.onclick = async () => {
          await this.plugin.refreshContext(true);
        };
        const rebuildBtn = emptyActions.createEl("button", { text: "Discover Repositories" });
        rebuildBtn.onclick = async () => {
          await this.plugin.rebuildIndex();
        };
        const graph = this.createWorkbenchSection(wrap, "GRAPH", "Graph");
        graph.body.createDiv({ text: "Select a repository to see its history.", cls: "vlg-graph-empty" });
        return;
      }

      const header = repositories.body.createDiv({ cls: "vlg-sc-header" });
      const headlineRow = header.createDiv({ cls: "vlg-headline-row" });
      const repoSelect = headlineRow.createEl("button", { cls: "vlg-repo-select" });
      repoSelect.setAttr("title", snapshot.repoRoot);
      repoSelect.setAttr("aria-label", "Switch repository: " + snapshot.repoName);
      setIcon(repoSelect.createSpan({ cls: "vlg-repo-icon" }), "hard-drive");
      repoSelect.createSpan({ text: snapshot.repoName, cls: "vlg-repo-name" });
      const branch = headlineRow.createEl("button", { cls: "vlg-repo-branch vlg-operation-action" });
      branch.setAttr("title", "Checkout or create branch");
      branch.setAttr("aria-label", "Checkout or create branch");
      branch.onclick = () => guard("Open branches", () => this.plugin.checkoutOrCreateBranch());
      setIcon(branch.createSpan({ cls: "vlg-repo-branch-icon" }), "git-branch");
      this.headlineEl = branch.createSpan({ text: snapshot.status.branch, cls: "vlg-repo-branch-name" });
      repoSelect.onclick = async () => { await guard("Switch repository", () => this.plugin.switchRepositoryContext()); };

      const makeAction = (parent: HTMLElement, icon: string, title: string, action: () => Promise<void>): void => {
        const button = parent.createEl("button", { cls: "vlg-workbench-icon vlg-operation-action" });
        button.setAttr("title", title);
        button.setAttr("aria-label", title);
        setIcon(button, icon);
        button.onclick = () => guard(title, action);
      };
      makeAction(headlineRow, "refresh-cw", "Refresh source control", () => this.plugin.refreshContext(true));
      const repoMore = headlineRow.createEl("button", { cls: "vlg-workbench-icon" });
      repoMore.setAttr("title", "Repository actions");
      repoMore.setAttr("aria-label", "Repository actions");
      setIcon(repoMore, "ellipsis");
      repoMore.onclick = (event) => {
        const menu = new Menu();
        menu.addItem((item) => item.setTitle("Switch repository").setIcon("git-branch")
          .onClick(() => { void guard("Switch repository", () => this.plugin.switchRepositoryContext()); }));
        menu.addSeparator();
        menu.addItem((item) => item.setTitle("Stash changes").setIcon("archive")
          .onClick(() => { void guard("Open stash", () => this.plugin.openStashModal()); }));
        menu.addItem((item) => item.setTitle("Commit history").setIcon("history")
          .onClick(() => { void guard("Open history", () => this.plugin.openHistoryModal()); }));
        menu.addItem((item) => item.setTitle("Undo last commit (keep changes staged)").setIcon("undo-2")
          .onClick(() => { void guard("Undo commit", () => this.plugin.undoLastCommit()); }));
        menu.showAtMouseEvent(event);
      };
      for (const repo of this.plugin.getKnownRepos()) {
        if (repo === snapshot.repoRoot) continue;
        const other = repositories.body.createEl("button", { cls: "vlg-repo-other" });
        other.setAttr("title", repo);
        other.setAttr("aria-label", "Switch to repository " + repo);
        setIcon(other.createSpan({ cls: "vlg-repo-icon" }), "hard-drive");
        other.createSpan({ text: path.basename(repo), cls: "vlg-repo-other-name" });
        other.createSpan({ text: path.dirname(repo), cls: "vlg-repo-other-path" });
        other.onclick = async () => { await guard("Switch repository", () => this.plugin.selectRepo(repo)); };
      }

      this.bannerEl = wrap.createDiv({ cls: "vlg-state-banner" });

      const changes = this.createWorkbenchSection(wrap, "CHANGES", "Source Control Changes");
      this.changesCountEl = changes.actions.createSpan({ cls: "vlg-workbench-count" });
      const commitAction = changes.actions.createEl("button", { cls: "vlg-workbench-icon" });
      commitAction.setAttr("title", "Commit staged changes");
      commitAction.setAttr("aria-label", "Commit staged changes");
      commitAction.disabled = true;
      setIcon(commitAction, "check");
      commitAction.onclick = () => this.commitBtnEl?.click();
      this.commitActionEl = commitAction;
      makeAction(changes.actions, "refresh-cw", "Refresh changes", () => this.plugin.refreshContext(true));
      const changesMore = changes.actions.createEl("button", { cls: "vlg-workbench-icon" });
      changesMore.setAttr("aria-label", "Changes actions");
      changesMore.setAttr("title", "Changes actions");
      setIcon(changesMore, "ellipsis");
      changesMore.onclick = (event) => {
        const menu = new Menu();
        menu.addItem((item) => item.setTitle("Stash changes").setIcon("archive")
          .onClick(() => { void guard("Open stash", () => this.plugin.openStashModal()); }));
        menu.addItem((item) => item.setTitle("Undo last commit").setIcon("undo-2")
          .onClick(() => { void guard("Undo commit", () => this.plugin.undoLastCommit()); }));
        menu.showAtMouseEvent(event);
      };

      const commitArea = changes.body.createDiv({ cls: "vlg-commit-area" });
      const ta = commitArea.createEl("textarea");
      ta.placeholder = Platform.isMacOS ? "Message (Cmd+Enter)" : "Message (Ctrl+Enter)";
      ta.addClass("vlg-commit-input");
      ta.value = this.commitDrafts.get(snapshot.repoRoot) ?? "";
      this.commitInputEl = ta;

      const commitControls = commitArea.createDiv({ cls: "vlg-commit-controls" });
      const commitBtn = commitControls.createEl("button");
      commitBtn.addClass("vlg-commit-btn");
      commitBtn.disabled = true;
      this.commitBtnEl = commitBtn;
      const commitMore = commitControls.createEl("button", { cls: "vlg-commit-more" });
      commitMore.disabled = true;
      commitMore.setAttr("aria-label", "Commit options");
      commitMore.setAttr("title", "Commit options");
      setIcon(commitMore, "chevron-down");
      this.commitMoreEl = commitMore;

      this.commitHintEl = commitArea.createDiv({ cls: "vlg-commit-hint" });

      ta.addEventListener("input", () => {
        this.commitDrafts.set(snapshot.repoRoot, ta.value);
        updateCommitButtonState(this.commitBtnEl, ta, this.plugin.getSourceControlState());
        commitAction.disabled = commitBtn.disabled;
        commitMore.disabled = commitBtn.disabled;
      });

      ta.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          this.commitBtnEl?.click();
        }
      });

      const commitDraft = async (pushAfter: boolean): Promise<void> => {
        const msg = ta.value.trim();
        if (!msg) { new Notice("Enter a commit message"); return; }
        const snap = await this.plugin.getActiveRepoSnapshot();
        if (!snap) return;
        const committed = await this.plugin.commitWithMessage(snap.repoRoot, msg);
        if (committed) {
          ta.value = "";
          this.commitDrafts.delete(snap.repoRoot);
          commitBtn.disabled = true;
          commitAction.disabled = true;
          commitMore.disabled = true;
          if (pushAfter) await this.plugin.pushCurrentRepo();
        }
      };
      commitBtn.onclick = async () => { await guard("Commit", () => commitDraft(false)); };
      commitMore.onclick = (event) => {
        const menu = new Menu();
        menu.addItem((item) => item.setTitle("Commit")
          .onClick(() => { void guard("Commit", () => commitDraft(false)); }));
        menu.addItem((item) => item.setTitle("Commit and push").setIcon("arrow-up-from-line")
          .onClick(() => { void guard("Commit and push", () => commitDraft(true)); }));
        menu.showAtMouseEvent(event);
      };

      this.statsEl = changes.body.createEl("p", { cls: "vlg-sc-stats" });
      this.bodyEl = changes.body.createDiv({ cls: "vlg-sc-body" });

      const graph = this.createWorkbenchSection(wrap, "GRAPH", "Graph");
      const scopeBtn = graph.actions.createEl("button", { cls: "vlg-graph-scope" });
      setIcon(scopeBtn.createSpan({ cls: "vlg-repo-branch-icon" }), "git-branch");
      const scopeLabel = scopeBtn.createSpan({ text: this.graphScope === "all" ? "All" : "Current" });
      scopeBtn.setAttr("aria-label", "Graph branch scope");
      scopeBtn.setAttr("title", this.graphScope === "all" ? "All branches" : "Current branch");
      scopeBtn.onclick = (event) => {
        const menu = new Menu();
        menu.addItem((item) => item.setTitle("All branches").setChecked(this.graphScope === "all")
          .onClick(() => {
            this.graphScope = "all";
            scopeLabel.setText("All");
            scopeBtn.setAttr("title", "All branches");
            void this.loadGraph(snapshot.repoRoot, true);
          }));
        menu.addItem((item) => item.setTitle("Current branch").setChecked(this.graphScope === "current")
          .onClick(() => {
            this.graphScope = "current";
            scopeLabel.setText("Current");
            scopeBtn.setAttr("title", "Current branch");
            void this.loadGraph(snapshot.repoRoot, true);
          }));
        menu.showAtMouseEvent(event);
      };
      makeAction(graph.actions, "arrow-down-to-line", "Pull", () => this.plugin.pullCurrentRepo());
      makeAction(graph.actions, "arrow-up-from-line", "Push", () => this.plugin.pushCurrentRepo());
      makeAction(graph.actions, "refresh-cw", "Refresh graph", () => this.loadGraph(snapshot.repoRoot, true));
      const graphMore = graph.actions.createEl("button", { cls: "vlg-workbench-icon" });
      graphMore.setAttr("aria-label", "Graph actions");
      graphMore.setAttr("title", "Graph actions");
      setIcon(graphMore, "ellipsis");
      graphMore.onclick = (event) => {
        const menu = new Menu();
        menu.addItem((item) => item.setTitle("Load more commits").setIcon("list-plus")
          .onClick(() => {
            this.graphLimit += 80;
            void this.loadGraph(snapshot.repoRoot, true);
          }));
        menu.addItem((item) => item.setTitle("Open commit history").setIcon("history")
          .onClick(() => { void guard("Open history", () => this.plugin.openHistoryModal()); }));
        menu.showAtMouseEvent(event);
      };
      this.graphEl = graph.body.createDiv({ cls: "vlg-graph-list" });
    }

    if (!snapshot) return;

    wrap.classList.toggle("is-busy", Boolean(state.operation));
    wrap.setAttr("aria-busy", state.operation || state.loading ? "true" : "false");
    wrap.querySelectorAll<HTMLButtonElement>(".vlg-operation-action").forEach((button) => {
      button.disabled = Boolean(state.operation);
    });

    this.renderStateBanner(state);

    // ── Update mutable parts in-place (no flash) ──────────────────────────
    if (this.headlineEl) {
      this.headlineEl.setText(snapshot.status.branch);
    }
    updateCommitButtonState(this.commitBtnEl, this.commitInputEl, state);
    if (this.commitActionEl && this.commitBtnEl) this.commitActionEl.disabled = this.commitBtnEl.disabled;
    if (this.commitMoreEl && this.commitBtnEl) this.commitMoreEl.disabled = this.commitBtnEl.disabled;
    if (this.changesCountEl) this.changesCountEl.setText(String(snapshot.changes.length));
    if (this.commitHintEl) {
      this.commitHintEl.setText(
        snapshot.status.conflicts > 0
          ? "Resolve merge conflicts before committing"
          : snapshot.status.staged === 0
            ? "Stage changes to enable commit"
            : ""
      );
    }
    if (this.statsEl) {
      this.statsEl.setText(
        snapshot.status.ahead || snapshot.status.behind
          ? `↑ ${snapshot.status.ahead} outgoing · ↓ ${snapshot.status.behind} incoming`
          : ""
      );
    }
    if (state.operation) this.graphCacheKey = "";
    else void this.loadGraph(snapshot.repoRoot);

    const body = this.bodyEl!;
    body.empty();

    if (snapshot.changes.length === 0) {
      body.createDiv({ text: "No changes", cls: "vlg-workbench-clean" });
      return;
    }

    const displayChanges = this.buildDisplayChanges(snapshot.changes);
    const conflictChanges = displayChanges.filter((change) => change.mode === "conflict");
    const stagedChanges   = displayChanges.filter((change) => change.mode === "staged");
    const workingChanges = displayChanges.filter(
      (change) => change.mode === "unstaged" || change.mode === "untracked"
    );

    if (conflictChanges.length > 0) this.renderChangeSection(body, snapshot.repoRoot, "Merge Changes", conflictChanges);
    if (stagedChanges.length > 0) this.renderChangeSection(body, snapshot.repoRoot, "Staged Changes", stagedChanges);
    if (workingChanges.length > 0) this.renderChangeSection(body, snapshot.repoRoot, "Changes", workingChanges);
  }

  private createWorkbenchSection(
    parent: HTMLElement,
    label: string,
    key: string
  ): { body: HTMLElement; actions: HTMLElement } {
    const section = parent.createDiv({ cls: "vlg-workbench-section" });
    section.addClass("vlg-workbench-" + (key === "Source Control Changes" ? "changes" : key.toLowerCase()));
    const heading = section.createDiv({ cls: "vlg-workbench-section-head" });
    const toggle = heading.createEl("button", { cls: "vlg-workbench-section-toggle" });
    const chevron = toggle.createSpan({ cls: "vlg-workbench-chevron" });
    toggle.createSpan({ text: label });
    const actions = heading.createDiv({ cls: "vlg-workbench-section-actions" });
    const body = section.createDiv({ cls: "vlg-workbench-section-body" });
    const collapsed = this.collapsedSections.get(key) ?? false;
    setIcon(chevron, collapsed ? "chevron-right" : "chevron-down");
    toggle.setAttr("aria-expanded", String(!collapsed));
    body.classList.toggle("is-hidden", collapsed);
    toggle.onclick = async () => {
      const next = !(this.collapsedSections.get(key) ?? false);
      this.collapsedSections.set(key, next);
      body.classList.toggle("is-hidden", next);
      toggle.setAttr("aria-expanded", String(!next));
      setIcon(chevron, next ? "chevron-right" : "chevron-down");
      await this.plugin.setSectionCollapsed(key, next);
      if (key === "Graph") {
        this.graphCacheKey = "";
        if (next) {
          this.graphRequestId += 1;
        } else {
          const repoRoot = this.plugin.getSourceControlState().snapshot?.repoRoot;
          if (repoRoot) void this.loadGraph(repoRoot, true);
        }
      }
    };
    return { body, actions };
  }

  private async loadGraph(repoRoot: string, force = false): Promise<void> {
    const list = this.graphEl;
    if (!list || this.collapsedSections.get("Graph")) return;
    const branch = this.plugin.getSourceControlState().snapshot?.status.branch ?? "";
    const key = [repoRoot, branch, this.graphScope, this.graphLimit].join("|");
    if (!force && key === this.graphCacheKey) return;
    this.graphCacheKey = key;
    const requestId = ++this.graphRequestId;
    const scrollTop = list.scrollTop;
    if (this.graphRaw === null) {
      list.empty();
      list.createDiv({ text: "Loading commits…", cls: "vlg-graph-empty" });
    }

    try {
      const args = [
        "log", "--graph", "--topo-order", "--decorate=short", "--no-color",
        "-n", String(this.graphLimit),
        "--format=%x1f%H%x1f%h%x1f%s%x1f%an%x1f%D"
      ];
      if (this.graphScope === "all") args.splice(1, 0, "--all");
      const raw = await this.plugin.runGitPublic(args, repoRoot);
      if (requestId !== this.graphRequestId || list !== this.graphEl) return;
      if (raw === this.graphRaw && key === this.graphRenderedKey) return;
      this.graphRaw = raw;
      this.graphRenderedKey = key;
      list.empty();

      let count = 0;
      for (const line of raw.split(/\r?\n/)) {
        if (!line) continue;
        const separator = line.indexOf("\x1f");
        if (separator < 0) {
          if (line.trim()) list.createDiv({ text: line, cls: "vlg-graph-connector" });
          continue;
        }
        const [hash, shortHash, subject, author, decorations] = line.slice(separator + 1).split("\x1f");
        if (!hash || !/^[0-9a-f]{40,64}$/.test(hash)) continue;

        const row = list.createEl("button", { cls: "vlg-graph-row" });
        row.setAttr("title", shortHash + " " + subject + " — " + author);
        row.setAttr("aria-label", "Show commit " + shortHash + ": " + subject);
        row.createSpan({ text: line.slice(0, separator), cls: "vlg-graph-path" });
        row.createSpan({ text: subject || shortHash, cls: "vlg-graph-subject" });
        const refs = (decorations ?? "").split(", ").filter(Boolean);
        for (const ref of refs.slice(0, 2)) {
          const badge = row.createSpan({
            text: ref.replace(/^HEAD -> /, "").replace(/^tag: /, ""),
            cls: "vlg-graph-ref"
          });
          if (ref.startsWith("HEAD -> ")) badge.addClass("is-head");
          if (ref.startsWith("tag: ")) badge.addClass("is-tag");
        }
        if (refs.length > 2) row.createSpan({ text: "+" + (refs.length - 2), cls: "vlg-graph-ref" });
        row.createSpan({ text: author ?? "", cls: "vlg-graph-author" });
        row.onclick = () => {
          void this.plugin.showCommitDiff(repoRoot, hash).catch((error: unknown) => {
            this.plugin.reportSourceControlError("Show commit", error);
          });
        };
        count += 1;
      }
      if (count === 0) list.createDiv({ text: "No commits yet.", cls: "vlg-graph-empty" });
      if (count >= this.graphLimit) {
        const more = list.createEl("button", { text: "Load more commits", cls: "vlg-graph-load-more" });
        more.onclick = () => {
          this.graphLimit += 80;
          void this.loadGraph(repoRoot, true);
        };
      }
      list.scrollTop = scrollTop;
    } catch (error) {
      if (requestId !== this.graphRequestId || list !== this.graphEl) return;
      this.graphCacheKey = "";
      this.graphRaw = null;
      this.graphRenderedKey = "";
      const message = error instanceof Error ? error.message : String(error);
      list.empty();
      list.createDiv({
        text: /does not have any commits|unknown revision|bad revision|ambiguous argument/i.test(message)
          ? "No commits yet."
          : "Could not load commits: " + message,
        cls: "vlg-graph-empty"
      });
    }
  }

  private buildSnapshotKey(state: SourceControlState): string {
    const snapshot = state.snapshot;
    if (!snapshot) {
      return `__empty__:${state.loading}:${state.error ?? ""}:${this.plugin.getKnownRepos().join("|")}`;
    }
    const collapsed = [...this.collapsedSections.entries()]
      .map(([k, v]) => `${k}:${v}`)
      .join(",");
    const changes = snapshot.changes
      .map((c) => `${c.x}${c.y}${c.path}${c.staged}${c.unstaged}${c.untracked}${c.conflicted}`)
      .join("|");
    const limits = [...this.sectionRenderLimits.entries()].map(([k, v]) => `${k}:${v}`).join(",");
    return `${snapshot.repoRoot}||${snapshot.status.branch}||${snapshot.status.ahead}:${snapshot.status.behind}||${changes}||${collapsed}||${limits}||${this.plugin.getKnownRepos().join("|")}||${state.loading}:${state.operation ?? ""}:${state.error ?? ""}`;
  }

  private renderStateBanner(state: SourceControlState): void {
    if (!this.bannerEl) return;
    this.bannerEl.empty();
    this.bannerEl.removeClass("is-loading", "is-error");

    const message = state.operation ?? (state.loading ? "Refreshing source control…" : state.error);
    if (!message) {
      this.bannerEl.addClass("is-hidden");
      return;
    }

    this.bannerEl.removeClass("is-hidden");
    this.bannerEl.addClass(state.error && !state.operation ? "is-error" : "is-loading");
    const icon = this.bannerEl.createSpan({ cls: "vlg-state-banner-icon" });
    setIcon(icon, state.error && !state.operation ? "circle-alert" : "loader-circle");
    this.bannerEl.createSpan({ text: message, cls: "vlg-state-banner-text" });
    if (state.error && !state.operation) {
      const dismiss = this.bannerEl.createEl("button", { cls: "vlg-state-dismiss" });
      dismiss.setAttr("aria-label", "Dismiss error");
      setIcon(dismiss, "x");
      dismiss.onclick = () => this.plugin.clearSourceControlError();
    }
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
    const chevron = toggle.createSpan({ cls: "vlg-section-chevron" });
    setIcon(chevron, isCollapsed ? "chevron-right" : "chevron-down");
    toggle.createSpan({ text: title, cls: "vlg-section-label" });
    toggle.createSpan({ text: String(changes.length), cls: "vlg-section-count" });
    toggle.setAttr("role", "button");
    toggle.setAttr("tabindex", "0");
    toggle.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") (e.currentTarget as HTMLElement).click();
    });
    toggle.onclick = async () => {
      const nextCollapsed = !isCollapsed;
      this.collapsedSections.set(title, nextCollapsed);
      await this.plugin.setSectionCollapsed(title, nextCollapsed);
      this.lastRenderKey = "";
      await this.render();
    };

    const sectionActions = titleRow.createDiv({ cls: "vlg-change-section-actions" });
    if (title === "Changes" || title === "Untracked Files") {
        const stageAllBtn = sectionActions.createEl("button");
      stageAllBtn.addClass("vlg-icon-btn");
      stageAllBtn.setAttr("title", "Stage all");
      setIcon(stageAllBtn, "plus");
      stageAllBtn.disabled = changes.length === 0;
      stageAllBtn.onclick = async () => {
        await this.plugin.stageRepoFiles(
          repoRoot,
          [...new Set(changes.flatMap((change) => [change.path, change.originalPath].filter((item): item is string => Boolean(item))))]
        );
      };
    }

    if (title === "Staged Changes") {
        const unstageAllBtn = sectionActions.createEl("button");
      unstageAllBtn.addClass("vlg-icon-btn");
      unstageAllBtn.setAttr("title", "Unstage all");
      setIcon(unstageAllBtn, "minus");
      unstageAllBtn.disabled = changes.length === 0;
      unstageAllBtn.onclick = async () => {
        await this.plugin.unstageRepoFiles(
          repoRoot,
          [...new Set(changes.flatMap((change) => [change.path, change.originalPath].filter((item): item is string => Boolean(item))))]
        );
      };
    }

    if (isCollapsed) {
      return;
    }

    const renderLimit = this.sectionRenderLimits.get(title) ?? this.plugin.getMaxVisibleChanges();
    for (const change of changes.slice(0, renderLimit)) {
      const row = section.createDiv({ cls: "vlg-change-row" });
      row.setAttr("role", "button");
      row.setAttr("tabindex", "0");
      row.setAttr("title", change.originalPath ? `${change.originalPath} → ${change.path}` : change.path);
      const state = row.createEl("span", {
        text: change.statusCode,
        cls: "vlg-change-state"
      });
      state.addClass(`vlg-change-state-${change.mode}`);
      state.setAttr("aria-label", this.getStatusLabel(change));

      const pathEl = row.createDiv({ cls: "vlg-change-path" });
      pathEl.createSpan({ text: path.posix.basename(change.path), cls: "vlg-change-name" });
      const directory = path.posix.dirname(change.path);
      const detail = change.originalPath
        ? `${directory === "." ? "" : directory + "/"}  ←  ${change.originalPath}`
        : directory === "." ? "" : directory;
      if (detail) pathEl.createSpan({ text: detail, cls: "vlg-change-directory" });

      const rowActions = row.createDiv({ cls: "vlg-change-actions" });
      const mkBtn = (icon: string, tooltip: string, danger = false): HTMLButtonElement => {
          const btn = rowActions.createEl("button");
        btn.addClass("vlg-icon-btn");
        if (danger) btn.addClass("vlg-btn-danger");
        btn.setAttr("title", tooltip);
        btn.setAttr("aria-label", tooltip);
        setIcon(btn, icon);
        btn.addEventListener("click", (event) => event.stopPropagation());
        return btn;
      };

      const showDiff = async (): Promise<void> => {
        try {
          await this.plugin.showDiffForRepoFile(
          repoRoot,
          change.path,
            change.mode === "staged",
            change.mode === "untracked",
            change.originalPath
          );
        } catch (error) {
          this.plugin.reportSourceControlError("Show diff", error);
        }
      };
      row.onclick = () => { void showDiff(); };
      row.onkeydown = (event: KeyboardEvent) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void showDiff();
        }
      };

      if (change.mode === "unstaged" || change.mode === "untracked") {
        const stageBtn = mkBtn("plus", "Stage");
        stageBtn.onclick = async () => {
          await this.plugin.stageRepoFile(repoRoot, change.path, change.originalPath);
        };

        if (change.mode === "unstaged") {
          const stageHunksBtn = mkBtn("layers", "Stage hunks…");
          stageHunksBtn.onclick = async () => {
            try {
              await this.plugin.openHunkStageModal(repoRoot, change.path);
            } catch (error) {
              this.plugin.reportSourceControlError("Stage hunks", error);
            }
          };
        }

        const discardBtn = mkBtn("trash-2", "Discard changes", true);
        discardBtn.onclick = async () => {
          await this.plugin.discardRepoFileChanges(
            repoRoot,
            change.path,
            change.mode === "untracked",
            change.originalPath
          );
        };
      }

      if (change.mode === "staged") {
        const unstageBtn = mkBtn("minus", "Unstage");
        unstageBtn.onclick = async () => {
          await this.plugin.unstageRepoFile(repoRoot, change.path, change.originalPath);
        };

        const unstageHunksBtn = mkBtn("layers", "Unstage hunks…");
        unstageHunksBtn.onclick = async () => {
          try {
            await this.plugin.openHunkUnstageModal(repoRoot, change.path);
          } catch (error) {
            this.plugin.reportSourceControlError("Unstage hunks", error);
          }
          };
      }

      if (change.mode === "conflict") {
        const resolveBtn = mkBtn("git-merge", "Resolve conflict…");
        resolveBtn.onclick = async () => {
          await this.plugin.openConflictResolverModal(repoRoot, change.path);
        };
        const markBtn = mkBtn("check", "Mark as resolved");
        markBtn.onclick = async () => {
          await this.plugin.stageRepoFile(repoRoot, change.path, change.originalPath);
        };
      }
    }

    if (changes.length > renderLimit) {
      const remaining = changes.length - renderLimit;
      const moreBtn = section.createEl("button", {
        text: `Show ${Math.min(this.plugin.getMaxVisibleChanges(), remaining)} more (${remaining} remaining)`,
        cls: "vlg-show-more"
      });
      moreBtn.onclick = async () => {
        this.sectionRenderLimits.set(title, renderLimit + this.plugin.getMaxVisibleChanges());
        this.lastRenderKey = "";
        await this.render();
      };
    }
  }

  private getStatusLabel(change: DisplayChange): string {
    if (change.mode === "conflict") return "Merge conflict";
    if (change.mode === "untracked") return "Untracked";
    const labels: Record<string, string> = {
      M: "Modified",
      A: "Added",
      D: "Deleted",
      R: "Renamed",
      C: "Copied",
      T: "Type changed"
    };
    return `${change.mode === "staged" ? "Staged" : "Unstaged"} ${labels[change.statusCode] ?? change.statusCode}`;
  }

  private initializeSectionCollapseState(): void {
    if (this.collapsedSections.size > 0) {
      return;
    }
    const persisted = this.plugin.getCollapsedSections();
    this.collapsedSections.set("Repositories", persisted["Repositories"] ?? false);
    this.collapsedSections.set("Source Control Changes", persisted["Source Control Changes"] ?? false);
    this.collapsedSections.set("Graph", persisted["Graph"] ?? false);
    this.collapsedSections.set("Merge Changes", persisted["Merge Changes"] ?? false);
    this.collapsedSections.set("Staged Changes", persisted["Staged Changes"] ?? false);
    this.collapsedSections.set("Changes", persisted["Changes"] ?? false);
    this.collapsedSections.set("Untracked Files", persisted["Untracked Files"] ?? false);
  }

  private buildDisplayChanges(changes: FileChange[]): DisplayChange[] {
    const result: DisplayChange[] = [];

    for (const change of changes) {
      if (change.conflicted) {
        result.push({ path: change.path, originalPath: change.originalPath, mode: "conflict", statusCode: "!" });
        continue;
      }

      if (change.untracked) {
        result.push({ path: change.path, originalPath: change.originalPath, mode: "untracked", statusCode: "U" });
        continue;
      }

      if (change.staged) {
        result.push({ path: change.path, originalPath: change.originalPath, mode: "staged", statusCode: change.x });
      }

      if (change.unstaged) {
        result.push({ path: change.path, originalPath: change.originalPath, mode: "unstaged", statusCode: change.y });
      }
    }

    return result.sort((a, b) => a.path.localeCompare(b.path));
  }
}

class VsCodeLikeGitPlugin extends Plugin {
  settings!: GitPluginSettings;
  private statusBarEl: HTMLElement | null = null;
  private currentRepoRoot: string | null = null;
  private currentFile: TFile | null = null;
  private refreshTimerId: number | null = null;
  private refreshDebounceId: number | null = null;
  private repoRegistry: Set<string> = new Set();
  private extraRepoRoots: Set<string> = new Set();
  private manualRepoRoot: string | null = null;
  private sourceControlState: SourceControlState = {
    snapshot: null,
    loading: true,
    operation: null,
    error: null
  };
  private refreshRequestId = 0;
  private refreshCompletedId = 0;
  private refreshPromise: Promise<void> | null = null;
  private refreshManualRequested = false;
  private activeOperation: string | null = null;

  async onload(): Promise<void> {
    loadDesktopModules();
    await this.loadSettings();
    this.currentFile = this.app.workspace.getActiveFile();

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
      this.app.vault.on("modify", () => this.scheduleRefresh())
    );
    this.registerEvent(this.app.vault.on("create", () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleRefresh()));

    this.resetAutoRefresh();
    await this.rebuildRepoRegistry();
    await this.refreshContext();
  }

  onunload(): void {
    if (this.refreshTimerId !== null) {
      window.clearInterval(this.refreshTimerId);
      this.refreshTimerId = null;
    }
    if (this.refreshDebounceId !== null) {
      window.clearTimeout(this.refreshDebounceId);
      this.refreshDebounceId = null;
    }
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

    await this.stageRepoFile(context.repoRoot, context.repoRelativeFile);
  }

  private async unstageCurrentFile(): Promise<void> {
    const context = await this.requireContext();
    if (!context) {
      return;
    }

    await this.unstageRepoFile(context.repoRoot, context.repoRelativeFile);
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

  getSourceControlState(): SourceControlState {
    return { ...this.sourceControlState };
  }

  getMaxVisibleChanges(): number {
    return Math.max(50, this.settings.maxVisibleChanges);
  }

  clearSourceControlError(): void {
    this.sourceControlState = { ...this.sourceControlState, error: null };
    void this.refreshSourceControlView();
  }

  reportSourceControlError(context: string, error: unknown): void {
    const message = `${context}: ${this.toErrorMessage(error)}`;
    this.sourceControlState = { ...this.sourceControlState, loading: false, error: message };
    new Notice(message);
    void this.refreshSourceControlView();
  }

  async runSourceControlAction(label: string, action: () => Promise<void>): Promise<boolean> {
    if (this.activeOperation) {
      new Notice(`${this.activeOperation} is already in progress`);
      return false;
    }

    this.activeOperation = label;
    this.sourceControlState = {
      ...this.sourceControlState,
      operation: label,
      error: null
    };
    await this.refreshSourceControlView();

    let operationError: unknown = null;
    try {
      await action();
    } catch (error) {
      operationError = error;
    }

    this.activeOperation = null;
    this.sourceControlState = { ...this.sourceControlState, operation: null };
    await this.refreshContext();

    if (operationError) {
      this.reportSourceControlError(label, operationError);
      return false;
    }
    return true;
  }

  async setSectionCollapsed(sectionName: string, collapsed: boolean): Promise<void> {
    this.settings.collapsedSections[sectionName] = collapsed;
    await this.saveData(this.settings);
  }

  async showDiffForRepoFile(
    repoRoot: string,
    repoRelativeFile: string,
    preferCached = false,
    isUntracked = false,
    originalPath?: string
  ): Promise<void> {
    if (isUntracked) {
      const output = await this.runGit(
        ["diff", "--no-index", "--", os.devNull, resolveInsideRoot(repoRoot, repoRelativeFile)],
        repoRoot,
        [1]
      );
      if (!output.trim()) {
        new Notice("No preview available for selected file");
        return;
      }
      this.openDiffModal(repoRelativeFile, output, "(untracked)");
      return;
    }

    const pathspecs = [repoRelativeFile, originalPath]
      .filter((item): item is string => Boolean(item))
      .map(toLiteralPathspec);
    const primaryArgs = preferCached
      ? ["diff", "--cached", "--", ...pathspecs]
      : ["diff", "--", ...pathspecs];
    const fallbackArgs = preferCached
      ? ["diff", "--", ...pathspecs]
      : ["diff", "--cached", "--", ...pathspecs];

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

  async stageRepoFile(repoRoot: string, repoRelativeFile: string, originalPath?: string): Promise<boolean> {
    return this.runSourceControlAction(`Staging ${path.posix.basename(repoRelativeFile)}…`, async () => {
      const pathspecs = [repoRelativeFile, originalPath]
        .filter((item): item is string => Boolean(item))
        .map(toLiteralPathspec);
      await this.runGit(["add", "-A", "--", ...pathspecs], repoRoot);
      this.repoRegistry.add(repoRoot);
    });
  }

  async discardRepoFileChanges(
    repoRoot: string,
    repoRelativeFile: string,
    isUntracked: boolean,
    originalPath?: string
  ): Promise<void> {
    const message = isUntracked
      ? `Discard untracked file ${repoRelativeFile}? This will delete the file from disk.`
      : `Discard local changes for ${repoRelativeFile}?`;

    new ConfirmModal(this.app, message, async () => {
      await this.runSourceControlAction(`Discarding ${path.posix.basename(repoRelativeFile)}…`, async () => {
        if (isUntracked) {
          await this.runGit(["clean", "-f", "--", toLiteralPathspec(repoRelativeFile)], repoRoot);
        } else if (originalPath) {
          await this.runGit(["restore", "--", toLiteralPathspec(originalPath)], repoRoot);
          await this.runGit(["clean", "-f", "--", toLiteralPathspec(repoRelativeFile)], repoRoot);
        } else {
          await this.runGit(["restore", "--", toLiteralPathspec(repoRelativeFile)], repoRoot);
        }
        new Notice(`Discarded changes for ${repoRelativeFile}`);
      });
    }).open();
  }

  async stageRepoFiles(repoRoot: string, repoRelativeFiles: string[]): Promise<void> {
    if (repoRelativeFiles.length === 0) {
      return;
    }
    await this.runSourceControlAction(`Staging ${repoRelativeFiles.length} files…`, async () => {
      await this.runGit(["add", "-A", "--", ...repoRelativeFiles.map(toLiteralPathspec)], repoRoot);
      this.repoRegistry.add(repoRoot);
    });
  }

  async unstageRepoFile(repoRoot: string, repoRelativeFile: string, originalPath?: string): Promise<boolean> {
    return this.runSourceControlAction(`Unstaging ${path.posix.basename(repoRelativeFile)}…`, async () => {
      const pathspecs = [repoRelativeFile, originalPath]
        .filter((item): item is string => Boolean(item))
        .map(toLiteralPathspec);
      await this.runGitWithFallback(
        ["restore", "--staged", "--", ...pathspecs],
        ["reset", "--", ...pathspecs],
        repoRoot
      );
      this.repoRegistry.add(repoRoot);
    });
  }

  async revertRepoFileToHead(repoRoot: string, repoRelativeFile: string): Promise<void> {
    const message = `Revert all changes for ${repoRelativeFile} to HEAD?`;
    new ConfirmModal(this.app, message, async () => {
      await this.runSourceControlAction(`Reverting ${path.posix.basename(repoRelativeFile)}…`, async () => {
        await this.runGit(
          ["restore", "--source=HEAD", "--staged", "--worktree", "--", toLiteralPathspec(repoRelativeFile)],
          repoRoot
        );
        new Notice(`Reverted ${repoRelativeFile} to HEAD`);
      });
    }).open();
  }

  async unstageRepoFiles(repoRoot: string, repoRelativeFiles: string[]): Promise<void> {
    if (repoRelativeFiles.length === 0) {
      return;
    }
    await this.runSourceControlAction(`Unstaging ${repoRelativeFiles.length} files…`, async () => {
      const pathspecs = repoRelativeFiles.map(toLiteralPathspec);
      await this.runGitWithFallback(
        ["restore", "--staged", "--", ...pathspecs],
        ["reset", "--", ...pathspecs],
        repoRoot
      );
      this.repoRegistry.add(repoRoot);
    });
  }

  async commitWithMessage(repoRoot: string, message: string): Promise<boolean> {
    const snapshot = await this.getRepoSnapshot(repoRoot);
    if (snapshot.status.staged === 0) {
      new Notice("No staged changes. Stage files before commit.");
      return false;
    }
    if (snapshot.status.conflicts > 0) {
      new Notice("Resolve merge conflicts before committing.");
      return false;
    }
    return this.runSourceControlAction("Committing changes…", async () => {
      await this.runGit(["commit", "-m", message], repoRoot);
      new Notice("Commit finished");
    });
  }

  async undoLastCommit(): Promise<void> {
    const repoRoot = await this.resolveActiveRepoRoot();
    if (!repoRoot) { new Notice("No active Git repository found"); return; }
    new ConfirmModal(this.app, "Undo last commit? Changes will be kept staged (--soft).", async () => {
      await this.runSourceControlAction("Undoing last commit…", async () => {
        await this.runGit(["reset", "--soft", "HEAD~1"], repoRoot);
        new Notice("Last commit undone (changes kept staged)");
      });
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

  async showCommitDiff(repoRoot: string, hash: string): Promise<void> {
    if (!/^[0-9a-f]{40,64}$/.test(hash)) throw new Error("Invalid commit ID");
    const diff = await this.runGit(
      ["show", "--no-ext-diff", "--no-color", "--format=fuller", "--stat", "--patch", hash],
      repoRoot
    );
    this.openDiffModal(hash.slice(0, 8), diff, "(commit)");
  }

  async openConflictResolverModal(repoRoot: string, filePath: string): Promise<void> {
    new ConflictResolverModal(this.app, repoRoot, filePath, this).open();
  }

  /** Exposed for use by Modals that need to run git commands. */
  async runGitPublic(args: string[], cwd: string): Promise<string> {
    return this.runGit(args, cwd);
  }

  async openHunkStageModal(repoRoot: string, filePath: string): Promise<void> {
    const diffOutput = await this.runGit(["diff", "--", toLiteralPathspec(filePath)], repoRoot);
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
        const applied = await this.runSourceControlAction("Staging selected hunks…", async () => {
          await this.applyPatchCached(repoRoot, patch);
          new Notice(`Staged selected hunks in ${filePath}`);
        });
        if (!applied) throw new Error("Selected hunks could not be staged");
      }
    ).open();
  }

  async openHunkUnstageModal(repoRoot: string, filePath: string): Promise<void> {
    const diffOutput = await this.runGit(["diff", "--cached", "--", toLiteralPathspec(filePath)], repoRoot);
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
        const applied = await this.runSourceControlAction("Unstaging selected hunks…", async () => {
          await this.applyPatchCached(repoRoot, patch, true);
          new Notice(`Unstaged selected hunks in ${filePath}`);
        });
        if (!applied) throw new Error("Selected hunks could not be unstaged");
      }
    ).open();
  }

  private async applyPatchCached(repoRoot: string, patch: string, reverse = false): Promise<void> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gitus-"));
    const tmpPath = path.join(tmpDir, "selection.patch");
    await fs.writeFile(tmpPath, patch, "utf8");
    try {
      const args = ["apply", "--cached"];
      if (reverse) args.push("--reverse");
      args.push(tmpPath);
      await this.runGit(args, repoRoot);
    } finally {
      try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore cleanup error */ }
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
      const committed = await this.commitWithMessage(repoRoot, message);
      if (!committed) throw new Error("Commit did not complete");
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
          await this.runSourceControlAction("Pulling changes…", async () => {
            await this.runGit(["pull"], repoRoot);
            new Notice("Pull finished");
          });
        }
      ).open();
      return;
    }

    await this.runSourceControlAction("Pulling changes…", async () => {
      await this.runGit(["pull"], repoRoot);
      new Notice("Pull finished");
    });
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
          await this.runSourceControlAction("Pushing commits…", async () => {
            await this.runGit(["push"], repoRoot);
            new Notice("Push finished");
          });
        }
      ).open();
      return;
    }

    await this.runSourceControlAction("Pushing commits…", async () => {
      await this.runGit(["push"], repoRoot);
      new Notice("Push finished");
    });
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
      await this.runSourceControlAction(`Checking out ${branchName}…`, async () => {
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
      });
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

    let absFilePath = this.getAbsolutePath(this.currentFile.path);
    if (this.extraRepoRoots.has(repoRoot)) {
      try {
        absFilePath = await fs.realpath(absFilePath);
      } catch {
        new Notice("Current file is not available on disk");
        return null;
      }
    }
    if (!isWithinRoot(repoRoot, absFilePath)) {
      new Notice("Current file is outside the active repository");
      return null;
    }
    const repoRelativeFile = normalizeToPosix(path.relative(repoRoot, absFilePath));

    return { repoRoot, repoRelativeFile };
  }

  async refreshContext(manual = false): Promise<void> {
    this.refreshRequestId += 1;
    this.refreshManualRequested = this.refreshManualRequested || manual;
    if (!this.refreshPromise) this.refreshPromise = this.runRefreshLoop();
    await this.refreshPromise;
  }

  private async runRefreshLoop(): Promise<void> {
    try {
      while (this.refreshCompletedId < this.refreshRequestId) {
        const requestId = this.refreshRequestId;
        const manual = this.refreshManualRequested;
        this.refreshManualRequested = false;

        if (manual || !this.sourceControlState.snapshot) {
          this.sourceControlState = { ...this.sourceControlState, loading: true };
          await this.refreshSourceControlView();
        }

        try {
          const repoRoot = await this.resolveActiveRepoRoot();
          const snapshot = repoRoot ? await this.getRepoSnapshot(repoRoot) : null;
          if (requestId !== this.refreshRequestId) {
            this.refreshCompletedId = requestId;
            continue;
          }

          this.currentRepoRoot = repoRoot;
          this.sourceControlState = {
            snapshot,
            loading: false,
            operation: this.activeOperation,
            error: null
          };

          if (!snapshot) {
            this.setStatusBarText("GitUS: no repo");
          } else {
            const { status } = snapshot;
            this.repoRegistry.add(snapshot.repoRoot);
            const manualTag = this.manualRepoRoot ? " [manual]" : "";
            this.setStatusBarText(
              `GitUS ${snapshot.repoName}:${status.branch} S${status.staged} U${status.unstaged} ?${status.untracked} C${status.conflicts} ↑${status.ahead} ↓${status.behind}${manualTag}`
            );
            if (manual) new Notice(`Repo: ${snapshot.repoName} (${status.branch})`);
          }
        } catch (error) {
          if (requestId === this.refreshRequestId) {
            const message = `Git refresh failed: ${this.toErrorMessage(error)}`;
            this.sourceControlState = {
              ...this.sourceControlState,
              loading: false,
              operation: this.activeOperation,
              error: message
            };
            this.setStatusBarText("GitUS: error");
            if (manual) new Notice(message);
          }
        }

        this.refreshCompletedId = requestId;
        await this.refreshSourceControlView();
      }
    } finally {
      this.refreshPromise = null;
    }
  }

  private setStatusBarText(text: string): void {
    if (this.statusBarEl) {
      this.statusBarEl.setText(text);
    }
  }

  private async getRepoSnapshot(repoRoot: string): Promise<RepoSnapshot> {
    const [branch, porcelain, divergence] = await Promise.all([
      this.getBranchLabel(repoRoot),
      this.runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], repoRoot),
      this.getAheadBehind(repoRoot)
    ]);
    const changes = this.parsePorcelainChanges(porcelain);

    let staged = 0;
    let unstaged = 0;
    let untracked = 0;
    let conflicts = 0;
    const { ahead, behind } = divergence;

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

  private async getBranchLabel(repoRoot: string): Promise<string> {
    try {
      const branch = (await this.runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], repoRoot)).trim();
      if (branch) return branch;
    } catch {
      // Detached HEAD is a valid state, not a refresh failure.
    }
    const hash = (await this.runGit(["rev-parse", "--short", "HEAD"], repoRoot)).trim();
    return `HEAD@${hash}`;
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
    if (this.sourceControlState.snapshot?.repoRoot === repoRoot) {
      return this.sourceControlState.snapshot;
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
    let extraRepoRoot: string | null = null;
    let linkedOutsideVault = false;
    if (this.extraRepoRoots.size > 0) {
      try {
        const realFilePath = await fs.realpath(absolutePath);
        const realVaultRoot = await fs.realpath(basePath);
        extraRepoRoot = [...this.extraRepoRoots]
          .filter((root) => isWithinRoot(root, realFilePath))
          .sort((a, b) => b.length - a.length)[0] ?? null;
        linkedOutsideVault = !isWithinRoot(realVaultRoot, realFilePath);
      } catch {
        // A missing file cannot be matched to an external repository.
      }
    }
    if (extraRepoRoot && linkedOutsideVault) {
      return extraRepoRoot;
    }

    const repoRoot = await this.findNearestRepo(basePath, path.dirname(absolutePath));
    if (repoRoot) {
      this.repoRegistry.add(repoRoot);
      return repoRoot;
    }
    return extraRepoRoot;
  }

  private async resolveActiveRepoRoot(): Promise<string | null> {
    if (this.manualRepoRoot) {
      if (await this.isGitEntry(path.join(this.manualRepoRoot, ".git"))) {
        return this.manualRepoRoot;
      }
      this.repoRegistry.delete(this.manualRepoRoot);
      this.manualRepoRoot = null;
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
      const relativeToVault = path.relative(vaultRootResolved, current);
      if (relativeToVault.startsWith("..") || path.isAbsolute(relativeToVault)) {
        return null;
      }
      const gitEntry = path.join(current, ".git");
      if (await this.isGitEntry(gitEntry)) {
        return current;
      }

      if (current === vaultRootResolved) {
        return null;
      }

      const parent = path.dirname(current);
      if (parent === current) {
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

  private parsePorcelainChanges(porcelain: string): FileChange[] {
    const records = porcelain.split("\0");
    const changes: FileChange[] = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index] ?? "";
      if (record.length < 3) continue;
      const x = record[0] ?? " ";
      const y = record[1] ?? " ";
      const filePath = record.slice(3);
      const isRenameOrCopy = x === "R" || x === "C" || y === "R" || y === "C";
      const originalPath = isRenameOrCopy ? records[index + 1] || undefined : undefined;
      if (isRenameOrCopy) index += 1;

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
        originalPath,
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
      const rightLeaf = this.app.workspace.getRightLeaf(false);
      if (!rightLeaf) {
        throw new Error("Unable to create a workspace leaf for Source Control");
      }
      leaf = rightLeaf;
      await leaf.setViewState({ type: SOURCE_CONTROL_VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
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
    const invalidPaths = await this.rebuildRepoRegistry();
    await this.refreshContext(true);
    if (invalidPaths.length > 0) {
      new Notice(`Skipped extra repositories:\n${invalidPaths.join("\n")}`, 10000);
    }
  }

  private async rebuildRepoRegistry(): Promise<string[]> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      return [];
    }

    const basePath = adapter.getBasePath();
    const nextRegistry = await this.discoverRepositories(basePath);
    const nextExtraRoots = new Set<string>();
    const invalidPaths: string[] = [];

    for (const configuredPath of this.settings.extraRepos) {
      if (!path.isAbsolute(configuredPath)) {
        invalidPaths.push(`${configuredPath}: enter an absolute path`);
        continue;
      }
      try {
        const repoRoot = await fs.realpath(configuredPath);
        if (!(await fs.stat(repoRoot)).isDirectory()) {
          throw new Error("not a directory");
        }
        const reportedRoot = (await this.runGit(["rev-parse", "--show-toplevel"], repoRoot)).trim();
        if (!reportedRoot || await fs.realpath(reportedRoot) !== repoRoot) {
          throw new Error("path is not a Git worktree root");
        }
        nextRegistry.add(repoRoot);
        nextExtraRoots.add(repoRoot);
      } catch (error) {
        invalidPaths.push(`${configuredPath}: ${this.toErrorMessage(error)}`);
      }
    }

    this.repoRegistry = nextRegistry;
    this.extraRepoRoots = nextExtraRoots;

    if (this.currentFile) {
      const currentRepo = await this.resolveRepoRootForCurrentFile();
      if (currentRepo) {
        this.repoRegistry.add(currentRepo);
      }
    }

    if (this.manualRepoRoot && !this.repoRegistry.has(this.manualRepoRoot)) {
      this.manualRepoRoot = null;
    }
    return invalidPaths;
  }

  private async discoverRepositories(basePath: string): Promise<Set<string>> {
    const repositories = new Set<string>();
    const queue = [path.resolve(basePath)];
    const configRoot = this.app.vault.configDir.split("/")[0];
    const skippedDirectories = new Set([".git", configRoot, ".trash", "node_modules"]);
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < queue.length) {
        const current = queue[cursor++];
        if (!current) continue;

        let entries: Array<{ name: string; isDirectory(): boolean }>;
        try {
          entries = await fs.readdir(current, { withFileTypes: true, encoding: "utf8" });
        } catch {
          continue;
        }

        const gitEntry = entries.find((entry) => entry.name === ".git");
        if (gitEntry && await this.isGitEntry(path.join(current, ".git"))) {
          repositories.add(current);
        }

        for (const entry of entries) {
          if (!entry.isDirectory() || skippedDirectories.has(entry.name)) continue;
          queue.push(path.join(current, entry.name));
        }
      }
    };

    await Promise.all(Array.from({ length: 8 }, () => worker()));
    return repositories;
  }

  private getAbsolutePath(vaultRelativePath: string): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error("FileSystemAdapter is required for desktop Git operations");
    }

    return path.join(adapter.getBasePath(), vaultRelativePath);
  }

  private async runGit(args: string[], cwd: string, acceptedExitCodes: number[] = []): Promise<string> {
    try {
      const result = await execFileAsync(this.settings.gitBinary, args, {
        cwd,
        maxBuffer: 50 * 1024 * 1024,
        timeout: Math.max(5, this.settings.gitTimeoutSeconds) * 1000
      });
      return (result.stdout ?? "").toString();
    } catch (error: unknown) {
      const processError = error as { code?: number | string; stdout?: string | Buffer };
      if (typeof processError.code === "number" && acceptedExitCodes.includes(processError.code)) {
        return (processError.stdout ?? "").toString();
      }
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

  private scheduleRefresh(): void {
    if (this.refreshDebounceId !== null) window.clearTimeout(this.refreshDebounceId);
    this.refreshDebounceId = window.setTimeout(() => {
      this.refreshDebounceId = null;
      void this.refreshContext();
    }, 350);
  }

  private parseSettings(raw: unknown): GitPluginSettings {
    const loaded = raw !== null && typeof raw === "object"
      ? raw as Record<string, unknown>
      : {};
    const readNumber = (key: string, fallback: number, min: number, max: number): number => {
      const value = loaded[key];
      return typeof value === "number" && Number.isFinite(value)
        ? Math.min(max, Math.max(min, value))
        : fallback;
    };
    const collapsedSections = { ...DEFAULT_SETTINGS.collapsedSections };
    const savedSections = loaded["collapsedSections"];
    if (savedSections !== null && typeof savedSections === "object") {
      for (const [name, value] of Object.entries(savedSections)) {
        if (typeof value === "boolean") collapsedSections[name] = value;
      }
    }

    const savedGitBinary = loaded["gitBinary"];
    const savedExtraRepos = loaded["extraRepos"];
    return {
      gitBinary: typeof savedGitBinary === "string" && savedGitBinary.trim()
        ? savedGitBinary.trim()
        : DEFAULT_SETTINGS.gitBinary,
      autoRefreshSeconds: readNumber("autoRefreshSeconds", DEFAULT_SETTINGS.autoRefreshSeconds, 2, 30),
      gitTimeoutSeconds: readNumber("gitTimeoutSeconds", DEFAULT_SETTINGS.gitTimeoutSeconds, 5, 120),
      maxVisibleChanges: readNumber("maxVisibleChanges", DEFAULT_SETTINGS.maxVisibleChanges, 50, 1000),
      extraRepos: Array.isArray(savedExtraRepos)
        ? savedExtraRepos.filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim()).filter(Boolean)
        : [],
      collapsedSections
    };
  }

  async loadSettings(): Promise<void> {
    const loaded: unknown = await this.loadData();
    this.settings = this.parseSettings(loaded);
  }

  async saveSettings(resetRefreshTimer = true): Promise<void> {
    await this.saveData(this.settings);
    if (resetRefreshTimer) this.resetAutoRefresh();
  }
}

class GitSettingsTab extends PluginSettingTab {
  plugin: VsCodeLikeGitPlugin;

  constructor(app: App, plugin: VsCodeLikeGitPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions() {
    return [
      {
        name: "Git binary",
        desc: "Path to git executable. Example: git or /usr/bin/git",
        control: { type: "text", key: "gitBinary", placeholder: "git" }
      },
      {
        name: "Auto refresh interval (seconds)",
        desc: "How often to refresh branch and change counts",
        control: { type: "slider", key: "autoRefreshSeconds", min: 2, max: 30, step: 1 }
      },
      {
        name: "Git command timeout (seconds)",
        desc: "Stops a stalled Git process without freezing source control",
        control: { type: "slider", key: "gitTimeoutSeconds", min: 5, max: 120, step: 5 }
      },
      {
        name: "Changes per section",
        desc: "Initial number of file rows rendered in large repositories",
        control: { type: "slider", key: "maxVisibleChanges", min: 50, max: 1000, step: 50 }
      },
      {
        name: "Extra repository roots",
        desc: "One absolute Git worktree root per line, including paths outside the vault. Rebuild the repository index after editing.",
        control: { type: "text", key: "extraRepos" }
      }
    ];
  }

  getControlValue(key: string): unknown {
    switch (key) {
      case "gitBinary": return this.plugin.settings.gitBinary;
      case "autoRefreshSeconds": return this.plugin.settings.autoRefreshSeconds;
      case "gitTimeoutSeconds": return this.plugin.settings.gitTimeoutSeconds;
      case "maxVisibleChanges": return this.plugin.settings.maxVisibleChanges;
      case "extraRepos": return this.plugin.settings.extraRepos.join("\n");
      default: return undefined;
    }
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    switch (key) {
      case "gitBinary":
        if (typeof value !== "string") return;
        this.plugin.settings.gitBinary = value.trim() || DEFAULT_SETTINGS.gitBinary;
        break;
      case "autoRefreshSeconds":
        if (typeof value !== "number") return;
        this.plugin.settings.autoRefreshSeconds = Math.min(30, Math.max(2, value));
        break;
      case "gitTimeoutSeconds":
        if (typeof value !== "number") return;
        this.plugin.settings.gitTimeoutSeconds = Math.min(120, Math.max(5, value));
        break;
      case "maxVisibleChanges":
        if (typeof value !== "number") return;
        this.plugin.settings.maxVisibleChanges = Math.min(1000, Math.max(50, value));
        break;
      case "extraRepos":
        if (typeof value !== "string") return;
        this.plugin.settings.extraRepos = value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
        break;
      default:
        return;
    }
    await this.plugin.saveSettings(key !== "extraRepos");
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

    new Setting(containerEl)
      .setName("Git command timeout (seconds)")
      .setDesc("Stops a stalled Git process without freezing source control")
      .addSlider((slider) =>
        slider
          .setLimits(5, 120, 5)
          .setValue(this.plugin.settings.gitTimeoutSeconds)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.gitTimeoutSeconds = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Changes per section")
      .setDesc("Initial number of file rows rendered in large repositories")
      .addSlider((slider) =>
        slider
          .setLimits(50, 1000, 50)
          .setValue(this.plugin.settings.maxVisibleChanges)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxVisibleChanges = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Extra repository roots")
      .setDesc("One absolute Git worktree root per line. Git actions can modify files outside the vault. Rebuild the index after editing.")
      .addTextArea((text) =>
        text
          .setPlaceholder("/absolute/path/to/repo")
          .setValue(this.plugin.settings.extraRepos.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.extraRepos = value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
            await this.plugin.saveSettings(false);
          })
      )
      .addButton((button) => button
        .setButtonText("Rebuild index")
        .onClick(async () => { await this.plugin.rebuildIndex(); }));
  }
}

export default VsCodeLikeGitPlugin;
