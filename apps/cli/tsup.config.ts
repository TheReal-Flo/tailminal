import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  clean: true,
  target: 'node20',
  platform: 'node',
  // inline all workspace packages so the published package is self-contained;
  // keep real npm deps external (node-pty is native and must stay a dependency)
  noExternal: ['@tailminal/shared', '@tailminal/client', '@tailminal/server'],
  external: ['node-pty', 'fastify', '@fastify/static', '@fastify/websocket'],
  // bundled CJS deps (e.g. ws) call require() — provide it in ESM output
  banner: {
    js: "import { createRequire as __createRequire } from 'module';\nconst require = __createRequire(import.meta.url);",
  },
})
