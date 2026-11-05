# 来源 DNS 策略 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 来源节点按各自 DNS 解析，导入来源 DNS 策略并排除来源本地 DNS。

**Architecture:** 新增 source-dns.js，集中处理 DNS 地址过滤与策略合并；解析器保留所需来源 DNS 字段，缓存读取和两个转换入口传递 sourceDns 数组，转换时结合来源节点生成策略。不改变现有 nameserver 选择逻辑。

**Tech Stack:** CommonJS、Node.js、yaml、node:test，无新增依赖。

**Spec:** 本次用户要求（1）来源 proxy-server-nameserver 用于节点域名策略，127.0.0.1:端口替换成同源 nameserver；（2）导入两个 policy，排除本地地址。

## Global Constraints

- 当前分支开发，不创建分支/worktree，不自动提交或推送。
- 模板同名策略优先，来源显式策略次之（来源先到先得），自动节点策略最后；通配显式策略覆盖到的域名不再新增更具体的自动策略。
- 混合地址列表逐项替换本地 proxy-server-nameserver 地址为同源 nameserver，过滤备用中的本地地址并去重。来源 policy 仅删除本地项，全删空则跳过该键。
- 原始来源缓存不变，不导入其他来源 DNS 设置；旧缓存缺少 DNS 时保持兼容。
- 节点 IP 不生成域名策略；策略激活所需 proxy-server-nameserver 为空时，使用最终 nameserver，仍空则使用来源安全 DNS 地址。

## Review Focus

- 裸地址、udp/tcp/tls/https URL 本地端点均过滤，公网查询参数中的 127.0.0.1 不误删。
- 混合列表保留外部地址，纯本地策略键不生成空数组。
- 来源 hosts 域名别名的目标亦按同源节点 DNS 解析，别名循环须终止。
- 多来源重名域名、显式通配策略、无 DNS 和 IP 节点兼容。
- 完整缓存重启/更新失败后仍保留 DNS；国家过滤后不为排除节点新增策略。

## Task 1: 来源策略处理与转换

**Files:** 新增 source-dns.js、test/source-dns.test.js，修改 transform.js。

**Interfaces:** mergeSourceDns(output, sources)，sources 项为 {dns, proxies}；transformConfig 新增 sourceDns 数组（顺序同 upstreamProxyLists）。

- [x] 编写测试：节点映射、混合回环替换、policy 字符串/数组过滤、优先级/通配、IP/无配置、别名链、策略激活、输入不变与国家过滤。
- [x] 运行测试确认缺失功能导致失败。
- [x] 实现 source-dns.js 并在 transformConfig 生成完成前调用。
- [x] 运行相关测试。

## Task 2: 两入口与缓存集成

**Files:** fetch-subscriptions.js、managed.js、server.js、test/managed.test.js、test/server.test.js、README.md。

**Interfaces:** parseSubscriptionDocument 返回 dns（仅相关四字段）；Managed.currentSource/sourceContent 保留并传递 dns，两个入口传递 sourceDns。

- [x] 编写两入口输出与缓存复用/重启/失败回退测试，确认失败。
- [x] 实现传递，补充 README 行为说明。
- [x] 运行 npm test 和 git diff --check，审查整个变更。

## Ledger

- Ruling: 不改写模板本地 DNS，仅过滤来源 DNS — 本地模板可能明确依赖用户设备上服务。
- Ruling: 完整来源策略独立于国家筛选导入，自动策略仅基于筛选保留的节点。
- Ruling: 审查发现来源 DNS 的 #节点名 引用须随节点同步重命名；增加回归测试验证失败后修复。来源独有策略组不自动迁移，保留原引用并在 README 说明依赖最终模板对应组。
