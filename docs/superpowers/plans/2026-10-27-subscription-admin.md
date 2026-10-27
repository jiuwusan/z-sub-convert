# Subscription Admin Implementation Plan

> **For agentic workers:** Execute using superpowers:executing-plans; user authorized implementation after requirements review.

**Goal:** Deliver persistent subscription/source/template management, account access and 23-hour subscription caching.
**Architecture:** Native Node HTTP, serialized atomic JSON storage, separate cache files, static browser admin.
**Tech Stack:** Node >=22, CommonJS, node:crypto, yaml, native browser APIs.
**Spec:** docs/superpowers/specs/2026-10-27-subscription-admin-design.md

## Global Constraints
- User-Agent default clash-verge/v2.4.5; TTL exactly 23 hours; first initialization needs no reset key.
- Default template seeded once; stable subscription keys; persisted credentials hash; runtime reset key rotates.
- No fetch on save. Failed refresh preserves complete last good content and last success timestamp.
- Existing conversion and legacy URL endpoint remain compatible.

## Review Focus
- Concurrent setup, mutation and refresh must not lose state or publish outdated data.
- Failed multi-source fetch cannot publish partial output or leak URL tokens.
- Expired cache, server restarts and account reset retain usable subscription links.
- Browser mutations require auth and CSRF; user content rendered as text.
- Missing referenced records, invalid YAML, file limits and failed disk writes surface safely.

### Task 1: Persistence, auth and record validation
Files: store.js, auth.js, test/store.test.js, test/auth.test.js.
Interfaces: Store.open({directory,templatePath}), store.read(), store.update(fn); Auth(store,{resetKey,now}), setup/login/reset/session/logout; persisted sources/templates/subscriptions records.
- [x] Write failing persistence/initialization/concurrent transaction and credential/session tests; run node --test test/store.test.js test/auth.test.js (expect missing module).
- [x] Implement atomic serialized persistence and scrypt/session management; verify focused tests pass.

### Task 2: Managed subscription service and HTTP API
Files: managed.js, admin-api.js, server.js, fetch-subscriptions.js, test/managed.test.js, test/admin.test.js.
Interfaces: Managed(store,{fetchImpl,now,timeoutMs,maxBytes}).save/list/remove/refresh/content; createAdminHandler({store,managed,auth}); createApp({dataDir,...}).
- [x] Write failing tests covering CRUD/validation, UA, merge, 23h TTL, failure fallback, coalescing, edit races, auth/reset/CSRF and restart persistence.
- [x] Implement managed cache and authenticated API; keep legacy endpoint unchanged; run focused tests and npm test.

### Task 3: Browser management and Docker delivery
Files: public/index.html, public/admin.js, public/style.css, Dockerfile, docker-compose.yml, .gitignore, README.md.
- [x] Implement responsive Chinese initialization/login/reset screens and three resource tabs with edit dialogs, upload, multiselect, copy, refresh feedback.
- [x] Configure persistent DATA_DIR mount, copy runtime modules/assets; document setup, reset logs and compatibility.
- [x] Run npm test, syntax/diff checks and browser workflow; obtain fresh whole-change review, fix material findings and repeat relevant checks.
