# Git Us 冗余内容审计

## 项目概述

Git Us 是一个桌面端 Obsidian Git 插件，提供接近 VS Code Source Control 的仓库发现、暂存、撤销、提交、分支、Stash、冲突处理和历史记录体验。

本次按单用户、多个仓库、数百到数千个变更文件的规模评估，重点检查可以删除或合并的重复内容，以及清理可能带来的兼容性风险。

## Must fix

没有发现必须立即删除的死代码、无用依赖或明显废弃文件。

## Should fix

### 1. `styles.css` 存在大量重复选择器

**What this is**

同一选择器在文件中定义两到三次。例如：

- `.vlg-diff`：`styles.css:62`、`styles.css:1063`
- `.vlg-sc-actions`：`styles.css:117`、`styles.css:731`、`styles.css:1146`
- `.vlg-change-row`：`styles.css:317`、`styles.css:913`
- `.vlg-commit-area`：`styles.css:430`、`styles.css:805`

**Problem**

后面的规则会覆盖前面的规则，导致修改前面的样式却看不到效果。这也可能是当前多个 `!important` 出现的原因之一。

**Fix**

把每个组件的基础样式合并到一个位置，只保留状态、窄屏和主题差异覆盖。预计可以安全删除约 150 至 250 行 CSS。

**If skip**

当前功能仍能运行，但 UI 调整很容易出现“改了不生效”、主题差异和回归问题。

### 2. 提交按钮状态判断重复

**What this is**

提交输入变化时在 `main.ts:955` 计算一次按钮状态，视图刷新后又在 `main.ts:1002` 执行近似相同的计算。

**Problem**

提交条件以后增加 amend、冲突状态或 detached HEAD 限制时，两处逻辑容易不同步。

**Fix**

提取一个很小的 `updateCommitButtonState()`，由输入事件和刷新逻辑共同调用。这里不需要引入额外状态管理。

**If skip**

代码量影响很小，但后续修改提交规则时存在按钮状态错误风险。

### 3. 核心解析器没有测试保护

**What this is**

以下边界敏感逻辑目前没有测试覆盖：

- Diff hunk 解析：`main.ts:127`
- 冲突标记解析：`main.ts:617`
- Git porcelain 状态解析：`main.ts:2211`

**Problem**

清理重复逻辑或拆分 `main.ts` 时，重命名、复制、特殊文件名、无尾换行和异常冲突标记可能静默回归。

**Fix**

只给这三个纯解析器增加一组小型表格测试，不需要为 UI 建立完整测试体系。

**If skip**

CSS 清理不受影响，但不建议顺手重构 Git 解析逻辑。

## Nice to have

### 4. 设置界面存在有意的双实现

**What this is**

新版本在 `main.ts:2492` 使用 `getSettingDefinitions()`，旧版本在 `main.ts:2551` 继续使用命令式 `display()`。

**Problem**

相同设置项维护两遍，大约占用 80 至 110 行。

**Fix**

目前不要删除，因为 `minAppVersion` 是 `1.7.2`。只有决定将最低版本提升至支持声明式设置 API 的版本后，才删除旧 `display()` 实现。

**If skip**

只是维护成本稍高，不影响功能。这是兼容性代码，不是无用代码。

### 5. `CommitMessageModal` 与面板提交框功能重叠

**What this is**

旧命令在 `main.ts:172` 使用独立提交弹窗，Source Control 面板在 `main.ts:940` 已有完整提交输入区域。

**Problem**

提交输入体验存在两条实现路径。

**Fix**

如果允许调整旧命令行为，可以让命令打开 Source Control 面板并聚焦提交框，随后删除弹窗约 40 行。当前弹窗仍有调用方，因此不是死代码。

**If skip**

没有稳定性风险，只是两套提交入口需要同步维护。

## 应当保留

- `RepoPickerModal` 和无仓库页面的仓库列表服务于不同场景，不值得强行抽象。
- Stage 与 unstage 虽然结构相似，但 Git 参数和错误语义不同，合并收益有限。
- Validate 与 Release workflow 的少量重复不值得提取 reusable workflow。
- `main.ts` 虽然有 2612 行，但拆文件只改变代码位置，不减少代码，不应作为减法目标。

## 结论

最值得处理的是 CSS 重复块；其余重复大多是兼容性代码或不同交互入口。建议做一次小范围减法，不建议重写架构。

在不改变现有行为的前提下，预计可减少约 160 至 260 行。如果未来放弃旧版 Obsidian 和旧提交弹窗，可再减少约 120 至 150 行。

## 未检查与风险

本次没有修改业务代码，也没有运行构建或测试。最大风险是项目没有解析器测试，清理时应避免顺手改动 Git 状态解析。
