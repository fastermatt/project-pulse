(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : "");
  const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ""); } catch { return ""; } };

  // Theme toggle (remembered per browser).
  const root = document.documentElement;
  try { const t = localStorage.getItem("pulse-theme"); if (t) root.dataset.theme = t; } catch {}
  $("#theme").addEventListener("click", () => {
    const dark = (root.dataset.theme || "dark") === "dark"; // dark glass is the default
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("pulse-theme", root.dataset.theme); } catch {}
  });

  const STATE = {
    up: { label: "Up", c: "var(--up)" },
    protected: { label: "Up (protected)", c: "var(--up)" },
    degraded: { label: "Degraded", c: "var(--warn)" },
    down: { label: "Down", c: "var(--down)" },
    paused: { label: "Paused", c: "var(--paused)" },
    unknown: { label: "Not checked yet", c: "var(--tick-empty)" },
  };
  const CODE = { u: "up", p: "protected", g: "degraded", d: "down", z: "paused" };
  const PLATFORM = { netlify: "Netlify", vercel: "Vercel", supabase: "Supabase", custom: "Custom", github: "GitHub" };
  const WEB = new Set(["netlify", "vercel", "custom"]);
  const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  const fmtBytes = (b) => {
    if (b == null) return "—";
    const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; let n = b;
    while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
    return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
  };
  const fmtMiB = (b) => (b == null ? "—" : `${(b / 1048576).toFixed(b < 10 * 1048576 ? 1 : 0)} MB`);
  const ago = (iso) => {
    if (!iso) return "—";
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return "just now";
    const m = s / 60; if (m < 60) return `${Math.round(m)}m ago`;
    const h = m / 60; if (h < 48) return `${Math.round(h)}h ago`;
    const d = h / 24; if (d < 60) return `${Math.round(d)}d ago`;
    return `${Math.round(d / 30)}mo ago`;
  };
  const daysLeft = (iso) => (iso ? Math.max(0, Math.ceil((new Date(iso) - Date.now()) / 86400000)) : null);
  const levelColor = (pct) => (pct >= 90 ? "var(--down)" : pct >= 70 ? "var(--warn)" : "var(--up)");
  const fmtPct = (p) => (p == null ? "—" : `${p >= 99.95 ? "100" : p.toFixed(1)}%`);

  // Run a transition after first paint: rings and gauges draw themselves in.
  const animateIn = (el) => requestAnimationFrame(() => requestAnimationFrame(() => el && el.classList.add("go")));

  // ---------- Usage & limits (semicircle gauges) ----------
  function gauge(label, usedTxt, limitTxt, pct, foot, opts = {}) {
    const raw = opts.bar ?? pct;
    const p = raw == null ? 0 : Math.max(0, Math.min(100, raw));
    const c = opts.color || levelColor(p);
    const center = opts.center ?? (raw != null ? `${Math.round(p)}%` : "—");
    const arc = "M10 60A50 50 0 0 1 110 60";
    const aria = `${label}: ${usedTxt}${limitTxt ? ` of ${limitTxt}` : ""}${raw != null ? `, ${Math.round(p)} percent` : ""}`;
    return `<div class="gauge">
      <svg viewBox="0 0 120 68" role="img" aria-label="${esc(aria)}">
        <path class="g-track" d="${arc}" pathLength="100"/>
        <path class="g-val" d="${arc}" pathLength="100" style="--v:${p};--c:${c}"${p <= 0 ? ' visibility="hidden"' : ""}/>
        <text x="60" y="54" text-anchor="middle" class="g-num">${esc(center)}</text>
      </svg>
      <div class="g-label" title="${esc(label)}">${esc(label)}</div>
      <div class="g-sub num">${usedTxt}${limitTxt ? ` <small>/ ${limitTxt}</small>` : ""}</div>
      ${foot ? `<div class="g-foot">${foot}</div>` : ""}
    </div>`;
  }

  function cardHead(key, title, sub, href, linkTxt = "Usage ↗") {
    const letter = { netlify: "N", vercel: "▲", supabase: "S" }[key];
    return `<div class="card-head"><div class="logo ${key}">${letter}</div>
      <div><h3>${esc(title)}</h3>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>
      ${safeUrl(href) ? `<a class="out" href="${esc(href)}" target="_blank" rel="noopener">${linkTxt}</a>` : ""}</div>`;
  }

  function notConfigured(key, name, secret) {
    return `<div class="card">${cardHead(key, name, "Not connected")}<div class="note">Add the <code>${secret}</code> repository secret to show ${name} data.</div></div>`;
  }

  function renderUsage(d) {
    const cards = [];

    // Netlify
    if (!d.netlify?.configured) cards.push(notConfigured("netlify", "Netlify", "NETLIFY_TOKEN"));
    for (const a of d.netlify?.usage || []) {
      let body = "";
      const bw = a.bandwidth;
      if (bw?.usedBytes != null) {
        const pct = bw.includedBytes ? (bw.usedBytes / bw.includedBytes) * 100 : null;
        const left = daysLeft(bw.periodEnd);
        body += gauge("Bandwidth", fmtBytes(bw.usedBytes), bw.includedBytes ? fmtBytes(bw.includedBytes) : "", pct, left != null ? `Resets in ${left} day${left === 1 ? "" : "s"}` : "");
      }
      const bm = a.buildMinutes;
      if (bm?.used != null) {
        const pct = bm.included ? (bm.used / bm.included) * 100 : null;
        body += gauge("Build minutes", `${bm.used}`, bm.included ? `${bm.included}` : "", pct);
      }
      const cr = a.credits;
      if (cr && cr.included != null && cr.used != null) {
        const used = Number(cr.used), inc = Number(cr.included);
        body = gauge("Credits", `${Math.round(used)}`, `${inc}`, inc ? (used / inc) * 100 : null, cr.next_usage_period_start ? `Resets in ${daysLeft(cr.next_usage_period_start)} days` : "") + body;
      }
      body = body ? `<div class="gauges">${body}</div>` : `<div class="note">Netlify didn't return usage numbers for this team (newer credit-based plans hide them from the API). Use the usage link for credits.</div>`;
      const nSites = (d.sites || []).filter((s) => s.platform === "netlify").length;
      cards.push(`<div class="card">${cardHead("netlify", "Netlify", `${a.plan || "Team"} · ${nSites} sites`, a.dashboard)}${body}</div>`);
    }

    // Supabase
    const sb = d.supabase;
    if (!sb?.configured) cards.push(notConfigured("supabase", "Supabase", "SUPABASE_TOKEN"));
    else {
      const active = sb.projects.filter((p) => p.status === "ACTIVE_HEALTHY");
      let body = "";
      if (sb.activeLimit) {
        const pct = (active.length / sb.activeLimit) * 100;
        body += gauge("Active projects", `${active.length}`, `${sb.activeLimit}`, pct,
          active.length >= sb.activeLimit ? "At the limit: restoring a paused project needs another one paused first" : "Free tier");
      }
      for (const p of active) {
        const pct = p.dbLimitBytes && p.dbBytes != null ? (p.dbBytes / p.dbLimitBytes) * 100 : null;
        body += gauge(`${p.name} · database`, fmtMiB(p.dbBytes), p.dbLimitBytes ? fmtMiB(p.dbLimitBytes) : "", pct);
      }
      if (body) body = `<div class="gauges">${body}</div>`;
      const paused = sb.projects.filter((p) => p.status !== "ACTIVE_HEALTHY");
      if (paused.length) body += `<div class="chips">${paused.map((p) => `<span class="chip paused">⏸︎ ${esc(p.name)} · ${esc(p.status.toLowerCase().replace(/_/g, " "))}</span>`).join("")}</div>`;
      cards.push(`<div class="card">${cardHead("supabase", "Supabase", `${sb.projects.length} projects`, sb.projects[0]?.usageDashboard)}${body}</div>`);
    }

    // Vercel
    if (!d.vercel?.configured) cards.push(notConfigured("vercel", "Vercel", "VERCEL_TOKEN"));
    else {
      const vs = (d.sites || []).filter((s) => s.platform === "vercel");
      const ok = vs.filter((s) => s.deploy?.state === "ready").length;
      const failed = vs.filter((s) => s.deploy?.state === "error");
      let body = `<div class="gauges">${gauge("Production deploys ready", `${ok}`, `${vs.length}`, null, "",
        { bar: vs.length ? (ok / vs.length) * 100 : 0, center: `${ok}/${vs.length}`, color: failed.length ? "var(--warn)" : "var(--up)" })}</div>`;
      const u = d.vercel.usage;
      if (u?.source === "billing" && u.services) {
        const rows = Object.entries(u.services).sort((a, b) => b[1].quantity - a[1].quantity).slice(0, 6);
        body += rows.map(([k, v]) => `<div class="dim-row"><span>${esc(k)}</span><span class="num">${Math.round(v.quantity).toLocaleString()} ${esc(v.unit)}</span></div>`).join("");
      } else {
        body += `<div class="note">Vercel's Hobby plan doesn't expose usage through its API. The <b>Usage ↗</b> link opens your live meters.</div>`;
      }
      if (failed.length) body += `<div class="chips">${failed.map((s) => `<span class="chip bad">✕ ${esc(s.name)} · last deploy failed</span>`).join("")}</div>`;
      cards.push(`<div class="card">${cardHead("vercel", "Vercel", `${u?.plan ? u.plan + " · " : ""}${vs.length} projects`, u?.dashboard)}${body}</div>`);
    }

    $("#usage").classList.remove("go");
    $("#usage").innerHTML = cards.join("");
    animateIn($("#usage"));
  }

  // ---------- History helpers ----------
  const runsOf = (history) => history?.runs || [];
  const RANK = { down: 4, degraded: 3, up: 2, protected: 2, paused: 1, unknown: 0 };

  function siteHistory(id, history, n) {
    const runs = runsOf(history);
    const ticks = [];
    for (const r of runs.slice(-n)) {
      const v = r.r[id];
      ticks.push({ t: r.t, state: v ? CODE[v[0]] : "unknown", ms: v ? v[1] : null });
    }
    while (ticks.length < n) ticks.unshift({ t: null, state: "unknown" });
    let up = 0, total = 0;
    for (const r of runs) {
      const v = r.r[id]; if (!v) continue;
      const s = CODE[v[0]]; if (s === "paused") continue;
      total++; if (s === "up" || s === "protected") up++;
    }
    return { ticks, pct: total ? (up / total) * 100 : null, total };
  }

  // Worst-of history across several component ids (one tick per run) plus pooled uptime.
  function groupHistory(ids, history, n) {
    const runs = runsOf(history);
    const ticks = [];
    for (const r of runs.slice(-n)) {
      let state = "unknown", t = r.t;
      for (const id of ids) {
        const v = r.r[id]; if (!v) continue;
        const s = CODE[v[0]] || "unknown";
        if (RANK[s] > RANK[state]) state = s;
      }
      ticks.push({ t, state });
    }
    while (ticks.length < n) ticks.unshift({ t: null, state: "unknown" });
    let up = 0, total = 0;
    for (const r of runs) for (const id of ids) {
      const v = r.r[id]; if (!v) continue;
      const s = CODE[v[0]]; if (s === "paused") continue;
      total++; if (s === "up" || s === "protected") up++;
    }
    return { ticks, pct: total ? (up / total) * 100 : null, total };
  }

  function series(id, history, n) {
    return runsOf(history).slice(-n).map((r) => {
      const v = r.r[id];
      return v ? { state: CODE[v[0]] || "unknown", ms: v[1], t: r.t } : null;
    });
  }

  // ---------- Grouping sites + repos into apps ----------
  const SUFFIX = /-(v\d+|prod|production|deploy|app|web|site)$/;
  function normKey(name) {
    const orig = String(name || "").toLowerCase().trim();
    let k = orig.replace(/[\s_]+/g, "-"), prev;
    do { prev = k; k = k.replace(SUFFIX, ""); } while (k !== prev);
    return k || orig;
  }
  const titleCase = (k) => k.split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") || k;
  const isPlatformHost = (u) => /\.(netlify|vercel)\.app$/i.test(hostOf(u));
  const COMP_ORDER = { vercel: 0, netlify: 1, custom: 2, supabase: 3, github: 4 };
  const DAY = 86400000;
  const SEV = { critical: 3, warning: 2, info: 1 };

  const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "group";
  function buildApps(d, history) {
    // Explicit groups from config run BEFORE automatic name normalisation (case-insensitive).
    const overrides = new Map();
    for (const [title, members] of Object.entries(d.config?.groups || {})) {
      for (const m of Array.isArray(members) ? members : []) overrides.set(String(m).toLowerCase().trim(), { mk: "ov:" + slug(title), key: slug(title), title });
    }
    const groups = new Map();
    const group = (mk, key, title) => {
      if (!groups.has(mk)) groups.set(mk, { key, title: title || null, comps: [], repos: [], homepage: null });
      return groups.get(mk);
    };
    const place = (name) => { const o = overrides.get(String(name || "").toLowerCase().trim()); return o ? group(o.mk, o.key, o.title) : group(normKey(name), normKey(name), null); };

    for (const s of d.sites || []) {
      const g = place(s.name);
      g.comps.push({ kind: s.platform, name: s.name, site: s, url: s.platform === "supabase" ? "" : s.url, dashboard: s.platform === "custom" ? s.url : s.dashboard, state: s.check?.state || "unknown" });
    }
    const spare = [];
    for (const r of d.github?.repos || []) {
      if (r.archived) continue; // archived repos live in the Archive tab
      const o = overrides.get(String(r.name).toLowerCase().trim());
      const mk = o ? o.mk : normKey(r.name);
      if (o) group(o.mk, o.key, o.title).repos.push(r);
      else if (groups.has(mk)) groups.get(mk).repos.push(r);
      else if (r.homepage && safeUrl(r.homepage)) { const g = group(mk, mk, null); g.repos.push(r); g.hpOnly = true; }
      else spare.push(r);
    }
    for (const g of groups.values()) g.homepage = g.repos.map((r) => r.homepage).find((h) => h && safeUrl(h)) || null;

    const apps = [];
    for (const g of groups.values()) {
      const comps = g.comps.slice().sort((a, b) => (COMP_ORDER[a.kind] - COMP_ORDER[b.kind]) || a.name.localeCompare(b.name));
      for (const r of g.repos) comps.push({ kind: "github", name: r.name, repo: r, url: "", dashboard: r.url, state: "ok" });
      const web = comps.filter((c) => WEB.has(c.kind));
      const dbs = comps.filter((c) => c.kind === "supabase");
      const webChecked = web.filter((c) => c.site?.check);

      // Primary live URL
      const withUrl = webChecked.filter((c) => safeUrl(c.url));
      const rank = (c) => (c.state === "up" ? 0 : c.state === "protected" ? 2 : c.state === "degraded" ? 3 : 4);
      const custom = withUrl.find((c) => !isPlatformHost(c.url));
      const upSite = withUrl.slice().sort((a, b) => rank(a) - rank(b)).find((c) => c.state === "up");
      const anySite = withUrl.slice().sort((a, b) => rank(a) - rank(b))[0];
      const hpCustom = g.homepage && !isPlatformHost(g.homepage) ? g.homepage : null;
      const live = custom?.url || hpCustom || upSite?.url || anySite?.url || g.homepage || null;
      const primary = custom || upSite || anySite || null;
      const fallbackDash = dbs[0]?.dashboard || g.repos[0]?.url || null;

      // Issues
      const issues = [];
      const multiWeb = web.length > 1;
      for (const c of webChecked) {
        const ck = c.site.check;
        const suffix = multiWeb ? ` · ${c.name}` : "";
        if (ck.state === "down") issues.push({ sev: "critical", kind: "down", comp: c, text: `Site down (${ck.status ? `HTTP ${ck.status}` : ck.error === "timeout" || !ck.error ? "timeout" : "unreachable"})${suffix}` });
        else if (ck.state === "degraded") issues.push({ sev: "warning", kind: "degraded", comp: c, text: `Degraded (HTTP ${ck.status ?? "?"})${suffix}` });
      }
      for (const plat of ["vercel", "netlify"]) {
        const bad = comps.filter((c) => c.kind === plat && c.site?.deploy?.state === "error");
        if (bad.length) issues.push({ sev: "warning", kind: "deploy", comp: bad[0], text: `Last deploy failed on ${PLATFORM[plat]} (${bad.map((c) => c.name).join(", ")})` });
      }
      for (const c of dbs) {
        const st = c.site.deploy?.state || "";
        if (st !== "active_healthy") {
          const paused = st.startsWith("inactive") || st === "paused";
          issues.push({ sev: "info", kind: paused ? "paused" : "dbstate", comp: c, text: paused ? "Database paused" : `Database ${st.replace(/_/g, " ") || "unavailable"}` });
        } else if (c.state === "degraded") issues.push({ sev: "warning", kind: "degraded", comp: c, text: "Database services unhealthy" });
      }
      for (const c of web) if (c.kind === "netlify" && c.site?.deploy?.state === "none") issues.push({ sev: "info", kind: "none", comp: c, text: "Nothing published" });
      if (webChecked.length && webChecked.length === web.length && webChecked.every((c) => c.state === "protected")) {
        issues.push({ sev: "info", kind: "protected", comp: webChecked[0], text: `Behind login (${PLATFORM[webChecked[0].kind]} protection)` });
      }
      const deployTimes = web.map((c) => c.site?.deploy?.at).filter(Boolean).sort();
      const okDeploys = web.filter((c) => c.site?.deploy?.at && c.site.deploy.state !== "error").map((c) => c.site.deploy.at).sort();
      const lastDeploy = okDeploys.at(-1) || null;
      const lastDeployAny = deployTimes.at(-1) || null;
      const lastPush = g.repos.map((r) => r.pushedAt).filter(Boolean).sort().at(-1) || null;
      const newest = Math.max(lastDeployAny ? +new Date(lastDeployAny) : 0, lastPush ? +new Date(lastPush) : 0);
      if (newest && Date.now() - newest > 180 * DAY) issues.push({ sev: "info", kind: "stale", comp: null, text: "Stale: no deploys or pushes in 6+ months" });
      if (!webChecked.length && !dbs.length && g.hpOnly) issues.push({ sev: "info", kind: "unmonitored", comp: null, text: "Not monitored (no deploy checks)" });
      issues.sort((a, b) => SEV[b.sev] - SEV[a.sev]);

      const health = issues.some((i) => i.sev === "critical") ? "critical" : issues.some((i) => i.sev === "warning") ? "warning" : issues.length ? "info" : "healthy";

      // History
      const histComps = webChecked.length ? webChecked : dbs;
      const hist = groupHistory(histComps.map((c) => c.site.id), history, 24);
      const ser = primary ? series(primary.site.id, history, 24) : [];
      const msOk = ser.filter((p) => p && p.ms != null && p.state !== "down" && p.ms > 0).map((p) => p.ms);

      const names = [...new Set([...comps.map((c) => c.name)])];
      apps.push({
        key: g.key, name: g.title || titleCase(g.key), names, comps, issues, health,
        live, liveIsHomepage: live === g.homepage && !primary?.url, dashboardFallback: fallbackDash, primary,
        pct: hist.pct, ticks: hist.ticks, series: ser, avgMs: msOk.length ? Math.round(msOk.reduce((a, b) => a + b, 0) / msOk.length) : null,
        lastDeploy, lastDeployAny, lastPush, failedDeploy: !lastDeploy && !!lastDeployAny,
        pausedOnly: health === "info" && issues.every((i) => i.kind === "paused" || i.kind === "dbstate"),
      });
    }
    const hr = { critical: 0, warning: 1, healthy: 2, info: 3 };
    apps.sort((a, b) => (hr[a.health] - hr[b.health]) || a.name.localeCompare(b.name));
    apps.forEach((a, i) => { a.id = `app-${i}-${a.key.replace(/[^a-z0-9-]/g, "-")}`; });
    return { apps, spare };
  }

  // ---------- App rendering ----------
  const PILL = {
    healthy: { t: "Healthy", g: "✓" },
    warning: { t: "Needs attention", g: "!" },
    critical: { t: "Down", g: "✕" },
    info: { t: "Info", g: "i" },
    paused: { t: "Paused", g: "⏸︎" },
  };
  const pillOf = (a) => (a.health === "info" && a.pausedOnly ? PILL.paused : PILL[a.health]);
  const ISSUE_GLYPH = { critical: "✕", warning: "!", info: "i" };

  const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  function monogram(a) {
    const w = a.name.split(/\s+/).filter(Boolean);
    const letters = (w.length > 1 ? w[0][0] + w[1][0] : (w[0] || "?").slice(0, 2)).toUpperCase();
    const hue = hash(a.key) % 360;
    return `<div class="mono" aria-hidden="true" style="background:linear-gradient(135deg,hsl(${hue} 62% 54%),hsl(${(hue + 42) % 360} 64% 40%))">${esc(letters)}</div>`;
  }

  function ringSvg(pct, label) {
    const r = 15, c = 2 * Math.PI * r;
    const col = pct == null ? "var(--paused)" : pct >= 99 ? "var(--up)" : pct >= 90 ? "var(--warn)" : "var(--down)";
    const v = pct == null ? 0 : Math.max(0, Math.min(100, pct));
    const txt = pct == null ? "—" : pct >= 99.95 ? "100" : pct >= 10 ? pct.toFixed(0) : pct.toFixed(1);
    return `<svg class="ring" viewBox="0 0 40 40" role="img" aria-label="${esc(label)}: ${pct == null ? "no data" : fmtPct(pct) + " uptime"}">
      <circle class="r-track" cx="20" cy="20" r="${r}"/>
      <circle class="r-val" cx="20" cy="20" r="${r}" pathLength="100" style="--v:${v};--c:${col}"/>
      <text x="20" y="23.5" text-anchor="middle" class="r-num">${txt}</text></svg>`;
  }

  function sparkSvg(a, uid) {
    const ser = a.series; const n = ser.length;
    const ok = ser.filter((p) => p && p.ms != null && p.ms > 0 && p.state !== "down");
    if (!ok.length) return `<div class="spark-empty">${a.primary ? "No response data yet" : "No web checks for this app"}</div>`;
    const W = 240, H = 46, P = 5;
    const vals = ok.map((p) => p.ms);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const span = Math.max(hi - lo, hi * 0.2, 20);
    const x = (i) => (n > 1 ? P + (i * (W - 2 * P)) / (n - 1) : W / 2);
    const y = (v) => P + 3 + (1 - (v - lo) / span) * (H - 2 * P - 8);
    const pts = []; const dots = [];
    ser.forEach((p, i) => {
      if (!p) return;
      if (p.state === "down" || p.ms == null || p.ms <= 0) { dots.push(`<circle cx="${x(i).toFixed(1)}" cy="${P}" r="2.6" class="s-bad"><title>${esc(new Date(p.t).toLocaleString())} · failed check</title></circle>`); return; }
      pts.push([x(i), y(p.ms), p]);
    });
    const line = pts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
    const area = pts.length > 1 ? `${pts[0][0].toFixed(1)},${H} ${line} ${pts.at(-1)[0].toFixed(1)},${H}` : "";
    const last = pts.at(-1);
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="Response time, last ${n} checks, average ${a.avgMs} milliseconds">
      <defs><linearGradient id="sg-${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="sg-a"/><stop offset="1" class="sg-b"/></linearGradient></defs>
      ${area ? `<polygon points="${area}" fill="url(#sg-${uid})"/>` : ""}
      ${pts.length > 1 ? `<polyline points="${line}" class="s-line"/>` : ""}
      ${dots.join("")}
      ${last ? `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.8" class="s-last"/>` : ""}
    </svg>`;
  }

  function compTip(c) {
    const parts = [PLATFORM[c.kind], c.name];
    if (c.kind === "github") parts.push(c.repo.pushedAt ? `pushed ${ago(c.repo.pushedAt)}` : "repository");
    else if (c.kind === "supabase") {
      const st = c.site.deploy?.state || "";
      parts.push(st === "active_healthy" ? (c.state === "degraded" ? "services unhealthy" : "database active") : st.startsWith("inactive") || st === "paused" ? "database paused" : `database ${st.replace(/_/g, " ")}`);
    } else {
      const ck = c.site?.check;
      if (ck) parts.push(ck.state === "protected" ? `behind login (HTTP ${ck.status})` : ck.state === "down" ? `down${ck.status ? ` (HTTP ${ck.status})` : ""}` : ck.state === "degraded" ? `degraded (HTTP ${ck.status})` : `up${ck.ms != null ? ` · ${ck.ms} ms` : ""}`);
      const ds = c.site?.deploy;
      if (ds?.state === "error") parts.push(`last deploy failed${ds.at ? " " + ago(ds.at) : ""}`);
      else if (ds?.state === "none") parts.push("nothing published");
      else if (ds?.at) parts.push(`deployed ${ago(ds.at)}`);
    }
    return parts.join(" · ");
  }
  function compStatus(c) {
    if (c.kind === "github") return { c: "var(--faint)", t: "repository" };
    const st = c.state;
    if (c.kind !== "supabase" && c.site?.deploy?.state === "error" && st !== "down") return { c: "var(--warn)", t: "deploy failed" };
    if (c.kind === "supabase" && c.site.deploy?.state !== "active_healthy") return { c: "var(--paused)", t: "paused" };
    return { up: { c: "var(--up)", t: "up" }, protected: { c: "var(--up)", t: "up, behind login" }, degraded: { c: "var(--warn)", t: "degraded" }, down: { c: "var(--down)", t: "down" }, paused: { c: "var(--paused)", t: "paused" } }[st] || { c: "var(--tick-empty)", t: "not checked" };
  }

  function appCard(a) {
    const pill = pillOf(a);
    const live = safeUrl(a.live);
    const href = live || safeUrl(a.dashboardFallback);
    const host = live ? hostOf(live) : a.comps.some((c) => c.kind === "supabase") ? "Database only" : "No live site";
    const sameKind = (k) => a.comps.filter((c) => c.kind === k).length > 1;
    const badges = a.comps.map((c) => {
      const st = compStatus(c);
      const link = safeUrl(c.dashboard) || safeUrl(c.url);
      const label = PLATFORM[c.kind] + (sameKind(c.kind) ? ` · ${c.name}` : "");
      const inner = `<span class="cdot" style="--c:${st.c}" aria-hidden="true"></span><span class="cn">${esc(label)}</span><span class="sr"> (${esc(st.t)})</span>`;
      return link ? `<a class="comp ${c.kind}" href="${esc(link)}" target="_blank" rel="noopener" title="${esc(compTip(c))}">${inner}</a>` : `<span class="comp ${c.kind}" title="${esc(compTip(c))}">${inner}</span>`;
    }).join("");
    const ticks = a.ticks.map((t) => {
      const s = STATE[t.state] || STATE.unknown;
      return `<i style="--c:${s.c}" title="${esc(t.t ? `${new Date(t.t).toLocaleString()} · ${s.label}` : "No data")}"></i>`;
    }).join("");
    const meta = [
      a.lastDeploy ? `Deployed ${ago(a.lastDeploy)}` : a.failedDeploy ? `Last deploy failed ${ago(a.lastDeployAny)}` : "",
      a.lastPush ? `Pushed ${ago(a.lastPush)}` : "",
    ].filter(Boolean).join(" · ") || "No activity data";
    const shown = a.issues.slice(0, 3);
    const issues = a.issues.length ? `<ul class="issues">${shown.map((i) => `<li class="is-${i.sev}"><i aria-hidden="true">${ISSUE_GLYPH[i.sev]}</i><span>${esc(i.text)}</span></li>`).join("")}${a.issues.length > 3 ? `<li class="more">+${a.issues.length - 3} more</li>` : ""}</ul>` : "";
    return `<article class="app h-${a.health}" id="${a.id}" tabindex="-1" data-name="${esc(a.names.join(" ").toLowerCase() + " " + a.key)}">
      <div class="app-top">
        ${monogram(a)}
        <div class="app-id"><h3 title="${esc(a.names.join(" · "))}">${esc(a.name)}</h3><div class="host" title="${esc(host)}">${esc(host)}</div></div>
        ${ringSvg(a.pct, a.name)}
      </div>
      <div class="app-cta">
        <span class="pill p-${a.health === "info" && a.pausedOnly ? "paused" : a.health}"><i aria-hidden="true">${pill.g}</i>${pill.t}</span>
        ${href ? `<a class="btn" href="${esc(href)}" target="_blank" rel="noopener">${live ? "Open app" : "Open dashboard"} <span aria-hidden="true">↗</span><span class="sr"> (opens in a new tab)</span></a>` : ""}
      </div>
      <div class="metric">
        <div class="metric-top"><span>Response time</span><span class="num">${a.avgMs != null ? `avg ${a.avgMs} ms` : "—"}</span></div>
        ${sparkSvg(a, a.id)}
      </div>
      <div class="metric">
        <div class="metric-top"><span>Last ${a.ticks.length} checks</span><span class="num">${fmtPct(a.pct)}</span></div>
        <div class="ticks slim">${ticks}</div>
      </div>
      <div class="comps">${badges}</div>
      ${issues}
      <div class="app-meta">${esc(meta)}</div>
    </article>`;
  }

  function attnCard(a) {
    const live = safeUrl(a.live);
    const serious = a.issues.filter((i) => i.sev !== "info");
    const seen = new Set(); const links = [];
    if (live) links.push(`<a class="btn sm" href="${esc(live)}" target="_blank" rel="noopener">Open app ↗</a>`);
    for (const i of serious) {
      const c = i.comp; const u = c && safeUrl(c.dashboard);
      if (!u || c.kind === "github" || seen.has(c.kind) || (c.kind === "custom" && u === live)) continue;
      seen.add(c.kind);
      links.push(`<a class="btn sm ghost-link" href="${esc(u)}" target="_blank" rel="noopener">Open in ${PLATFORM[c.kind]} ↗</a>`);
    }
    const pill = PILL[a.health];
    return `<div class="attn h-${a.health}">
      <div class="attn-body">
        <div class="attn-title"><span class="pill p-${a.health}"><i aria-hidden="true">${pill.g}</i>${pill.t}</span><b title="${esc(a.names.join(" · "))}">${esc(a.name)}</b></div>
        <ul class="attn-issues">${serious.map((i) => `<li class="is-${i.sev}">${esc(i.text)}</li>`).join("")}</ul>
      </div>
      <div class="attn-actions">${links.join("")}</div>
    </div>`;
  }

  // ---------- App-level state & views ----------
  let APPS = [];
  const FILTERS = [["all", "All"], ["attention", "Needs attention"], ["healthy", "Healthy"], ["inactive", "Paused / inactive"]];
  const FKEYS = FILTERS.map((f) => f[0]);
  let appFilter = "all";
  try { const f = localStorage.getItem("pulse-app-filter"); if (FKEYS.includes(f)) appFilter = f; } catch {}
  let appQuery = "";
  const matchesFilter = (a, f) => f === "all" || (f === "attention" ? ["critical", "warning"].includes(a.health) : f === "healthy" ? a.health === "healthy" : a.health === "info");

  function renderAppControls() {
    $("#app-filters").innerHTML = FILTERS.map(([k, l]) => `<button type="button" data-k="${k}" aria-pressed="${appFilter === k}">${l}<span class="count num">${APPS.filter((a) => matchesFilter(a, k)).length}</span></button>`).join("");
  }
  function renderApps() {
    renderAppControls();
    const q = appQuery.trim().toLowerCase();
    const shown = APPS.filter((a) => matchesFilter(a, appFilter) && (!q || a.name.toLowerCase().includes(q) || a.key.includes(q) || a.names.some((n) => n.toLowerCase().includes(q))));
    const box = $("#apps");
    box.classList.remove("go");
    if (!shown.length) {
      box.innerHTML = `<div class="empty">${!APPS.length ? "No apps found yet." : q ? `No apps match “${esc(appQuery.trim())}”.` : appFilter === "attention" ? "Nothing needs attention. Everything's healthy." : "Nothing in this view."}</div>`;
      return;
    }
    box.innerHTML = shown.map(appCard).join("");
    animateIn(box);
  }
  function jumpToApp(id) {
    let el = document.getElementById(id);
    if (!el) { appFilter = "all"; appQuery = ""; $("#app-search").value = ""; renderApps(); el = document.getElementById(id); }
    if (!el) return;
    el.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "center" });
    el.focus({ preventScroll: true });
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1800);
  }
  $("#app-filters").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    appFilter = b.dataset.k; renderApps();
    try { localStorage.setItem("pulse-app-filter", appFilter); } catch {}
  });
  $("#app-search").addEventListener("input", (e) => { appQuery = e.target.value; renderApps(); });
  $("#hero").addEventListener("click", (e) => { const b = e.target.closest("[data-jump]"); if (b) jumpToApp(b.dataset.jump); });

  function renderAttention() {
    const list = APPS.filter((a) => a.health === "critical" || a.health === "warning");
    $("#attention-section").hidden = !list.length;
    $("#attention").innerHTML = list.map(attnCard).join("");
  }

  // ---------- Hero ----------
  const HEALTH_META = [
    ["healthy", "Healthy", "var(--up)"],
    ["warning", "Warning", "var(--warn)"],
    ["critical", "Down", "var(--down)"],
    ["info", "Paused / info", "var(--paused)"],
  ];
  function renderHero(d, history, stale) {
    const total = APPS.length;
    const counts = Object.fromEntries(HEALTH_META.map(([k]) => [k, APPS.filter((a) => a.health === k).length]));
    const need = counts.warning + counts.critical;

    let h, p;
    if (!total) { h = "Waiting for the first check"; p = "The first scheduled run will fill this in."; }
    else if (counts.critical) { h = `${need} app${need > 1 ? "s" : ""} need${need > 1 ? "" : "s"} attention`; p = `${counts.critical} down${counts.warning ? `, ${counts.warning} with warnings` : ""}.`; }
    else if (counts.warning) { h = `${need} app${need > 1 ? "s" : ""} need${need > 1 ? "" : "s"} attention`; p = "Everything is reachable, but something needs a look."; }
    else if (d.errors?.length) { h = "Mostly good"; p = "Some monitoring data is unavailable. Review the collector warnings below; missing data does not confirm that every project is healthy."; }
    else { h = "All good"; p = "Every app is up and running."; }
    let tone = counts.critical ? "var(--down)" : need || d.errors?.length ? "var(--warn)" : total ? "var(--up)" : "var(--paused)";
    if (stale) { h = "Monitoring data is out of date"; p = "The scheduled collector has missed its expected refresh. These are the last recorded checks."; tone = "var(--warn)"; }

    // Pills: web sites only (Supabase "uptime" is derived from platform status).
    const web = (d.sites || []).filter((s) => s.platform !== "supabase" && s.check && s.check.state !== "paused");
    const upNow = web.filter((s) => ["up", "protected"].includes(s.check.state)).length;
    const ms = web.map((s) => s.check.ms).filter((x) => x != null && x > 0);
    const avg = ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null;
    const pcts = web.map((s) => siteHistory(s.id, history, 1).pct).filter((x) => x != null);
    const overall = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null;

    // Donut
    const R = 52, GAP = total > 1 ? 1.4 : 0;
    let start = 0; const segs = [];
    for (const [k, , col] of HEALTH_META) {
      const n = counts[k]; if (!n) continue;
      const len = (n / total) * 100;
      const vis = Math.max(len - (Object.values(counts).filter(Boolean).length > 1 ? GAP : 0), 0.5);
      segs.push(`<circle class="seg" cx="70" cy="70" r="${R}" pathLength="100" style="--l:${vis.toFixed(2)};--rest:${(100 - vis).toFixed(2)};--c:${col}" stroke-dashoffset="${(-(start + GAP / 2)).toFixed(2)}"/>`);
      start += len;
    }
    const aria = total ? `${counts.healthy} of ${total} apps healthy. ${counts.warning} warning, ${counts.critical} down, ${counts.info} paused or informational.` : "No apps yet";
    const donut = `<div class="donut"><svg viewBox="0 0 140 140" role="img" aria-label="${esc(aria)}">
        <circle class="d-track" cx="70" cy="70" r="${R}"/>
        <g transform="rotate(-90 70 70)">${segs.join("")}</g></svg>
        <div class="donut-center"><b class="num">${counts.healthy}</b><span>of ${total} healthy</span></div></div>`;

    const legend = HEALTH_META.filter(([k]) => counts[k]).map(([k, l, col]) => `<li><i style="--c:${col}"></i><b class="num">${counts[k]}</b> ${l}</li>`).join("");
    const strip = APPS.map((a) => `<button type="button" class="sq h-${a.health}" data-jump="${a.id}" title="${esc(a.name)} · ${pillOf(a).t}" aria-label="${esc(a.name)}: ${pillOf(a).t}. Jump to card"></button>`).join("");

    $("#hero").classList.remove("go");
    $("#hero").innerHTML = `<div class="hero-main">
        ${donut}
        <div class="hero-text">
          <h2 style="--c:${tone}"><span class="pulse" aria-hidden="true"></span>${esc(h)}</h2>
          <p>${esc(p)}</p>
          <div class="stat-pills">
            <div class="spill"><b class="num">${web.length ? `${upNow}/${web.length}` : "—"}</b><span>sites up now</span></div>
            <div class="spill"><b class="num">${avg != null ? avg + " ms" : "—"}</b><span>avg response</span></div>
            <div class="spill"><b class="num">${fmtPct(overall)}</b><span>recorded uptime</span></div>
          </div>
          ${legend ? `<ul class="legend">${legend}</ul>` : ""}
        </div>
      </div>
      ${total ? `<div class="strip-wrap"><div class="strip-label">Every app, one block each. Click to jump.</div><div class="strip">${strip}</div></div>` : ""}`;
    animateIn($("#hero"));
  }

  // ---------- All checks (detailed per-site list) ----------
  let checkFilter = "all";
  function renderSites(d, history) {
    const N = matchMedia("(max-width: 760px)").matches ? 36 : 48;
    const sites = (d.sites || []).map((s) => ({ ...s, h: siteHistory(s.id, history, N), state: s.check?.state || "unknown" }));
    const rank = { down: 0, degraded: 1, unknown: 2, up: 3, protected: 3, paused: 4 };
    const deployBad = (s) => s.deploy?.state === "error";
    sites.sort((a, b) => (rank[a.state] - rank[b.state]) || (deployBad(b) - deployBad(a)) || a.name.localeCompare(b.name));

    const issues = sites.filter((s) => ["down", "degraded"].includes(s.state) || deployBad(s));
    $("#checks-count").textContent = `${sites.length}`;
    const tabs = [["all", "All", sites.length], ...["netlify", "vercel", "supabase", "custom"].map((p) => [p, PLATFORM[p], sites.filter((s) => s.platform === p).length]).filter((t) => t[2]), ["issues", "Issues", issues.length]];
    $("#filters").innerHTML = tabs.map(([k, l, c]) => `<button role="tab" data-k="${k}" aria-selected="${checkFilter === k}">${l}<span class="count num">${c}</span></button>`).join("");
    $("#filters").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; checkFilter = b.dataset.k; renderSites(d, history); };

    const shown = sites.filter((s) => checkFilter === "all" || (checkFilter === "issues" ? issues.includes(s) : s.platform === checkFilter));
    if (!shown.length) { $("#sites").innerHTML = `<div class="empty">${checkFilter === "issues" ? "No issues. Everything's healthy." : "Nothing here yet."}</div>`; return; }

    $("#sites").innerHTML = shown.map((s) => {
      const st = STATE[s.state] || STATE.unknown;
      let host = ""; try { host = s.url ? new URL(s.url).host : ""; } catch {}
      const deploy = s.deploy?.state && s.platform !== "supabase"
        ? (s.deploy.at && !deployBad(s) ? ` · deployed ${ago(s.deploy.at)}` : "")
        : s.region ? ` · ${esc(s.region)}` : "";
      const ticks = s.h.ticks.map((t) => {
        const c = (STATE[t.state] || STATE.unknown).c;
        const title = t.t ? `${new Date(t.t).toLocaleString()} · ${(STATE[t.state] || STATE.unknown).label}${t.ms != null ? ` · ${t.ms} ms` : ""}` : "No data";
        return `<i style="--c:${c}" title="${esc(title)}"></i>`;
      }).join("");
      const link = safeUrl(s.platform === "supabase" ? s.dashboard : s.url);
      return `<div class="site">
        <div class="site-name"><span class="dot" style="--c:${st.c}" title="${st.label}"></span>
          <div class="txt"><div class="nrow">${link ? `<a class="n" href="${esc(link)}" target="_blank" rel="noopener">${esc(s.name)}</a>` : `<span class="n">${esc(s.name)}</span>`}${deployBad(s) ? `<span class="chip bad sm">deploy failed</span>` : ""}</div>
          <div class="host"><span class="pf ${s.platform}">${PLATFORM[s.platform]}</span><span>${esc(host)}${deploy}</span></div></div></div>
        <div class="ticks-wrap"><div class="ticks">${ticks}</div><div class="lbl"><span>Last ${N} checks</span><span>${esc(st.label)}${s.check?.status ? ` · HTTP ${s.check.status}` : ""}</span><span>latest</span></div></div>
        <div class="ms num">${s.check?.ms != null ? `${s.check.ms} ms` : "—"}<small>response</small></div>
        <div class="pct num">${s.state === "paused" ? "—" : s.h.pct != null ? `${s.h.pct >= 99.95 ? "100" : s.h.pct.toFixed(1)}%` : "—"}<small>uptime</small></div>
      </div>`;
    }).join("");
  }

  function renderWarnings(d) {
    const errs = d.errors || [];
    $("#warnings").hidden = !errs.length;
    if (!errs.length) return;
    const el = $("#warnings"); el.hidden = false;
    el.querySelector("summary").textContent = `${errs.length} collector warning${errs.length > 1 ? "s" : ""}`;
    el.querySelector("ul").innerHTML = errs.map((e) => `<li>${esc(e)}</li>`).join("");
  }

  // ---------- Shared data for the extra tabs ----------
  let D = null, HIST = null, SPARE = [];
  let SERIES = null; // declared before initTabs so a saved "traffic" tab can't hit it early
  let pendingApps = false;
  const nf = (n) => Number(n || 0).toLocaleString();
  const lower = (x) => String(x || "").toLowerCase();
  const GLYPH = { netlify: "N", vercel: "▲", supabase: "S", github: "GH", custom: "↗" };
  const LOCK_SVG = `<svg class="lk" viewBox="0 0 16 16" width="12" height="12" aria-label="Private" role="img"><rect x="3" y="7" width="10" height="7" rx="2" fill="currentColor"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;
  const glyph = (k) => `<span class="tg ${k}" aria-hidden="true">${GLYPH[k] || "↗"}</span>`;

  // ---------- Tabs ----------
  const TABS = ["overview", "traffic", "links", "archive"];
  const TAB_KEY = "pulse-tab";
  const hashTab = () => { const h = location.hash.replace(/^#/, "").toLowerCase(); return h === "apps" ? "overview" : TABS.includes(h) ? h : null; };
  function setTab(t, persist = true) {
    for (const k of TABS) {
      $("#panel-" + k).hidden = k !== t;
      const b = $(`#tabs [data-tab="${k}"]`);
      b.setAttribute("aria-selected", String(k === t));
      b.tabIndex = k === t ? 0 : -1;
    }
    if (persist) { try { localStorage.setItem(TAB_KEY, t); } catch {} }
    if (t === "traffic") { try { drawChart(); } catch (e) { console.warn(e); } }
  }
  (function initTabs() {
    let t = hashTab();
    if (!t) { try { t = localStorage.getItem(TAB_KEY); } catch {} }
    if (!TABS.includes(t)) t = "overview";
    pendingApps = location.hash === "#apps";
    setTab(t, false);
    $("#tabs").addEventListener("click", (e) => {
      const b = e.target.closest("[data-tab]"); if (!b) return;
      setTab(b.dataset.tab);
      try { history.replaceState(null, "", "#" + b.dataset.tab); } catch {}
      window.scrollTo({ top: 0, behavior: reduceMotion() ? "auto" : "smooth" });
    });
    $("#tabs").addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const i = TABS.indexOf(document.activeElement?.dataset?.tab); if (i < 0) return;
      const n = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
      setTab(n); $(`#tabs [data-tab="${n}"]`).focus();
      try { history.replaceState(null, "", "#" + n); } catch {}
    });
    window.addEventListener("hashchange", () => { const h = hashTab(); if (h) { setTab(h); if (location.hash === "#apps") $("#apps-section").scrollIntoView({ block: "start" }); } });
  })();

  // ---------- Traffic tab ----------
  const REPO_NEW_TOKEN = "https://github.com/settings/personal-access-tokens/new";
  const REPO_SECRETS = "https://github.com/fastermatt/project-pulse/settings/secrets/actions";
  const extLink = (u, t, cls = "") => (safeUrl(u) ? `<a class="${cls}" href="${esc(u)}" target="_blank" rel="noopener">${t}</a>` : "");

  // Daily series summed across repos from history.ghTraffic (last <= 90 days).
  function trafficSeries(history) {
    const agg = {};
    for (const days of Object.values(history?.ghTraffic || {})) {
      for (const [date, a] of Object.entries(days || {})) {
        const x = (agg[date] = agg[date] || [0, 0, 0, 0]);
        for (let i = 0; i < 4; i++) x[i] += Number(a[i] || 0);
      }
    }
    const dates = Object.keys(agg).sort();
    if (!dates.length) return null;
    const end = new Date(dates.at(-1) + "T00:00:00Z");
    let start = new Date(dates[0] + "T00:00:00Z");
    const min = new Date(end.getTime() - 89 * DAY);
    if (start < min) start = min;
    const out = [];
    for (let t = start.getTime(); t <= end.getTime(); t += DAY) {
      const iso = new Date(t).toISOString().slice(0, 10);
      const a = agg[iso] || [0, 0, 0, 0];
      out.push({ date: iso, views: a[0], vu: a[1], clones: a[2], cu: a[3] });
    }
    return out;
  }
  function drawChart() {
    const el = $("#gh-chart");
    if (!el || !SERIES) return;
    const W = Math.round(el.clientWidth);
    if (W < 40) return;
    const H = W < 520 ? 200 : 240, L = 38, R = 10, T = 12, B = 26;
    const n = SERIES.length;
    const maxV = Math.max(1, ...SERIES.map((p) => Math.max(p.views, p.clones)));
    const step = maxV <= 5 ? 1 : Math.pow(10, Math.floor(Math.log10(maxV / 4)));
    const nice = [1, 2, 2.5, 5, 10].map((m) => m * step).find((s) => maxV / s <= 4) || step * 10;
    const top = Math.ceil(maxV / nice) * nice;
    const x = (i) => L + (n > 1 ? (i * (W - L - R)) / (n - 1) : (W - L - R) / 2);
    const y = (v) => T + (1 - v / top) * (H - T - B);
    const line = (k) => SERIES.map((p, i) => `${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join(" ");
    const area = `${x(0).toFixed(1)},${y(0)} ${line("views")} ${x(n - 1).toFixed(1)},${y(0)}`;
    let grid = "";
    for (let v = 0; v <= top + 0.001; v += nice) grid += `<line class="gl" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="ax" x="${L - 6}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end">${v}</text>`;
    const ticks = Math.min(5, n); let xl = "";
    for (let k = 0; k < ticks; k++) {
      const i = ticks === 1 ? 0 : Math.round((k * (n - 1)) / (ticks - 1));
      const lab = new Date(SERIES[i].date + "T00:00:00Z").toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
      xl += `<text class="ax" x="${x(i).toFixed(1)}" y="${H - 7}" text-anchor="${k === 0 ? "start" : k === ticks - 1 ? "end" : "middle"}">${lab}</text>`;
    }
    const bw = n > 1 ? (W - L - R) / (n - 1) : 20;
    const hits = SERIES.map((p, i) => `<rect class="hit" x="${(x(i) - bw / 2).toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${H - T - B}"><title>${esc(new Date(p.date + "T00:00:00Z").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }))} · ${p.views} views (${p.vu} unique) · ${p.clones} clones (${p.cu} unique)</title></rect>`).join("");
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Daily GitHub views and clones across all repos, last ${n} days">
      <defs><linearGradient id="gv" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="gv-a"/><stop offset="1" class="gv-b"/></linearGradient></defs>
      ${grid}${xl}<polygon class="av" points="${area}" fill="url(#gv)"/>
      <polyline class="lv" points="${line("views")}"/><polyline class="lc" points="${line("clones")}"/>${hits}</svg>`;
  }
  let resizeT; window.addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (!$("#panel-traffic").hidden) drawChart(); }, 120); });

  const kpi = (v, l, sub = "") => `<div class="kpi"><b class="num">${v}</b><span>${l}</span>${sub ? `<small>${sub}</small>` : ""}</div>`;
  function rankList(rows, valKey) {
    const max = Math.max(1, ...rows.map((r) => r[valKey]));
    return `<ul class="rank">${rows.map((r) => `<li><div class="rk-top"><span class="rk-name" title="${esc(r.label)}">${esc(r.label)}</span><span class="num rk-val">${nf(r[valKey])}<small> · ${nf(r.uniques)} unique</small></span></div><div class="rk-bar"><i style="width:${Math.max(3, (r[valKey] / max) * 100).toFixed(1)}%"></i></div></li>`).join("")}</ul>`;
  }

  function renderTraffic(d, history) {
    const t = d.traffic || {};
    const gh = t.github;
    const info = new Map((d.github?.repos || []).map((r) => [r.name, r]));
    let html = `<section><h3 class="sub-title">${glyph("github")}GitHub <small>views and clones of your repositories</small></h3>`;
    if (!gh || !gh.configured) {
      html += `<div class="card setup"><div class="setup-head"><span class="chip warn">Not connected</span><h4>Turn on GitHub traffic</h4></div>
        <p>${esc(gh?.note || "Add a GH_REPOS_TOKEN secret to see views, clones and referrers.")}</p>
        <ol class="steps">
          <li>Open GitHub → Settings → Developer settings → Personal access tokens → <b>Fine-grained tokens</b> → Generate new token.</li>
          <li>Repository access: <b>All repositories</b>.</li>
          <li>Repository permissions: <b>Administration: Read-only</b> and <b>Metadata: Read-only</b>.</li>
          <li>Copy the token and add it as a repository secret named <code>GH_REPOS_TOKEN</code> in <code>fastermatt/project-pulse</code> (Settings → Secrets and variables → Actions).</li>
          <li>Run the <b>Pulse</b> workflow from the Actions tab. Traffic appears here after the run finishes.</li>
        </ol>
        <div class="row-actions">${extLink(REPO_NEW_TOKEN, "Create token ↗", "btn sm")}${extLink(REPO_SECRETS, "Add secret ↗", "btn sm ghost-link")}</div></div>`;
    } else {
      const rows = (gh.repos || []).slice().sort((a, b) => (b.views.count - a.views.count) || (b.clones.count - a.clones.count) || a.name.localeCompare(b.name));
      const sum = (f) => rows.reduce((acc, r) => acc + f(r), 0);
      if (gh.note) html += `<div class="note warnnote">${esc(gh.note)}</div>`;
      if (!rows.length) html += `<div class="card"><div class="note">No traffic numbers came back yet. GitHub only keeps 14 days; the next collector run will fill this in.</div></div>`;
      else {
        html += `<div class="kpis">${kpi(nf(sum((r) => r.views.count)), "Views", "last 14 days")}${kpi(nf(sum((r) => r.views.uniques)), "Unique visitors", "summed per repo")}${kpi(nf(sum((r) => r.clones.count)), "Clones", "last 14 days")}${kpi(nf(sum((r) => r.clones.uniques)), "Unique cloners", "summed per repo")}</div>`;
        SERIES = trafficSeries(history);
        html += `<div class="card chart-card"><div class="card-top"><h4>Daily views &amp; clones</h4><div class="legend2"><span><i class="k-v"></i>Views</span><span><i class="k-c"></i>Clones</span></div></div>
          ${SERIES ? `<div id="gh-chart" class="chart"></div><div class="chart-foot">All repos combined · ${SERIES.length} day${SERIES.length === 1 ? "" : "s"} recorded (history is kept past GitHub's 14-day window)</div>` : `<div class="note">Daily history will build up after the next collector runs.</div>`}</div>`;
        html += `<div class="card tbl-card"><div class="card-top"><h4>By repository</h4></div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Repository</th><th class="r">Views</th><th class="r">Unique</th><th class="r">Clones</th><th class="r">Unique</th><th class="r">Stars</th><th class="r">Forks</th></tr></thead><tbody>${rows.map((r) => {
          const i = info.get(r.name);
          return `<tr><td>${i?.url ? extLink(i.url, esc(r.name), "tl") : esc(r.name)}${i?.private ? ` ${LOCK_SVG}` : ""}</td><td class="r num">${nf(r.views.count)}</td><td class="r num dim">${nf(r.views.uniques)}</td><td class="r num">${nf(r.clones.count)}</td><td class="r num dim">${nf(r.clones.uniques)}</td><td class="r num">${i ? nf(i.stars) : "—"}</td><td class="r num">${i ? nf(i.forks) : "—"}</td></tr>`;
        }).join("")}</tbody></table></div></div>`;
        const refs = new Map(), paths = new Map();
        for (const r of rows) {
          for (const e of r.referrers || []) { const x = refs.get(e.referrer) || { label: e.referrer, count: 0, uniques: 0 }; x.count += e.count || 0; x.uniques += e.uniques || 0; refs.set(e.referrer, x); }
          for (const e of r.paths || []) { const x = paths.get(e.path) || { label: e.path, title: e.title, count: 0, uniques: 0 }; x.count += e.count || 0; x.uniques += e.uniques || 0; paths.set(e.path, x); }
        }
        const top = (m) => [...m.values()].sort((a, b) => b.count - a.count).slice(0, 8);
        const tr = top(refs), tp = top(paths);
        html += `<div class="two-col"><div class="card"><div class="card-top"><h4>Top referrers</h4></div>${tr.length ? rankList(tr, "count") : `<div class="note">No referrer data yet.</div>`}</div>
          <div class="card"><div class="card-top"><h4>Top paths</h4></div>${tp.length ? rankList(tp, "count") : `<div class="note">No path data yet.</div>`}</div></div>`;
      }
    }
    html += `</section>`;

    // Sites: Netlify forms + Supabase users
    const forms = (t.netlifyForms || []).slice().sort((a, b) => (b.submissions - a.submissions) || String(a.site).localeCompare(b.site));
    const users = (t.supabaseUsers || []).slice().sort((a, b) => b.users - a.users);
    html += `<section><h3 class="sub-title">${glyph("custom")}Your sites <small>people interacting with them</small></h3><div class="two-col">
      <div class="card"><div class="card-top"><h4>${glyph("netlify")}Netlify form submissions</h4></div>${forms.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Site</th><th>Form</th><th class="r">Submissions</th><th class="r">Last</th></tr></thead><tbody>${forms.map((f) => `<tr><td>${extLink(f.dashboard, esc(f.site), "tl") || esc(f.site)}</td><td>${esc(f.form)}</td><td class="r num">${nf(f.submissions)}</td><td class="r dim">${f.lastAt ? ago(f.lastAt) : "never"}</td></tr>`).join("")}</tbody></table></div>` : `<div class="note">No forms found on your Netlify sites.</div>`}</div>
      <div class="card"><div class="card-top"><h4>${glyph("supabase")}Supabase app users</h4></div>${users.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Project</th><th class="r">Users</th><th class="r">Last sign-in</th><th class="r">Last signup</th></tr></thead><tbody>${users.map((u) => `<tr><td>${/^[a-z0-9]+$/i.test(u.ref || "") ? extLink(`https://supabase.com/dashboard/project/${u.ref}/auth/users`, esc(u.name), "tl") : esc(u.name)}</td><td class="r num">${nf(u.users)}</td><td class="r dim">${u.lastSignIn ? ago(u.lastSignIn) : "never"}</td><td class="r dim">${u.lastSignup ? ago(u.lastSignup) : "never"}</td></tr>`).join("")}</tbody></table></div>` : `<div class="note">No Supabase user counts available (needs an active project and SUPABASE_TOKEN).</div>`}</div></div></section>`;

    const acct = d.accounts || {};
    html += `<section><div class="card untracked"><div class="card-top"><h4><span class="chip">Not tracked yet</span> Site visitors</h4></div>
      <p><b>Vercel Web Analytics</b> is off on all projects. Turn it on per project in Vercel → Analytics, and add the <code>@vercel/analytics</code> snippet to each app so it can count visits.</p>
      <p><b>Netlify visitor analytics</b> is a paid add-on, so there are no numbers to show until it's enabled.</p>
      <div class="row-actions">${extLink(acct.vercel || "https://vercel.com/dashboard", "Open Vercel ↗", "btn sm ghost-link")}${extLink(acct.netlify || "https://app.netlify.com", "Open Netlify ↗", "btn sm ghost-link")}</div></div></section>`;

    $("#traffic").innerHTML = html;
    if (!$("#panel-traffic").hidden) drawChart();
  }

  // ---------- Links tab ----------
  let linkQuery = "";
  function tile({ kind, name, host, meta, url, locked, badge, dot }) {
    const q = lower([name, host, meta, kind, badge].join(" "));
    return { q, html: `<a class="tile" href="${esc(url)}" target="_blank" rel="noopener">${glyph(kind)}<span class="tt"><b>${dot ? `<i class="sdot" style="--c:${dot}" aria-hidden="true"></i>` : ""}<span class="tn">${esc(name)}</span>${locked ? LOCK_SVG : ""}${badge ? `<em class="badge">${esc(badge)}</em>` : ""}</b><small>${esc([host, meta].filter(Boolean).join(" · "))}</small></span><span class="to" aria-hidden="true">↗</span><span class="sr"> (opens in a new tab)</span></a>` };
  }
  function buildLinkSections(d) {
    const secs = [];
    const seenHost = new Set(); const live = [];
    for (const s of d.sites || []) {
      if (s.platform === "supabase" || !safeUrl(s.url)) continue;
      const h = hostOf(s.url); if (seenHost.has(h)) continue; seenHost.add(h);
      const st = STATE[s.check?.state || "unknown"] || STATE.unknown;
      live.push(tile({ kind: s.platform, name: s.name, host: h, meta: st.label, url: s.url, dot: st.c }));
    }
    for (const r of d.github?.repos || []) {
      if (!safeUrl(r.homepage)) continue;
      const h = hostOf(r.homepage); if (seenHost.has(h)) continue; seenHost.add(h);
      live.push(tile({ kind: "custom", name: r.name, host: h, meta: "Repo homepage", url: r.homepage }));
    }
    secs.push({ title: "Live sites", sub: "Every site URL, custom domains included", tiles: live });

    const dash = [];
    for (const s of (d.sites || []).slice().sort((a, b) => (COMP_ORDER[a.platform] - COMP_ORDER[b.platform]) || a.name.localeCompare(b.name))) {
      if (!["netlify", "vercel", "supabase"].includes(s.platform) || !safeUrl(s.dashboard)) continue;
      dash.push(tile({ kind: s.platform, name: s.name, host: hostOf(s.dashboard), meta: `${PLATFORM[s.platform]} dashboard`, url: s.dashboard }));
    }
    secs.push({ title: "App dashboards", sub: "Netlify, Vercel and Supabase project consoles", tiles: dash });

    const repos = (d.github?.repos || []).slice().sort((a, b) => (Number(a.archived) - Number(b.archived)) || String(b.pushedAt).localeCompare(String(a.pushedAt)));
    secs.push({ title: "GitHub repos", sub: `${repos.length} repositor${repos.length === 1 ? "y" : "ies"}`, tiles: repos.filter((r) => safeUrl(r.url)).map((r) => tile({ kind: "github", name: r.name, host: r.language || "", meta: `★ ${nf(r.stars)} · ⑂ ${nf(r.forks)} · pushed ${ago(r.pushedAt)}`, url: r.url, locked: r.private, badge: r.archived ? "Archived" : "" })) });

    const acct = d.accounts || {};
    const A = [["netlify", "Netlify team", acct.netlify], ["vercel", "Vercel", acct.vercel], ["supabase", "Supabase organization", acct.supabase], ["github", "GitHub profile", acct.github]];
    secs.push({ title: "Accounts", sub: "", tiles: A.filter((a) => safeUrl(a[2])).map(([k, n, u]) => tile({ kind: k, name: n, host: hostOf(u), meta: "", url: u })) });

    const custom = (d.config?.links || []).filter((l) => l && safeUrl(l.url));
    const byGroup = new Map();
    for (const l of custom) { const g = l.group || "Other"; if (!byGroup.has(g)) byGroup.set(g, []); byGroup.get(g).push(tile({ kind: "custom", name: l.label || hostOf(l.url), host: hostOf(l.url), meta: g, url: l.url })); }
    if (byGroup.size) for (const [g, tiles] of byGroup) secs.push({ title: byGroup.size === 1 && g === "Other" ? "Custom" : `Custom · ${g}`, sub: "", tiles });
    else secs.push({ title: "Custom", sub: "", tiles: [], emptyHint: `Add your own links under <code>links</code> in pulse.config.json, e.g. <code>{"label": "Docs", "url": "https://…", "group": "Work"}</code>.` });
    return secs;
  }
  function renderLinks() {
    if (!D) return;
    const q = lower(linkQuery).trim();
    let any = false;
    const html = buildLinkSections(D).map((s) => {
      const shown = q ? s.tiles.filter((t) => t.q.includes(q)) : s.tiles;
      if (q && !shown.length) return "";
      if (!shown.length && !s.emptyHint) return "";
      any = true;
      return `<section class="lsec"><h3 class="sub-title">${esc(s.title)}${s.sub ? ` <small>${esc(s.sub)}</small>` : ""}<span class="count num">${shown.length}</span></h3>${shown.length ? `<div class="tiles">${shown.map((t) => t.html).join("")}</div>` : `<div class="note">${s.emptyHint}</div>`}</section>`;
    }).join("");
    $("#links").innerHTML = any ? html : `<div class="empty">No links match “${esc(linkQuery.trim())}”.</div>`;
  }
  $("#link-search").addEventListener("input", (e) => { linkQuery = e.target.value; renderLinks(); });

  // ---------- Archive tab ----------
  const DONE_KEY = "pulse-archive-done";
  const readDone = () => { try { return JSON.parse(localStorage.getItem(DONE_KEY) || "{}") || {}; } catch { return {}; } };
  const writeDone = (m) => { try { localStorage.setItem(DONE_KEY, JSON.stringify(m)); } catch {} };
  const DORMANT_DAYS = 180;
  function dormantItems() {
    const out = [];
    for (const a of APPS) {
      const newest = Math.max(a.lastDeployAny ? +new Date(a.lastDeployAny) : 0, a.lastPush ? +new Date(a.lastPush) : 0);
      if (!newest || Date.now() - newest <= DORMANT_DAYS * DAY) continue;
      const links = []; const seen = new Set();
      if (safeUrl(a.live)) links.push(["Open site", a.live]);
      for (const c of a.comps) { const u = safeUrl(c.dashboard); if (!u || seen.has(c.kind + u) || (c.kind === "custom" && u === a.live)) continue; seen.add(c.kind + u); links.push([`${PLATFORM[c.kind]}`, u]); }
      out.push({ name: a.name, at: newest, what: "App", links });
    }
    for (const r of SPARE) {
      const at = r.pushedAt ? +new Date(r.pushedAt) : 0;
      if (!at || Date.now() - at <= DORMANT_DAYS * DAY) continue;
      out.push({ name: r.name, at, what: "Repo with no site", links: [["GitHub", r.url]] });
    }
    return out.sort((a, b) => a.at - b.at);
  }
  function renderArchive() {
    if (!D) return;
    const arch = D.archived || [];
    const done = readDone();
    const key = (x) => `${x.platform}:${x.name}`;
    const doneCount = arch.filter((x) => done[key(x)]).length;
    const badge = $("#tab-archive-count");
    badge.hidden = !arch.length; badge.textContent = String(arch.length);
    const ghArch = (D.github?.repos || []).filter((r) => r.archived);
    const dormant = dormantItems();

    let html = `<section><h3 class="sub-title">Ready to delete <small>hidden from the dashboard and not monitored</small><span id="arch-progress" class="count num">${doneCount}/${arch.length} done</span></h3>`;
    if (!arch.length) html += `<div class="empty">Nothing archived. Add project names to <code>archive</code> in pulse.config.json to move them here.</div>`;
    else html += `<ul class="checklist">${arch.map((x) => {
      const id = esc(key(x)); const plat = PLATFORM[x.platform] || x.platform;
      return `<li class="arch${done[key(x)] ? " is-done" : ""}">
        <label class="ck"><input type="checkbox" data-done="${id}"${done[key(x)] ? " checked" : ""}><span class="sr">Mark ${esc(x.name)} as done</span><i aria-hidden="true"></i></label>
        <div class="arch-main"><div class="arch-name"><b>${esc(x.name)}</b><span class="pf ${esc(x.platform)}">${esc(plat)}</span>${x.status ? `<span class="chip">${esc(String(x.status).replace(/_/g, " ").toLowerCase())}</span>` : ""}</div>
        <div class="arch-sub">${x.lastDeployAt ? `Last deploy ${ago(x.lastDeployAt)}` : "No deploy data"}</div></div>
        <div class="arch-actions">${extLink(x.url || x.dashboard, "Open ↗", "btn sm ghost-link")}${extLink(x.deleteUrl, `Delete in ${esc(plat)} ↗`, "btn sm danger")}</div></li>`;
    }).join("")}</ul><div class="hint">The checkboxes are a personal checklist saved in this browser. Nothing is deleted from here.</div>`;
    html += `</section>`;

    html += `<section><h3 class="sub-title">Possibly dormant <small>no deploy or push in ${DORMANT_DAYS}+ days</small><span class="count num">${dormant.length}</span></h3>`;
    if (!dormant.length) html += `<div class="empty">Nothing looks dormant. Every app has been touched in the last ${DORMANT_DAYS} days.</div>`;
    else html += `<ul class="checklist">${dormant.map((x) => `<li class="arch"><div class="arch-main"><div class="arch-name"><b>${esc(x.name)}</b><span class="chip">${esc(x.what)}</span></div><div class="arch-sub">Last activity ${ago(new Date(x.at).toISOString())}</div></div><div class="arch-actions">${x.links.map(([l, u]) => extLink(u, `${esc(l)} ↗`, "btn sm ghost-link")).join("")}</div></li>`).join("")}</ul>
      <div class="hint">Suggestions only. Add a name to <code>archive</code> in pulse.config.json to move it here.</div>`;
    html += `</section>`;

    html += `<section><h3 class="sub-title">Archived GitHub repos <small>marked archived on GitHub</small><span class="count num">${ghArch.length}</span></h3>`;
    if (!ghArch.length) html += `<div class="empty">No archived repositories.</div>`;
    else html += `<ul class="checklist">${ghArch.map((r) => `<li class="arch"><div class="arch-main"><div class="arch-name"><b>${esc(r.name)}</b>${r.private ? LOCK_SVG : ""}${r.language ? `<span class="chip">${esc(r.language)}</span>` : ""}</div><div class="arch-sub">${r.pushedAt ? `Last pushed ${ago(r.pushedAt)}` : "No push data"}</div></div><div class="arch-actions">${extLink(r.url, "Open ↗", "btn sm ghost-link")}${safeUrl(r.url) ? extLink(r.url + "/settings#danger-zone", "Delete in GitHub ↗", "btn sm danger") : ""}</div></li>`).join("")}</ul>`;
    html += `</section>`;
    $("#archive").innerHTML = html;
  }
  $("#archive").addEventListener("change", (e) => {
    const cb = e.target.closest("[data-done]"); if (!cb) return;
    const m = readDone();
    if (cb.checked) m[cb.dataset.done] = 1; else delete m[cb.dataset.done];
    writeDone(m);
    cb.closest(".arch").classList.toggle("is-done", cb.checked);
    const boxes = [...document.querySelectorAll("#archive [data-done]")];
    $("#arch-progress").textContent = `${boxes.filter((b) => b.checked).length}/${boxes.length} done`;
  });

  // ---------- Encryption (PBKDF2-SHA256 -> AES-256-GCM) ----------
  const unb64 = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  const keyCache = new Map(); // salt+iter+password -> CryptoKey (memory only)
  async function getKey(password, env_) {
    const id = `${env_.iter}:${env_.salt}:${password}`;
    if (!keyCache.has(id)) {
      keyCache.clear(); // keep only the latest salt
      const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
      keyCache.set(id, await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: unb64(env_.salt), iterations: env_.iter }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]));
    }
    return keyCache.get(id);
  }
  async function decrypt(env_, password) {
    if (env_?.v !== 1 || env_.kdf !== "pbkdf2-sha256") throw new Error("Unsupported data format");
    const key = await getKey(password, env_);
    let pt;
    try { pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(env_.iv) }, key, unb64(env_.ct)); }
    catch { throw Object.assign(new Error("Wrong password"), { wrongPassword: true }); }
    return JSON.parse(new TextDecoder().decode(pt));
  }
  async function fetchEnc(name, bust) {
    const r = await fetch(`data/${name}.enc.json${bust}`);
    if (!r.ok) throw Object.assign(new Error(`${name} not found (HTTP ${r.status})`), { noData: true });
    return r.json();
  }

  async function load(password) {
    const bust = `?t=${Math.floor(Date.now() / 60000)}`;
    const [encLatest, encHistory] = await Promise.all([
      fetchEnc("latest", bust),
      fetchEnc("history", bust).catch(() => null),
    ]);
    const d = await decrypt(encLatest, password);
    const history = encHistory ? await decrypt(encHistory, password).catch((e) => { if (e.wrongPassword) return { runs: [] }; throw e; }) : { runs: [] };
    document.title = d.title || "Project Pulse";
    $("#title").textContent = d.title || "Project Pulse";
    const next = new Date(new Date(d.generatedAt).getTime() + (d.intervalMinutes || 60) * 60000);
    const stale = Date.now() - new Date(d.generatedAt).getTime() > (d.intervalMinutes || 60) * 120000;
    $("#updated").innerHTML = `Updated <b>${ago(d.generatedAt)}</b> · ${stale ? 'Refresh overdue — showing last recorded data' : `next ~${next.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}`;
    $("#updated").title = new Date(d.generatedAt).toLocaleString();
    const built = buildApps(d, history);
    APPS = built.apps;
    renderHero(d, history, stale);
    renderAttention();
    renderApps();
    renderUsage(d);
    renderSites(d, history);
    D = d; HIST = history; SPARE = built.spare;
    renderTraffic(d, history);
    renderLinks();
    renderArchive();
    if (pendingApps && location.hash === "#apps") { pendingApps = false; $("#apps-section").scrollIntoView({ block: "start" }); }
    renderWarnings(d);
  }

  // ---------- Lock screen ----------
  const PASS_KEY = "pulse-pass";
  let password = null;
  const showApp = () => { $("#lock").hidden = true; $("#app").hidden = false; };
  const showLock = () => { $("#app").hidden = true; $("#lock").hidden = false; $("#lock-pass").focus(); };
  const noData = (e) => { $("#hero").innerHTML = `<div><h2>No data yet</h2><p>Run the “Pulse” workflow once from the Actions tab. (${esc(e.message)})</p></div>`; };

  // Returns true when unlocked (or when there is no data to unlock yet).
  async function unlock(pw) {
    try {
      await load(pw);
    } catch (e) {
      if (e.noData) { password = null; showApp(); noData(e); return true; }
      if (e.wrongPassword) return false;
      throw e;
    }
    password = pw;
    showApp();
    return true;
  }

  $("#lock-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const pw = $("#lock-pass").value;
    if (!pw) return;
    const btn = $("#lock-submit");
    btn.disabled = true; btn.textContent = "Unlocking…";
    $("#lock-error").hidden = true;
    try {
      const ok = await unlock(pw);
      if (!ok) { $("#lock-error").textContent = "Wrong password"; $("#lock-error").hidden = false; $("#lock-pass").select(); }
      else if (password && $("#lock-remember").checked) { try { localStorage.setItem(PASS_KEY, pw); } catch {} }
    } catch (e) {
      $("#lock-error").textContent = `Could not load data: ${e.message}`; $("#lock-error").hidden = false;
    } finally { btn.disabled = false; btn.textContent = "Unlock"; }
  });

  $("#lock-btn").addEventListener("click", () => {
    try { localStorage.removeItem(PASS_KEY); } catch {}
    location.reload();
  });

  (async () => {
    let saved = null;
    try { saved = localStorage.getItem(PASS_KEY); } catch {}
    if (saved) {
      try { if (await unlock(saved)) return; } catch { return showLock(); }
      try { localStorage.removeItem(PASS_KEY); } catch {}
    }
    showLock();
  })();

  setInterval(() => { if (password) load(password).catch(() => {}); }, 5 * 60000);
})();
