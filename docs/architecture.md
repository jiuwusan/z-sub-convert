# 项目架构

本项目是 Node.js 22+ / CommonJS 单体应用，提供原生 HTTP API、静态管理界面与 Mihomo YAML 转换。保持单进程文件存储、现有接口、数据格式 v3、缓存和通知行为兼容，不引入新 Web 框架或数据库。

## 目录和职责

- `server.js`：进程启动入口，保留 createApp/start 导出供现有集成调用。
- `src/app.js`：创建 HTTP 服务并挂载路由，负责请求生命周期和关闭服务。
- `src/bootstrap/`：组装 repositories、gateways、services、controllers 与 routes。
- `src/config/`：项目路径、环境变量和运行参数校验。
- `src/routes/`：URL、HTTP 方法匹配和中间件编排，无业务读写和上游请求。
- `src/controllers/`：读取请求参数、调用 service、返回 JSON/YAML/下载响应。
- `src/middleware/`：安全响应头、认证、Origin/CSRF、限流、JSON 请求体、异常转换和调用记录。
- `src/services/`：账号、配置管理、来源更新、订阅生成、通知去重等用例；不持有 request/response，不直接访问文件或 fetch。
- `src/gateways/`：第三方订阅 HTTP 和通知渠道 Webhook，负责超时、响应校验、签名、敏感信息隐藏；不决定业务提醒频率。
- `src/repositories/`：状态文件、完整来源缓存、模板文件及历史记录的读写与清理。
- `src/domain/`：国家识别、节点转换、模板组装、DNS 策略、套餐数据、通知条件与消息格式等纯业务逻辑，无磁盘或网络 I/O。
- `src/utils/`：共享错误、常量时间比较和 HTTP 响应等明确用途的通用函数，不反向引用上层。
- `public/`：独立浏览器客户端，hash router 管页面路由，admin 管页面交互，CSS/HTML 管展示；不导入后端模块，接口路径保持不变。
- `test/`：领域、服务、HTTP、浏览器、真实启动、容器运行与工程规范测试。
- `scripts/`：开发质量检查，不进入业务运行依赖。

## 依赖方向

请求依次经过 routes → middleware/controllers → services → gateways/repositories/domain → utils。

具体静态依赖规则：routes 仅引用 routes/controllers/middleware/utils；controllers 仅引用 controllers/services/domain/utils/config；middleware 仅引用 middleware/services/utils；services 可引用其他 service、gateway、repository、domain、utils；gateway/repository 仅引用 domain/utils；domain 仅引用 domain/utils；utils 不引用其他层；config 仅引用 config/utils。app/bootstrap 可以组装各层。禁止循环依赖、越级调用和运行时动态 require。工程检查脚本作为可执行约束。

依赖通过工厂参数或构造参数传入；fetch、clock、logger 等可替换依赖继续支持。错误类型集中在 utils，不由认证或网关模块向其他层提供。domain 不得使用 fs/http/https/fetch、环境变量或 Web request/response。

## 兼容与部署

继续以 `node server.js` / PM2 单实例运行。Docker COPY 包含 src 和 public，测试须验证运行文件可完整加载。保留全部 HTTP 路径、状态码、Cookie/CSRF、安全响应头、GET/HEAD 行为、下载文件名、调用记录 499 语义与关闭清理。状态文件和缓存无需迁移。服务器健康检查、Compose 数据卷和外部网络保持现状。

重构完成后以全量测试、静态检查和架构依赖检查作为交付门槛；不自动提交推送。
