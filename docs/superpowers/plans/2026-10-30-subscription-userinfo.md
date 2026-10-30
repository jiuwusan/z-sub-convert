# 订阅套餐透传 Implementation Plan

> **For agentic workers:** 使用 superpowers:executing-plans，在当前 master 分支顺序实现；用户已授权开始落地，不再询问执行方式。

**Goal:** 一次 GET 共享缓存正文和套餐 2 小时，后台显示来源套餐及系统聚合覆盖，订阅和下载输出套餐头。

**Architecture:** 新增 `userinfo.js` 处理白名单解析、精确整数聚合和安全序列化。来源 cache 元数据存放 userInfo，沿用现有文件和状态原子写入；由 Managed 向列表、预览、正文和 HEAD 提供套餐信息，sendDownload 统一输出。

**Tech Stack:** Node.js 22 CommonJS、node:test、原生 HTML/CSS/JavaScript，无新增依赖。

**Spec:** docs/superpowers/specs/2026-10-30-subscription-userinfo-design.md

## Global Constraints

- 当前分支修改，不创建分支，不自动提交。
- 缓存有效期 2 小时，正文和套餐来自同一次 GET；失败不改成功数据和时间。
- 不暴露上游令牌，不转发其他第三方响应头；保留下载文件命名。

## Review Focus

- 部分/错误/无头响应、旧版缓存不会制造零用量或阻止正常订阅。
- 刷新期间配置变更、写失败和重启不能导致正文/套餐跨批次混用。
- 大整数精度、永久/无限值、部分字段及多来源去重聚合。
- HEAD 无缓存时不拉取，缓存已有时输出同样套餐头。
- 表格宽度、无套餐来源、过期失败旧数据显示、覆盖提示及 Docker COPY。

### Task 1: 解析和聚合

**Files:** 新增 userinfo.js、test/userinfo.test.js；修改 fetch-subscriptions.js、test/fetch-subscriptions.test.js。
**Interfaces:** parseUserinfo(header) -> 对象或 null；aggregateUserinfo(items) -> {userInfo, coverage: {available,total}}；formatUserinfo(info) -> 安全头字符串或 null。字段值为十进制字符串。
- [x] 写 RED：有效/部分/无效/重复字段、大整数、零语义及聚合最晚到期；验证 fetch 的同一次 GET 同时返回 content/proxies/userInfo。
- [x] 实现白名单解析、BigInt 聚合及响应头读取。
- [x] node --test test/userinfo.test.js test/fetch-subscriptions.test.js 全部通过。

### Task 2: 缓存及 HTTP

**Files:** managed.js、download.js、admin-api.js、server.js、Dockerfile；test/managed.test.js、test/admin.test.js。
**Interfaces:** cache.userInfo 与 file/revision 同时保存；来源/list/preview、content 结果包含 userInfo；Managed.subscriptionInfo(id) 返回缓存聚合和覆盖，无网络。
- [x] 写 RED：7200000 毫秒到期、重启共享、失败/无头成功/编辑/并发套餐一致性、覆盖和去重。
- [x] 写 RED：公开订阅和两类下载 GET/HEAD 套餐头一致，无缓存 HEAD 不拉取，无数据不输出头。
- [x] 实现，Docker COPY 包含 userinfo.js。
- [x] node --test test/managed.test.js test/admin.test.js 全部通过。

### Task 3: 列表和验证

**Files:** public/admin.js、public/style.css、public/index.html、README.md。
- [x] 来源套餐列紧凑三行展示总量/剩余/到期；系统关联区显示覆盖数量，2 小时提示统一。
- [x] 浏览器使用隔离临时数据验证完整/部分/无数据/永久无限/过期失败及窄屏。
- [x] npm test、git diff --check、JS 语法、Docker COPY 文件存在检查；独立代码审查并修复实际问题。

## 实施记录

- 新增测试先 RED，随后实现通过；完整测试 63/63。
- 独立审查未发现实际问题，额外核对 50 来源 uint64 上限精确求和及 Docker COPY 输入。
- 独立本地无头 Chrome 检查 1920×1200、390×844：页面无整体溢出，窄屏表格可横向滚动；三行套餐、无缓存徽章、覆盖比、过期更新失败保留套餐均通过，无运行时异常。
- 实施默认与设计一致，无新增未决项。浏览器连接工具无响应，改用本地 Chrome CDP 完成验证。
- 本机没有 Docker 命令，未运行镜像构建；已核对镜像所需文件。用户未要求提交，所有变更保留在当前 master 工作区。
