// Project Pulse collector.
// Runs in GitHub Actions (Node 20+, no dependencies). Reads platform APIs with
// tokens from env, sends one lightweight HEAD request to each live site, and
// writes AES-GCM encrypted site/data/latest.enc.json + site/data/history.enc.json
// (password from DASHBOARD_PASSWORD; plaintext data is never written).
//
// Management-API reads (Netlify/Vercel/Supabase) do not count toward your
// bandwidth, function, edge-request or egress quotas. The only quota-touching
// traffic is one HEAD request per site per run (a few hundred bytes).

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.PULSE_OUT_DIR || path.join(ROOT, "site", "data");
const config = JSON.parse(await readFile(path.join(ROOT, "pulse.config.json"), "utf8"));
const limits = config.limits || {};
const exclude = new Set((config.exclude || []).map((s) => s.toLowerCase()));

const env = process.env;
const errors = [];
const now = new Date();

const PASSWORD = env.DASHBOARD_PASSWORD;
if (!PASSWORD || PASSWORD.length < 16) {
  console.error("DASHBOARD_PASSWORD must contain at least 16 characters. Nothing is published without a strong dashboard password.");
  process.exit(1);
}

// ---------- Encryption (PBKDF2-SHA256 -> AES-256-GCM; same WebCrypto API as the browser) ----------
const KDF_ITER = 310000;
const b64 = (buf) => Buffer.from(buf).toString("base64");
const unb64 = (s) => new Uint8Array(Buffer.from(s, "base64"));
async function deriveKey(password, salt, iter) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function encryptJson(obj, key, salt) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return { v: 1, kdf: "pbkdf2-sha256", iter: KDF_ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}
async function decryptJson(env_, password) {
  if (env_?.v !== 1 || env_.kdf !== "pbkdf2-sha256") throw new Error("unsupported format");
  const key = await deriveKey(password, unb64(env_.salt), env_.iter);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(env_.iv) }, key, unb64(env_.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

async function api(url, { token, method = "GET", body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      "User-Agent": "project-pulse",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    // Provider error bodies can contain credentials or private request details.
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

async function safe(label, fn, fallback = null) {
  try {
    return await fn();
  } catch (e) {
    errors.push(`${label}: ${e.message}`);
    // Details belong only in the encrypted dashboard, never public Actions logs.
    return fallback;
  }
}

// ---------- Uptime ----------
async function check(url) {
  const started = performance.now();
  const attempt = async (method) => {
    const res = await fetch(url, {
      method,
      redirect: "follow",
      headers: { "User-Agent": "project-pulse-uptime", ...(method === "GET" ? { Range: "bytes=0-0" } : {}) },
      signal: AbortSignal.timeout(15000),
    });
    // Never download a body.
    res.body?.cancel?.().catch(() => {});
    return res.status;
  };
  try {
    let status = await attempt("HEAD");
    if (status === 405 || status === 501) status = await attempt("GET");
    const ms = Math.round(performance.now() - started);
    // 401/403 = deployment protection (e.g. Vercel SSO): the server answered, so it's up.
    const state = status < 400 ? "up" : status === 401 || status === 403 ? "protected" : status >= 500 ? "down" : "degraded";
    return { status, ms, state };
  } catch (e) {
    return { status: 0, ms: Math.round(performance.now() - started), state: "down", error: e.name === "TimeoutError" ? "timeout" : e.message.slice(0, 80) };
  }
}

// ---------- Netlify ----------
async function netlify() {
  const token = env.NETLIFY_TOKEN;
  if (!token) return { configured: false, sites: [], usage: null };
  const base = "https://api.netlify.com/api/v1";
  const sites = [];
  for (let page = 1; page <= 10; page++) {
    const batch = (await safe("netlify sites", () => api(`${base}/sites?filter=all&per_page=100&page=${page}`, { token }), [])) || [];
    sites.push(...batch);
    if (batch.length < 100) break;
  }
  const accounts = (await safe("netlify accounts", () => api(`${base}/accounts`, { token }), [])) || [];

  const usage = [];
  for (const acct of accounts) {
    const bw = await safe(`netlify bandwidth ${acct.slug}`, () => api(`${base}/accounts/${acct.slug}/bandwidth`, { token }));
    const builds = await safe(`netlify builds ${acct.slug}`, () => api(`${base}/${acct.slug}/builds/status`, { token }));
    usage.push({
      account: acct.name,
      slug: acct.slug,
      plan: acct.type_name || acct.type_slug || null,
      bandwidth: bw
        ? {
            usedBytes: bw.used ?? null,
            includedBytes: bw.included ?? (limits.netlifyBandwidthGB ? limits.netlifyBandwidthGB * 1e9 : null),
            periodStart: bw.period_start_date ?? null,
            periodEnd: bw.period_end_date ?? null,
          }
        : null,
      buildMinutes: builds?.minutes
        ? {
            used: Math.round(Number(builds.minutes.current ?? 0)),
            included: builds.minutes.included_minutes != null ? Number(builds.minutes.included_minutes) : (limits.netlifyBuildMinutes ?? null),
            periodStart: builds.minutes.period_start_date ?? null,
            periodEnd: builds.minutes.period_end_date ?? null,
          }
        : null,
      credits: acct.credits ?? null,
      dashboard: `https://app.netlify.com/teams/${acct.slug}/usage`,
    });
  }

  return {
    configured: true,
    usage,
    sites: sites
      .filter((s) => !exclude.has(s.name.toLowerCase()))
      .map((s) => ({
        id: `netlify:${s.id}`,
        name: s.name,
        platform: "netlify",
        url: s.ssl_url || s.url,
        deploy: {
          state: s.published_deploy?.state || (s.published_deploy ? "ready" : "none"),
          at: s.published_deploy?.published_at || s.updated_at || null,
        },
        repo: s.build_settings?.repo_url || null,
        dashboard: s.admin_url,
      })),
  };
}

// ---------- Vercel ----------
function pickVercelDomain(domains, teamSlugish) {
  const names = domains.map((d) => (typeof d === "string" ? d : d.name)).filter(Boolean);
  const custom = names.filter((n) => !n.endsWith(".vercel.app"));
  if (custom.length) return custom.sort((a, b) => a.length - b.length)[0];
  const clean = names.filter((n) => !teamSlugish || !n.includes(teamSlugish));
  return (clean.length ? clean : names).sort((a, b) => a.length - b.length)[0] || null;
}

async function vercel() {
  const token = env.VERCEL_TOKEN;
  if (!token) return { configured: false, sites: [], usage: null };
  const base = "https://api.vercel.com";
  const team = env.VERCEL_TEAM_ID ? `teamId=${encodeURIComponent(env.VERCEL_TEAM_ID)}` : "";
  const q = (extra = "") => [team, extra].filter(Boolean).join("&");

  const teamInfo = env.VERCEL_TEAM_ID ? await safe("vercel team", () => api(`${base}/v2/teams/${env.VERCEL_TEAM_ID}`, { token })) : null;
  const projectsRes = await safe("vercel projects", () => api(`${base}/v10/projects?${q("limit=100")}`, { token }), { projects: [] });
  const projects = (projectsRes?.projects || []).filter((p) => !exclude.has(p.name.toLowerCase()));

  const sites = [];
  for (const p of projects) {
    const [deps, doms] = await Promise.all([
      safe(`vercel deployments ${p.name}`, () => api(`${base}/v7/deployments?${q(`projectId=${p.id}&target=production&limit=1`)}`, { token }), { deployments: [] }),
      safe(`vercel domains ${p.name}`, () => api(`${base}/v9/projects/${p.id}/domains?${q()}`, { token }), { domains: [] }),
    ]);
    const d = deps?.deployments?.[0];
    const domain = pickVercelDomain(doms?.domains || [], teamInfo?.slug);
    sites.push({
      id: `vercel:${p.id}`,
      name: p.name,
      platform: "vercel",
      url: domain ? `https://${domain}` : null,
      framework: p.framework || null,
      deploy: { state: (d?.state || d?.readyState || "none").toLowerCase(), at: d?.created ? new Date(d.created).toISOString() : null },
      repo: p.link?.repo ? `https://github.com/${p.link.org || p.link.repoOwner || ""}/${p.link.repo}` : null,
      dashboard: teamInfo?.slug ? `https://vercel.com/${teamInfo.slug}/${p.name}` : `https://vercel.com/dashboard`,
    });
  }

  // Detailed usage is only exposed via the billing API on paid plans; on Hobby
  // this 404s and we fall back to a link to the usage page.
  let usage = null;
  if (env.VERCEL_TEAM_ID) {
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
    const res = await fetch(`${base}/v1/billing/charges?${q(`from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    }).catch(() => null);
    if (res?.ok) {
      const text = await res.text();
      const totals = {};
      // Response is JSONL (FOCUS records) or a JSON object; handle both.
      const rows = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
      for (const r of rows) {
        const key = r.ServiceName || r.ChargeDescription || "Other";
        totals[key] = totals[key] || { quantity: 0, unit: r.ConsumedUnit || r.PricingUnit || "", cost: 0 };
        totals[key].quantity += Number(r.ConsumedQuantity || 0);
        totals[key].cost += Number(r.BilledCost || 0);
      }
      usage = { source: "billing", period: { from, to }, services: totals };
    } else {
      usage = { source: "unavailable", reason: res ? `HTTP ${res.status} (Hobby plans don't expose usage via API)` : "request failed" };
    }
  }
  usage = { ...(usage || {}), dashboard: teamInfo?.slug ? `https://vercel.com/${teamInfo.slug}/~/usage` : "https://vercel.com/dashboard/usage", plan: teamInfo?.billing?.plan || null };

  return { configured: true, usage, sites };
}

// ---------- Supabase ----------
async function supabase() {
  const token = env.SUPABASE_TOKEN;
  if (!token) return { configured: false, projects: [] };
  const base = "https://api.supabase.com/v1";
  const projects = (await safe("supabase projects", () => api(`${base}/projects`, { token }), [])) || [];
  const out = [];
  for (const p of projects) {
    if (exclude.has(p.name.toLowerCase())) continue;
    const ref = p.ref || p.id;
    const active = p.status === "ACTIVE_HEALTHY";
    let dbBytes = null;
    let health = null;
    if (active) {
      // One tiny catalog query; doesn't touch your tables or egress quota.
      const rows = await safe(`supabase db size ${p.name}`, () =>
        api(`${base}/projects/${ref}/database/query/read-only`, { token, method: "POST", body: { query: "select pg_catalog.pg_database_size(pg_catalog.current_database())::bigint as bytes" } })
      );
      dbBytes = rows?.[0]?.bytes != null ? Number(rows[0].bytes) : null;
      const h = await safe(`supabase health ${p.name}`, () => api(`${base}/projects/${ref}/health?services=db,auth,rest,storage`, { token }));
      if (Array.isArray(h)) health = Object.fromEntries(h.map((s) => [s.name, s.healthy ? "healthy" : s.status || "unhealthy"]));
    }
    out.push({
      id: `supabase:${ref}`,
      name: p.name,
      ref,
      region: p.region,
      status: p.status,
      createdAt: p.created_at,
      dbBytes,
      dbLimitBytes: limits.supabaseDbMB ? limits.supabaseDbMB * 1024 * 1024 : null,
      health,
      dashboard: `https://supabase.com/dashboard/project/${ref}`,
      usageDashboard: `https://supabase.com/dashboard/org/${p.organization_slug || p.organization_id}/usage`,
    });
  }
  return { configured: true, projects: out, activeLimit: limits.supabaseActiveProjects ?? null };
}

// ---------- GitHub repos (activity) ----------
async function github() {
  const owner = config.githubOwner;
  if (!owner) return { configured: false, repos: [] };
  const token = env.GH_REPOS_TOKEN || env.GITHUB_TOKEN;
  const url = env.GH_REPOS_TOKEN
    ? `https://api.github.com/user/repos?per_page=100&sort=pushed&affiliation=owner`
    : `https://api.github.com/users/${owner}/repos?per_page=100&sort=pushed`;
  const repos = (await safe("github repos", () => api(url, { token, headers: { Accept: "application/vnd.github+json" } }), [])) || [];
  return {
    configured: true,
    repos: repos
      .filter((r) => !r.fork && !r.archived)
      .map((r) => ({ name: r.name, url: r.html_url, private: r.private, pushedAt: r.pushed_at, homepage: r.homepage || null, language: r.language })),
  };
}

// ---------- Run ----------
const [nl, vc, sb, gh] = await Promise.all([
  safe("Netlify collection", netlify, { configured: Boolean(env.NETLIFY_TOKEN), sites: [], usage: [] }),
  safe("Vercel collection", vercel, { configured: Boolean(env.VERCEL_TOKEN), sites: [], usage: null }),
  safe("Supabase collection", supabase, { configured: Boolean(env.SUPABASE_TOKEN), projects: [] }),
  safe("GitHub collection", github, { configured: true, repos: [] }),
]);

const targets = [
  ...nl.sites.filter((s) => s.url && s.deploy.state !== "none"),
  ...vc.sites.filter((s) => s.url),
  ...(config.extraChecks || []).map((c) => ({ id: `custom:${c.url}`, name: c.name, platform: "custom", url: c.url, deploy: null, dashboard: c.url })),
];

// Check with modest concurrency.
const checks = {};
for (let i = 0; i < targets.length; i += 6) {
  const batch = targets.slice(i, i + 6);
  const results = await Promise.all(batch.map((t) => check(t.url)));
  batch.forEach((t, j) => (checks[t.id] = results[j]));
}
// Supabase: derive "uptime" from platform status (no request to the project itself).
for (const p of sb.projects) {
  const unhealthy = p.health && Object.values(p.health).some((v) => v !== "healthy");
  checks[p.id] = { status: null, ms: null, state: p.status === "ACTIVE_HEALTHY" ? (unhealthy ? "degraded" : "up") : p.status?.startsWith("INACTIVE") || p.status === "PAUSED" ? "paused" : "degraded" };
}

// History
await mkdir(OUT_DIR, { recursive: true });
const histPath = path.join(OUT_DIR, "history.enc.json");
let history = { runs: [] };
if (existsSync(histPath)) {
  try {
    history = await decryptJson(JSON.parse(await readFile(histPath, "utf8")), PASSWORD);
  } catch (e) {
    console.warn(`[warn] could not decrypt previous history (password changed or file corrupt): ${e.message}. Starting fresh history.`);
    history = { runs: [] };
  }
}
const CODE = { up: "u", protected: "p", degraded: "g", down: "d", paused: "z" };
const compact = Object.fromEntries(Object.entries(checks).map(([id, c]) => [id, [CODE[c.state] || "g", c.ms]]));
history.runs.push({ t: now.toISOString(), r: compact });
const cutoff = now.getTime() - (config.historyDays || 30) * 86400000;
history.runs = history.runs.filter((r) => new Date(r.t).getTime() >= cutoff);

// Usage history (one point per run; small).
history.usage = history.usage || [];
history.usage.push({
  t: now.toISOString(),
  nb: nl.usage?.[0]?.bandwidth?.usedBytes ?? null,
  nm: nl.usage?.[0]?.buildMinutes?.used ?? null,
  sb: Object.fromEntries(sb.projects.filter((p) => p.dbBytes != null).map((p) => [p.ref, p.dbBytes])),
});
history.usage = history.usage.filter((r) => new Date(r.t).getTime() >= cutoff);

const latest = {
  title: config.title || "Project Pulse",
  generatedAt: now.toISOString(),
  intervalMinutes: Number(env.PULSE_INTERVAL_MINUTES || 60),
  netlify: { configured: nl.configured, usage: nl.usage },
  vercel: { configured: vc.configured, usage: vc.usage },
  supabase: sb,
  github: gh,
  sites: [
    ...targets.map((t) => ({ ...t, check: checks[t.id] })),
    ...sb.projects.map((p) => ({
      id: p.id, name: p.name, platform: "supabase", url: `https://${p.ref}.supabase.co`,
      deploy: { state: p.status.toLowerCase(), at: null }, region: p.region, dashboard: p.dashboard, check: checks[p.id],
    })),
  ],
  errors,
};

const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await deriveKey(PASSWORD, salt, KDF_ITER);
await writeFile(path.join(OUT_DIR, "latest.enc.json"), JSON.stringify(await encryptJson(latest, key, salt)));
await writeFile(histPath, JSON.stringify(await encryptJson(history, key, salt)));
// Never leave plaintext data behind.
await rm(path.join(OUT_DIR, "latest.json"), { force: true });
await rm(path.join(OUT_DIR, "history.json"), { force: true });
console.log(`Checked ${targets.length} sites, ${sb.projects.length} Supabase projects, ${errors.length} warnings.`);
