// highlight.js ships type declarations only for its main entry. We import the tree-shakeable core
// build plus individual language grammars (plan 36) to keep the bundle small, and those subpaths
// resolve to plain .js with no adjacent .d.ts under Bundler resolution. Re-expose the core type from
// the package's own declarations - the `import type` also loads highlight.js's ambient
// `declare module 'highlight.js/lib/languages/*'`, which types the grammar imports.
declare module "highlight.js/lib/core" {
  import type { HLJSApi } from "highlight.js";

  const hljs: HLJSApi;
  export default hljs;
}
