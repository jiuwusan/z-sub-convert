# 分层架构与项目开发规范 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for tightly coupled migration and delegate independent tooling/documentation and gateway extraction. Each delegated change receives review before final verification.

**Goal:** 将扁平模块重构为可检查的分层架构，并建立完整项目开发规范。

**Architecture:** 见 docs/architecture.md。保留原生 HTTP/CommonJS，用组合根注入服务及外部依赖，分离路由、控制器、中间件、业务、网络、存储与纯领域函数。

**Tech Stack:** Node.js 22+、yaml、node:test；开发依赖仅用于静态质量检查。

**Spec:** docs/architecture.md 和本次用户请求。

## Global Constraints

- 当前 master 分支工作，不创建分支/worktree，不自动提交或推送。
- 全部接口、状态文件 v3、缓存、DNS、通知、部署兼容；public 保持原生浏览器脚本，不改 UI。
- 根目录只保留启动/工程配置，测试引用迁移后的实际模块，不建立大量兼容转发文件。
- 低层不依赖高层；所有错误集中定义；避免循环依赖；领域无 I/O；service 无 HTTP/磁盘操作。

## Review Focus

- 路由认证和 CSRF 执行顺序、限流和错误响应与原行为一致。
- 路径不因 src 层级变化而偏移；真实启动和 Docker 加载有效。
- 来源缓存写入失败不发提醒、完整/旧缓存兼容、并发刷新合并及配置变更竞态保持。
- Webhook 签名、发送失败隔离与跨午夜/08:00 门槛保持。
- 规范检查覆盖实际源码且能在 PR 运行，工具测试验证违规依赖和循环可被拒绝。

## Tasks / Ledger

- [x] 1. 先记录 179 项测试基线，将纯模块/服务/持久化/网关移到 src，集中 errors，更新测试依赖。
- [x] 2. 分离缓存仓储与订阅解析领域；分离通知 domain 和 Webhook gateway，保持注入与行为。
- [x] 3. 提取 config、bootstrap、转换 service、controllers、routes、middleware，让入口只负责组合和启动。
- [x] 4. 制定 AGENTS.md、docs/development.md、编辑与换行规范、lint、架构检查、npm check 和 PR CI。
- [x] 5. 全量测试、真实启动/容器模拟、工程检查与独立审查；修复后再次验证并交付未提交变更。

Ruling: 用户已明确授权重构，目录拆分与工具选择作为常规可逆实现决策直接执行；现有全局规则禁止新建分支/worktree。

Ruling: 不为目录层级引入框架、数据库、TypeScript 或前端构建流程，降低接口和部署风险。

Validation: 重构前 179 项测试通过；新增架构检查器合成图测试、Webhook 固定签名和错误边界测试、认证状态断言及异工作目录真实启动测试。完成独立整体审查，未发现重要回归。最终使用 npm run check 验证。当前环境无 Docker CLI，容器验证为基于 Dockerfile/COPY/.dockerignore 的运行目录组装和 require 加载，不声称实际构建了镜像。
