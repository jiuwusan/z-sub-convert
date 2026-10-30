# 三类模板 Implementation Plan

> **For agentic workers:** 使用 superpowers:executing-plans，用户已确认方案，在当前分支顺序实现，不创建分支、不自动提交。

**Goal:** 三类独立模板维护与订阅组合，优先来源 nameserver、手动备用，缓存继续复用。

**Architecture:** 新增 template-parts.js 封装拆分默认配置、规则校验及组装。Store v3 使用 bases/nameservers/templates 三类，templates 表示规则模板；订阅引用 baseId/templateId/nameserverIds/useSourceNameservers。缓存正文提取 nameserver，不新增网络请求。

**Tech Stack:** Node.js 22/CommonJS、node:test、原生管理页面。

**Spec:** docs/superpowers/specs/2026-10-30-template-parts-design.md

## Global Constraints

- 仅规则模板有业务结构校验；不迁移、不删除旧数据。
- 来源 nameserver 与正文同一缓存，2 小时 TTL 和套餐透传不变。
- 开启来源模式时手动选择保持可用，仅全部来源缺少地址时备用；无可用地址明确报错。

## Review Focus

- 基础中的规则/DNS 字段不越权；规则外其他字段不覆盖基础。
- 多来源缺失、空/非法 nameserver、重复地址和 # 分组引用原样处理。
- 模板/地址/引用在请求期间修改时使用最新一致配置，不重新拉取有效缓存。
- 默认数据和 API 引用、删除保护、旧数据拒绝时原文件不变。
- 新导航、编辑/上传、勾选来源后仍可选备用、窄屏和打包。

### Task 1: 组合与存储
- [x] RED：新增模板三部分拆分/组装、规则校验、来源优先和备用测试。
- [x] 实现 template-parts.js、Store v3；拒绝旧数据且不修改磁盘。
- [x] node --test test/template-parts.test.js test/store.test.js 通过。

### Task 2: 缓存、订阅与 API
- [x] RED：订阅引用三类、缓存提取 DNS、编辑并发/删除保护及 API 路由测试。
- [x] 实现 fetch-subscriptions/managed/admin-api；更新原测试配置引用，保留原有行为断言。
- [x] npm test 全部通过。

### Task 3: 页面与验证
- [x] 三类 CRUD/hash 导航、文件编辑、订阅三类选择和来源 DNS 备用模式；文档与 Docker 文件清单更新。
- [x] 独立浏览器验证 CRUD/组装/备用和窄屏，独立代码审查。
- [x] 最终 npm test、JS 语法、git diff --check；保持未提交。

## 实施与验证记录

- 单元和集成测试先 RED 后实现；完整测试 72 项通过，保留原套餐、下载、鉴权、缓存及分组回归。
- 独立只读审查未发现实际问题。未专门增加规则模板/来源 DNS 开关在请求等待期间修改的独立测试；配置指纹已覆盖这两项，基础/手动地址/来源选择并发用例通过。
- 独立本地 Chrome 验证新增基础、nameserver、规则文件读取、系统订阅创建/编辑，以及来源优先去重、全无回退、纯手动三种实际输出，保留 # 片段和套餐透传；三类深链接重载正常。
- 浏览器发现五个导航项在 390px 屏幕溢出，已添加窄屏 flex-wrap 并复测：页面宽度 390px，普通弹窗 356px；基础模板编辑器手机 358px、桌面 1200px，wrap=off；无运行时异常。
- 本机无 Docker，未执行镜像构建；已核对 COPY 文件存在并包括 template-parts.js。旧数据不删除不迁移，升级需新数据目录。
- 所有变更保留在当前 master 工作区，未提交。
