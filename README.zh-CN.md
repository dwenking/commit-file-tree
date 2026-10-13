<!-- markdownlint-disable MD013 MD033 MD041 -->

<div align="center">

<img src="icon.png" alt="Commit Review Tree logo" width="128" />

# Commit Review Tree

### 像人工审 PR 一样审查 AI 生成的提交，不用离开 Cursor / VS Code。

编程 agent 在你的仓库里干完活，会留下一堆本地提交：中途的修修补补、大面积的文件改动，偶尔还有你根本没要求的修改。Commit Review Tree 把这堆提交变成一个可以审查的整体：未推送的改动以清晰的文件树呈现，并附带审查工具，让你检查、批注，再把结果直接交还给 agent。

[![VS Marketplace](https://img.shields.io/badge/VS%20Marketplace-Install-007ACC?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=dwenking.commit-file-tree)
[![Open VSX](https://img.shields.io/open-vsx/v/dwenking/commit-file-tree?label=Open%20VSX)](https://open-vsx.org/extension/dwenking/commit-file-tree)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/dwenking/commit-file-tree?label=Open%20VSX%20Downloads)](https://open-vsx.org/extension/dwenking/commit-file-tree)
[![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A5%201.80-007ACC?logo=visualstudiocode&logoColor=white)](#系统要求)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**4 种视图 · 行评论与备注 · 越界改动标记 · 按轮次审查 · 一键导出给 agent**

<p align="center">
  <b>语言：</b>
  <a href="README.md">English</a> |
  <a href="README.zh-CN.md">简体中文</a>
</p>

</div>

---

## 为什么用 Commit Review Tree？

Source Control 告诉你*哪些改动还没提交*，Graph 告诉你*有哪些提交*。但审查者真正关心的问题，它们都回答不了：agent 总共改了什么？碰了哪些不该碰的东西？上一轮让它改的，它改了没有？

| 能力                         | 只用 Source Control + Graph | Commit Review Tree |
| ---------------------------- | :-------------------------: | :----------------: |
| 未推送的提交以文件树展示     |             否              |         是         |
| 多个提交的最终结果合成一棵树 |             否              |         是         |
| 按导入关系排列改动的文件     |             否              |         是         |
| 在任意提交的 diff 上写行评论 |             否              |         是         |
| 重载后仍保留的"已审"标记     |             否              |         是         |
| 标记 lockfile、CI、env、删除 |             否              |         是         |
| 把反馈导出为 agent 可执行的指令 |          否              |         是         |
| 跟踪 agent 处理了哪些反馈    |             否              |         是         |

> **提示：** 想看最终结果用 **Combined**，想跟着 agent 一步步看用 **By commits**，想先审底层、再审调用方用 **By dependencies**。

---

## 亮点

<table>
<tr>
<td width="50%" valign="top">

<h3>未推送的改动优先</h3>

只列出还没推送到远端的本地提交，每个都带 `+新增 −删除` 行数。未提交的改动显示在最上方的 **Working tree** 一行。

</td>
<td width="50%" valign="top">

<h3>四种视图</h3>

By commits、Combined、By dependencies 和 Comments，在标题栏一键切换，当前视图显示在标题旁。

</td>
</tr>
<tr>
<td width="50%" valign="top">

<h3>像审 PR 一样审查</h3>

在 diff 行号旁写 GitHub 风格的行评论，给文件或文件夹加备注，标记"已审"，一键在同一个标签页里打开整个提交的 diff。

</td>
<td width="50%" valign="top">

<h3>越界改动标记</h3>

删除、lockfile、CI 配置、env 文件、构建配置会带 ⚠ 和原因标出，专门对付"改了你没让它改的东西"这类常见问题。

</td>
</tr>
<tr>
<td width="50%" valign="top">

<h3>导出给 agent</h3>

所有评论和备注汇总成一份待办式 markdown 报告，复制到剪贴板，并写入 `.commit-review/latest.md` 供 agent 读取。

</td>
<td width="50%" valign="top">

<h3>按轮次审查</h3>

每次导出就是一轮。最新一轮把每条反馈标为 ✅（代码之后改过）或 ⏳（还没改）。

</td>
</tr>
</table>

---

## 目录

- [工作原理](#工作原理)
- [视图](#视图)
- [功能](#功能)
- [导出格式](#导出格式)
- [系统要求](#系统要求)
- [安装](#安装)
- [快速上手](#快速上手)
- [配置](#配置)
- [命令](#命令)
- [数据与隐私](#数据与隐私)
- [常见问题](#常见问题)
- [许可证](#许可证)

---

## 工作原理

整个插件围绕一个循环：**审查 → 评论 → 导出 → agent 修改 → 检查**。

1. **审查**
   用合适的视图打开未推送的改动：按提交、合并成一棵树，或按依赖关系。越界标记会指出超出预期范围的改动。

2. **评论**
   在任意 diff 里写行评论，或给整个文件、文件夹加备注。边看边标记"已审"。

3. **导出**
   一键把所有反馈整理成 markdown 报告，复制到剪贴板，并写入 `.commit-review/latest.md`。你的评论会归入一个已导出的轮次，下一轮从零开始。

4. **agent 修改**
   把报告粘贴到 agent 对话里，或者直接让 agent 读这个文件。

5. **检查**
   在 **Comments** 视图里，最新一轮的每条反馈都会标为 ✅（导出后代码改过，无论是否已提交）或 ⏳（还没改）。点击任意一条可跳到对应代码行。

---

## 视图

| 视图                | 显示内容                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **By commits**      | 每个未推送的提交都能展开成它自己的文件夹树。最上方的 **Working tree** 一行是未提交的改动。                                                      |
| **Combined**        | 所有未推送提交的*最终*结果合成一棵树。agent 提交了十次中间版本、你只关心最终结果时最合适。                                                       |
| **By dependencies** | 按导入关系排列改动的文件（`↑N` 表示被 N 个改动文件导入），先审底层。没有任何导入关系的文件归入 "Standalone files"。**Search files…** 一行可按名称模糊查找任意文件。 |
| **Comments**        | 按轮次的总览：最上面是可编辑的 **Current round**，下面是所有已导出的轮次，最新的在前。                                                          |

**Combined** 和 **By dependencies** 共用树顶部的 **Include uncommitted changes** 复选框（默认勾选）。取消勾选就只看已提交的改动。

依赖分析基于启发式规则，支持 JS/TS/Vue/Svelte、Python、Java/Kotlin/Scala、Go、Rust、C/C++、C#、Ruby 和 PHP。

---

## 功能

### 看清 agent 到底做了什么

- **未推送的改动优先**：只显示还没推送到远端的本地提交（`@{upstream}..HEAD`）。远端历史收在 "Show pushed history…" 后面；展开后，"Hide pushed history" 就在本地提交和已推送提交的分界处。
- **Working tree**：未提交的改动（已暂存、未暂存、未跟踪）作为一行显示在提交上方，与 HEAD 对比，agent 的改动在提交前就能审查。
- **按文件在视图间跳转**：右键文件 → **Reveal in Dependency View**，会切换视图、从根部展开它的导入链并选中它。
- **在依赖树里查找文件**：**Search files…** 一行会打开按类名或文件名的模糊搜索，无论文件藏在多深的折叠链里都能定位。
- **越界改动标记**：删除、lockfile、CI 配置、env 文件、构建配置会带 ⚠ 和原因标出。
- **原生风格**：SCM 状态颜色和徽标、紧凑文件夹、未推送提交带蓝点。

### 像审 PR 一样审查

- **一键审查整个提交**：鼠标移到提交行上，点多文件 diff 按钮，所有文件的 diff 会堆叠在同一个标签页里打开。
- **GitHub 风格的行评论**：点 diff 行号旁的 "+" 给光标所在行写评论，或选中多行对整段写评论。评论绑定到不可变的提交上，不会错位，重载后仍在，并在树里显示为 💬 计数。
- **"已审"标记**：边看边标记；已审的文件会变暗并带 ✓，审查中断后可以从停下的地方继续。
- **文件和文件夹备注**：行评论不够用时，给整个文件或文件夹加一条备注（📝）。
- **diff 始终正确**：重命名、新增、删除的文件，以及根提交都能正确打开 diff。

### 管理你的反馈

- **Comments 视图**：这一轮写的所有内容，按路径分组。鼠标悬停可看引用的代码和完整内容，点击跳到对应行，用行内的 ✏️ / 🗑 按钮修改或删除。
- **已导出的轮次**：每次导出都会出现一个轮次；点击可打开当时写出的 markdown 文件。
- **归档旧轮次**：行内的 Archive 按钮会把某一轮收进折叠的 "Archived rounds" 组里，随时可以取消归档。

### 把反馈交还给 agent

- **导出审查报告**：把所有行评论（附引用的代码）、备注和标记汇总成待办式报告。对改动范围之外的文件的评论（比如"这个文件也应该改"）会单独成节，你写的东西一条都不会丢。
- **按轮次审查**：导出时，已交付的反馈会归入一个已导出的轮次，并保留一份带时间戳的副本（`.commit-review/2026-09-24_1608.md`）。下一次导出的报告会以 **Previous round** 清单开头。
- **撤销**：导出后提示框里的 "Undo Export"，或命令面板里的 "Restore Last Exported Round"，会把上一轮放回当前轮。
- **回滚提交**：右键 → revert（确认后创建一个撤销提交），用于根本不该存在的改动。

---

## 导出格式

报告读起来是指令，而不是一段描述。下面是一个简化示例：

````markdown
# Code review feedback (a1b2c3d..e4f5a6b)

## 🔁 Previous round

- [x] ✅ src/api/client.ts:42 — do not hardcode the timeout
- [ ] ⏳ src/api/retry.ts — rewrite with backoff

## 🎯 Action items (3)

### 📁 src/legacy/ (folder)

This whole folder should not change in this task.

### 💬 src/api/client.ts:58-61

```
if (!res.ok) return null;
```
Throw instead of swallowing the error.

### 📝 package.json

Revert the dependency bump.
````

| 标记                            | 含义                                               |
| ------------------------------- | -------------------------------------------------- |
| 💬                              | 行评论，附引用的代码                               |
| 📝                              | 文件备注                                           |
| 📁                              | 文件夹备注                                         |
| `[x] ✅` / `[ ] ⏳`             | 上一轮的条目：导出后代码改过 / 还没改              |
| 🌐 Comments outside this change | 对未推送范围之外文件的反馈                         |

---

## 系统要求

- **VS Code 1.80 或更高版本**，或基于它的编辑器（Cursor 及其他使用 Open VSX 的编辑器）
- `PATH` 中可以找到 **Git**
- 以 Git 仓库作为工作区文件夹打开

---

## 安装

- **VS Code**：从 [Marketplace](https://marketplace.visualstudio.com/items?itemName=dwenking.commit-file-tree) 安装，或在命令面板运行 `ext install dwenking.commit-file-tree`。
- **Cursor 及其他使用 Open VSX 的编辑器**：在扩展面板搜索 *Commit Review Tree*，或从 [Open VSX](https://open-vsx.org/extension/dwenking/commit-file-tree) 安装。

---

## 快速上手

1. 打开 **Source Control** 侧边栏（`Cmd/Ctrl+Shift+G`）。
2. 在内置的 Changes / Graph 区域下方找到 **COMMIT REVIEW TREE** 区域。它可能折叠在最底部，点击标题展开，或把标题拖到上面固定位置。
3. 点击提交行展开它的文件树。鼠标悬停可看到 review-all 和 revert 按钮，右键可复制或回滚。
4. 用这个区域标题栏上的按钮切换视图。

---

## 配置

| 设置项                      | 默认值                     | 说明                                                                                                                                  |
| --------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `commitFileTree.exportPath` | `.commit-review/latest.md` | **Export Review Summary** 额外写出报告的路径（相对仓库根目录），方便 agent 读取。通过 `.git/info/exclude` 排除在 git 之外。留空则只复制到剪贴板。 |

---

## 命令

标题栏按钮和命令面板中的命令：

| 命令                                            | 说明                                       |
| ----------------------------------------------- | ------------------------------------------ |
| View by Commits                                 | 切换到按提交的视图                         |
| View All Unpushed Changes as One Tree           | 切换到 Combined 视图                       |
| View by Dependencies                            | 切换到依赖视图                             |
| View Review Comments                            | 切换到 Comments 视图                       |
| Export Review Summary (copy for AI)             | 导出所有反馈，并开始新的一轮               |
| Review All Changes                              | 在同一个多文件 diff 标签页里打开所有未推送改动 |
| Refresh                                         | 刷新树                                     |
| Commit Review Tree: Restore Last Exported Round | 把上一个已导出的轮次放回当前轮             |
| Commit Review Tree: Clear All Review Data       | 删除所有评论、备注、轮次和"已审"标记       |

行内操作（评论、备注、标记已审、回滚、复制、归档、编辑、删除）以行内按钮和右键菜单的形式出现。

---

## 数据与隐私

- 评论、备注、"已审"标记和轮次保存在编辑器的工作区存储中，只在你的电脑上。每个 worktree 文件夹各有一份。
- 不会向任何地方发送数据。插件只运行本地 `git` 命令，没有遥测。
- 导出的报告写在你的仓库里，并通过 `.git/info/exclude` 排除在 git 之外；不会改动你的 `.gitignore`。

---

## 常见问题

<details>
<summary><strong>我删掉了 <code>.commit-review/</code> 下的文件，为什么轮次还在？</strong></summary>

这些文件只是写给 agent 看的副本，插件不会读回来。轮次保存在编辑器的工作区存储中。运行 **Commit Review Tree: Clear All Review Data** 可以全部删除，也可以把不再需要的轮次归档。

</details>

<details>
<summary><strong>Combined 视图显示的提交太多（或太少）。</strong></summary>

"未推送"指上游分支之后的提交。没有上游分支时，插件依次退而使用：最近一个已在任意远端上的提交；与本地 `main`/`master` 的分叉点；整个历史。

</details>

<details>
<summary><strong>为什么某个文件不在依赖链里？</strong></summary>

依赖分析是对 import 语句的启发式分析。没有检测到任何关系的文件会列在 "Standalone files" 下。用 **Search files…** 一行可以找到任意改动的文件。

</details>

---

## 许可证

[MIT](LICENSE)
