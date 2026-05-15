# Codex 设置页与设计系统构造（仓库内可追溯依据）

本文说明 **Codex 桌面应用「设置」相关界面在设计系统里的位置**，以及如何把它映射到本项目 `src/theme/tokens.css`。依据来自本仓库对 Codex.app 打包产物的静态扫描：`codex-css-tokens.css` / `codex-css-tokens.json`（见 `codex-css-tokens.md`），以及对整体 UI 分层已有文档：`codex-ui-framework-notes.md`。

## 结论摘要

Codex 的 Renderer 并非单独造一套「设置页设计语言」，而是在 **Electron + React/Vite Shell** 之上，叠加 **一套与 VS Code Webview 相近的主题变量**，设置类控件大量使用 `--vscode-settings-*` 系列 token，再与通用语义色（如 `--color-background-elevated-primary`、`--color-border-focus`）组合。观感上更接近 **VS Code 设置编辑器：分组、行式列表、elevated 输入背景、行间 hover**，而不是零散卡片拼装。

---

## 1. 层级：Codex UI 里「设置页」在哪儿

按 `codex-ui-framework-notes.md` 的五层拆分，设置页落在：

| 层级 | 与设置页的关系 |
|------|----------------|
| 桌面窗口层 | 与设置内容弱相关（安全区、拖拽区） |
| **App Shell** | 路由/入口切换：从顶栏或侧栏打开「设置」，主 viewport 载入对应模块 |
| **Design System** | **设置页的边框、文本、输入、行 hover、焦点环**全部由 token / 适配变量驱动 |
| Command | 「打开设置」等动作走统一 command（与按钮、快捷键一致） |
| Runtime Bridge | 真实业务设置项会与本地持久化或主进程 IPC 对齐（本项目为 `getSettings` / `saveSettings`） |

因此：**设置页是 Design System + Shell 的产物**，核心是 token 与行式控件模式，而非单独一套视觉草稿。

---

## 2. 设计系统在 CSS 里的构造方式

从 `codex-css-tokens.css` 的类目统计（摘录见 `codex-css-tokens.md`）可知，变量数量最多的是 **`vscode-theme-adapter`** —— Codex 用大量 `--vscode-*` 把编辑器/工作台主题「桥接」到 Web 控件上，设置界面是其中一环。

可以理解为三层（与 `codex-ui-framework-notes.md` 第七章一致，这里落到「设置」场景）：

1. **Primitive**：灰阶、字号步进、spacing、radius 等裸值。
2. **语义色 / 语义面**：例如 `--color-text-foreground`、`--color-border`、`--color-background-elevated-primary`。
3. **组件 / 编辑器适配**：设置专用 `--vscode-settings-*`，把语义色具体到「设置行」「文本框」「下拉」等控件。

---

## 3. 与「设置」直接相关的 Codex token 示例

以下内容直接摘自本仓库 `codex-css-tokens.css`（由 Codex Renderer 打包 CSS 逆向汇总，**语义与 VS Code Settings UI 对齐**）。

| Token | 在设计中的含义 |
|-------|----------------|
| `--vscode-settings-headerForeground` | 分组标题文本 |
| `--vscode-settings-headerBorder` | 分组与内容之间的分隔观感 |
| `--vscode-settings-textInputBackground` / `Border` / `Foreground` | 设置项内联文本框的外观 |
| `--vscode-settings-dropdownBackground` / `Border` / `Foreground` | 下拉类设置控件 |
| `--vscode-settings-checkboxBackground` / `Border` | 勾选类设置控件 |
| `--vscode-settings-rowHoverBackground` | 设置列表行悬浮 |
| `--vscode-settings-focusedRowBackground` | 键盘焦点所在行底色 |
| `--vscode-settings-focusedRowBorder` | 焦点行边框 / 指示（常接 `--color-border-focus`） |

这些变量在 Codex 里通常再 **引用语义层**，例如输入背景落在 `elevated-primary`、边框落在 `color-border`、`focus` 落在 `color-border-focus` —— 形成「语义 → VS Code 设置控件」的链路。

---

## 4. 设置页的交互与布局范式（观感层面）

基于上述 token 的职责，可把 Codex/VS Code 式「设置编辑器」归纳为：

1. **主表面扁平**：整块内容铺在 `--color-token-main-surface-primary`（或 Codex 的 surface 等价物）上，不靠厚重外框界定页面。
2. **分组**：每一类配置有简短 **分组标题**（对应 `*-headerForeground` / `*-headerBorder`）。
3. **列表行**：多行条目共享同一容器时，行间有 **分界**（细边框或分割线），行上 **hover**、**焦点**用 `*-rowHoverBackground` / `*-focusedRow*`。
4. **控件区域略「抬起」**：文本输入等使用略高于底色的背景（elevated），与只读正文区分层次。
5. **模式选择**：二进制/少量枚举有时呈现为 **并排分段控件**（segmented），与整页卡片二选一区分开，更贴合工作台密度。

以上为从 token 命名的**可推断行为规范**；若在本地安装 Codex.app，还可以在运行态对照具体 DOM，但源码不在本仓库内。

---

## 5. 与本项目 `tokens.css` 的对齐关系

本项目维护精简版语义 token（`src/theme/tokens.css`），命名以 `--color-token-*` 为主，**没有逐字复制全套 `--vscode-settings-*`**。对标方式建议如下：

| Codex / VS Code 设置语义 | 本项目优先使用的变量 |
|--------------------------|----------------------|
| 主内容底 | `--color-token-main-surface-primary` |
| 主文案 / 次级文案 | `--color-token-text-primary` / `--color-token-text-secondary`，说明可用 `--color-token-description-foreground` |
| 通用边框 | `--color-token-border`、`--color-token-border-heavy` |
| 焦点 | `--color-focus-border` |
| 行 hover / 浅色抬升 | `--color-token-list-hover-background`、`color-mix` 微调分组背景 |
| 输入控件 | `--color-token-input-*` |

因此：**理念上对齐 Codex（VS Code adapter + 分层 token），实现上使用本仓库已有的精简 token**，在设置页样式里显式沿用「分组 + 分段 + grouped rows」结构即可。

---

## 参考文件

- `codex-css-tokens.md` — 摘录范围与体量说明  
- `codex-css-tokens.css` — 完整变量清单（含 `--vscode-settings-*`）  
- `codex-ui-framework-notes.md` — Shell、主题与 token 总则  
- `src/theme/tokens.css` — 本项目落地 token  
- `src/components/SettingsPage.tsx` — 本项目设置页结构与文案  
