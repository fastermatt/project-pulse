import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const password = 'test-only-password-never-used-live';
function run(out, pw = password, extra = {}) {
  return spawnSync(process.execPath, ['--import', './tests/mock-fetch.mjs', './scripts/collect.mjs'], {
    cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, DASHBOARD_PASSWORD: pw,
      NETLIFY_TOKEN: 'fake-token', PULSE_OUT_DIR: out, PULSE_CONFIG: 'tests/fixture.config.json', ...extra },
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
const ALL = { VERCEL_TOKEN: 'fake-v', VERCEL_TEAM_ID: 'team_x', SUPABASE_TOKEN: 'fake-s', GH_REPOS_TOKEN: 'fake-g', MOCK_DAY0: '2026-01-10' };
test('archived items are listed separately and unqueried; traffic history accumulates across runs', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'pulse test '));
  try {
    const first = run(out, password, ALL);
    assert.equal(first.status, 0, first.stderr);
    assert.doesNotMatch(first.stdout + first.stderr, /fake-/);
    const latest = await decrypt(JSON.parse(await readFile(path.join(out, 'latest.enc.json'), 'utf8')));
    const names = latest.sites.map((x) => x.name.toLowerCase());
    for (const n of ['fastidious-pasca-123116', 'family-quest-prod', 'coffinder']) assert.ok(!names.includes(n), n);
    assert.ok(names.includes('live-proj') && names.includes('sb-live'));
    const byPlatform = Object.fromEntries(latest.archived.map((a) => [a.platform, a]));
    assert.equal(latest.archived.length, 3);
    assert.equal(byPlatform.netlify.deleteUrl, 'https://app.netlify.com/projects/Fastidious-Pasca-123116/configuration/general#danger-zone');
    assert.equal(byPlatform.vercel.deleteUrl, 'https://vercel.com/vteam/Family-Quest-Prod/settings/general#delete-project');
    assert.equal(byPlatform.supabase.deleteUrl, 'https://supabase.com/dashboard/project/archref/settings/general');
    // Archived items were never queried (mock returns 500 for them, which would surface as warnings).
    assert.ok(!latest.errors.some((e) => /fastidious|family-quest|coffinder/i.test(e)), latest.errors.join('; '));
    assert.equal(latest.accounts.netlify, 'https://app.netlify.com/teams/private-team/projects');
    assert.equal(latest.accounts.vercel, 'https://vercel.com/vteam');
    assert.equal(latest.accounts.supabase, 'https://supabase.com/dashboard/org/orgslug');
    assert.equal(latest.accounts.github, 'https://github.com/fastermatt');
    assert.ok(latest.config.groups.Family.includes('family-quest'));
    assert.ok(latest.config.groups.Family.includes('live-proj'), 'group entries given as IDs resolve to current names');
    assert.deepEqual(latest.traffic.supabaseUsers.map((u) => [u.ref, u.users]), [['liveref', 12]]);
    assert.deepEqual(latest.traffic.netlifyForms.map((f) => [f.site, f.form, f.submissions]), [['PRIVATE_SITE_SENTINEL', 'contact', 7], ['PRIVATE_SITE_SENTINEL', 'empty', 0]]);
    const gh = latest.github.repos;
    assert.equal(gh.find((r) => r.name === 'old').archived, true);
    assert.ok(!gh.some((r) => r.name === 'forked'));
    assert.equal(gh.find((r) => r.name === 'alpha').watchers, 2);
    assert.deepEqual(latest.traffic.github.repos.map((r) => r.name), ['alpha']);
    assert.equal(latest.traffic.github.repos[0].referrers.length, 5);
    const h1 = await decrypt(JSON.parse(await readFile(path.join(out, 'history.enc.json'), 'utf8')));
    assert.equal(Object.keys(h1.ghTraffic.alpha).length, 3);
    assert.equal(run(out, password, { ...ALL, MOCK_SHIFT: '1' }).status, 0);
    const h2 = await decrypt(JSON.parse(await readFile(path.join(out, 'history.enc.json'), 'utf8')));
    const days = Object.keys(h2.ghTraffic.alpha).sort();
    assert.deepEqual(days, ['2026-01-08', '2026-01-09', '2026-01-10', '2026-01-11']);
    assert.equal(h2.ghTraffic.alpha['2026-01-08'][0], 10);
    assert.notEqual(h2.ghTraffic.alpha['2026-01-09'][0], h1.ghTraffic.alpha['2026-01-09'][0]);
    assert.equal(h2.ghTraffic.alpha['2026-01-09'].length, 4);
  } finally { await rm(out, { recursive: true, force: true }); }
});
test('without GH_REPOS_TOKEN traffic is reported as not configured', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'pulse test '));
  try {
    assert.equal(run(out).status, 0);
    const latest = await decrypt(JSON.parse(await readFile(path.join(out, 'latest.enc.json'), 'utf8')));
    assert.equal(latest.traffic.github.configured, false);
    assert.match(latest.traffic.github.note, /GH_REPOS_TOKEN/);
  } finally { await rm(out, { recursive: true, force: true }); }
});
