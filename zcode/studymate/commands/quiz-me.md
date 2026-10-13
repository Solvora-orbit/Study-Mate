---
description: StudyMate 现场考核：按当前/指定节点出题，用可运行证据核验并更新学习进度
argument-hint: "[科目或节点，可留空取当前节点]"
skills: learning-system
---

以 `${CLAUDE_PLUGIN_ROOT}/skills/learning-system/SKILL.md` 的总控身份进入考核评估流程，范围：$ARGUMENTS（留空取当前节点）。

按该技能与 `practice-evaluator` 的规范现场出题；编程类题目用 Bash 实际运行交付物核验，按结果更新「学习进度」与学习记录，遵循「ZCode 宿主约定」。
