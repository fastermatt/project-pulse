import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const password = 'test-only-password-never-used-live';
function run(out, pw = password) {
  return spawnSync(process.execPath, ['--import', './tests/mock-fetch.mjs', './scripts/collect.mjs'], {
    cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, DASHBOARD_PASSWORD: pw,
      NETLIFY_TOKEN: 'fake-token', PULSE_OUT_DIR: out },
  });
}
async function decrypt(envelope, pw = password) {
  const raw = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', iterations: envelope.iter,
    salt: Buffer.from(envelope.salt, 'base64') }, raw, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const value = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(envelope.iv, 'base64') }, key, Buffer.from(envelope.ct, 'base64'));
  return JSON.parse(new TextDecoder().decode(value));
}
test('collector encrypts private data, redacts public logs, and preserves history across runs', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'pulse test '));
  try {
    await writeFile(path.join(out, 'latest.json'), 'old plaintext');
    const first = run(out);
    assert.equal(first.status, 0, first.stderr);
    assert.doesNotMatch(first.stdout + first.stderr, /PRIVATE_SITE_SENTINEL|private-team|DO_NOT_LOG|fake-token/);
    assert.deepEqual((await readdir(out)).sort(), ['history.enc.json', 'latest.enc.json']);
    const raw = await readFile(path.join(out, 'latest.enc.json'), 'utf8');
    assert.doesNotMatch(raw, /PRIVATE_SITE_SENTINEL|fake-token/);
    const env = JSON.parse(raw);
    const latest = await decrypt(env);
    assert.equal(latest.sites[0].name, 'PRIVATE_SITE_SENTINEL');
    assert.equal(latest.errors.length, 2);
    assert.doesNotMatch(JSON.stringify(latest), /DO_NOT_LOG_PROVIDER_BODY_OR_TOKEN/);
    await assert.rejects(decrypt(env, 'incorrect-password'));
    const tampered = { ...env, ct: Buffer.from('not valid ciphertext').toString('base64') };
    await assert.rejects(decrypt(tampered));
    assert.equal(run(out).status, 0);
    const history = await decrypt(JSON.parse(await readFile(path.join(out, 'history.enc.json'), 'utf8')));
    assert.equal(history.runs.length, 2);
  } finally { await rm(out, { recursive: true, force: true }); }
});
test('missing or short password never writes artifacts', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'pulse test '));
  try {
    for (const pw of ['', 'short']) {
      assert.equal(run(out, pw).status, 1);
      assert.deepEqual(await readdir(out), []);
    }
  } finally { await rm(out, { recursive: true, force: true }); }
});
