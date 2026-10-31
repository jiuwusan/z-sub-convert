# Source Update Mode Implementation Plan

> **For agentic workers:** superpowers:executing-plans，按用户确认在当前分支实现，不创建分支、不自动提交。

**Goal:** 来源自动/仅手动更新模式，不特殊处理 HTTP 状态码。
**Architecture:** sources.updateMode=auto/manual，缺省读 auto；保存保留/验证字段，按需取缓存时按模式分支，强制更新不受影响。UI 使用“仅手动更新”复选框及模式展示。
**Tech Stack:** Node.js 22、原生后台、node:test。
**Spec:** docs/superpowers/specs/2026-10-31-source-update-mode-design.md

## Global Constraints
- 不针对 403 或其他 HTTP 状态增加策略。
- 仅手动允许复用旧缓存，无缓存不拉取；全部更新仍包含手动来源。
- 切换模式不改变成功时间/缓存 revision；默认兼容 v3。

## Review Focus
- 缺失字段、非法值和 PATCH 保留原选择。
- 无缓存/过期/URL 改动后的手动缓存行为。
- 强制更新失败，及切回自动后的重试。
- 正在执行的更新与模式切换、配置指纹一致性。
- 查看入口/显示与保存、两小时及来源日志回归。

### Task 1
- [x] RED：模式默认/持久化、无缓存、旧缓存、强制/全部更新、失败及切换；实现后端。
### Task 2
- [x] API 回归与编辑复选框/模式展示；更新说明。
### Task 3
- [x] 完整测试、浏览器验证、独立审查、语法/diff 检查。

## 实施记录

- 新增用例 RED→GREEN，完整测试 90 项通过。覆盖默认/缺失字段、非法值、PATCH 保留、重启、无缓存、过期/invalidated 旧缓存、强制/全部更新、403 不特殊处理和模式切换。
- 独立审查未发现实际问题，额外验证缓存读取期间切模式会重读，刷新发起前切模式会由 guard 拦截，上游调用均为零。
- 浏览器验证新建默认 auto、编辑/保存 manual、名称下显示、过期手动缓存返回 stale 且不增加更新记录、无缓存返回 409 且不请求上游；390px 手机弹窗宽 356px，页面无溢出、保存按钮可见。
- 用户补充改为“仅手动更新”复选框，已验证默认不勾选、勾选保存 manual、编辑回显勾选、取消勾选保存 auto；手机页面宽度保持 390px。
- 无新依赖或 Docker COPY 变更，schema v3 兼容，无需重建数据目录。当前 master 工作区，未提交。
