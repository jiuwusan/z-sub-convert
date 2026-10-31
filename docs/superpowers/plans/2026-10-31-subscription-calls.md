# Subscription Calls Implementation Plan

> **For agentic workers:** superpowers:executing-plans，当前分支直接实现，用户已确认保留 3 天且后台下载不计入，不再询问执行方式。

**Goal:** 公开系统订阅 GET/HEAD 的三天持久调用记录及后台分页查看。

**Architecture:** 独立 call-records.js 按订阅/日期追加 JSONL，单订阅队列避免写入、清理、删除竞态；server.js 记录处理结果，admin-api.js 只读分页；Managed 删除时清理日志。

**Tech Stack:** Node.js 22、原生 fs、node:test、现有 HTML/CSS/JS。

**Spec:** docs/superpowers/specs/2026-10-31-subscription-calls-design.md

## Global Constraints
- 72 小时滚动保留，无条数上限；后台下载和非法 key 不计入。
- 日志不包含 key/URL/正文；失败不影响订阅响应。
- 当前分支、不自动提交；不改变 schema 或网络缓存策略。

## Review Focus
- 200 次以上、UTC 边界和恰好 72 小时的记录。
- 并发追加/清理/删除、重启读取及损坏尾行。
- GET、HEAD、上游失败、模板失败与记录失败的响应行为。
- 鉴权、分页边界、敏感字段及客户端伪造代理头。
- 弹窗导航和注销竞态、窄屏、操作列宽度及 Docker COPY。

### Task 1: 日志存储
- [x] RED：保留时长、超过 200 条、重启、并发、过期清理、删除和坏行；实现 CallRecords 并通过测试。

### Task 2: 调用与 API
- [x] RED：GET/HEAD 成败记录，下载不计入，分页/鉴权/删除及日志失败不影响响应；实现服务端与 Docker 打包。

### Task 3: 页面与验证
- [x] 调用记录按钮/弹窗、分页/刷新及导航保护；更新说明。
- [x] 浏览器验证正常/空/失败记录与窄屏，独立代码审查。
- [x] 完整测试、语法和 diff 检查；保持未提交。

## 实施记录

- 完整测试 83 项通过，新增用例均先观察失败后实现；220 条记录无截断，72 小时边界、持久化、并发/删除、破损尾行、关闭时排队写入等均验证。
- 独立审查两个 P2 已修复：响应完成/关闭后追加，避免日志队列阻塞响应及中断状态错误；请求层只对发起时仍匹配的会话/导航处理 401，避免旧请求注销新会话。对应测试 RED→GREEN。
- 服务端记录方式的实施调整：从“发送前等待磁盘”改为 finish/close 事件异步追加，耗时包含响应完成/连接关闭，正常请求只记一次，中断记 499；日志耗时不影响订阅返回。
- 浏览器另发现关闭再立即重开弹窗时旧 close 事件会清除新视图，已补回归并修复；关闭后切换页面，延迟返回不重开弹窗/填充旧记录。
- 浏览器 125 条分页为 50/50/25，上一页/下一页边界、空记录、GET/HEAD、失败原因正常；1440px 桌面和 390px 手机弹窗不溢出页面，手机仅内容横向滚动、底部按钮可见。
- Docker COPY 输入包含 call-records.js；本机未执行 Docker 镜像构建。当前 master 工作区，未提交。
