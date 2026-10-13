import { build } from 'esbuild';
import { builtinModules } from 'node:module';
await build({ entryPoints: ['src/main.ts'], bundle: true, external: ['obsidian', 'electron', ...builtinModules], platform: 'node', format: 'cjs', target: 'es2021', outfile: 'main.js', minify: true });
