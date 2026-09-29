/**
 * Two bundles, mirroring how DSH loads a plugin package:
 *
 * - host   → lib/index.js   ESM, Node, loaded by the Cordis Loader in the DSH Host process.
 * - client → lib/client.js  CJS wrapped in `window.__ModuleLoader__.load(...)`, served by
 *                            dsh-client-modules to the browser / Desktop renderer.
 *
 * `tsc -p tsconfig.build.json` runs first and emits JS + .d.ts into lib/types; tsdown bundles
 * from there (same pipeline as the official and community DSH plugins).
 */
import type { UserConfig } from 'tsdown'

/** Modules the DSH shell already provides in PLATFORM_MODULES; never bundle them. */
const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-slots']

/** Host-side packages provided by the DSH runtime resolution (peer deps); never bundle them. */
const HOST_EXTERNALS = [/^@deepseek-ai\//, /^node:/]

const host: UserConfig = {
  name: 'inkbridge/host',
  entry: { index: 'lib/types/host/index.js' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: { neverBundle: HOST_EXTERNALS },
}

const client: UserConfig = {
  name: 'inkbridge/client',
  entry: { client: 'lib/types/client/index.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: CLIENT_EXTERNALS,
    alwaysBundle: (id: string) => !CLIENT_EXTERNALS.includes(id),
  },
  define: {
    // The DSH webview has no `process` global.
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-inkbridge", factory: (require) => {',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
}

export default [host, client]
