import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../site/', import.meta.url));
const allowed = new Set(['index.html', 'style.css', 'app.js', '.nojekyll', 'data/latest.enc.json', 'data/history.enc.json']);
async function inspect(dir, prefix = '') {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error('Published site must not contain symlinks');
    if (entry.isDirectory()) {
      if (name !== 'data') throw new Error('Unexpected published directory');
      await inspect(path.join(dir, entry.name), name + '/');
    } else if (!allowed.has(name)) throw new Error('Unexpected published file');
  }
}
await inspect(root);
for (const name of ['latest', 'history']) {
  const data = JSON.parse(await readFile(path.join(root, 'data', `${name}.enc.json`), 'utf8'));
  if (Object.keys(data).sort().join(',') !== 'ct,iter,iv,kdf,salt,v' || data.v !== 1 ||
      data.kdf !== 'pbkdf2-sha256' || data.iter !== 310000 ||
      Buffer.from(data.salt, 'base64').length !== 16 || Buffer.from(data.iv, 'base64').length !== 12 ||
      Buffer.from(data.ct, 'base64').length < 16) throw new Error('Invalid encrypted artifact');
}
console.log('Public artifact allowlist and encrypted envelopes verified.');
