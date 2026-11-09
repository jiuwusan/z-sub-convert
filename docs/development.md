# 开发规范

## 环境与常用命令

运行环境为 Node.js 22+，开发和 CI 使用 Node.js 22.13+（ESLint 10 的最低 Node 22 小版本要求），npm 与运行环境配套。后端 CommonJS，浏览器原生脚本；生产依赖仅包含实际运行所需模块，ESLint、Espree 和 globals 均为开发依赖。新增依赖必须说明用途、许可证和运行成本，更新 `package.json` 与 `package-lock.json`，不要手改锁文件。

```sh
npm ci
npm start
npm run lint
npm run check:architecture
npm test
npm run check
```

`npm run check` 依次执行 lint、架构检查和完整测试，任一步失败即停止。开发可用 `node --test test/具体文件.test.js` 定位问题，交付仍需完整检查。没有额外编译步骤。生产镜像使用 `npm ci --omit=dev`，不需要开发工具。

## 目录与依赖边界

职责说明见 [architecture.md](architecture.md)。文件按业务职责命名，新增服务/网关/仓储使用 `*.service.js`、`*.gateway.js`、`*.repository.js`，路由使用 `*.routes.js`；不要因目录层级新增无行为的转发文件。

| 模块 | 可引用的项目层 |
| --- | --- |
| routes | routes、controllers、middleware、utils |
| controllers | controllers、services、domain、utils、config |
| middleware | middleware、services、utils |
| services | services、gateways、repositories、domain、utils |
| gateways | domain、utils |
| repositories | domain、utils |
| domain | domain、utils |
| utils | utils |
| config | config、utils |
| server.js、app.js、bootstrap | 组合并注入运行模块 |

同层可引用不代表允许循环。`scripts/check-architecture.js` 使用 Espree 解析真实 AST，检查 server.js 和 src 内全部 JS/CommonJS 文件的依赖方向、未分类模块、未解析的本地模块、循环和动态加载；字符串和注释不参与依赖判断。运行时代码使用单一字面量 `require('...')`，不使用动态 require/import、require 别名、`module.require` 或绕过检查的间接加载。新增层必须先更新架构设计、矩阵和检查器测试。

domain 不读取环境变量、不使用磁盘/网络/子进程或 HTTP 对象；允许 `const { isIP } = require('node:net')`，仅作纯 IP 校验，不导入网络连接能力。services 不直接读写文件、不发 HTTP 请求、不持有 request/response；网络和文件操作由注入的 gateway/repository 执行。为兼容调用者可保留未被直接调用的 fetch 注入句柄，真正请求仍在 gateway 内。工具函数若需要 domain 数据，应由上层调用并传入普通值，不能从 utils 反向引用 domain。

检查器是静态约束，不是 JavaScript 沙箱；别名、反射等规避行为须在代码审查中拒绝。外部包是否具有副作用、状态所有权和业务正确性同样需要人工审查。

## 后端代码约定

使用两空格、UTF-8、LF、文件末尾换行和分号，遵循相邻代码的引号风格。通过 `.editorconfig` 和 `.gitattributes` 统一编辑/检出规则，避免为格式化产生无关 diff。ESLint flat config 按 [官方配置规范](https://eslint.org/docs/latest/use/configure/configuration-files) 区分 CommonJS 和浏览器全局，启用推荐错误检查；允许空 catch、忽略有意省略的参数/对象 rest 字段，控制字符清洗正则为明确例外。其余规则异常需说明原因，不整目录关闭 lint。

优先小而明确的函数和对象，避免万能 service、巨型 controller 和含混的 helper。导出清晰的工厂、类或纯函数，不在模块加载时启动服务器、创建定时器或访问私有网络。组合根负责对象生命周期和依赖注入，clock、fetch、logger 等可替换依赖保持可测试；关闭过程清理服务器、连接、定时器及任务。

校验分两步：HTTP 层检查方法、URL、内容类型、请求体大小和基本结构；业务层校验资源存在、字段范围、关联关系及状态约束。校验在持久化或上游调用前完成，不能以客户端校验替代服务端校验。对用户可修复的问题抛出集中定义的 AppError 等错误，保留既有状态码与消息格式；异常边界负责安全转换，未知错误不能泄露堆栈、上游正文或密钥。不要捕获后静默吞掉真实失败；允许的失败隔离必须可观测且不破坏主流程。

## HTTP、认证与敏感数据

保持现有路径、方法、状态码、JSON/YAML 类型、GET/HEAD 语义、下载文件名、缓存标记和调用记录兼容。routes 只匹配和编排，controllers 解析输入并构造响应；业务不得依赖 Node request/response。请求断开仍保留既有 499 调用记录语义，不对已关闭的响应重复写入。

保持安全响应头、会话 Cookie 属性、认证、Origin/CSRF、限流和请求体限制的既有执行顺序。管理写操作必须同时满足认证与现有 CSRF 条件，不能因为后台按钮不可见就省略鉴权。公开订阅 key 只授权对应公开能力，不替代管理会话。涉及登录、重置、退出或权限的变化需要覆盖拒绝路径和失效会话。

URL、正文、来源缓存、Cookie、订阅 key 和 Webhook 都可能含密钥。面向客户端和日志使用脱敏摘要，不透传上游错误正文和无关响应头；常量时间比较、密码散列及签名交给现有安全实现。测试使用虚构 URL/标识。真实数据留在数据卷，不放入仓库。任何新外部请求需规定超时、响应体大小、重定向策略、响应校验和错误脱敏，避免无界等待和内存增长。

## 前端约定

`public/router.js` 维护 hash 路由、登录返回目的地及权限状态；`public/admin.js` 维护交互和 API 调用，HTML/CSS 维护结构与展示。路由、认证、编辑器状态和服务端数据分清所有权，不重复创建互相覆盖的状态副本。新脚本若引入全局对象，需保持加载顺序并在 ESLint 中声明，不直接导入后端模块。

用户和上游文本通过 `textContent`、DOM API 和受控属性输出，禁止拼接到未清洗的 HTML。API 错误需可见；异步提交有明确加载/禁用状态并防止重复操作；切换页面、登出或晚到响应不能覆盖当前页面状态。保持键盘操作、表单 label、对话框焦点和已有桌面/移动布局。浏览器行为用现有 VM/DOM 测试验证，涉及视觉交互时补人工浏览器检查。

## 持久化、缓存与并发

状态格式保持 v3，仓储负责文件位置、原子写入、读取、清理和历史记录。环境/路径由 config 和组合根统一解析，不从嵌套源码路径推导错误的项目根。对旧格式的拒绝不得修改或删除原文件；格式迁移必须另有兼容设计、备份与回滚方案。

仅支持一个进程写入一个 DATA_DIR。PM2 必须 `instances: 1`、fork 模式；不能通过 cluster 或多容器共享文件目录实现扩容。新增共享写入能力必须先设计跨进程一致性或更换存储。

来源保留完整缓存和套餐元数据。来源更新按来源配置 revision 合并并发请求，旧更新不能覆盖编辑后的配置；失败保留旧缓存与最近成功时间，未成功持久化不得触发成功通知。自动两小时按需刷新、手动来源仅读缓存、HEAD 不拉取、缺失来源不输出部分结果等规则保持一致。通知去重、渠道失败隔离、跨午夜与 09:00 门槛由 service/domain 决定，gateway 只负责发送，不重复定义提醒频率。

## 测试、文档和审查

行为修改先写能失败的回归测试，再完成实现。domain 测试输入输出和边界；service 测试用例、持久化失败、缓存、时钟和竞态；gateway/repository 测试真实协议/文件边界；HTTP 测试验证认证、CSRF、状态码、头与请求断开。浏览器、真实启动和 Docker 文件加载测试验证交付布局。依赖注入用于隔离外部系统，测试不访问真实私人订阅或发送真实通知。

用临时目录并在结束后清理，使用注入时钟代替依赖墙上时间的等待；竞态通过可控 Promise/屏障复现。断言观察外部行为，不能只断言 mock 被调用或匹配源码文本。架构检查器自身用合成文件图测试允许/禁止引用、循环、动态加载和纯逻辑约束。

改接口、安全、环境参数、数据格式、缓存或部署时同步 README 和相关设计/开发文档；复杂决策说明兼容性、失败场景和取舍。审查优先确认安全边界、数据所有权、并发、错误隔离和兼容性，再看可读性；不以测试全绿代替边界审查。

## CI、部署、备份和回滚

面向 master 的 pull request、master push 与手动 workflow 执行 `npm ci` 和 `npm run check`。镜像发布依赖检查成功，且仅允许 push/workflow_dispatch，pull request 不登录仓库、不发布镜像。GitHub 仓库分支保护需由维护者将检查任务设为必需检查；工作流本身不配置远程分支保护。

部署环境参数以现有 README、Compose 和 config 为准：HOST、PORT、DATA_DIR、TEMPLATE_PATH、UPSTREAM_TIMEOUT_MS、MAX_UPSTREAM_BYTES。检查监听地址、端口映射、模板文件和数据目录权限，Compose 外部 `wk` 网络须已存在；数据卷必须持久化。不要提交 .env、生产数据或凭据。环境参数变化须校验非法值并补文档，不悄悄回退为不安全配置。

发布前记录旧镜像 digest/标签、部署配置和 v3 数据备份，优先使用可追溯的镜像 digest。单进程停止写入后备份整个 DATA_DIR（包括状态、缓存和记录），备份存放在独立位置并限制访问；需要时同步保留自定义模板。升级后检查 `/version`、登录、管理读取、订阅输出和容器健康，不用真实写操作作无意的验证。

回滚时停止新实例，恢复已记录的旧镜像和相应配置；若数据格式变化，仅恢复与旧程序兼容的停写备份。不要删除数据卷或让新旧实例同时写入同一目录。涉及格式升级时先验证可恢复性；此重构不要求迁移现有 v3 数据。

## Git 与完成清单

默认在当前分支完成修改，用户未明确要求时不创建分支/worktree，不自行提交、推送或发布。提交经授权后使用 `<类型>: <中文摘要>`，例如 `refactor: 拆分订阅转换服务职责`；类型按变更选 fix、feat、refactor、docs、chore、test。本项目当前路径不在 `E:\code`，无需飞书 ID；迁入该目录后按全局要求绑定准确工作项 ID，不能省略或编造。

交付前逐项确认：

- 需求和失败路径有对应实现，现有行为兼容，文档同步。
- `npm run check` 实际执行并通过，改动涉及的启动/浏览器/部署边界已验证。
- 无越层/循环依赖、真实密钥、无关批量改动、遗留调试输出或未清理资源。
- 锁文件与依赖一致，生产依赖未混入开发工具，部署数据有明确备份/回滚路径。
- 最终说明包含改动目的、验证命令和真实结果、未验证项及实际风险。
