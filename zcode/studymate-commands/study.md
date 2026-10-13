---
description: StudyMate 学习总控入口：开新课、继续学习、查进度、贴课文提问
argument-hint: "[学习目标 / 科目名 / '继续'，可留空]"
skills: learning-system
---

按 `${CLAUDE_PLUGIN_ROOT}/skills/learning-system/SKILL.md` 作为学习系统总控执行本次请求：$ARGUMENTS

- 参数为空时先按该技能的「会话开场」恢复进度或开始盘问。
- 学习工作区与宿主能力按其「ZCode 宿主约定」一节执行；角色调度用 Agent 工具按该技能的派发规范进行。
