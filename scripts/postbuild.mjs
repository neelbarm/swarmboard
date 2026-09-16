import { readFile, writeFile, chmod } from 'node:fs/promises';

const target = new URL('../dist/src/cli.js', import.meta.url);
const src = await readFile(target, 'utf8');
if (!src.startsWith('#!')) {
  await writeFile(target, `#!/usr/bin/env node\n${src}`);
}
await chmod(target, 0o755);
