import { spawnSync } from 'node:child_process';

const command = process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler';
const result = spawnSync(command, ['types', 'worker-configuration.d.ts'], {
  cwd: process.cwd(),
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;
