import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const projectRoot = process.cwd();
const localConfig = join(projectRoot, 'wrangler.toml');
let temporaryDirectory;
let configArguments = [];

try {
  if (!existsSync(localConfig)) {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'typecho-cf-wrangler-'));
    const temporaryConfig = join(temporaryDirectory, 'wrangler.toml');
    copyFileSync(join(projectRoot, 'wrangler.toml.example'), temporaryConfig);
    configArguments = ['--config', temporaryConfig];
  }

  const command = process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler';
  const result = spawnSync(
    command,
    ['types', 'worker-configuration.d.ts', ...configArguments],
    { cwd: projectRoot, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
}
