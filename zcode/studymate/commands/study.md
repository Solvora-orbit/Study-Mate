---
description: StudyMate 学习总控入口：开新课、继续学习、查进度、贴课文提问
argument-hint: "[学习目标 / 科目名 / '继续'，可留空]"
skills: learning-system
---

用 `learning-system` skill 作为学习系统总控处理本次请求：

$ARGUMENTS

- 参数为空时先按该 skill 的「会话开场」恢复进度或开始盘问；带目标直接开课时按「新科目盘问」补齐信息。
- 学习工作区与宿主能力按该 skill 的「ZCode 宿主约定」一节执行；需要课程设计、讲解、采图、练习评估等角色时按其派发规范串行执行（本宿主没有原生工具，校验逐项自查）。
