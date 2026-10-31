# Remove Failover Implementation Plan

> **For agentic workers:** superpowers:executing-plans，在当前分支实现，不自动提交。

**Goal:** 单系统订阅可选移除顶层故障转移组，生成有效且引用一致的配置。
**Architecture:** transformConfig 增加可选 removeFailover 参数；Managed 保存/读取默认值并纳入配置指纹；订阅编辑复选框及列表简要显示。
**Tech Stack:** Node.js 22、原生后台、node:test。
**Spec:** docs/superpowers/specs/2026-10-31-remove-failover-design.md

## Global Constraints
- 默认保留，不改变共享模板/缓存；国家 fallback 组保留。
- 原模板校验不放宽；公开订阅和下载一致。
## Review Focus
- 组成员去重、模板自有成员及无关组保留。
- 规则/no-resolve、子规则、DNS 片段和 dialer 引用，不改凭据。
- 默认/旧记录、PATCH 保留、非法值、重启持久化。
- 模式切换不重新拉取有效来源，请求期间切换使用最新配置。
- 浏览器保存回显和手机展示。

### Task 1
- [x] RED：转换保留/移除与引用处理；实现转换选项。
### Task 2
- [x] RED：保存、读取、HTTP/下载与并发切换；实现后端。
### Task 3
- [x] 复选框、说明、浏览器与完整测试，独立审查，保持未提交。

## Verification
- `npm test`：96/96 通过；三个修改的运行时 JS 语法检查及 `git diff --check` 通过。
- 独立审查发现的 src 参数和 SUB-RULE 标识误改问题已先补失败用例，再修正通过。
- 隔离浏览器验证：新增默认关闭、启用保存回显、公开结果移除、取消后恢复；国家 fallback 保留。有效来源缓存仅拉取一次。
- 1366px 桌面及 390px 手机验证，手机弹窗宽 356px，文档无横向溢出。
