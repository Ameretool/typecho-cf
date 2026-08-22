import { spawnSync } from 'node:child_process';

const command = process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler';
const result = spawnSync(command, ['types', 'worker-configuration.d.ts'], {
  cwd: process.cwd(),
  stdio: 'inherit',
  // Node >= 18.20 / 20.12 refuses to spawn .cmd/.bat directly on Windows
  // (EINVAL); route through cmd.exe so `pnpm run typecheck` works.
  shell: process.platform === 'win32',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;
