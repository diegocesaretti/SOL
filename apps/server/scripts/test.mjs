import { readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Shell ** expansion differs on Windows and Linux. Discover the entire suite
// explicitly so CI cannot silently skip modules nested below src/.
const root = fileURLToPath(new URL('../', import.meta.url));
async function discover(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await discover(path));
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) files.push(path);
  }
  return files;
}
const files = (await discover(resolve(root, 'src'))).sort();
if (!files.length) throw new Error('No server tests found');
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
