// Shared example services — the single canonical contracts + classes both
// example apps wire. Source-only: imported by each example via a relative source
// path so plain `tsc` / `tspc` compiles it into that example's own `dist`
// (no bundler, no separate build step). The bare package specifier is never
// imported at runtime — only these types + classes, via the relative path.

export * from "./contracts.js";
export * from "./services.js";
