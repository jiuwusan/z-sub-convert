# Subscription Downloads

Goal: Download full cached third-party responses and generated system subscriptions using 名称-下载时Unix毫秒时间戳.yaml.

- [x] Test authenticated source/system downloads, exact raw body, Unicode filename headers, no-cache/legacy-source errors, public key naming and HEAD without fetching.
- [x] Add shared safe UTF-8 attachment naming/sending helper; source downloads only read full caches, system downloads reuse current conversion/cache logic. Keep unnamed legacy URL conversion naming compatible. Include runtime helper in Docker image.
- [x] Add source/system list download buttons and preview download action, surface JSON errors in place, validate browser downloads and full suite.

Source downloads remain cache-only: no cache or legacy node-only cache requires explicit update, matching preview behavior. System downloads behave like accessing its subscription link. Source endpoints remain login-protected. Replace filesystem/header-unsafe characters and bound filename length; preserve Unicode using filename*. Do not trigger pending downloads after logout/session change.

Verification: filename/helper tests RED then GREEN; authenticated download tests RED (404 instead of 409) then GREEN. Full suite54/54 passes; JS syntax and diff checks pass. Browser intercepted generated download anchors/Blobs to inspect all three download paths without leaving test files in the user's Downloads directory: correct Chinese name+timestamp, source original BOM/DNS/groups/rules/comment preserved, system config converted. Missing cache shows in-page update guidance; mobile preview download footer fits viewport. A held download is suppressed after logout. No unexpected console errors.

Independent review: no actionable findings. Docker COPY inputs checked including download.js; no Docker executable is available for an actual image build. Native OS/browser save-dialog behavior was not automated. No commit or push performed.
