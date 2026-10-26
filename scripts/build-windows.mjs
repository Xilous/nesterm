// Builds dist/nesterm.exe: one bundled script embedded in the running Node.js as a single executable application.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = resolve(root, 'dist');
const bundle = resolve(dist, 'nesterm-windows.cjs');
const config = resolve(dist, 'sea-config.json');
const output = resolve(dist, 'nesterm.exe');

if (process.platform !== 'win32') throw new Error('build the Windows executable on Windows');
const major = Number(process.versions.node.split('.')[0]);
if (major < 26) throw new Error(`Node.js 26 or newer is required (it provides node:ffi and --build-sea), found ${process.version}`);

mkdirSync(dist, { recursive: true });
await build({
  entryPoints: [resolve(root, 'bin/nesterm-windows.mjs')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: `node${major}`,
  external: ['node:ffi'],
  banner: { js: '// nesterm for Windows. MIT licensed; see LICENSE and THIRD_PARTY_NOTICES.md.' },
  logLevel: 'warning',
});

writeFileSync(config, `${JSON.stringify({
  main: bundle,
  output,
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  // The console key reader needs node:ffi; the embedded runtime is fixed, so the experimental API cannot drift.
  execArgv: ['--experimental-ffi', '--no-warnings'],
}, null, 2)}\n`);

execFileSync(process.execPath, ['--build-sea', config], { stdio: 'inherit' });
console.log(`built ${output}`);
