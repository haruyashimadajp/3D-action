/**
 * Unit-test runner: bundles every tests/*.test.ts with rolldown (Vite's bundler, TypeScript built in) into
 * .test-dist/ and runs them with Node's built-in test runner. Usage: npm test
 */
import { rolldown } from 'rolldown';
import { readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const files = readdirSync('tests').filter((f) => f.endsWith('.test.ts')).sort();
rmSync('.test-dist', { recursive: true, force: true });
const outs = [];
for (const f of files) {
  const bundle = await rolldown({ input: `tests/${f}`, platform: 'node', external: [/^node:/], logLevel: 'warn' });
  const file = `.test-dist/${f.replace(/\.ts$/, '.mjs')}`;
  await bundle.write({ file, format: 'esm' });
  await bundle.close();
  outs.push(file);
}
const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...outs], { stdio: 'inherit' });
process.exit(r.status ?? 1);
