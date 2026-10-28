# Full Upstream Preview

User correction: source preview must show the complete third-party response, not reconstructed proxies-only YAML.

- [x] Add failing fetch/cache/API tests for provider comments, line endings, DNS, groups, rules and exact response-text preservation.
- [x] Fetch once and return validated proxy data plus the original response text; preserve legacy fetchOne/proxy-list APIs. Save new source caches as original YAML text. Read old JSON proxy arrays for conversion compatibility, with preview reporting requiresUpdate rather than synthesizing a fake full response.
- [x] Preview reads cached full text only, never fetches; source updates retain old good caches on failure. Update UI notes/docs, validate legacy caches, shared-source behavior, HTTP auth and restart, and perform browser checks.

Decisions: keep state schema v2 and subscription keys unchanged. Cache format is identified by generated .yaml versus legacy .json filenames. Old node-only caches remain usable until the existing TTL or manual update; a read-only preview cannot recover discarded provider fields. System subscription generation extracts proxies while retaining its selected local template/rules.

Verification: failing tests reproduced truncated output and missing legacy update notice before implementation; full suite 51/51 passes after implementation. JS syntax and diff checks pass. Browser checks confirm complete provider sections, exact original string passed to clipboard including BOM/CRLF, clearing on close, explicit legacy-cache update notice and full preview after one manual update. No console errors. Independent read-only review found no actionable findings.

Scope: original decoded UTF-8 response text is retained, not binary/non-UTF-8 archival. Application passes the original string to the clipboard; OS clipboard newline representation and manual textarea copy remain browser/platform behavior. No commits or pushes performed.
