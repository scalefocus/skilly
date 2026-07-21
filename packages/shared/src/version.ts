// Application version — the single source of truth, shown in the UI colophon.
// Client-safe subpath export (`@skilly/shared/version`): a pure constant, no node deps.
//
// MUST be bumped on EVERY change to the app (see CLAUDE.md "App version"):
//   patch — fixes, styling, copy, small tweaks
//   minor — new features / behaviors / endpoints / migrations
//   major — breaking changes (install contract, API shapes, config)
export const APP_VERSION = "1.131.1";
