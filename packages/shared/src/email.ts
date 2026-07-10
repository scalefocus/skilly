// SERVER-ONLY entry for the §12 email channel (node:crypto inside) — import via
// "@skilly/shared/email". The client-safe wrapper/template helpers live in the main index
// (email-template.ts) so the admin editor can share the placeholder contract.
export * from "./email-crypto.js";
export * from "./email-graph.js";
