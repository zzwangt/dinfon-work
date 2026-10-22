import { mkdir, cp, writeFile, readFile, readdir, lstat } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const packageName = `dinfon-independent-${stamp}`;
const destination = resolve(root, 'outputs', packageName);
await mkdir(dirname(destination), { recursive: true });
await mkdir(destination, { recursive: false });
// An explicit allowlist prevents local credentials, databases, preview fixtures,
// Git history and hosting metadata from entering the distributable.
for (const path of ['public', 'server', 'tests', 'drizzle', 'deploy', 'Dockerfile', '.dockerignore', 'README.md', 'DEPLOYMENT.md', 'PRODUCT.md', 'DESIGN.md', '启动平台.command']) {
  await cp(resolve(root, path), resolve(destination, path), { recursive: true });
}
await mkdir(resolve(destination, 'scripts'));
for (const file of ['setup-local.mjs', 'terminal-input.mjs', 'manage-admin.mjs', 'backup.mjs']) await cp(resolve(root, 'scripts', file), resolve(destination, 'scripts', file));
const sourcePackage = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const scripts = Object.fromEntries(['start', 'dev', 'setup', 'test', 'check', 'backup', 'admin:recover', 'admin:migrate'].map(key => [key, sourcePackage.scripts[key]]));
await writeFile(resolve(destination, 'package.json'), JSON.stringify({ name: 'dinfon-independent', version: '1.0.0', private: true, type: 'module', engines: { node: '>=24' }, scripts }, null, 2) + '\n');
await writeFile(resolve(destination, '.gitignore'), 'config/runtime.json\nconfig/deploy.env\ndata/\nbackups/\nnode_modules/\n');
const hashes = [];
async function inventory(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const filename = resolve(directory, item.name);
    if ((await lstat(filename)).isSymbolicLink()) throw new Error('Package must not contain symlinks');
    if (item.isDirectory()) await inventory(filename);
    else hashes.push(`${createHash('sha256').update(await readFile(filename)).digest('hex')}  ${relative(destination, filename)}`);
  }
}
await inventory(destination);
await writeFile(resolve(destination, 'SHA256SUMS'), hashes.sort().join('\n') + '\n');
const archive = resolve(root, 'outputs', `${packageName}.zip`);
const result = spawnSync('zip', ['-q', '-r', archive, packageName], { cwd: dirname(destination), encoding: 'utf8' });
if (result.status !== 0) throw new Error('Zip packaging failed');
console.log(JSON.stringify({ directory: destination, archive, files: hashes.length }, null, 2));
