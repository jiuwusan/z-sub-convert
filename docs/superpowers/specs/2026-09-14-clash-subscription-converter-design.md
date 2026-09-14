# Clash.Meta Subscription Converter Design

## Goal

Build a small Node.js HTTP service that fetches one or more third-party Clash YAML subscriptions, extracts and normalizes their proxies, groups them by protocol and country/region, and injects the result into `prds/template.yaml` for Clash.Meta/Mihomo clients.

## HTTP Interface

- Expose `GET /sub?url=<subscription>` using the same basic route and `url` query convention as open-source subconverter.
- Support multiple subscription URLs separated by `|` in one `url` value. URL decoding is handled by the HTTP query parser before splitting.
- The `target` query parameter is optional and always ignored. Output is always Clash.Meta/Mihomo-compatible YAML.
- Ignore other unknown subconverter query parameters so existing generated URLs remain usable.
- Expose `GET /version` returning the service name and package version as JSON.
- A successful conversion returns `Content-Type: text/yaml; charset=utf-8` and a YAML download filename through `Content-Disposition`.

## Upstream Fetching

- Accept only `http:` and `https:` subscription URLs.
- Fetch all URLs concurrently while preserving their order when merging results.
- Send `User-Agent: clash-meta` on every upstream request.
- Apply a configurable timeout and response body size limit to each request.
- Treat any non-2xx response, timeout, oversized response, invalid YAML document, or document without a non-empty `proxies` array as a conversion failure. Do not return a partial configuration.

## Country and Region Recognition

Country/region recognition uses only the original proxy `name`. It must not perform DNS, IP, or GeoIP lookup.

Match in this order:

1. Flag emoji.
2. Chinese country/region names.
3. English country/region names.
4. Common abbreviations appearing as independent tokens, such as `SG`, `JP`, and `US`.

Matching is case-insensitive where applicable. Token boundaries prevent short abbreviations from matching arbitrary substrings. Unrecognized names use flag `🏳️` and country name `其他`.

The initial country/region priority is:

1. 新加坡
2. 日本
3. 美国
4. 香港
5. 台湾
6. 韩国
7. Other recognized countries/regions, ordered by their normalized Chinese name
8. 其他

The recognition table and priority list are maintained as data in `country.js` so more entries can be added without changing transformation logic.

## Protocol Recognition and Priority

Read the protocol from each proxy's `type` field, normalized to lowercase for comparison. Protocol group labels use the full uppercase protocol value.

The initial protocol priority is:

1. `ss`
2. `ssr`
3. `hysteria2`
4. `trojan`
5. `vmess`
6. `vless`
7. `tuic`
8. `hysteria`
9. `wireguard`
10. Other protocols, ordered by normalized protocol name

For example, `hysteria2` is displayed as `HYSTERIA2`, not `HY2`.

## Proxy Transformation and Grouping

- Merge proxies in subscription URL order, preserving each upstream document's proxy order.
- Preserve every proxy field except `name`.
- Do not deduplicate proxies. Nodes sharing a server and port may still have different credentials or transport settings.
- Group proxies by normalized protocol and normalized country/region.
- Name each generated group as `$国旗 $大写协议 $国家名称`, for example `🇸🇬 SS 新加坡`.
- Rename each proxy as `$国旗 $国家名称 $编号`, for example `🇸🇬 新加坡 01`.
- Number proxies per country/region across all protocol groups, starting at 1 and padded to at least two digits. A country's later protocol groups continue from the numbers assigned to its earlier protocol groups, ensuring proxy names are globally unique while keeping the required name format. Numbers above 99 remain untruncated.
- Sort groups by protocol priority first and country/region priority second.
- Each generated group uses the same fallback behavior as the provided result sample: `type: fallback`, `interval: 305`, and `url: http://www.gstatic.com/generate_204`.

## Template Injection

- Load `prds/template.yaml` for every conversion so template changes take effect without rebuilding the image.
- Replace the template's top-level `proxies` value with the complete transformed proxy list.
- Append generated protocol-country groups to the existing top-level `proxy-groups` list.
- Append all generated group names, in sorted order, to both `🚀 节点选择` and `🔰 故障转移` while preserving their existing entries.
- Preserve all other parsed template data and ordering. Exact comments and whitespace are not part of the output contract because the template is parsed and serialized structurally.
- Missing or malformed `proxies`, `proxy-groups`, `🚀 节点选择`, or `🔰 故障转移` template structures are server configuration errors.

## Error Handling

- Return HTTP 400 JSON for a missing/empty `url`, malformed URL, or unsupported URL protocol.
- Return HTTP 404 JSON for unknown routes.
- Return HTTP 405 JSON for unsupported methods.
- Return HTTP 502 JSON when an upstream subscription cannot be fetched or parsed into proxies.
- Return HTTP 500 JSON for template loading, parsing, or structural errors.
- Log concise errors without printing complete subscription URLs, because those URLs may contain credentials.

## File Layout

The application uses a flat root layout as requested:

- `server.js`: HTTP server, routing, query parsing, and responses.
- `fetch-subscriptions.js`: URL splitting, validation, concurrent fetching, limits, and YAML subscription parsing.
- `country.js`: country/region aliases, flag data, recognition, and country priority.
- `transform.js`: proxy normalization, sorting, renaming, generated groups, and template injection.
- `test/*.test.js`: unit and HTTP integration tests.
- `ecosystem.config.cjs`: PM2 process configuration.
- `Dockerfile`: Node 22 Alpine production image.
- `docker-compose.yml`: service definition and restart behavior.
- `package.json`: dependencies, scripts, package name, and version.
- `README.md`: installation, configuration, Docker deployment, and API examples.

## Runtime and Deployment

- Require Node.js 22.
- Use Node's built-in `http`, `fetch`, and test runner; use the `yaml` package for YAML parsing and serialization.
- Use `pm2-runtime` inside the container.
- Configure PM2 with `max_memory_restart: 256M`, causing the application process to restart after it crosses the 256 MB threshold.
- Build from `node:22-alpine` and run as a non-root user.
- Copy `prds/template.yaml` into the image so the service works without any host mount.
- Provide Docker Compose deployment with port `25500` and a container restart policy. A read-only host mount for `prds/template.yaml` is an optional override, not a runtime requirement.
- Support environment variables for host, port, upstream timeout, maximum upstream response size, and template path. Defaults are `0.0.0.0`, `25500`, 15 seconds, 10 MiB, and `prds/template.yaml` respectively.

## Testing and Acceptance Criteria

Use Node's built-in test runner and test observable behavior with real local HTTP servers where network behavior matters.

Coverage includes:

- Recognition through flags, Chinese names, English names, and independent abbreviations.
- Prevention of false-positive abbreviation substring matches.
- Unknown-country fallback.
- Exact protocol priority, country priority, and fallback ordering.
- Full uppercase protocol display, including `HYSTERIA2`.
- Per-country cross-protocol two-digit numbering, global name uniqueness, and numbering beyond 99.
- Stable merge order across multiple concurrently fetched subscriptions.
- Preservation of arbitrary proxy fields.
- Injection into both required template groups while preserving existing entries.
- Ignoring any `target` value and unknown query parameters.
- Exact `User-Agent: clash-meta` behavior.
- Missing parameters, invalid URLs, upstream errors, timeouts, body limits, invalid YAML, and invalid templates.
- A conversion using the provided third-party test URL, performed as a manual integration check so the automated suite does not depend on an external service.
- Docker image build and Compose configuration validation.

Acceptance requires all automated tests to pass, the produced YAML to parse successfully, all group references to resolve to a generated group or proxy, the provided subscription to convert successfully, and the service to run under PM2 in the Node 22 Alpine container.
