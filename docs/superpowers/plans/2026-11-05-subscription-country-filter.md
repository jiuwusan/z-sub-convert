# 订阅国家筛选 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement inline on the current branch.

**Goal:** 每份系统订阅可选持久化国家白名单，创建、编辑和后续生成一致生效。
**Architecture:** country.js 统一验证和聚合；transform.js 在生成分组前过滤；Managed 读写配置、提供候选并把筛选加入生成快照；管理 API 暴露登录候选接口；现有表单加入开关及标签。
**Tech Stack:** Node.js、CommonJS、原生 HTTP、原生 DOM、node:test。
**Spec:** ../specs/2026-11-05-subscription-country-filter-design.md（已获用户确认）

## Global Constraints
- 当前分支实施，不创建 worktree，不自动提交推送，不操作真实订阅服务。
- 默认全量兼容；启用且名单为空或无匹配节点明确报错；模板自有节点不受过滤。
- sourceContent 既有缓存/自动和手动更新语义不变；名单按订阅隔离。

## Review Focus
- 上游增减国家不默默扩展白名单；暂缺的选择可见且保留。
- 快速换来源、关闭弹窗、登录变化不能被旧响应覆盖。
- 聚合失败不返回不完整的候选，错误可重试。
- 配置并发变化要重做生成，不复用旧白名单。
- 候选接口需登录+CSRF，不暴露节点地址/凭据。

## Task 1: 筛选与持久化
Files: country.js, transform.js, managed.js, test/transform.test.js, test/managed.test.js。
- [x] 写测试：默认/关闭全量、白名单识别其他、模板保留、过滤引用、非法值/空匹配；先失败后实现 countryFilterOptions({customCountries,countryCodes}) 和 summarizeCountries(lists)。
- [x] Managed 保存/详情/列表默认、编辑省略保持、configuration 快照和 content 传参；测试持久化、缓存复用与生成中修改。

## Task 2: 国家候选与表单
Files: managed.js, admin-api.js, public/admin.js, public/style.css, test/admin.test.js, test/browser-state.test.js。
- [x] 先失败后实现 POST /api/subscriptions/countries {sourceIds} -> {countries,stale}，sourceIds 1–50；sourceContent 聚合后返回 code/name/flag/count，按既有优先级排序。提供识别目录用于暂缺国家显示；所有错误走现有处理。
- [x] 表单默认关闭无请求，开启加载候选，多选标签+数量，来源变化重新加载，保留暂缺选择，失败可重试；保存开关及代码，启用至少一项。
- [x] DOM 测试覆盖开关/标签/提交、编辑回显、来源切换/关闭旧响应、候选失败，API 测试认证/CSRF/输入与公开输出。

## Task 3: 文档和交付验证
- [x] 更新 README；npm test、JS syntax、git diff --check；独立只读审查并修复实质问题。

## Execution ledger
- 基线 npm test 153 项通过。用户确认推荐方案，未授权提交推送。

- 完成：先验证新增后端/接口/DOM用例失败，再实现通过；全量 npm test 161 项通过，相关 JS 语法与 diff 检查通过。独立只读审查无实质问题。额外补充混合来源失败不返回部分结果、旧缓存 stale 标记验证通过。
- 浏览器使用临时数据和假来源验证：默认全量、开启后解析四类国家与数量、选日本创建后输出无美国节点、编辑回显。未调用真实上游服务，未提交推送。
