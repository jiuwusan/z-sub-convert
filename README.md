# Clash.Meta 订阅转换服务

一个面向 Clash.Meta/Mihomo 的轻量 Node.js 订阅转换服务。它可合并多个 Clash YAML 订阅，按照“协议优先、国家/地区其次”生成 fallback 分组，重命名节点，并注入 `prds/template.yaml`。

## 转换规则

- 分组名：`国旗-大写协议-国家名称`，例如 `🇸🇬-SS-新加坡`、`🇯🇵-HYSTERIA2-日本`。
- 节点名：`国旗-国家名称-编号`，例如 `🇸🇬-新加坡-01`。
- 同一国家/地区跨协议连续编号，避免 Clash 配置中出现重复节点名。
- 国家识别顺序：国旗、中文名、英文名、独立常见缩写；无法识别时使用 `🏳️-其他`。
- 协议优先级：`ss → ssr → hysteria2 → trojan → vmess → vless → tuic → hysteria → wireguard → 其他`。
- 国家优先级：`新加坡 → 日本 → 美国 → 香港 → 台湾 → 韩国 → 其他已识别国家 → 其他`。

## 本地运行

需要 Node.js 22 或更高版本：

```bash
npm ci
npm start
```

服务默认监听 `0.0.0.0:25500`。

## API

健康与版本信息：

```text
GET http://127.0.0.1:25500/version
```

转换单个订阅：

```text
GET http://127.0.0.1:25500/sub?url=<URL编码后的订阅地址>
```

合并多个订阅时，先用 `|` 连接地址，再对整个参数值进行 URL 编码：

```text
GET http://127.0.0.1:25500/sub?url=<URL编码后的订阅1|订阅2>
```

兼容 subconverter 风格的调用链接，但 `target` 和其他额外查询参数都会被忽略；输出始终为 Clash.Meta/Mihomo YAML。

成功响应的下载文件名包含当前 Unix 毫秒时间戳，例如 `config-clash-meta-1789353600123.yaml`。

```text
GET /sub?target=anything&url=<已编码地址>&emoji=false
```

抓取上游订阅时固定发送 `User-Agent: clash-meta`。

## Docker Compose 部署

```bash
docker compose up -d --build
```

镜像基于 `node:22-alpine`，通过 `pm2-runtime` 运行。PM2 的 `max_memory_restart` 设置为 `256M`，进程内存达到阈值后会自动重启。

模板已复制到镜像内的 `/app/prds/template.yaml`，因此默认 Compose 配置不需要挂载模板即可正常使用。

如需在不重建镜像的情况下覆盖模板，可在 `docker-compose.yml` 的服务下添加只读挂载：

```yaml
    volumes:
      - ./prds/template.yaml:/app/prds/template.yaml:ro
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | ---: | --- |
| `HOST` | `0.0.0.0` | 服务监听地址 |
| `PORT` | `25500` | Node 服务监听端口；Compose 中宿主机端口也可通过同名变量调整 |
| `UPSTREAM_TIMEOUT_MS` | `15000` | 单个上游请求超时（毫秒） |
| `MAX_UPSTREAM_BYTES` | `10485760` | 单个上游响应最大字节数（默认 10 MiB） |
| `TEMPLATE_PATH` | `prds/template.yaml` | 模板文件路径 |

## 测试

```bash
npm test
```

自动化测试使用本地 HTTP 服务，不依赖外部订阅提供方。`prds/第三方订阅测试链接.txt` 仅用于手动联调。
