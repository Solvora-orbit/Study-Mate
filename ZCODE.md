# StudyMate · ZCode 分发层（本 fork 自维护）

这里是把上游 [Miaotofu01/Study-Mate](https://github.com/Miaotofu01/Study-Mate)（原 DSH 插件）移植成 **ZCode 插件**的整套分发层，并把 [sorrowKnight123/video-to-skill](https://github.com/sorrowKnight123/video-to-skill-)（B 站网课蒸馏）一并 vendor 进来。**上游源文件一律不动**；所有新增内容都在 `zcode/`、根 `marketplace.json` 与本文件的 workflow 里。

## 目录

```
marketplace.json                      ← 生成物：ZCode 插件市场目录（两个插件条目）
zcode/
├── VERSION                           ← studymate 插件版本（CI 自动 patch bump）
├── BUILD-CONFIG.json                 ← fork/仓库名等构建参数
├── studymate/                        ← 构建产物：ZCode 插件本体（勿手改）
├── studymate-commands/               ← 手写命令源（study / quiz-me），构建时拷入插件
├── vendor/bilibili-persona/          ← video-to-skill 整体 vendor（GPL-3.0 独立插件）
└── scripts/                          ← 构建器、版本器、vendor 同步器
.github/workflows/zc-*.yml            ← 同步与构建自动化
```

## 移植怎么做的（为什么可靠）

- 技能转换**复用上游自己的无头宿主兼容层** `bin/openai-skill-compat.mjs`（`adaptOpenAiSkill`）：它把 16 个 `studymate_*` 原生工具逐一翻译成本宿主做得到的做法，重写总控编排，移除 DSH 专属 frontmatter/路径。其 `replaceRequired` 在上游文案漂移时会**直接抛错**——这是第一道护栏。
- 构建器 `zcode/scripts/build-zcode-plugin.mjs` 在其上叠加 ZCode 覆写：宿主名替换 + 一份「ZCode 工具对照」（Read/Write/Edit/Bash/Agent/AskUserQuestion/WebFetch/visualize 的映射，网络操作只允许 http/https，并在发请求前拒绝 localhost、环回、私有与保留地址）。
- 第二道护栏：产物扫描——`SKILL.md` 与 `commands` 里出现残留的 `studymate_*`、`.dsh/`、`DSH_HOME`、安装器占位符即构建失败；`docs/规范/文件归属.md` 必须存在（技能里的 `<root>/docs` 指针靠它兑现）。
- 与上游 Codex 产物同口径：`schemas/`、`templates/`、`docs/`、`skills/<名>/references` 里的说明性提及（如 `tools.md` 的宿主差异表）只警告不拦截。

## 日常维护（全自动链路）

1. `zc-sync-upstream`（每日）：上游 Study-Mate 有新提交 → 开/刷新同步 PR。**你合并它**。
2. `zc-build-studymate`：main 变化 → 重建插件；产物有实质变化才 patch bump 并发布（幂等，无变化不产 commit）。
3. `zc-sync-video`（每日）：video-to-skill 上游变化 → vendor 刷新 + bump + PR。
4. ZCode 端：设置 → 插件管理 → 发现 → 刷新市场 → 插件详情点「更新」（官方机制只有这两步是手动的）。

## 安装

ZCode → 设置 → 插件管理 → 发现 → `+` → 添加插件市场，粘贴本仓库地址：

```
https://github.com/<你的账号>/Study-Mate-zcode
```

安装 `studymate`（12 个学习技能 + `/study`、`/quiz-me`）与 `bilibili-persona`（`/learn-course`）。

依赖（仅 bilibili-persona 的本地转写路径需要）：`uv pip install faster-whisper pypdf yt-dlp` + `ffmpeg`；纯用 B 站原生字幕时无需任何依赖。学习数据默认写入 `~/StudyMate`。

## 许可

上游 Study-Mate 为 MIT；vendored 的 bilibili-persona 为 GPL-3.0，两者在本市场里是**独立插件条目**（各自保留原许可，见各自目录内 LICENSE）。构建产物中的 `zcode/studymate` 继承 MIT 并注明上游。
