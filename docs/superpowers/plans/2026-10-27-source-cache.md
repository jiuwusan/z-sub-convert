# Source Cache Implementation Plan

> Execute with superpowers:executing-plans. User correction authorizes replacing per-subscription caches with per-source caches and moving refresh controls to sources.

**Goal:** Cache third-party proxy results once per source; render system subscriptions from source caches and the selected template.
**Architecture:** Persistent raw proxy arrays in source-cache UUID JSON files, source revisions and refresh metadata on source records; no persisted rendered output. Native Node/HTTP/UI retained.
**Requirements:** Sources retain per-source UA, 23-hour TTL from last success, lazy first fetch and expired fetch, single/all manual refresh, failure retains source cache and timestamp. Multiple system subscriptions share raw caches and in-flight source fetches. Template edits only re-render, no upstream fetch for valid sources. Preserve account/templates/source IDs/subscription keys during upgrade. Source URL/UA edits invalidate only that source. Independently successful sources may update even if another source fails; a subscription requires a cached result from every selected source.

## Tasks
- [x] 1. Replace managed-cache tests with shared-source/TTL/reuse/concurrency/failure/edits/disk-failure tests; observe RED. Implement source cache engine and v1→v2 storage migration (old rendered caches are not raw sources); verify GREEN.
- [x] 2. Move authenticated refresh API to POST /api/sources/:id/refresh and /api/sources/refresh-all. Move cache columns, per-row refresh and all-refresh to source tab; system subscriptions retain copy/edit/delete. Update HTTP tests and README, verify full suite.
- [x] 3. Browser-check source refresh controls, shared-source reuse, live template rendering and old subscription key compatibility. Fresh read-only whole-change review, address material findings, final suite/syntax/diff checks.

## Review Focus
- Across different subscriptions and restart, each valid shared source fetches only once.
- Edited URL/UA must not let an older inflight refresh overwrite current raw data.
- Failed source updates retain source cache and timestamp; uncached missing sources cannot yield partial output.
- Rendering rechecks config after awaited source reads; template/selection edits cannot produce obsolete combinations.
- Migration preserves credentials and subscription keys; public source lists omit upstream URL tokens and cache file paths.

## Progress
Baseline: master aeff9b9 plus user-owned docker-compose.yml edit; branch feat/source-cache. Compose edit is outside this change.
Decision: Use source caches only; schema v2 drops obsolete rendered cache metadata. First access after v1 upgrade establishes raw caches without changing stable links. Old raw data cannot be reconstructed from transformed/renamed output.
Decision: Source updates are independent. After a failed update, a subscription may combine that source's last good data with other sources' newly updated data.
Verification: Managed-cache RED: 8/9 failed against old subscription cache engine; GREEN 12/12 cache/store tests. API refresh path RED then GREEN; initial full suite 40/40 pass.
Browser QA: creating a source does not fetch; source single refresh performs exactly one real HTTP request; two system subscriptions share the result without more requests. Editing template changes output immediately without another HTTP request. Refresh-all includes unused source (2 sources, each fetched once), and both subscribers see updated data. System rows show copy/edit/delete only. Mobile 390px source refresh controls visible, no document overflow, no console errors.
Review: fresh independent reviewer found no Critical/Important issues. Suggested pending-read regression added: editing template and selection and deleting the deselected source during a held fetch still returns current template/selection. Migration test also exercises original stable key after upgrade.
Final verification: 41/41 full-suite tests pass, syntax and diff checks pass. No automatic commit/push. Existing user-owned Compose change remains untouched.
Review boundaries: single-process storage and existing atomic-rename durability retained; cross-process deduplication/fsync power-loss guarantees remain outside this change. Browser interactions verified separately from code review.
