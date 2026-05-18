"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => main_default
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var import_node_child_process = require("node:child_process");
var fs = __toESM(require("node:fs/promises"));
var os = __toESM(require("node:os"));
var path = __toESM(require("node:path"));
var import_node_util = require("node:util");
var execFileAsync = (0, import_node_util.promisify)(import_node_child_process.execFile);
var SOURCE_CONTROL_VIEW_TYPE = "gitus-source-control-view";
var GITUS_ICON = "git-branch";
var DEFAULT_SETTINGS = {
  gitBinary: "git",
  autoRefreshSeconds: 5,
  collapsedSections: {
    "Merge Changes": false,
    "Staged Changes": false,
    "Changes": false,
    "Untracked Files": false
  }
};
function parseDiffHunks(diffOutput) {
  const lines = diffOutput.split("\n");
  const headerLines = [];
  const hunks = [];
  let currentLines = null;
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
function normalizeToPosix(input) {
  return input.split(path.sep).join(path.posix.sep);
}
var CommitMessageModal = class extends import_obsidian.Modal {
  constructor(app, onSubmit) {
    super(app);
    this.onSubmit = onSubmit;
  }
  onOpen() {
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
        new import_obsidian.Notice("Commit message is required");
        return;
      }
      await this.onSubmit(message);
      this.close();
    };
    cancelBtn.onclick = () => this.close();
    input.focus();
  }
};
var ConfirmModal = class extends import_obsidian.Modal {
  constructor(app, message, onConfirm) {
    super(app);
    this.message = message;
    this.onConfirm = onConfirm;
  }
  onOpen() {
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
};
var RepoPickerModal = class extends import_obsidian.Modal {
  constructor(app, repos, onPick) {
    super(app);
    this.repos = repos;
    this.onPick = onPick;
  }
  onOpen() {
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
};
var BranchPickerModal = class extends import_obsidian.Modal {
  constructor(app, branches, onCheckout) {
    super(app);
    this.branches = branches;
    this.onCheckout = onCheckout;
  }
  onOpen() {
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
        new import_obsidian.Notice("Branch name is required");
        return;
      }
      await this.onCheckout(name, false);
      this.close();
    };
    createBtn.onclick = async () => {
      const name = input.value.trim();
      if (!name) {
        new import_obsidian.Notice("Branch name is required");
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
};
var StashModal = class extends import_obsidian.Modal {
  constructor(app, repoRoot, plugin) {
    super(app);
    this.repoRoot = repoRoot;
    this.plugin = plugin;
    this.titleEl.setText("Stash");
  }
  async onOpen() {
    await this.renderContent();
  }
  async renderContent() {
    const { contentEl } = this;
    contentEl.empty();
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
      await this.plugin.runGitPublic(args, this.repoRoot);
      new import_obsidian.Notice("Stash saved");
      await this.plugin.refreshContext();
      await this.renderContent();
    };
    pushStagedBtn.onclick = async () => {
      const msg = msgInput.value.trim();
      const args = msg ? ["stash", "push", "--staged", "-m", msg] : ["stash", "push", "--staged"];
      await this.plugin.runGitPublic(args, this.repoRoot);
      new import_obsidian.Notice("Staged changes stashed");
      await this.plugin.refreshContext();
      await this.renderContent();
    };
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
        new import_obsidian.Notice(`Popped stash@{${stash.index}}`);
        await this.plugin.refreshContext();
        await this.renderContent();
      };
      const applyBtn = rowActions.createEl("button", { text: "Apply" });
      applyBtn.onclick = async () => {
        await this.plugin.runGitPublic(["stash", "apply", `stash@{${stash.index}}`], this.repoRoot);
        new import_obsidian.Notice(`Applied stash@{${stash.index}}`);
        await this.plugin.refreshContext();
        await this.renderContent();
      };
      const dropBtn = rowActions.createEl("button", { text: "Drop" });
      dropBtn.addClass("vlg-btn-danger");
      dropBtn.onclick = async () => {
        await this.plugin.runGitPublic(["stash", "drop", `stash@{${stash.index}}`], this.repoRoot);
        new import_obsidian.Notice(`Dropped stash@{${stash.index}}`);
        await this.renderContent();
      };
    }
  }
  async loadStashes() {
    try {
      const raw = await this.plugin.runGitPublic(["stash", "list"], this.repoRoot);
      return raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0).map((label, index) => ({ index, label }));
    } catch {
      return [];
    }
  }
};
var CommitHistoryModal = class extends import_obsidian.Modal {
  constructor(app, repoRoot, plugin) {
    super(app);
    this.repoRoot = repoRoot;
    this.plugin = plugin;
    this.titleEl.setText("Commit History");
  }
  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    let raw;
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
};
var ConflictResolverModal = class extends import_obsidian.Modal {
  constructor(app, repoRoot, filePath, plugin) {
    super(app);
    this.repoRoot = repoRoot;
    this.filePath = filePath;
    this.plugin = plugin;
    this.titleEl.setText(`Resolve conflict: ${filePath}`);
  }
  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    const absPath = path.join(this.repoRoot, this.filePath);
    let content;
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
  async applyResolution(content, choice) {
    const resolved = resolveConflictMarkers(content, choice);
    const absPath = path.join(this.repoRoot, this.filePath);
    await fs.writeFile(absPath, resolved, "utf8");
    await this.plugin.stageRepoFile(this.repoRoot, this.filePath);
    new import_obsidian.Notice(`Resolved with ${choice} and staged`);
    this.close();
  }
};
function parseConflictMarkers(content) {
  const oursLines = [];
  const theirsLines = [];
  let state = "normal";
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
function resolveConflictMarkers(content, choice) {
  const lines = content.split("\n");
  const result = [];
  let state = "normal";
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
var HunkPickerModal = class extends import_obsidian.Modal {
  constructor(app, hunks, patchHeader, title, actionLabel, onApply) {
    super(app);
    this.hunks = hunks;
    this.patchHeader = patchHeader;
    this.titleEl.setText(title);
    this.actionLabel = actionLabel;
    this.onApply = onApply;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    const selected = new Set(this.hunks.map((h) => h.index));
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
      const diffLines = hunk.content.split("\n").slice(1);
      for (const diffLine of diffLines.slice(0, 12)) {
        if (!diffLine) continue;
        const span = pre.createEl("span");
        span.setText(diffLine + "\n");
        if (diffLine.startsWith("+")) span.addClass("vlg-hunk-add");
        else if (diffLine.startsWith("-")) span.addClass("vlg-hunk-del");
      }
      if (diffLines.length > 13) {
        pre.createEl("span", { text: `\u2026 (${diffLines.length - 12} more lines)`, cls: "vlg-hunk-more" });
      }
    }
    const actions = contentEl.createDiv({ cls: "vlg-actions" });
    const applyBtn = actions.createEl("button", { text: this.actionLabel });
    const cancelBtn = actions.createEl("button", { text: "Cancel" });
    applyBtn.onclick = async () => {
      if (selected.size === 0) {
        new import_obsidian.Notice("Select at least one hunk");
        return;
      }
      const selectedHunks = this.hunks.filter((h) => selected.has(h.index));
      const patch = this.patchHeader + selectedHunks.map((h) => h.content).join("");
      try {
        await this.onApply(patch);
        this.close();
      } catch (err) {
        new import_obsidian.Notice(`Failed to apply patch: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    cancelBtn.onclick = () => this.close();
  }
};
var SourceControlView = class extends import_obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.collapsedSections = /* @__PURE__ */ new Map();
    this.lastRenderKey = "";
    this.bodyEl = null;
    this.headlineEl = null;
    this.statsEl = null;
    this.commitInputEl = null;
    this.commitBtnEl = null;
    this.plugin = plugin;
  }
  getViewType() {
    return SOURCE_CONTROL_VIEW_TYPE;
  }
  getDisplayText() {
    return "GItUS Source Control";
  }
  getIcon() {
    return GITUS_ICON;
  }
  async onOpen() {
    this.containerEl.addClass("vlg-sc-view");
    this.initializeSectionCollapseState();
    await this.render();
  }
  async onClose() {
    this.containerEl.empty();
  }
  async render() {
    const snapshot = await this.plugin.getActiveRepoSnapshot();
    const key = this.buildSnapshotKey(snapshot);
    if (key === this.lastRenderKey) return;
    this.lastRenderKey = key;
    const wrap = this.containerEl.children[1];
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
        wrap.createEl("p", { text: "No active Git repository context." });
        return;
      }
      const panelTitle = wrap.createEl("h4", {
        text: "SOURCE CONTROL",
        cls: "vlg-panel-title"
      });
      panelTitle.setAttr("aria-label", "Source Control");
      const header = wrap.createDiv({ cls: "vlg-sc-header" });
      this.headlineEl = header.createEl("div", {
        text: `${snapshot.repoName} \u2022 ${snapshot.status.branch}`,
        cls: "vlg-repo-headline"
      });
      const actions = header.createDiv({ cls: "vlg-sc-actions" });
      const refreshBtn = actions.createEl("button", { text: "Refresh" });
      const undoBtn = actions.createEl("button", { text: "Undo" });
      undoBtn.setAttr("title", "Undo last commit (--soft)");
      const pullBtn = actions.createEl("button", { text: "Pull" });
      const pushBtn = actions.createEl("button", { text: "Push" });
      const stashBtn = actions.createEl("button", { text: "Stash" });
      const historyBtn = actions.createEl("button", { text: "History" });
      const branchBtn = actions.createEl("button", { text: "Branch" });
      const switchBtn = actions.createEl("button", { text: "Switch Repo" });
      refreshBtn.onclick = async () => {
        await this.plugin.refreshContext(true);
        await this.render();
      };
      undoBtn.onclick = async () => {
        await this.plugin.undoLastCommit();
        await this.render();
      };
      pullBtn.onclick = async () => {
        await this.plugin.pullCurrentRepo();
        await this.render();
      };
      pushBtn.onclick = async () => {
        await this.plugin.pushCurrentRepo();
        await this.render();
      };
      stashBtn.onclick = async () => {
        await this.plugin.openStashModal();
      };
      historyBtn.onclick = async () => {
        await this.plugin.openHistoryModal();
      };
      branchBtn.onclick = async () => {
        await this.plugin.checkoutOrCreateBranch();
        await this.render();
      };
      switchBtn.onclick = async () => {
        await this.plugin.switchRepositoryContext();
        await this.render();
      };
      const commitArea = wrap.createDiv({ cls: "vlg-commit-area" });
      const ta = commitArea.createEl("textarea");
      ta.placeholder = "Message (Ctrl+Enter to commit)";
      ta.addClass("vlg-commit-input");
      this.commitInputEl = ta;
      const commitBtn = commitArea.createEl("button");
      commitBtn.addClass("vlg-commit-btn");
      commitBtn.disabled = true;
      this.commitBtnEl = commitBtn;
      ta.addEventListener("input", () => {
        if (this.commitBtnEl) {
          this.commitBtnEl.disabled = ta.value.trim().length === 0;
        }
      });
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          this.commitBtnEl?.click();
        }
      });
      commitBtn.onclick = async () => {
        const msg = ta.value.trim();
        if (!msg) {
          new import_obsidian.Notice("Enter a commit message");
          return;
        }
        const snap = await this.plugin.getActiveRepoSnapshot();
        if (!snap) return;
        await this.plugin.commitWithMessage(snap.repoRoot, msg);
        ta.value = "";
        if (this.commitBtnEl) this.commitBtnEl.disabled = true;
        await this.render();
      };
      this.statsEl = wrap.createEl("p", { cls: "vlg-sc-stats" });
      this.bodyEl = wrap.createDiv({ cls: "vlg-sc-body" });
    }
    if (!snapshot) return;
    if (this.headlineEl) {
      this.headlineEl.setText(`${snapshot.repoName} \u2022 ${snapshot.status.branch}`);
    }
    if (this.commitBtnEl) {
      this.commitBtnEl.setText(`Commit to "${snapshot.status.branch}"`);
    }
    if (this.statsEl) {
      this.statsEl.setText(
        `Staged ${snapshot.status.staged} | Unstaged ${snapshot.status.unstaged} | Untracked ${snapshot.status.untracked} | Conflicts ${snapshot.status.conflicts} | \u2191${snapshot.status.ahead} \u2193${snapshot.status.behind}`
      );
    }
    const body = this.bodyEl;
    body.empty();
    if (snapshot.changes.length === 0) {
      body.createEl("p", { text: "Working tree clean." });
      return;
    }
    const displayChanges = this.buildDisplayChanges(snapshot.changes);
    const conflictChanges = displayChanges.filter((change) => change.mode === "conflict");
    const stagedChanges = displayChanges.filter((change) => change.mode === "staged");
    const unstagedChanges = displayChanges.filter((change) => change.mode === "unstaged");
    const untrackedChanges = displayChanges.filter((change) => change.mode === "untracked");
    this.renderChangeSection(body, snapshot.repoRoot, "Merge Changes", conflictChanges);
    this.renderChangeSection(body, snapshot.repoRoot, "Staged Changes", stagedChanges);
    this.renderChangeSection(body, snapshot.repoRoot, "Changes", unstagedChanges);
    this.renderChangeSection(body, snapshot.repoRoot, "Untracked Files", untrackedChanges);
  }
  buildSnapshotKey(snapshot) {
    if (!snapshot) return "__empty__";
    const collapsed = [...this.collapsedSections.entries()].map(([k, v]) => `${k}:${v}`).join(",");
    const changes = snapshot.changes.map((c) => `${c.x}${c.y}${c.path}${c.staged}${c.unstaged}${c.untracked}${c.conflicted}`).join("|");
    return `${snapshot.repoRoot}||${snapshot.status.branch}||${snapshot.status.ahead}:${snapshot.status.behind}||${changes}||${collapsed}`;
  }
  renderChangeSection(list, repoRoot, title, changes) {
    const section = list.createDiv({ cls: "vlg-change-section" });
    const isCollapsed = this.collapsedSections.get(title) ?? false;
    const titleRow = section.createDiv({ cls: "vlg-change-section-head" });
    const toggle = titleRow.createEl("button", {
      text: isCollapsed ? `\u25B8 ${title} (${changes.length})` : `\u25BE ${title} (${changes.length})`,
      cls: "vlg-change-section-toggle"
    });
    toggle.onclick = async () => {
      const nextCollapsed = !isCollapsed;
      this.collapsedSections.set(title, nextCollapsed);
      await this.plugin.setSectionCollapsed(title, nextCollapsed);
      await this.render();
    };
    const sectionActions = titleRow.createDiv({ cls: "vlg-change-section-actions" });
    if (title === "Changes" || title === "Untracked Files") {
      const stageAllBtn = sectionActions.createEl("button", { text: "Stage All" });
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
      const unstageAllBtn = sectionActions.createEl("button", { text: "Unstage All" });
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
      const diffBtn = rowActions.createEl("button", { text: "Diff" });
      diffBtn.onclick = async () => {
        await this.plugin.showDiffForRepoFile(
          repoRoot,
          change.path,
          change.mode === "staged"
        );
      };
      if (change.mode === "unstaged" || change.mode === "untracked") {
        const stageBtn = rowActions.createEl("button", { text: "Stage" });
        stageBtn.onclick = async () => {
          await this.plugin.stageRepoFile(repoRoot, change.path);
          await this.render();
        };
        if (change.mode === "unstaged") {
          const stageHunksBtn = rowActions.createEl("button", { text: "Stage Hunks\u2026" });
          stageHunksBtn.onclick = async () => {
            await this.plugin.openHunkStageModal(repoRoot, change.path);
            await this.render();
          };
        }
        const discardBtn = rowActions.createEl("button", { text: "Discard" });
        discardBtn.addClass("vlg-btn-danger");
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
        const unstageBtn = rowActions.createEl("button", { text: "Unstage" });
        unstageBtn.onclick = async () => {
          await this.plugin.unstageRepoFile(repoRoot, change.path);
          await this.render();
        };
        const unstageHunksBtn = rowActions.createEl("button", { text: "Unstage Hunks\u2026" });
        unstageHunksBtn.onclick = async () => {
          await this.plugin.openHunkUnstageModal(repoRoot, change.path);
          await this.render();
        };
        const revertBtn = rowActions.createEl("button", { text: "Revert" });
        revertBtn.addClass("vlg-btn-danger");
        revertBtn.onclick = async () => {
          await this.plugin.revertRepoFileToHead(repoRoot, change.path);
          await this.render();
        };
      }
      if (change.mode === "conflict") {
        const resolveBtn = rowActions.createEl("button", { text: "Resolve\u2026" });
        resolveBtn.onclick = async () => {
          await this.plugin.openConflictResolverModal(repoRoot, change.path);
          await this.render();
        };
        const markBtn = rowActions.createEl("button", { text: "Mark Resolved" });
        markBtn.onclick = async () => {
          await this.plugin.stageRepoFile(repoRoot, change.path);
          await this.render();
        };
      }
    }
  }
  initializeSectionCollapseState() {
    if (this.collapsedSections.size > 0) {
      return;
    }
    const persisted = this.plugin.getCollapsedSections();
    this.collapsedSections.set("Merge Changes", persisted["Merge Changes"] ?? false);
    this.collapsedSections.set("Staged Changes", persisted["Staged Changes"] ?? false);
    this.collapsedSections.set("Changes", persisted["Changes"] ?? false);
    this.collapsedSections.set("Untracked Files", persisted["Untracked Files"] ?? false);
  }
  buildDisplayChanges(changes) {
    const result = [];
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
};
var VsCodeLikeGitPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.statusBarEl = null;
    this.currentRepoRoot = null;
    this.currentFile = null;
    this.refreshTimerId = null;
    this.repoRegistry = /* @__PURE__ */ new Set();
    this.manualRepoRoot = null;
  }
  async onload() {
    await this.loadSettings();
    this.registerView(
      SOURCE_CONTROL_VIEW_TYPE,
      (leaf) => new SourceControlView(leaf, this)
    );
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("vlg-status");
    this.addRibbonIcon(
      GITUS_ICON,
      "GItUS: Open Source Control view",
      async () => {
        await this.activateSourceControlView();
      }
    );
    this.addSettingTab(new GitSettingsTab(this.app, this));
    this.registerCommands();
    this.registerEvent(
      this.app.workspace.on("file-open", async (file) => {
        this.currentFile = file instanceof import_obsidian.TFile ? file : null;
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
  onunload() {
    if (this.refreshTimerId !== null) {
      window.clearInterval(this.refreshTimerId);
      this.refreshTimerId = null;
    }
    this.app.workspace.detachLeavesOfType(SOURCE_CONTROL_VIEW_TYPE);
  }
  registerCommands() {
    this.addCommand({
      id: "gitus-refresh-context",
      name: "Refresh context",
      callback: async () => {
        await this.refreshContext(true);
      }
    });
    this.addCommand({
      id: "gitus-open-source-control",
      name: "Open Source Control view",
      callback: async () => {
        await this.activateSourceControlView();
      }
    });
    this.addCommand({
      id: "gitus-switch-repository-context",
      name: "Switch repository context",
      callback: async () => {
        await this.switchRepositoryContext();
      }
    });
    this.addCommand({
      id: "gitus-clear-repository-context",
      name: "Clear manual repository context",
      callback: async () => {
        this.manualRepoRoot = null;
        await this.refreshContext(true);
      }
    });
    this.addCommand({
      id: "gitus-stage-current-file",
      name: "Stage current file",
      callback: async () => {
        await this.stageCurrentFile();
      }
    });
    this.addCommand({
      id: "gitus-unstage-current-file",
      name: "Unstage current file",
      callback: async () => {
        await this.unstageCurrentFile();
      }
    });
    this.addCommand({
      id: "gitus-show-current-file-diff",
      name: "Show diff for current file",
      callback: async () => {
        await this.showCurrentFileDiff();
      }
    });
    this.addCommand({
      id: "gitus-commit-current-repo",
      name: "Commit in current repo",
      callback: async () => {
        await this.commitCurrentRepo();
      }
    });
    this.addCommand({
      id: "gitus-pull-current-repo",
      name: "Pull in current repo",
      callback: async () => {
        await this.pullCurrentRepo();
      }
    });
    this.addCommand({
      id: "gitus-push-current-repo",
      name: "Push in current repo",
      callback: async () => {
        await this.pushCurrentRepo();
      }
    });
    this.addCommand({
      id: "gitus-checkout-branch",
      name: "Checkout or create branch",
      callback: async () => {
        await this.checkoutOrCreateBranch();
      }
    });
    this.addCommand({
      id: "gitus-rebuild-repository-index",
      name: "Rebuild repository index",
      callback: async () => {
        await this.rebuildRepoRegistry();
        await this.refreshContext(true);
      }
    });
  }
  async stageCurrentFile() {
    const context = await this.requireContext();
    if (!context) {
      return;
    }
    await this.runGit(["add", "--", context.repoRelativeFile], context.repoRoot);
    this.repoRegistry.add(context.repoRoot);
    new import_obsidian.Notice("Staged current file");
    await this.refreshContext();
  }
  async unstageCurrentFile() {
    const context = await this.requireContext();
    if (!context) {
      return;
    }
    await this.runGit(["restore", "--staged", "--", context.repoRelativeFile], context.repoRoot);
    this.repoRegistry.add(context.repoRoot);
    new import_obsidian.Notice("Unstaged current file");
    await this.refreshContext();
  }
  async showCurrentFileDiff() {
    const context = await this.requireContext();
    if (!context) {
      return;
    }
    await this.showDiffForRepoFile(context.repoRoot, context.repoRelativeFile);
  }
  getCollapsedSections() {
    return this.settings.collapsedSections;
  }
  async setSectionCollapsed(sectionName, collapsed) {
    this.settings.collapsedSections[sectionName] = collapsed;
    await this.saveData(this.settings);
  }
  async showDiffForRepoFile(repoRoot, repoRelativeFile, preferCached = false) {
    const primaryArgs = preferCached ? ["diff", "--cached", "--", repoRelativeFile] : ["diff", "--", repoRelativeFile];
    const fallbackArgs = preferCached ? ["diff", "--", repoRelativeFile] : ["diff", "--cached", "--", repoRelativeFile];
    const primary = await this.runGit(primaryArgs, repoRoot);
    if (primary.trim()) {
      const suffix2 = preferCached ? "(cached)" : "";
      this.openDiffModal(repoRelativeFile, primary, suffix2);
      return;
    }
    const fallback = await this.runGit(fallbackArgs, repoRoot);
    if (!fallback.trim()) {
      new import_obsidian.Notice("No changes for selected file");
      return;
    }
    const suffix = preferCached ? "(working tree)" : "(cached)";
    this.openDiffModal(repoRelativeFile, fallback, suffix);
  }
  async stageRepoFile(repoRoot, repoRelativeFile) {
    await this.runGit(["add", "--", repoRelativeFile], repoRoot);
    this.repoRegistry.add(repoRoot);
    new import_obsidian.Notice(`Staged ${repoRelativeFile}`);
    await this.refreshContext();
  }
  async discardRepoFileChanges(repoRoot, repoRelativeFile, isUntracked) {
    const message = isUntracked ? `Discard untracked file ${repoRelativeFile}? This will delete the file from disk.` : `Discard local changes for ${repoRelativeFile}?`;
    new ConfirmModal(this.app, message, async () => {
      if (isUntracked) {
        await this.runGit(["clean", "-f", "--", repoRelativeFile], repoRoot);
      } else {
        await this.runGit(["restore", "--", repoRelativeFile], repoRoot);
      }
      new import_obsidian.Notice(`Discarded changes for ${repoRelativeFile}`);
      await this.refreshContext();
    }).open();
  }
  async stageRepoFiles(repoRoot, repoRelativeFiles) {
    if (repoRelativeFiles.length === 0) {
      return;
    }
    await this.runGit(["add", "--", ...repoRelativeFiles], repoRoot);
    this.repoRegistry.add(repoRoot);
    new import_obsidian.Notice(`Staged ${repoRelativeFiles.length} files`);
    await this.refreshContext();
  }
  async unstageRepoFile(repoRoot, repoRelativeFile) {
    await this.runGit(["restore", "--staged", "--", repoRelativeFile], repoRoot);
    this.repoRegistry.add(repoRoot);
    new import_obsidian.Notice(`Unstaged ${repoRelativeFile}`);
    await this.refreshContext();
  }
  async revertRepoFileToHead(repoRoot, repoRelativeFile) {
    const message = `Revert all changes for ${repoRelativeFile} to HEAD?`;
    new ConfirmModal(this.app, message, async () => {
      await this.runGit(
        ["restore", "--source=HEAD", "--staged", "--worktree", "--", repoRelativeFile],
        repoRoot
      );
      new import_obsidian.Notice(`Reverted ${repoRelativeFile} to HEAD`);
      await this.refreshContext();
    }).open();
  }
  async unstageRepoFiles(repoRoot, repoRelativeFiles) {
    if (repoRelativeFiles.length === 0) {
      return;
    }
    await this.runGit(["restore", "--staged", "--", ...repoRelativeFiles], repoRoot);
    this.repoRegistry.add(repoRoot);
    new import_obsidian.Notice(`Unstaged ${repoRelativeFiles.length} files`);
    await this.refreshContext();
  }
  async commitWithMessage(repoRoot, message) {
    const snapshot = await this.getRepoSnapshot(repoRoot);
    if (snapshot.status.staged === 0) {
      new import_obsidian.Notice("No staged changes. Stage files before commit.");
      return;
    }
    await this.runGit(["commit", "-m", message], repoRoot);
    new import_obsidian.Notice("Commit finished");
    await this.refreshContext();
  }
  async undoLastCommit() {
    const repoRoot = await this.resolveActiveRepoRoot();
    if (!repoRoot) {
      new import_obsidian.Notice("No active Git repository found");
      return;
    }
    new ConfirmModal(this.app, "Undo last commit? Changes will be kept staged (--soft).", async () => {
      await this.runGit(["reset", "--soft", "HEAD~1"], repoRoot);
      new import_obsidian.Notice("Last commit undone (changes kept staged)");
      await this.refreshContext();
    }).open();
  }
  async openStashModal() {
    const repoRoot = await this.resolveActiveRepoRoot();
    if (!repoRoot) {
      new import_obsidian.Notice("No active Git repository found");
      return;
    }
    new StashModal(this.app, repoRoot, this).open();
  }
  async openHistoryModal() {
    const repoRoot = await this.resolveActiveRepoRoot();
    if (!repoRoot) {
      new import_obsidian.Notice("No active Git repository found");
      return;
    }
    new CommitHistoryModal(this.app, repoRoot, this).open();
  }
  async openConflictResolverModal(repoRoot, filePath) {
    new ConflictResolverModal(this.app, repoRoot, filePath, this).open();
  }
  /** Exposed for use by Modals that need to run git commands. */
  async runGitPublic(args, cwd) {
    return this.runGit(args, cwd);
  }
  async openHunkStageModal(repoRoot, filePath) {
    const diffOutput = await this.runGit(["diff", "--", filePath], repoRoot);
    if (!diffOutput.trim()) {
      new import_obsidian.Notice("No unstaged changes to stage by hunk");
      return;
    }
    const { patchHeader, hunks } = parseDiffHunks(diffOutput);
    if (hunks.length === 0) {
      new import_obsidian.Notice("No hunks found in diff");
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
        new import_obsidian.Notice(`Staged selected hunks in ${filePath}`);
        await this.refreshContext();
      }
    ).open();
  }
  async openHunkUnstageModal(repoRoot, filePath) {
    const diffOutput = await this.runGit(["diff", "--cached", "--", filePath], repoRoot);
    if (!diffOutput.trim()) {
      new import_obsidian.Notice("No staged changes to unstage by hunk");
      return;
    }
    const { patchHeader, hunks } = parseDiffHunks(diffOutput);
    if (hunks.length === 0) {
      new import_obsidian.Notice("No hunks found in diff");
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
        new import_obsidian.Notice(`Unstaged selected hunks in ${filePath}`);
        await this.refreshContext();
      }
    ).open();
  }
  async applyPatchCached(repoRoot, patch, reverse = false) {
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
      try {
        await fs.rm(tmpPath);
      } catch {
      }
    }
  }
  async commitCurrentRepo() {
    const repoRoot = await this.resolveActiveRepoRoot();
    if (!repoRoot) {
      new import_obsidian.Notice("No active Git repository found");
      return;
    }
    const snapshot = await this.getRepoSnapshot(repoRoot);
    if (snapshot.status.staged === 0) {
      new import_obsidian.Notice("No staged changes. Stage files before commit.");
      return;
    }
    new CommitMessageModal(this.app, async (message) => {
      await this.runGit(["commit", "-m", message], repoRoot);
      new import_obsidian.Notice("Commit finished");
      await this.refreshContext();
    }).open();
  }
  async pullCurrentRepo() {
    const repoRoot = await this.resolveActiveRepoRoot();
    if (!repoRoot) {
      new import_obsidian.Notice("No active Git repository found");
      return;
    }
    const snapshot = await this.getRepoSnapshot(repoRoot);
    if (snapshot.status.unstaged > 0 || snapshot.status.untracked > 0) {
      new ConfirmModal(
        this.app,
        "Working tree has local changes. Continue pull anyway?",
        async () => {
          await this.runGit(["pull"], repoRoot);
          new import_obsidian.Notice("Pull finished");
          await this.refreshContext();
        }
      ).open();
      return;
    }
    await this.runGit(["pull"], repoRoot);
    new import_obsidian.Notice("Pull finished");
    await this.refreshContext();
  }
  async pushCurrentRepo() {
    const repoRoot = await this.resolveActiveRepoRoot();
    if (!repoRoot) {
      new import_obsidian.Notice("No active Git repository found");
      return;
    }
    const snapshot = await this.getRepoSnapshot(repoRoot);
    if (snapshot.status.unstaged > 0 || snapshot.status.untracked > 0) {
      new ConfirmModal(
        this.app,
        "Working tree has unstaged or untracked changes. Continue push anyway?",
        async () => {
          await this.runGit(["push"], repoRoot);
          new import_obsidian.Notice("Push finished");
          await this.refreshContext();
        }
      ).open();
      return;
    }
    await this.runGit(["push"], repoRoot);
    new import_obsidian.Notice("Push finished");
    await this.refreshContext();
  }
  async checkoutOrCreateBranch() {
    const repoRoot = await this.resolveActiveRepoRoot();
    if (!repoRoot) {
      new import_obsidian.Notice("No active Git repository found");
      return;
    }
    const branchesRaw = await this.runGit(["branch", "--list"], repoRoot);
    const branches = branchesRaw.split("\n").map((line) => line.replace(/^\*/, "").trim()).filter((line) => line.length > 0).sort((a, b) => a.localeCompare(b));
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
      new import_obsidian.Notice(`Checked out ${branchName}`);
      await this.refreshContext(true);
    }).open();
  }
  async requireContext() {
    if (!this.currentFile) {
      new import_obsidian.Notice("Open a note first");
      return null;
    }
    const repoRoot = await this.resolveRepoRootForCurrentFile();
    if (!repoRoot) {
      new import_obsidian.Notice("Current file is not inside a Git repository");
      return null;
    }
    const absFilePath = this.getAbsolutePath(this.currentFile.path);
    const repoRelativeFile = normalizeToPosix(path.relative(repoRoot, absFilePath));
    return { repoRoot, repoRelativeFile };
  }
  async refreshContext(manual = false) {
    try {
      const repoRoot = await this.resolveActiveRepoRoot();
      this.currentRepoRoot = repoRoot;
      if (!repoRoot) {
        this.setStatusBarText("GItUS: no repo");
        return;
      }
      const status = (await this.getRepoSnapshot(repoRoot)).status;
      const repoName = path.basename(repoRoot);
      this.repoRegistry.add(repoRoot);
      const manualTag = this.manualRepoRoot ? " [manual]" : "";
      this.setStatusBarText(
        `GItUS ${repoName}:${status.branch} S${status.staged} U${status.unstaged} ?${status.untracked} C${status.conflicts} \u2191${status.ahead} \u2193${status.behind}${manualTag}`
      );
      if (manual) {
        new import_obsidian.Notice(`Repo: ${repoName} (${status.branch})`);
      }
      await this.refreshSourceControlView();
    } catch (error) {
      this.setStatusBarText("GItUS: error");
      new import_obsidian.Notice(`Git refresh failed: ${this.toErrorMessage(error)}`);
    }
  }
  setStatusBarText(text) {
    if (this.statusBarEl) {
      this.statusBarEl.setText(text);
    }
  }
  async getRepoSnapshot(repoRoot) {
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
  async getAheadBehind(repoRoot) {
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
  async getActiveRepoSnapshot() {
    const repoRoot = await this.resolveActiveRepoRoot();
    if (!repoRoot) {
      return null;
    }
    return this.getRepoSnapshot(repoRoot);
  }
  async resolveRepoRootForCurrentFile() {
    if (!this.currentFile) {
      return null;
    }
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof import_obsidian.FileSystemAdapter)) {
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
  async resolveActiveRepoRoot() {
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
  async findNearestRepo(vaultRoot, startDir) {
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
      if (parent === current || !current.startsWith(vaultRootResolved)) {
        return null;
      }
      current = parent;
    }
  }
  async isGitEntry(gitEntryPath) {
    try {
      const stat2 = await fs.stat(gitEntryPath);
      if (stat2.isDirectory()) {
        return true;
      }
      if (!stat2.isFile()) {
        return false;
      }
      const content = await fs.readFile(gitEntryPath, "utf8");
      return content.trimStart().startsWith("gitdir:");
    } catch {
      return false;
    }
  }
  parsePorcelainChanges(porcelain) {
    const lines = porcelain.split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 2);
    const changes = [];
    for (const line of lines) {
      const x = line[0] ?? " ";
      const y = line[1] ?? " ";
      let filePath = line.slice(3).trim();
      if (filePath.includes(" -> ")) {
        const parts = filePath.split(" -> ");
        filePath = parts[parts.length - 1] ?? filePath;
      }
      const untracked = x === "?" && y === "?";
      const conflicted = !untracked && (x === "U" || y === "U" || x === "A" && y === "A" || x === "D" && y === "D" || x === "A" && y === "D" || x === "D" && y === "A");
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
  openDiffModal(filePath, diffText, titleSuffix = "") {
    const modal = new import_obsidian.Modal(this.app);
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
  async activateSourceControlView() {
    let leaf = this.app.workspace.getLeavesOfType(SOURCE_CONTROL_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: SOURCE_CONTROL_VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    await this.refreshSourceControlView();
  }
  async refreshSourceControlView() {
    const leaves = this.app.workspace.getLeavesOfType(SOURCE_CONTROL_VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof SourceControlView) {
        await view.render();
      }
    }
  }
  async switchRepositoryContext() {
    await this.rebuildRepoRegistry();
    const repos = [...this.repoRegistry].sort((a, b) => a.localeCompare(b));
    if (repos.length === 0) {
      new import_obsidian.Notice("No repository found in vault index");
      return;
    }
    new RepoPickerModal(this.app, repos, async (repoRoot) => {
      this.manualRepoRoot = repoRoot;
      await this.refreshContext(true);
    }).open();
  }
  async rebuildRepoRegistry() {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof import_obsidian.FileSystemAdapter)) {
      return;
    }
    const basePath = adapter.getBasePath();
    const markdownFiles = this.app.vault.getMarkdownFiles();
    const dirCache = /* @__PURE__ */ new Map();
    const nextRegistry = /* @__PURE__ */ new Set();
    for (const file of markdownFiles) {
      const absPath = this.getAbsolutePath(file.path);
      const dir = path.dirname(absPath);
      let repoRoot = dirCache.get(dir);
      if (repoRoot === void 0) {
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
  getAbsolutePath(vaultRelativePath) {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof import_obsidian.FileSystemAdapter)) {
      throw new Error("FileSystemAdapter is required for desktop Git operations");
    }
    return path.join(adapter.getBasePath(), vaultRelativePath);
  }
  async runGit(args, cwd) {
    try {
      const result = await execFileAsync(this.settings.gitBinary, args, {
        cwd,
        maxBuffer: 10 * 1024 * 1024
      });
      return (result.stdout ?? "").toString();
    } catch (error) {
      const message = this.toErrorMessage(error);
      throw new Error(`git ${args.join(" ")} failed: ${message}`);
    }
  }
  async runGitWithFallback(primaryArgs, fallbackArgs, cwd) {
    try {
      return await this.runGit(primaryArgs, cwd);
    } catch {
      return this.runGit(fallbackArgs, cwd);
    }
  }
  toErrorMessage(error) {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
  resetAutoRefresh() {
    if (this.refreshTimerId !== null) {
      window.clearInterval(this.refreshTimerId);
      this.refreshTimerId = null;
    }
    const seconds = Math.max(2, this.settings.autoRefreshSeconds);
    this.refreshTimerId = window.setInterval(() => {
      void this.refreshContext();
    }, seconds * 1e3);
    this.registerInterval(this.refreshTimerId);
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
    this.resetAutoRefresh();
  }
};
var GitSettingsTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new import_obsidian.Setting(containerEl).setName("Git binary").setDesc("Path to git executable. Example: git or /usr/bin/git").addText(
      (text) => text.setPlaceholder("git").setValue(this.plugin.settings.gitBinary).onChange(async (value) => {
        this.plugin.settings.gitBinary = value.trim() || "git";
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Auto refresh interval (seconds)").setDesc("How often to refresh branch and change counts").addSlider(
      (slider) => slider.setLimits(2, 30, 1).setValue(this.plugin.settings.autoRefreshSeconds).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.autoRefreshSeconds = value;
        await this.plugin.saveSettings();
      })
    );
  }
};
var main_default = VsCodeLikeGitPlugin;
