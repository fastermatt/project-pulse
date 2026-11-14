(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : "");
  const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ""); } catch { return ""; } };

  // ---------- State (everything setTab or initTabs can touch is declared up front) ----------
  let D = null, HIST = null, SPARE = [], APPS = [];
  let SERIES = null;      // traffic daily series
  let TCFG = null;        // traffic chart config
  let pendingApps = false;
  let curTab = "overview";
  let appQuery = "", linkQuery = "", checkFilter = "all";
  let appFilter = "all";
  let appSort = "status";
  let password = null;

  // ---------- Theme: follows the system, the toggle overrides ----------
  const root = document.documentElement;
  try { const t = localStorage.getItem("pulse-theme"); if (t === "dark" || t === "light") root.dataset.theme = t; } catch {}
  const sysDark = () => matchMedia("(prefers-color-scheme: dark)").matches;
  $("#theme").addEventListener("click", () => {
    const dark = (root.dataset.theme || (sysDark() ? "dark" : "light")) === "dark";
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("pulse-theme", root.dataset.theme); } catch {}
  });

  // ---------- Glass segmented controls: one selected "lens" pill slides between segments ----------
  const SEG_SEL = '[aria-selected="true"],[aria-pressed="true"],[aria-current="page"]';
  const segRO = typeof ResizeObserver !== "undefined" ? new ResizeObserver((es) => es.forEach((e) => segSync(e.target))) : null;
  function segSync(seg) {
    if (!seg || !seg.isConnected) return;
    if (segRO && !seg._ro) { seg._ro = true; segRO.observe(seg); }
    let ind = seg.querySelector(":scope > .seg-ind");
    const on = seg.querySelector(`:scope > ${SEG_SEL.split(",").join(", :scope > ")}`);
    if (!on || !seg.offsetWidth || !on.offsetWidth) { if (ind) ind.style.opacity = "0"; return; }
    const pos = { x: on.offsetLeft, y: on.offsetTop, w: on.offsetWidth, h: on.offsetHeight };
    const place = (q) => { ind.style.width = q.w + "px"; ind.style.height = q.h + "px"; ind.style.transform = `translate(${q.x}px, ${q.y}px)`; };
    if (!ind) {
      ind = document.createElement("i"); ind.className = "seg-ind"; ind.setAttribute("aria-hidden", "true");
      ind.style.transition = "none"; place(seg._pos || pos); seg.prepend(ind);
      void ind.offsetWidth; ind.style.transition = "";
    }
    ind.style.opacity = "1"; place(pos); seg._pos = pos;
  }
  const syncSegs = () => document.querySelectorAll(".seg, .bbar").forEach(segSync);

  // ---------- One status helper: good / mid / bad / none ----------
  // uptime % >=99.5 good, >=97 mid; response ms <800 good, <2000 mid; usage % <70 good, <90 mid.
  const rate = (kind, v) => {
    if (v == null || (typeof v === "number" && Number.isNaN(v))) return "none";
    switch (kind) {
      case "uptime": return v >= 99.5 ? "good" : v >= 97 ? "mid" : "bad";
      case "ms": return v < 800 ? "good" : v < 2000 ? "mid" : "bad";
      case "usage": return v < 70 ? "good" : v < 90 ? "mid" : "bad";
      case "score": return v >= 85 ? "good" : v >= 60 ? "mid" : "bad";
      case "app": return { healthy: "good", warning: "mid", critical: "bad" }[v] || "none";
      case "deploy": return { ready: "good", building: "mid", queued: "mid", enqueued: "mid", new: "mid", processing: "mid", uploading: "mid", error: "bad" }[v] || "none";
      case "state": return { up: "good", protected: "good", degraded: "mid", down: "bad" }[v] || "none";
    }
    return "none";
  };
  const WORD = { good: "Good", mid: "Fair", bad: "Poor", none: "n/a" };

  const STATE = {
    up: { label: "Up" }, protected: { label: "Up (protected)" }, degraded: { label: "Degraded" },
    down: { label: "Down" }, paused: { label: "Paused" }, unknown: { label: "Not checked yet" },
  };
  const CODE = { u: "up", p: "protected", g: "degraded", d: "down", z: "paused" };
  const PLATFORM = { netlify: "Netlify", vercel: "Vercel", supabase: "Supabase", custom: "Custom", github: "GitHub" };
  // Authored 16px icons (1.5 stroke) instead of unicode stand-ins.
  const svgI = (d, extra = "") => `<svg class="ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false"${extra}>${d}</svg>`;
  const EXT = svgI('<path d="M6 3.5h6.5V10M12.5 3.5 4 12"/>', ' style="width:.85em;height:.85em;vertical-align:-.05em;margin-left:.25em"');
  const GLYPH = {
    netlify: svgI('<path d="M8 1.8 14.2 8 8 14.2 1.8 8z"/><path d="M5.6 8h4.8"/>'),
    vercel: svgI('<path d="M8 2.6 14 13H2z" fill="currentColor" stroke="none"/>'),
    supabase: svgI('<path d="M9 1.8 3 9.2h4.6L7 14.2l6-7.4H8.4z"/>'),
    github: svgI('<circle cx="4.5" cy="3.8" r="1.6"/><circle cx="4.5" cy="12.2" r="1.6"/><circle cx="11.5" cy="5.6" r="1.6"/><path d="M4.5 5.4v5.2M11.5 7.2c0 2.4-2.6 2.6-7 3.4"/>'),
    custom: svgI('<path d="M6.5 9.5 9.5 6.5M7 4.6l1.3-1.3a2.6 2.6 0 0 1 3.7 3.7L10.7 8.3M9 11.4l-1.3 1.3a2.6 2.6 0 0 1-3.7-3.7l1.3-1.3"/>'),
  };
  const WEB = new Set(["netlify", "vercel", "custom"]);
  const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const nf = (n) => Number(n || 0).toLocaleString();
  const lower = (x) => String(x || "").toLowerCase();
  const fmtDate = (iso) => { const t = iso ? new Date(iso) : null; return t && !Number.isNaN(+t) ? t.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "n/a"; };
  const fmtDateTime = (iso) => { const t = iso ? new Date(iso) : null; return t && !Number.isNaN(+t) ? `${fmtDate(iso)}, ${t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "n/a"; };

  const fmtBytes = (b) => {
    if (b == null) return "n/a";
    const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; let n = b;
    while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
    return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
  };
  const fmtMiB = (b) => (b == null ? "n/a" : `${(b / 1048576).toFixed(b < 10 * 1048576 ? 1 : 0)} MB`);
  const ago = (iso) => {
    if (!iso) return "n/a";
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return "just now";
    const m = s / 60; if (m < 60) return `${Math.round(m)}m ago`;
    const h = m / 60; if (h < 48) return `${Math.round(h)}h ago`;
    const d = h / 24; if (d < 60) return `${Math.round(d)}d ago`;
    return `${Math.round(d / 30)}mo ago`;
  };
  const dur = (iso) => {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
    if (s < 172800) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;
  };
  const daysLeft = (iso) => (iso ? Math.max(0, Math.ceil((new Date(iso) - Date.now()) / 86400000)) : null);
  const fmtPct = (p) => (p == null ? "n/a" : `${p >= 99.95 ? "100" : p.toFixed(1)}%`);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const avgOf = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  // ---------- Icons (16px, 1.5 stroke) ----------
  const IC = {
    shield: '<path d="M8 1.8l5 1.8v4c0 3.2-2.1 5.4-5 6.6-2.9-1.2-5-3.4-5-6.6v-4z"/><path d="M5.8 8l1.6 1.6 3-3.2"/>',
    alert: '<path d="M8 2.2l6 10.6H2z"/><path d="M8 6.6v2.8"/><path d="M8 11.3v.1"/>',
    pulse: '<path d="M1.5 8.5h3l1.8-4.5 3 8 1.8-3.5h3.4"/>',
    grid: '<rect x="2" y="2" width="5" height="5" rx="1.2"/><rect x="9" y="2" width="5" height="5" rx="1.2"/><rect x="2" y="9" width="5" height="5" rx="1.2"/><rect x="9" y="9" width="5" height="5" rx="1.2"/>',
    clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.6V8l2.3 1.4"/>',
    chart: '<path d="M2 13.5h12"/><path d="M2.5 10.5l3.2-4 3 2.3L13.5 3.5"/>',
    gauge: '<path d="M2.5 11.5a5.5 5.5 0 1 1 11 0"/><path d="M8 11.5l2.4-3.6"/>',
    server: '<rect x="2" y="2.5" width="12" height="4.5" rx="1.2"/><rect x="2" y="9" width="12" height="4.5" rx="1.2"/><path d="M4.8 4.8v.1M4.8 11.3v.1"/>',
    apps: '<rect x="2" y="3" width="12" height="9.5" rx="1.5"/><path d="M2 6h12"/>',
    list: '<path d="M5.5 4.5H14M5.5 8H14M5.5 11.5H14"/><path d="M2.5 4.5h.1M2.5 8h.1M2.5 11.5h.1"/>',
    eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
    users: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3 13.5c.6-2.6 2.6-3.8 5-3.8s4.4 1.2 5 3.8"/>',
    git: '<circle cx="4.5" cy="4" r="1.6"/><circle cx="4.5" cy="12" r="1.6"/><circle cx="11.5" cy="6.5" r="1.6"/><path d="M4.5 5.6v4.8M11.5 8.1c0 2-2.5 2-5.4 3"/>',
    box: '<rect x="2" y="2.5" width="12" height="3.2" rx="1"/><path d="M3.2 5.7v6.8a1 1 0 0 0 1 1h7.6a1 1 0 0 0 1-1V5.7"/><path d="M6.5 8.8h3"/>',
    link: '<path d="M6.7 9.3a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-.7.7"/><path d="M9.3 6.7a2.8 2.8 0 0 0-4 0l-2 2a2.8 2.8 0 0 0 4 4l.7-.7"/>',
    check: '<path d="M3 8.5l3.2 3.2L13 4.8"/>',
    mail: '<rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="M2.5 4.5L8 9l5.5-4.5"/>',
  };
  const ico = (k) => `<svg viewBox="0 0 16 16" aria-hidden="true">${IC[k] || ""}</svg>`;
  const pnh = (icon, title, right = "", sub = "") => `<div class="pn-h"><span class="ib">${ico(icon)}</span><h2>${title}</h2>${sub ? `<small>${sub}</small>` : ""}${right ? `<div class="pn-r">${right}</div>` : ""}</div>`;
  const chip = (st, txt) => `<span class="chip st-${st}">${esc(txt)}</span>`;
  const sdot = (st) => `<i class="dot st-${st}" aria-hidden="true"></i>`;

  const GLYPHCHIP = (k) => `<span class="tg" aria-hidden="true">${GLYPH[k] || GLYPH.custom}</span>`;
  const LOCK_SVG = `<svg class="lk" viewBox="0 0 16 16" width="12" height="12" aria-label="Private" role="img"><rect x="3" y="7" width="10" height="7" rx="2" fill="currentColor"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;
  const extLink = (u, t, cls = "") => (safeUrl(u) ? `<a class="${cls}" href="${esc(u)}" target="_blank" rel="noopener">${t}</a>` : "");

  // ---------- Generic SVG chart (area + lines, y grid, thresholds, callout) ----------
  const RO = typeof ResizeObserver !== "undefined"
    ? new ResizeObserver((entries) => { for (const e of entries) { const el = e.target; if (el._cfg && Math.round(el.clientWidth) !== el._w) chart(el, el._cfg); } })
    : null;
  function chart(el, cfg) {
    el._cfg = cfg;
    const W = Math.round(el.clientWidth);
    if (RO && !el._ro) { el._ro = true; RO.observe(el); }
    if (W < 40) return;
    el._w = W;
    const H = cfg.h || (W < 520 ? 190 : 230), L = 40, R = 12, T = 12, B = 26;
    const n = cfg.n;
    const x = (i) => L + (n > 1 ? (i * (W - L - R)) / (n - 1) : (W - L - R) / 2);
    const y = (v) => T + (1 - v / cfg.top) * (H - T - B);
    let grid = "";
    for (const v of cfg.ticks) grid += `<line class="gl" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="ax" x="${L - 7}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end">${cfg.fmtY ? cfg.fmtY(v) : v}</text>`;
    const nt = Math.min(5, n); let xl = "";
    for (let k = 0; k < nt; k++) {
      const i = nt === 1 ? 0 : Math.round((k * (n - 1)) / (nt - 1));
      xl += `<text class="ax" x="${x(i).toFixed(1)}" y="${H - 7}" text-anchor="${k === 0 ? "start" : k === nt - 1 ? "end" : "middle"}">${esc(cfg.xl(i))}</text>`;
    }
    let th = "";
    for (const t of cfg.thresholds || []) {
      if (t.v >= cfg.top) continue;
      th += `<line class="th st-${t.st}" x1="${L}" x2="${W - R}" y1="${y(t.v).toFixed(1)}" y2="${y(t.v).toFixed(1)}"/><text class="thl st-${t.st}" x="${W - R - 3}" y="${(y(t.v) - 4).toFixed(1)}" text-anchor="end">${esc(t.label)}</text>`;
    }
    let body = "", defs = "";
    cfg.series.forEach((s, si) => {
      const pts = []; s.vals.forEach((v, i) => { if (v != null) pts.push([x(i), y(v)]); });
      if (!pts.length) return;
      const line = pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
      if (s.area) {
        const gid = `${cfg.id}-g${si}`;
        defs += `<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="ga ${s.cls}"/><stop offset="1" class="gb ${s.cls}"/></linearGradient>`;
        body += `<polygon points="${pts[0][0].toFixed(1)},${y(0).toFixed(1)} ${line} ${pts[pts.length - 1][0].toFixed(1)},${y(0).toFixed(1)}" fill="url(#${gid})"/>`;
      }
      body += `<polyline class="ln ${s.cls}" points="${line}"/>`;
    });
    let call = "";
    if (cfg.last) {
      const lv = cfg.last; const px = x(lv.i), py = y(lv.v);
      const tw = lv.label.length * 6.6 + 16; const tx = Math.max(L + 4, px - tw - 10);
      call = `<circle class="ld st-${lv.st}" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="4.5"/><g class="pill st-${lv.st}"><rect x="${tx.toFixed(1)}" y="${(py - 10).toFixed(1)}" width="${tw.toFixed(1)}" height="20" rx="10"/><text x="${(tx + tw / 2).toFixed(1)}" y="${(py + 3.8).toFixed(1)}" text-anchor="middle">${esc(lv.label)}</text></g>`;
    }
    const bw = n > 1 ? (W - L - R) / (n - 1) : 20;
    let hits = "";
    for (let i = 0; i < n; i++) hits += `<rect class="hit" x="${(x(i) - bw / 2).toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${H - T - B}"><title>${esc(cfg.tip(i))}</title></rect>`;
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(cfg.aria)}"><defs>${defs}</defs>${grid}${xl}${th}${body}${call}${hits}</svg>`;
  }
  function niceTicks(max, steps) {
    const step = steps.find((s) => max / s <= 4) || steps[steps.length - 1];
    const top = Math.ceil(max / step) * step; const ticks = [];
    for (let v = 0; v <= top + 0.001; v += step) ticks.push(v);
    return { top, ticks };
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
  }  // ---------- Grouping sites + repos into apps ----------
  const SUFFIX = /-(v\d+|prod|production|deploy|app|web|site)$/;
  function normKey(name) {
    const orig = String(name || "").toLowerCase().trim();
    let k = orig.replace(/[\s_]+/g, "-"), prev;
    do { prev = k; k = k.replace(SUFFIX, ""); } while (k !== prev);
    return k || orig;
  }
  const titleCase = (k) => k.split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") || k;
  const SUFFIX_I = /-(v\d+|prod|production|deploy|app|web|site)$/i;
  // Display title from a component's current name: drop deploy suffixes, split on dashes, capitalise lowercase words.
  function humanize(name) {
    const raw = String(name || "").trim();
    let k = raw.replace(/[\s_]+/g, "-"), prev;
    do { prev = k; k = k.replace(SUFFIX_I, ""); } while (k !== prev);
    return (k || raw).split("-").filter(Boolean).map((w) => (w === w.toLowerCase() ? w[0].toUpperCase() + w.slice(1) : w)).join(" ") || raw;
  }
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
      // Last updated: newest of any component deploy and any repo push.
      const anyDeploy = comps.map((c) => c.site?.deploy?.at).filter((t) => t && !Number.isNaN(+new Date(t))).sort((a, b) => +new Date(a) - +new Date(b)).at(-1) || null;
      const dMs = anyDeploy ? +new Date(anyDeploy) : 0, pMs = lastPush ? +new Date(lastPush) : 0;
      const updatedAt = dMs || pMs ? (pMs > dMs ? lastPush : anyDeploy) : null;
      const updatedSource = updatedAt ? (pMs > dMs ? "push" : "deploy") : null;
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
      const titleSrc = (primary || web[0] || comps[0])?.name;
      apps.push({
        key: g.key, name: g.title || (titleSrc ? humanize(titleSrc) : titleCase(g.key)), names, comps, issues, health,
        live, liveIsHomepage: live === g.homepage && !primary?.url, dashboardFallback: fallbackDash, primary,
        histIds: histComps.map((c) => c.site.id), pct: hist.pct, ticks: hist.ticks, series: ser, avgMs: msOk.length ? Math.round(msOk.reduce((a, b) => a + b, 0) / msOk.length) : null,
        lastDeploy, lastDeployAny, lastPush, updatedAt, updatedSource, failedDeploy: !lastDeploy && !!lastDeployAny,
        pausedOnly: health === "info" && issues.every((i) => i.kind === "paused" || i.kind === "dbstate"),
      });
    }
    const hr = { critical: 0, warning: 1, healthy: 2, info: 3 };
    apps.sort((a, b) => (hr[a.health] - hr[b.health]) || a.name.localeCompare(b.name));
    apps.forEach((a, i) => { a.id = `app-${i}-${a.key.replace(/[^a-z0-9-]/g, "-")}`; });
    return { apps, spare };
  }
  // ---------- Metrics shared by several panels ----------
  let M = null;
  function computeMetrics(d, history) {
    const webSites = (d.sites || []).filter((s) => s.platform !== "supabase");
    const web = webSites.filter((s) => s.check && s.check.state !== "paused");
    const upNow = web.filter((s) => ["up", "protected"].includes(s.check.state)).length;
    const msNow = web.map((s) => s.check.ms).filter((v) => v != null && v > 0);
    const avgNow = avgOf(msNow);
    const pcts = web.map((s) => siteHistory(s.id, history, 1).pct).filter((v) => v != null);
    const ids = webSites.map((s) => s.id);
    const runs = runsOf(history).map((r) => {
      let up = 0, tot = 0; const ms = [];
      for (const id of ids) {
        const v = r.r[id]; if (!v) continue;
        const s = CODE[v[0]]; if (!s || s === "paused") continue;
        tot++; if (s === "up" || s === "protected") up++;
        if (v[1] > 0 && s !== "down") ms.push(v[1]);
      }
      return { t: r.t, up, tot, pct: tot ? (up / tot) * 100 : null, avg: ms.length ? Math.round(avgOf(ms)) : null, n: ms.length };
    });
    return { web, upNow, msNow, avgMs: avgNow == null ? null : Math.round(avgNow), overall: avgOf(pcts), runs };
  }
  function appCounts() {
    const c = { healthy: 0, warning: 0, critical: 0, paused: 0 };
    for (const a of APPS) { if (a.health === "info") c.paused++; else c[a.health]++; }
    return c;
  }
  function healthScore() {
    const mon = APPS.filter((a) => a.health !== "info");
    const parts = [];
    if (mon.length) { const h = mon.filter((a) => a.health === "healthy").length; parts.push({ w: 60, v: (h / mon.length) * 100, label: `${h} of ${mon.length} apps healthy` }); }
    if (M.overall != null) parts.push({ w: 25, v: clamp((M.overall - 90) * 10, 0, 100), label: `${fmtPct(M.overall)} recorded uptime (90% scores 0, 100% scores 100)` });
    if (M.avgMs != null) parts.push({ w: 15, v: clamp(((3000 - M.avgMs) / 2700) * 100, 0, 100), label: `${M.avgMs} ms average response (300 ms scores 100, 3000 ms scores 0)` });
    if (!parts.length) return { score: null, tip: "No data yet" };
    const ws = parts.reduce((a, p) => a + p.w, 0);
    const score = Math.round(parts.reduce((a, p) => a + p.w * p.v, 0) / ws);
    return { score, tip: `Health score = 60% apps healthy + 25% uptime + 15% response, reweighted over available data. ${parts.map((p) => `${p.label}: ${Math.round(p.v)}`).join("; ")}.` };
  }

  // ---------- Incidents ----------
  function streakSince(id, history, pred) {
    const runs = runsOf(history); let k = -1;
    for (let j = runs.length - 1; j >= 0; j--) { const v = runs[j].r[id]; if (!v || !pred(CODE[v[0]])) break; k = j; }
    if (k < 0) return null;
    return { t: runs[k].t, all: k === 0 };
  }
  function issueAge(i, history) {
    const c = i.comp;
    if ((i.kind === "down" || i.kind === "degraded") && c?.site?.id) {
      const s = streakSince(c.site.id, history, (st) => st === i.kind);
      if (s) return `${dur(s.t)}${s.all && runsOf(history).length > 1 ? "+" : ""}`;
    }
    if (i.kind === "deploy" && c?.site?.deploy?.at) return dur(c.site.deploy.at);
    return "";
  }
  const SEVLABEL = { critical: "Critical", warning: "Warning" };
  const SEVST = { critical: "bad", warning: "mid" };
  let INC = [];
  function buildIncidents(history, stale) {
    const rows = [];
    if (stale && D) rows.push({ sev: "warning", app: "Collector", text: "Refresh overdue. Showing last recorded data", age: dur(D.generatedAt), url: "" });
    for (const a of APPS) for (const i of a.issues) {
      if (i.sev === "info") continue;
      const u = safeUrl(a.live) || safeUrl(i.comp?.dashboard) || safeUrl(a.dashboardFallback);
      rows.push({ sev: i.sev, app: a.name, id: a.id, text: i.text, age: issueAge(i, history), url: u });
    }
    rows.sort((a, b) => (SEV[b.sev] - SEV[a.sev]) || String(a.app).localeCompare(b.app));
    INC = rows;
  }
  function renderIncidents() {
    const crit = INC.filter((r) => r.sev === "critical").length, warn = INC.length - crit;
    const right = [crit ? chip("bad", `${crit} critical`) : "", warn ? chip("mid", `${warn} warning`) : ""].join("");
    const body = INC.length
      ? `<ul class="inc">${INC.map((r) => `<li class="inc-row"><span class="sev st-${SEVST[r.sev]}">${sdot(SEVST[r.sev])}${SEVLABEL[r.sev]}</span>${r.id ? `<button type="button" class="inc-app linklike" data-jump="${esc(r.id)}">${esc(r.app)}</button>` : `<b class="inc-app">${esc(r.app)}</b>`}<span class="inc-t">${esc(r.text)}</span><span class="inc-age num">${esc(r.age)}</span>${r.url ? `<a class="btn sm" href="${esc(r.url)}" target="_blank" rel="noopener">Open<span class="sr"> ${esc(r.app)}</span></a>` : `<span></span>`}</li>`).join("")}</ul>`
      : `<div class="inc-empty"><span class="okring st-good">${ico("check")}</span><b>No open incidents</b></div>`;
    $("#p-inc").innerHTML = pnh("alert", "Incidents", right) + body;
  }

  // ---------- KPI row, health gauge, availability ----------
  const kpiTile = ({ ic, label, val, unit = "", chipSt, chipTxt, cap = "" }) =>
    `<div class="pn kpi"><div class="k-top"><span class="ib">${ico(ic)}</span><span class="k-l">${label}</span></div><div class="k-v"><b class="num">${val}</b>${unit ? `<small>${unit}</small>` : ""}</div><div class="k-f">${chipTxt ? chip(chipSt, chipTxt) : ""}${cap ? `<span class="k-c">${cap}</span>` : ""}</div></div>`;

  function renderKpis(stale) {
    const c = appCounts(); const mon = c.healthy + c.warning + c.critical;
    const crit = INC.filter((r) => r.sev === "critical").length, warn = INC.length - crit;
    const upPct = M.web.length ? (M.upNow / M.web.length) * 100 : null;
    const msSt = rate("ms", M.avgMs);
    $("#p-kpi").innerHTML = [
      kpiTile({ ic: "shield", label: "Apps healthy", val: mon ? c.healthy : "n/a", unit: mon ? `/ ${mon}` : "", chipSt: c.critical ? "bad" : c.warning ? "mid" : mon ? "good" : "none", chipTxt: c.critical ? `${c.critical} critical` : c.warning ? `${c.warning} warning` : mon ? "All healthy" : "No apps", cap: c.paused ? `${c.paused} paused` : "monitored" }),
      kpiTile({ ic: "pulse", label: "Sites up now", val: M.web.length ? M.upNow : "n/a", unit: M.web.length ? `/ ${M.web.length}` : "", chipSt: rate("uptime", upPct), chipTxt: fmtPct(upPct), cap: "last check" }),
      kpiTile({ ic: "clock", label: "Avg response", val: M.avgMs != null ? nf(M.avgMs) : "n/a", unit: M.avgMs != null ? "ms" : "", chipSt: msSt, chipTxt: M.avgMs != null ? { good: "Fast", mid: "Slow", bad: "Very slow" }[msSt] : "", cap: "all sites" }),
      kpiTile({ ic: "alert", label: "Open incidents", val: INC.length, chipSt: crit ? "bad" : warn ? "mid" : "good", chipTxt: crit ? `${crit} critical` : warn ? `${warn} warning` : "Clear", cap: stale ? "data stale" : "now" }),
    ].join("");
  }

  function tickGauge(score) {
    const cx = 120, cy = 124, N = 37, r2 = 108; let t = "";
    for (let i = 0; i < N; i++) {
      const f = i / (N - 1), a = Math.PI * (1 - f), major = i % 6 === 0;
      const r1 = major ? 76 : 84;
      const on = score != null && f * 100 <= score + 0.001;
      t += `<line class="tk ${on ? "st-" + rate("score", score) : "off"}" x1="${(cx + r1 * Math.cos(a)).toFixed(1)}" y1="${(cy - r1 * Math.sin(a)).toFixed(1)}" x2="${(cx + r2 * Math.cos(a)).toFixed(1)}" y2="${(cy - r2 * Math.sin(a)).toFixed(1)}"/>`;
    }
    return `<svg class="tgauge" viewBox="0 0 240 134" role="img" aria-label="Health score ${score == null ? "unavailable" : score + " out of 100"}">
      <defs><radialGradient id="dome" cx="50%" cy="100%" r="100%"><stop offset="0" class="dm-a"/><stop offset="1" class="dm-b"/></radialGradient></defs>
      <path d="M52 124A68 68 0 0 1 188 124Z" fill="url(#dome)"/>${t}
      <text x="120" y="114" text-anchor="middle" class="g-num">${score == null ? "n/a" : score}</text></svg>`;
  }

  function renderHealth(stale) {
    const { score, tip } = healthScore(); const c = appCounts();
    const st = score == null ? "none" : rate("score", score);
    const word = { good: "Healthy", mid: "Degraded", bad: "Critical", none: "No data" }[st];
    const counters = [["good", "Healthy", c.healthy], ["mid", "Warning", c.warning], ["bad", "Critical", c.critical], ["none", "Paused", c.paused]]
      .map(([s, l, n]) => `<li class="st-${s}">${sdot(s)}<span>${l}</span><b class="num">${n}</b></li>`).join("");
    $("#p-health").innerHTML = pnh("gauge", "Health score", stale ? chip("mid", "Stale") : "") +
      `<div class="hg" title="${esc(tip)}">${tickGauge(score)}<div class="hg-cap">${chip(st, word)}<span>of 100</span></div></div>
       <ul class="counters" aria-label="Apps by health">${counters}</ul>`;
    $("#p-health").title = tip;
  }

  function renderAvail() {
    const runs = M.runs.slice(-24);
    const bars = runs.map((r) => {
      const st = rate("uptime", r.pct); const h = r.pct == null ? 6 : clamp(((r.pct - 50) / 50) * 100, 6, 100);
      return `<i class="bar st-${st}" style="height:${h.toFixed(0)}%" title="${esc(`${new Date(r.t).toLocaleString()} · ${r.pct == null ? "no data" : r.up + "/" + r.tot + " up (" + r.pct.toFixed(1) + "%)"}`)}"></i>`;
    }).join("");
    const up = rate("uptime", M.overall);
    $("#p-avail").innerHTML = pnh("pulse", "Availability") +
      `<div class="av-big st-${up}"><b class="num">${M.overall == null ? "n/a" : fmtPct(M.overall).replace("%", "")}</b><small>${M.overall == null ? "" : "%"}</small></div>
       <div class="av-sub">Recorded uptime</div>
       <dl class="av-stats"><div><dt>Sites up</dt><dd class="num">${M.web.length ? `${M.upNow}/${M.web.length}` : "n/a"}</dd></div><div class="st-${rate("ms", M.avgMs)}"><dt>Avg response</dt><dd class="num t">${M.avgMs != null ? M.avgMs + " ms" : "n/a"}</dd></div></dl>
       <div class="hist" role="img" aria-label="Share of sites up, last ${runs.length} runs">${bars}</div><div class="hist-cap"><span>${runs.length} runs ago</span><span>latest</span></div>`;
  }

  // ---------- Status matrix ----------
  function matrixCells(a, history, N) {
    if (a.primary) {
      const s = series(a.primary.site.id, history, N); while (s.length < N) s.unshift(null);
      return s.map((p) => (p ? { t: p.t, st: p.state, ms: p.ms } : { t: null, st: "unknown", ms: null }));
    }
    return groupHistory(a.histIds || [], history, N).ticks.map((t) => ({ t: t.t, st: t.state, ms: null }));
  }
  function renderMatrix(history) {
    const N = matchMedia("(max-width: 760px)").matches ? 24 : 48;
    const legend = `<div class="legend">${[["good", "Up"], ["mid", "Degraded"], ["bad", "Down"], ["none", "No data"]].map(([s, l]) => `<span class="st-${s}">${sdot(s)}${l}</span>`).join("")}</div>`;
    if (!APPS.length) { $("#p-matrix").innerHTML = pnh("grid", "Status matrix") + `<div class="empty">No apps found yet.</div>`; return; }
    const rows = APPS.map((a) => {
      const cells = matrixCells(a, history, N).map((c) => {
        const s = STATE[c.st] || STATE.unknown;
        return `<i class="cell st-${rate("state", c.st)}" title="${esc(c.t ? `${new Date(c.t).toLocaleString()} · ${s.label}${c.ms > 0 ? ` · ${c.ms} ms` : ""}` : "No data")}"></i>`;
      }).join("");
      const hs = rate("app", a.health);
      const href = safeUrl(a.live) || safeUrl(a.dashboardFallback);
      return `<div class="mx-row"><button type="button" class="mx-name" data-jump="${esc(a.id)}" title="${esc(a.names.join(" · "))}">${sdot(hs)}<span>${esc(a.name)}</span></button><div class="mx-cells">${cells}</div>
        <b class="mx-up num st-${rate("uptime", a.pct)}"><span class="t">${fmtPct(a.pct)}</span></b><span class="mx-ms num st-${rate("ms", a.avgMs)}"><span class="t">${a.avgMs != null ? a.avgMs + " ms" : "n/a"}</span></span>
        <span class="mx-upd num" title="${esc(updTip(a))}">${esc(fmtDate(a.updatedAt))}</span>
        ${href ? `<a class="mx-open" href="${esc(href)}" target="_blank" rel="noopener">Open${EXT}<span class="sr"> ${esc(a.name)}</span></a>` : `<span></span>`}</div>`;
    }).join("");
    $("#p-matrix").innerHTML = pnh("grid", "Status matrix", legend, `last ${N} runs`) +
      `<div class="mx"><div class="mx-row mx-head" aria-hidden="true"><span>App</span><span class="mx-axis"><span>${N} runs ago</span><span>latest</span></span><span class="r">Uptime</span><span class="r">Avg</span><span class="r">Updated</span><span></span></div>${rows}</div>`;
  }

  // ---------- Response time ----------
  function renderResp() {
    const runs = M.runs.slice(-120);
    const vals = runs.map((r) => r.avg);
    const real = vals.filter((v) => v != null);
    const el = $("#p-resp");
    if (!real.length) { el.innerHTML = pnh("chart", "Response time") + `<div class="empty">No response data yet.</div>`; return; }
    const sorted = real.slice().sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    const lastI = vals.length - 1 - vals.slice().reverse().findIndex((v) => v != null);
    const lastV = vals[lastI];
    const { top, ticks } = niceTicks(Math.max(Math.max(...real) * 1.1, 900), [100, 200, 250, 500, 1000, 2000]);
    const stat = (l, v) => `<div class="st-${rate("ms", v)}"><dt>${l}</dt><dd class="num t">${Math.round(v)} ms</dd></div>`;
    const slow = M.web.filter((s) => s.check.ms > 0).sort((a, b) => b.check.ms - a.check.ms).slice(0, 3);
    el.innerHTML = pnh("chart", "Response time", chip(rate("ms", lastV), `${lastV} ms now`), "average across sites") +
      `<div id="resp-chart" class="chart"></div>
       <dl class="rstats">${stat("Avg", avgOf(real))}${stat("p95", p95)}${stat("Peak", sorted[sorted.length - 1])}${slow.length ? `<div class="slowest"><dt>Slowest now</dt><dd>${slow.map((s) => `<span class="st-${rate("ms", s.check.ms)}">${sdot(rate("ms", s.check.ms))}${esc(s.name)} <b class="num t">${s.check.ms} ms</b></span>`).join("")}</dd></div>` : ""}</dl>`;
    const fmtD = (iso) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
    chart($("#resp-chart"), {
      id: "rs", h: 300, n: runs.length, top, ticks, fmtY: (v) => v, aria: `Average response time per run, last ${runs.length} runs`,
      series: [{ vals, cls: "s-a", area: true }],
      thresholds: [{ v: 800, st: "mid", label: "800 ms" }, { v: 2000, st: "bad", label: "2000 ms" }],
      last: { i: lastI, v: lastV, st: rate("ms", lastV), label: `${lastV} ms` },
      xl: (i) => fmtD(runs[i].t),
      tip: (i) => `${new Date(runs[i].t).toLocaleString()} · ${vals[i] == null ? "no data" : vals[i] + " ms avg over " + runs[i].n + " sites"}`,
    });
  }

  // ---------- Capacity ----------
  function ring(p, st) {
    const v = p == null ? 0 : clamp(p, 0, 100);
    return `<svg class="m-ring st-${st}" viewBox="0 0 44 44" aria-hidden="true"><circle class="rg-t" cx="22" cy="22" r="18"/><circle class="rg-v" cx="22" cy="22" r="18" pathLength="100" stroke-dasharray="${v.toFixed(1)} 100" transform="rotate(-90 22 22)"/><text x="22" y="26.5" text-anchor="middle">${p == null ? "n/a" : Math.round(v)}</text></svg>`;
  }
  function meter(label, usedTxt, limitTxt, pct, foot, opts = {}) {
    const raw = opts.bar ?? pct;
    const p = raw == null ? null : clamp(raw, 0, 100);
    const st = opts.st || rate("usage", p);
    const aria = `${label}: ${usedTxt}${limitTxt ? ` of ${limitTxt}` : ""}${p != null ? `, ${Math.round(p)} percent` : ""}`;
    return `<div class="meter st-${st}"><div class="m-top"><span class="m-l" title="${esc(label)}">${esc(label)}</span><span class="m-v num">${usedTxt}${limitTxt ? ` <small>/ ${limitTxt}</small>` : ""}</span></div>
      <div class="m-bar" role="img" aria-label="${esc(aria)}"><i style="width:${p == null ? 0 : p}%">${p != null ? `<b>${opts.chip || Math.round(p) + "%"}</b>` : ""}</i></div>${ring(p, st)}${foot ? `<div class="m-foot">${foot}</div>` : ""}</div>`;
  }
  function prov(key, title, sub, href, linkTxt = "Usage" + EXT) {
    return `<div class="prov">${GLYPHCHIP(key)}<div class="pv-t"><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ""}</div>${safeUrl(href) ? `<a class="out" href="${esc(href)}" target="_blank" rel="noopener">${linkTxt}</a>` : ""}</div>`;
  }
  const notConfigured = (key, name, secret) => `<div class="cap-sec">${prov(key, name, "Not connected")}<div class="note">Add the <code>${secret}</code> repository secret to show ${name} data.</div></div>`;

  function renderUsage(d) {
    const cards = [];
    if (!d.netlify?.configured) cards.push(notConfigured("netlify", "Netlify", "NETLIFY_TOKEN"));
    for (const a of d.netlify?.usage || []) {
      let body = "";
      const bw = a.bandwidth;
      if (bw?.usedBytes != null) {
        const pct = bw.includedBytes ? (bw.usedBytes / bw.includedBytes) * 100 : null;
        const left = daysLeft(bw.periodEnd);
        body += meter("Bandwidth", fmtBytes(bw.usedBytes), bw.includedBytes ? fmtBytes(bw.includedBytes) : "", pct, left != null ? `Resets in ${left} day${left === 1 ? "" : "s"}` : "");
      }
      const bm = a.buildMinutes;
      if (bm?.used != null) body += meter("Build minutes", `${bm.used}`, bm.included ? `${bm.included}` : "", bm.included ? (bm.used / bm.included) * 100 : null, "");
      const cr = a.credits;
      if (cr && cr.included != null && cr.used != null) {
        const used = Number(cr.used), inc = Number(cr.included);
        body = meter("Credits", `${Math.round(used)}`, `${inc}`, inc ? (used / inc) * 100 : null, cr.next_usage_period_start ? `Resets in ${daysLeft(cr.next_usage_period_start)} days` : "") + body;
      }
      if (!body) body = `<div class="note">Netlify did not return usage numbers for this team. Use the usage link for credits.</div>`;
      const nSites = (d.sites || []).filter((s) => s.platform === "netlify").length;
      cards.push(`<div class="cap-sec">${prov("netlify", "Netlify", `${a.plan || "Team"} · ${nSites} sites`, a.dashboard)}${body}</div>`);
    }

    const sb = d.supabase;
    if (!sb?.configured) cards.push(notConfigured("supabase", "Supabase", "SUPABASE_TOKEN"));
    else {
      const active = sb.projects.filter((p) => p.status === "ACTIVE_HEALTHY");
      let body = "";
      if (sb.activeLimit) body += meter("Active projects", `${active.length}`, `${sb.activeLimit}`, (active.length / sb.activeLimit) * 100, active.length >= sb.activeLimit ? "At the limit: pause one before restoring another" : "");
      for (const p of active) {
        const pct = p.dbLimitBytes && p.dbBytes != null ? (p.dbBytes / p.dbLimitBytes) * 100 : null;
        body += meter(`${p.name} database`, fmtMiB(p.dbBytes), p.dbLimitBytes ? fmtMiB(p.dbLimitBytes) : "", pct, "");
      }
      const paused = sb.projects.filter((p) => p.status !== "ACTIVE_HEALTHY");
      if (paused.length) body += `<div class="chips">${paused.map((p) => `<span class="chip st-none">${esc(p.name)} · ${esc(p.status.toLowerCase().replace(/_/g, " "))}</span>`).join("")}</div>`;
      cards.push(`<div class="cap-sec">${prov("supabase", "Supabase", `${sb.projects.length} projects`, sb.projects[0]?.usageDashboard)}${body}</div>`);
    }

    if (!d.vercel?.configured) cards.push(notConfigured("vercel", "Vercel", "VERCEL_TOKEN"));
    else {
      const vs = (d.sites || []).filter((s) => s.platform === "vercel");
      const ok = vs.filter((s) => s.deploy?.state === "ready").length;
      const failed = vs.filter((s) => s.deploy?.state === "error");
      let body = meter("Deploys ready", `${ok}`, `${vs.length}`, null, "", { bar: vs.length ? (ok / vs.length) * 100 : 0, st: !vs.length ? "none" : ok === vs.length ? "good" : ok / vs.length >= 0.5 ? "mid" : "bad", chip: `${ok}/${vs.length}` });
      const u = d.vercel.usage;
      if (u?.source === "billing" && u.services) {
        const rows = Object.entries(u.services).sort((a, b) => b[1].quantity - a[1].quantity).slice(0, 6);
        body += rows.map(([k, v]) => `<div class="dim-row"><span>${esc(k)}</span><span class="num">${Math.round(v.quantity).toLocaleString()} ${esc(v.unit)}</span></div>`).join("");
      } else body += `<div class="note">The Hobby plan does not expose usage through the API. Use the usage link for live meters.</div>`;
      if (failed.length) body += `<div class="chips">${failed.map((s) => `<span class="chip st-bad">${esc(s.name)} · deploy failed</span>`).join("")}</div>`;
      cards.push(`<div class="cap-sec">${prov("vercel", "Vercel", `${u?.plan ? u.plan + " · " : ""}${vs.length} projects`, u?.dashboard)}${body}</div>`);
    }
    $("#usage").innerHTML = cards.join("");
  }

  // ---------- Apps table ----------
  const PILL = { healthy: "Healthy", warning: "Warning", critical: "Critical", info: "Info", paused: "Paused" };
  const pillOf = (a) => (a.health === "info" && a.pausedOnly ? "Paused" : PILL[a.health]);

  function compStatus(c) {
    if (c.kind === "github") return { st: "none", t: "repository" };
    const k = c.state;
    const dep = c.kind !== "supabase" ? c.site?.deploy?.state : "";
    if (c.kind === "supabase") {
      if (c.site.deploy?.state !== "active_healthy") return { st: "none", t: "paused" };
      return k === "degraded" ? { st: "mid", t: "services unhealthy" } : { st: "good", t: "active" };
    }
    if (k === "down") return { st: "bad", t: "down" };
    if (dep === "error") return { st: "bad", t: "deploy failed" };
    if (k === "degraded") return { st: "mid", t: "degraded" };
    if (k === "up" || k === "protected") return { st: rate("deploy", dep) === "mid" ? "mid" : "good", t: k === "protected" ? "up, behind login" : "up" };
    return { st: "none", t: k === "paused" ? "paused" : "not checked" };
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
  function miniSpark(a) {
    const ser = a.series, n = ser.length;
    const ok = ser.filter((p) => p && p.ms != null && p.ms > 0 && p.state !== "down");
    if (!ok.length) return `<span class="spark-empty"></span>`;
    const W = 60, H = 18, P = 2;
    const vals = ok.map((p) => p.ms); const lo = Math.min(...vals), hi = Math.max(...vals);
    const span = Math.max(hi - lo, hi * 0.2, 20);
    const x = (i) => (n > 1 ? P + (i * (W - 2 * P)) / (n - 1) : W / 2);
    const y = (v) => P + (1 - (v - lo) / span) * (H - 2 * P);
    const pts = []; ser.forEach((p, i) => { if (p && p.ms > 0 && p.state !== "down") pts.push([x(i), y(p.ms)]); });
    const last = pts[pts.length - 1];
    return `<svg class="mspark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">${pts.length > 1 ? `<polyline points="${pts.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ")}"/>` : ""}<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2"/></svg>`;
  }
  const updTip = (a) => `Last deploy: ${a.lastDeployAny ? fmtDateTime(a.lastDeployAny) : "n/a"}\nLast push: ${a.lastPush ? fmtDateTime(a.lastPush) : "n/a"}`;
  function appRow(a) {
    const live = safeUrl(a.live), href = live || safeUrl(a.dashboardFallback);
    const host = live ? hostOf(live) : a.comps.some((c) => c.kind === "supabase") ? "Database only" : "No live site";
    const hs = rate("app", a.health);
    const sameKind = (k) => a.comps.filter((c) => c.kind === k).length > 1;
    const chips = a.comps.map((c) => {
      const s = compStatus(c); const link = safeUrl(c.dashboard) || safeUrl(c.url);
      const label = PLATFORM[c.kind] + (sameKind(c.kind) ? ` · ${c.name}` : "");
      const inner = `<b>${GLYPH[c.kind]}</b>${sdot(s.st)}<span class="sr">${esc(label)} (${esc(s.t)})</span>`;
      return link ? `<a class="pchip" href="${esc(link)}" target="_blank" rel="noopener" title="${esc(compTip(c))}">${inner}</a>` : `<span class="pchip" title="${esc(compTip(c))}">${inner}</span>`;
    }).join("");
    const dc = a.comps.filter((c) => WEB.has(c.kind) && c.site?.deploy?.at).sort((x, y) => String(y.site.deploy.at).localeCompare(String(x.site.deploy.at)))[0];
    const failed = a.updatedSource === "deploy" && dc && dc.site.deploy.state === "error" && dc.site.deploy.at === a.updatedAt;
    const updSub = a.updatedAt ? `${failed ? "Deploy failed" : a.updatedSource === "deploy" ? "Deployed" : "Pushed"} ${ago(a.updatedAt)}` : "";
    const stateWord = pillOf(a);
    return `<tr id="${a.id}" tabindex="-1" data-name="${esc(a.names.join(" ").toLowerCase() + " " + a.key)}">
      <td class="c-st" data-l="Status"><span class="stc">${sdot(hs)}${stateWord}</span></td>
      <td class="c-app"><div class="app-n"><b title="${esc(a.names.join(" · "))}">${live ? `<a href="${esc(live)}" target="_blank" rel="noopener">${esc(a.name)}</a>` : esc(a.name)}</b><small title="${esc(host)}">${esc(host)}</small></div></td>
      <td class="c-plat"><div class="pchips">${chips}</div></td>
      <td class="c-up r" data-l="Uptime"><b class="num st-${rate("uptime", a.pct)}"><span class="t">${fmtPct(a.pct)}</span></b></td>
      <td class="c-resp" data-l="Response"><span class="resp st-${rate("ms", a.avgMs)}"><b class="num t">${a.avgMs != null ? a.avgMs + " ms" : "n/a"}</b>${miniSpark(a)}</span></td>
      <td class="c-upd" data-l="Last updated" title="${esc(updTip(a))}"><div class="upd num"><b>${esc(fmtDate(a.updatedAt))}</b>${updSub ? `<small class="${failed ? "st-bad t" : ""}">${esc(updSub)}</small>` : ""}</div></td>
      <td class="c-act">${href ? `<a class="btn sm" href="${esc(href)}" target="_blank" rel="noopener">${live ? "Open app" : "Open dashboard"} ${EXT}<span class="sr"> (opens in a new tab)</span></a>` : ""}</td>
    </tr>`;
  }
  const FILTERS = [["all", "All"], ["attention", "Issues"], ["healthy", "Healthy"], ["inactive", "Paused"]];
  const FKEYS = FILTERS.map((f) => f[0]);
  try { const f = localStorage.getItem("pulse-app-filter"); if (FKEYS.includes(f)) appFilter = f; } catch {}
  const SORTS = [["status", "Status"], ["name", "Name"], ["updated", "Last updated"]];
  try { const f = localStorage.getItem("pulse-app-sort"); if (SORTS.some((x) => x[0] === f)) appSort = f; } catch {}
  const sortApps = (list) => {
    if (appSort === "name") return list.slice().sort((a, b) => a.name.localeCompare(b.name));
    if (appSort === "updated") return list.slice().sort((a, b) => (b.updatedAt ? +new Date(b.updatedAt) : 0) - (a.updatedAt ? +new Date(a.updatedAt) : 0) || a.name.localeCompare(b.name));
    return list;
  };
  const matchesFilter = (a, f) => f === "all" || (f === "attention" ? ["critical", "warning"].includes(a.health) : f === "healthy" ? a.health === "healthy" : a.health === "info");

  function renderApps() {
    $("#app-filters").innerHTML = FILTERS.map(([k, l]) => `<button type="button" data-k="${k}" aria-pressed="${appFilter === k}">${l}<span class="count num">${APPS.filter((a) => matchesFilter(a, k)).length}</span></button>`).join("");
    $("#app-sort").innerHTML = SORTS.map(([k, l]) => `<button type="button" data-k="${k}" aria-pressed="${appSort === k}">${l}</button>`).join("");
    $("#apps-count").textContent = String(APPS.length);
    const q = appQuery.trim().toLowerCase();
    const shown = sortApps(APPS).filter((a) => matchesFilter(a, appFilter) && (!q || a.name.toLowerCase().includes(q) || a.key.includes(q) || a.names.some((n) => n.toLowerCase().includes(q))));
    const box = $("#apps");
    if (!shown.length) {
      box.innerHTML = `<div class="empty">${!APPS.length ? "No apps found yet." : q ? `No apps match “${esc(appQuery.trim())}”.` : appFilter === "attention" ? "No apps with issues." : "Nothing in this view."}</div>`;
      syncSegs();
      return;
    }
    box.innerHTML = `<div class="tw"><table class="atbl"><thead><tr><th class="c-st">Status</th><th>App</th><th>Platforms</th><th class="r">Uptime</th><th>Response</th><th class="c-upd">Last updated</th><th><span class="sr">Actions</span></th></tr></thead><tbody>${shown.map(appRow).join("")}</tbody></table></div>`;
    syncSegs();
  }
  function jumpToApp(id) {
    let el = document.getElementById(id);
    if (!el) { appFilter = "all"; appQuery = ""; syncSearch(); renderApps(); el = document.getElementById(id); }
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
  $("#app-sort").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    appSort = b.dataset.k; renderApps();
    try { localStorage.setItem("pulse-app-sort", appSort); } catch {}
  });
  $("#panel-overview").addEventListener("click", (e) => { const b = e.target.closest("[data-jump]"); if (b) jumpToApp(b.dataset.jump); });

  // ---------- All checks ----------
  function renderSites(d, history) {
    const N = matchMedia("(max-width: 760px)").matches ? 36 : 48;
    const sites = (d.sites || []).map((s) => ({ ...s, h: siteHistory(s.id, history, N), state: s.check?.state || "unknown" }));
    const rank = { down: 0, degraded: 1, unknown: 2, up: 3, protected: 3, paused: 4 };
    const deployBad = (s) => s.deploy?.state === "error";
    sites.sort((a, b) => (rank[a.state] - rank[b.state]) || (deployBad(b) - deployBad(a)) || a.name.localeCompare(b.name));
    const issues = sites.filter((s) => ["down", "degraded"].includes(s.state) || deployBad(s));
    $("#checks-count").textContent = `${sites.length}`;
    const tabs = [["all", "All", sites.length], ...["netlify", "vercel", "supabase", "custom"].map((p) => [p, PLATFORM[p], sites.filter((s) => s.platform === p).length]).filter((t) => t[2]), ["issues", "Issues", issues.length]];
    $("#filters").innerHTML = tabs.map(([k, l, c]) => `<button type="button" role="tab" data-k="${k}" aria-selected="${checkFilter === k}">${l}<span class="count num">${c}</span></button>`).join("");
    $("#filters").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; checkFilter = b.dataset.k; renderSites(d, history); };
    segSync($("#filters"));
    const shown = sites.filter((s) => checkFilter === "all" || (checkFilter === "issues" ? issues.includes(s) : s.platform === checkFilter));
    if (!shown.length) { $("#sites").innerHTML = `<div class="empty">${checkFilter === "issues" ? "No issues." : "Nothing here yet."}</div>`; return; }
    $("#sites").innerHTML = shown.map((s) => {
      const st = STATE[s.state] || STATE.unknown; const sst = rate("state", s.state);
      let host = ""; try { host = s.url ? new URL(s.url).host : ""; } catch {}
      const deploy = s.deploy?.state && s.platform !== "supabase" ? (s.deploy.at && !deployBad(s) ? ` · deployed ${ago(s.deploy.at)}` : "") : s.region ? ` · ${esc(s.region)}` : "";
      const ticks = s.h.ticks.map((t) => {
        const title = t.t ? `${new Date(t.t).toLocaleString()} · ${(STATE[t.state] || STATE.unknown).label}${t.ms != null ? ` · ${t.ms} ms` : ""}` : "No data";
        return `<i class="cell st-${rate("state", t.state)}" title="${esc(title)}"></i>`;
      }).join("");
      const link = safeUrl(s.platform === "supabase" ? s.dashboard : s.url);
      return `<div class="site">
        <div class="site-name">${sdot(sst)}<div class="txt"><div class="nrow">${link ? `<a class="n" href="${esc(link)}" target="_blank" rel="noopener">${esc(s.name)}</a>` : `<span class="n">${esc(s.name)}</span>`}${deployBad(s) ? chip("bad", "deploy failed") : ""}</div>
          <div class="host"><span class="pf">${esc(PLATFORM[s.platform])}</span><span>${esc(host)}${deploy}</span></div></div></div>
        <div class="ticks-wrap"><div class="ticks">${ticks}</div><div class="lbl"><span>Last ${N} checks</span><span>${esc(st.label)}${s.check?.status ? ` · HTTP ${s.check.status}` : ""}</span><span>latest</span></div></div>
        <div class="ms num st-${rate("ms", s.check?.ms)}"><span class="t">${s.check?.ms != null ? `${s.check.ms} ms` : "n/a"}</span><small>response</small></div>
        <div class="pct num st-${s.state === "paused" ? "none" : rate("uptime", s.h.pct)}"><span class="t">${s.state === "paused" ? "n/a" : fmtPct(s.h.pct)}</span><small>uptime</small></div>
      </div>`;
    }).join("");
  }

  function renderWarnings(d) {
    const errs = d.errors || [];
    $("#warnings").hidden = !errs.length;
    if (!errs.length) return;
    const el = $("#warnings");
    el.querySelector("summary").textContent = `${errs.length} collector warning${errs.length > 1 ? "s" : ""}`;
    el.querySelector("ul").innerHTML = errs.map((e) => `<li>${esc(e)}</li>`).join("");
  }

  // ---------- Sidebar ----------
  function renderSide(d) {
    const cnt = { netlify: 0, vercel: 0, supabase: 0 };
    for (const s of d.sites || []) if (cnt[s.platform] != null) cnt[s.platform]++;
    const gh = (d.github?.repos || []).filter((r) => !r.archived).length;
    const rows = [["netlify", "Netlify", cnt.netlify], ["vercel", "Vercel", cnt.vercel], ["supabase", "Supabase", cnt.supabase], ["github", "GitHub", gh]];
    $("#side-plat").innerHTML = rows.map(([k, n, c]) => {
      const u = safeUrl(d.accounts?.[k]);
      const inner = `${GLYPHCHIP(k)}<span class="sl">${n}</span><span class="sbadge num gray">${c}</span>`;
      return u ? `<a class="srow" href="${esc(u)}" target="_blank" rel="noopener">${inner}<span class="sr"> (opens in a new tab)</span></a>` : `<div class="srow">${inner}</div>`;
    }).join("");
    const b = $("#sb-overview"); const crit = INC.some((r) => r.sev === "critical");
    b.hidden = !INC.length; b.textContent = String(INC.length); b.className = `sbadge num st-${crit ? "bad" : "mid"}`;
  }

  // ---------- Search (toolbar field and sidebar field stay in sync) ----------
  function syncSearch() {
    const v = curTab === "links" ? linkQuery : curTab === "overview" ? appQuery : "";
    const on = curTab === "links" || curTab === "overview";
    for (const el of [$("#app-search"), $("#side-search")]) {
      el.value = v; el.disabled = !on;
      el.placeholder = curTab === "links" ? "Filter links" : curTab === "overview" ? "Search apps" : "Search";
    }
  }
  function onSearch(v) {
    if (curTab === "links") { linkQuery = v; renderLinks(); }
    else if (curTab === "overview") { appQuery = v; renderApps(); }
    syncSearch();
  }
  for (const el of [$("#app-search"), $("#side-search")]) el.addEventListener("input", (e) => { const v = e.target.value; onSearch(v); e.target.value = v; });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      const el = [$("#side-search"), $("#app-search")].find((x) => x.offsetParent !== null && !x.disabled);
      if (el) { e.preventDefault(); el.focus(); el.select(); }
    }
  });

  // ---------- Tabs ----------
  const TABS = ["overview", "traffic", "links", "archive"];
  const TAB_KEY = "pulse-tab";
  const hashTab = () => { const h = location.hash.replace(/^#/, "").toLowerCase(); return h === "apps" ? "overview" : TABS.includes(h) ? h : null; };
  function setTab(t, persist = true) {
    curTab = t;
    for (const k of TABS) { const p = $("#panel-" + k); if (p) p.hidden = k !== t; }
    document.querySelectorAll("[data-tab]").forEach((b) => {
      const on = b.dataset.tab === t;
      if (b.getAttribute("role") === "tab") { b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; }
      else if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    syncSearch();
    syncSegs();
    if (persist) { try { localStorage.setItem(TAB_KEY, t); } catch {} }
    if (t === "traffic") { try { drawChart(); } catch (e) { console.warn(e); } }
    if (t === "overview") { try { redrawResp(); } catch (e) { console.warn(e); } }
  }
  function redrawResp() { const el = $("#resp-chart"); if (el && el._cfg) chart(el, el._cfg); }
  const goTab = (t) => {
    setTab(t);
    try { history.replaceState(null, "", "#" + t); } catch {}
    window.scrollTo({ top: 0, behavior: reduceMotion() ? "auto" : "smooth" });
  };
  (function initTabs() {
    let t = hashTab();
    if (!t) { try { t = localStorage.getItem(TAB_KEY); } catch {} }
    if (!TABS.includes(t)) t = "overview";
    pendingApps = location.hash === "#apps";
    setTab(t, false);
    for (const sel of ["#tabs", "#side", ".bbar"]) {
      $(sel).addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) goTab(b.dataset.tab); });
    }
    $("#tabs").addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const i = TABS.indexOf(document.activeElement?.dataset?.tab); if (i < 0) return;
      const n = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
      setTab(n); $(`#tabs [data-tab="${n}"]`).focus();
      try { history.replaceState(null, "", "#" + n); } catch {}
    });
    window.addEventListener("hashchange", () => { const h = hashTab(); if (h) { setTab(h); if (location.hash === "#apps") $("#apps-section").scrollIntoView({ block: "start" }); } });
  })();
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
  }  // ---------- Encryption (PBKDF2-SHA256 -> AES-256-GCM) ----------
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

  // ---------- Traffic tab ----------
  const REPO_NEW_TOKEN = "https://github.com/settings/personal-access-tokens/new";
  const REPO_SECRETS = "https://github.com/fastermatt/project-pulse/settings/secrets/actions";
  const STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 50000, 100000, 1000000];

  function drawChart() { const el = $("#gh-chart"); if (el && TCFG) chart(el, TCFG); }

  const kpiT = (ic, label, val, cap) => `<div class="pn kpi"><div class="k-top"><span class="ib">${ico(ic)}</span><span class="k-l">${label}</span></div><div class="k-v"><b class="num">${val}</b></div><div class="k-f"><span class="k-c">${cap}</span></div></div>`;
  function rankList(rows, valKey) {
    const max = Math.max(1, ...rows.map((r) => r[valKey]));
    return `<ul class="rank">${rows.map((r) => `<li><div class="rk-top"><span class="rk-name" title="${esc(r.label)}">${esc(r.label)}</span><span class="num rk-val">${nf(r[valKey])}<small> · ${nf(r.uniques)} unique</small></span></div><div class="rk-bar"><i style="width:${Math.max(3, (r[valKey] / max) * 100).toFixed(1)}%"></i></div></li>`).join("")}</ul>`;
  }
  const tblWrap = (h) => `<div class="tbl-wrap">${h}</div>`;

  function renderTraffic(d, history) {
    const t = d.traffic || {};
    const gh = t.github;
    const info = new Map((d.github?.repos || []).map((r) => [r.name, r]));
    TCFG = null; SERIES = null;
    let html = `<div class="bento">`;
    if (!gh || !gh.configured) {
      html += `<section class="pn span7 setup">${pnh("git", "GitHub traffic", chip("none", "Not connected"))}
        <p class="lead">${esc(gh?.note || "Add a GH_REPOS_TOKEN secret to see views, clones and referrers.")}</p>
        <ol class="steps">
          <li>Open GitHub, Settings, Developer settings, Personal access tokens, <b>Fine-grained tokens</b>, Generate new token.</li>
          <li>Repository access: <b>All repositories</b>.</li>
          <li>Repository permissions: <b>Administration: Read-only</b> and <b>Metadata: Read-only</b>.</li>
          <li>Add the token as a repository secret named <code>GH_REPOS_TOKEN</code> in <code>fastermatt/project-pulse</code> (Settings, Secrets and variables, Actions).</li>
          <li>Run the <b>Pulse</b> workflow from the Actions tab.</li>
        </ol>
        <div class="row-actions">${extLink(REPO_NEW_TOKEN, "Create token " + EXT, "btn sm")}${extLink(REPO_SECRETS, "Add secret " + EXT, "btn sm")}</div></section>`;
    } else {
      const rows = (gh.repos || []).slice().sort((a, b) => (b.views.count - a.views.count) || (b.clones.count - a.clones.count) || a.name.localeCompare(b.name));
      const sum = (f) => rows.reduce((acc, r) => acc + f(r), 0);
      if (gh.note) html += `<div class="note warnnote span12">${esc(gh.note)}</div>`;
      if (!rows.length) html += `<section class="pn span12">${pnh("git", "GitHub traffic")}<div class="note">No traffic numbers yet. GitHub keeps 14 days; the next collector run fills this in.</div></section>`;
      else {
        html += `<div class="kpirow span12">${kpiT("eye", "Views", nf(sum((r) => r.views.count)), "last 14 days")}${kpiT("users", "Unique visitors", nf(sum((r) => r.views.uniques)), "summed per repo")}${kpiT("git", "Clones", nf(sum((r) => r.clones.count)), "last 14 days")}${kpiT("users", "Unique cloners", nf(sum((r) => r.clones.uniques)), "summed per repo")}</div>`;
        SERIES = trafficSeries(history);
        const refs = new Map(), paths = new Map();
        for (const r of rows) {
          for (const e of r.referrers || []) { const x = refs.get(e.referrer) || { label: e.referrer, count: 0, uniques: 0 }; x.count += e.count || 0; x.uniques += e.uniques || 0; refs.set(e.referrer, x); }
          for (const e of r.paths || []) { const x = paths.get(e.path) || { label: e.path, title: e.title, count: 0, uniques: 0 }; x.count += e.count || 0; x.uniques += e.uniques || 0; paths.set(e.path, x); }
        }
        const top = (m) => [...m.values()].sort((a, b) => b.count - a.count).slice(0, 8);
        const tr = top(refs), tp = top(paths);
        html += `<section class="pn span8">${pnh("chart", "Daily views and clones", `<div class="legend"><span><i class="sw s-a"></i>Views</span><span><i class="sw s-b"></i>Clones</span></div>`)}
          ${SERIES ? `<div id="gh-chart" class="chart"></div><div class="chart-foot">All repos combined · ${SERIES.length} day${SERIES.length === 1 ? "" : "s"} recorded</div>` : `<div class="note">Daily history builds up after the next collector runs.</div>`}</section>
          <section class="pn span4">${pnh("link", "Top referrers")}${tr.length ? rankList(tr, "count") : `<div class="note">No referrer data yet.</div>`}</section>
          <section class="pn span8">${pnh("git", "By repository")}${tblWrap(`<table class="tbl"><thead><tr><th>Repository</th><th class="r">Views</th><th class="r">Unique</th><th class="r">Clones</th><th class="r">Unique</th><th class="r">Stars</th><th class="r">Forks</th></tr></thead><tbody>${rows.map((r) => {
            const i = info.get(r.name);
            return `<tr><td>${i?.url ? extLink(i.url, esc(r.name), "tl") : esc(r.name)}${i?.private ? ` ${LOCK_SVG}` : ""}</td><td class="r num">${nf(r.views.count)}</td><td class="r num dim">${nf(r.views.uniques)}</td><td class="r num">${nf(r.clones.count)}</td><td class="r num dim">${nf(r.clones.uniques)}</td><td class="r num">${i ? nf(i.stars) : "n/a"}</td><td class="r num">${i ? nf(i.forks) : "n/a"}</td></tr>`;
          }).join("")}</tbody></table>`)}</section>
          <section class="pn span4">${pnh("list", "Top paths")}${tp.length ? rankList(tp, "count") : `<div class="note">No path data yet.</div>`}</section>`;
        if (SERIES) {
          const n = SERIES.length;
          const { top: yt, ticks } = niceTicks(Math.max(1, ...SERIES.map((p) => Math.max(p.views, p.clones))), STEPS);
          const dl = (iso, o) => new Date(iso + "T00:00:00Z").toLocaleDateString([], { timeZone: "UTC", ...o });
          TCFG = {
            id: "gh", n, top: yt, ticks, aria: `Daily GitHub views and clones across all repos, last ${n} days`,
            series: [{ vals: SERIES.map((p) => p.views), cls: "s-a", area: true }, { vals: SERIES.map((p) => p.clones), cls: "s-b" }],
            xl: (i) => dl(SERIES[i].date, { month: "short", day: "numeric" }),
            tip: (i) => { const p = SERIES[i]; return `${dl(p.date, { weekday: "short", month: "short", day: "numeric" })} · ${p.views} views (${p.vu} unique) · ${p.clones} clones (${p.cu} unique)`; },
          };
        }
      }
    }

    const forms = (t.netlifyForms || []).slice().sort((a, b) => (b.submissions - a.submissions) || String(a.site).localeCompare(b.site));
    const users = (t.supabaseUsers || []).slice().sort((a, b) => b.users - a.users);
    html += `<section class="pn span6">${pnh("mail", "Netlify form submissions")}${forms.length ? tblWrap(`<table class="tbl"><thead><tr><th>Site</th><th>Form</th><th class="r">Submissions</th><th class="r">Last</th></tr></thead><tbody>${forms.map((f) => `<tr><td>${extLink(f.dashboard, esc(f.site), "tl") || esc(f.site)}</td><td>${esc(f.form)}</td><td class="r num">${nf(f.submissions)}</td><td class="r dim">${f.lastAt ? ago(f.lastAt) : "never"}</td></tr>`).join("")}</tbody></table>`) : `<div class="note">No forms found on your Netlify sites.</div>`}</section>
      <section class="pn span6">${pnh("users", "Supabase app users")}${users.length ? tblWrap(`<table class="tbl"><thead><tr><th>Project</th><th class="r">Users</th><th class="r">Last sign-in</th><th class="r">Last signup</th></tr></thead><tbody>${users.map((u) => `<tr><td>${/^[a-z0-9]+$/i.test(u.ref || "") ? extLink(`https://supabase.com/dashboard/project/${u.ref}/auth/users`, esc(u.name), "tl") : esc(u.name)}</td><td class="r num">${nf(u.users)}</td><td class="r dim">${u.lastSignIn ? ago(u.lastSignIn) : "never"}</td><td class="r dim">${u.lastSignup ? ago(u.lastSignup) : "never"}</td></tr>`).join("")}</tbody></table>`) : `<div class="note">No Supabase user counts available (needs an active project and SUPABASE_TOKEN).</div>`}</section>`;
    const acct = d.accounts || {};
    html += `<section class="pn span12 untracked">${pnh("eye", "Site visitors", chip("none", "Not tracked"))}
      <p><b>Vercel Web Analytics</b> is off on all projects. Enable it per project and add the <code>@vercel/analytics</code> snippet to each app.</p>
      <p><b>Netlify visitor analytics</b> is a paid add-on. No numbers until it is enabled.</p>
      <div class="row-actions">${extLink(acct.vercel || "https://vercel.com/dashboard", "Open Vercel " + EXT, "btn sm")}${extLink(acct.netlify || "https://app.netlify.com", "Open Netlify " + EXT, "btn sm")}</div></section></div>`;
    $("#traffic").innerHTML = html;
    if (curTab === "traffic") drawChart();
  }

  // ---------- Links tab ----------
  function tile({ kind, name, host, meta, url, locked, badge, dot, date }) {
    const q = lower([name, host, meta, kind, badge].join(" "));
    return { q, html: `<a class="frow" href="${esc(url)}" target="_blank" rel="noopener">${GLYPHCHIP(kind)}<span class="fn">${dot || ""}<span class="tn">${esc(name)}</span>${locked ? LOCK_SVG : ""}${badge ? `<em class="badge">${esc(badge)}</em>` : ""}</span><span class="fm">${esc([host, meta].filter(Boolean).join(" · "))}</span><span class="fd num"${date ? ` title="${esc(date.tip)}"` : ""}>${date ? esc(fmtDate(date.at)) : ""}</span><span class="to">${EXT}</span><span class="sr"> (opens in a new tab)</span></a>` };
  }
  function buildLinkSections(d) {
    const secs = [];
    const seenHost = new Set(); const live = [];
    for (const s of d.sites || []) {
      if (s.platform === "supabase" || !safeUrl(s.url)) continue;
      const h = hostOf(s.url); if (seenHost.has(h)) continue; seenHost.add(h);
      const st = STATE[s.check?.state || "unknown"] || STATE.unknown;
      live.push(tile({ kind: s.platform, name: s.name, host: h, meta: st.label, url: s.url, dot: sdot(rate("state", s.check?.state)), date: s.deploy?.at ? { at: s.deploy.at, tip: `Last deploy ${fmtDateTime(s.deploy.at)}` } : null }));
    }
    for (const r of d.github?.repos || []) {
      if (!safeUrl(r.homepage)) continue;
      const h = hostOf(r.homepage); if (seenHost.has(h)) continue; seenHost.add(h);
      live.push(tile({ kind: "custom", name: r.name, host: h, meta: "Repo homepage", url: r.homepage, date: r.pushedAt ? { at: r.pushedAt, tip: `Last push ${fmtDateTime(r.pushedAt)}` } : null }));
    }
    secs.push({ title: "Live sites", icon: "pulse", sub: "", tiles: live });
    const dash = [];
    for (const s of (d.sites || []).slice().sort((a, b) => (COMP_ORDER[a.platform] - COMP_ORDER[b.platform]) || a.name.localeCompare(b.name))) {
      if (!["netlify", "vercel", "supabase"].includes(s.platform) || !safeUrl(s.dashboard)) continue;
      dash.push(tile({ kind: s.platform, name: s.name, host: hostOf(s.dashboard), meta: `${PLATFORM[s.platform]} dashboard`, url: s.dashboard, date: s.deploy?.at ? { at: s.deploy.at, tip: `Last deploy ${fmtDateTime(s.deploy.at)}` } : null }));
    }
    secs.push({ title: "App dashboards", icon: "server", sub: "", tiles: dash });
    const repos = (d.github?.repos || []).slice().sort((a, b) => (Number(a.archived) - Number(b.archived)) || String(b.pushedAt).localeCompare(String(a.pushedAt)));
    secs.push({ title: "GitHub repos", icon: "git", sub: `${repos.length} repositor${repos.length === 1 ? "y" : "ies"}`, tiles: repos.filter((r) => safeUrl(r.url)).map((r) => tile({ kind: "github", name: r.name, host: r.language || "", meta: `${nf(r.stars)} stars · ${nf(r.forks)} forks · pushed ${ago(r.pushedAt)}`, url: r.url, locked: r.private, badge: r.archived ? "Archived" : "", date: r.pushedAt ? { at: r.pushedAt, tip: `Last push ${fmtDateTime(r.pushedAt)}` } : null })) });
    const acct = d.accounts || {};
    const A = [["netlify", "Netlify team", acct.netlify], ["vercel", "Vercel", acct.vercel], ["supabase", "Supabase organization", acct.supabase], ["github", "GitHub profile", acct.github]];
    secs.push({ title: "Accounts", icon: "users", sub: "", tiles: A.filter((a) => safeUrl(a[2])).map(([k, n, u]) => tile({ kind: k, name: n, host: hostOf(u), meta: "", url: u })) });
    const custom = (d.config?.links || []).filter((l) => l && safeUrl(l.url));
    const byGroup = new Map();
    for (const l of custom) { const g = l.group || "Other"; if (!byGroup.has(g)) byGroup.set(g, []); byGroup.get(g).push(tile({ kind: "custom", name: l.label || hostOf(l.url), host: hostOf(l.url), meta: g, url: l.url })); }
    if (byGroup.size) for (const [g, tiles] of byGroup) secs.push({ title: byGroup.size === 1 && g === "Other" ? "Custom" : `Custom · ${g}`, icon: "link", sub: "", tiles });
    else secs.push({ title: "Custom", icon: "link", sub: "", tiles: [], emptyHint: `Add your own links under <code>links</code> in pulse.config.json, e.g. <code>{"label": "Docs", "url": "https://…", "group": "Work"}</code>.` });
    return secs;
  }
  function renderLinks() {
    if (!D) return;
    const q = lower(linkQuery).trim();
    let any = false;
    const html = buildLinkSections(D).map((s) => {
      const shown = q ? s.tiles.filter((x) => x.q.includes(q)) : s.tiles;
      if (q && !shown.length) return "";
      if (!shown.length && !s.emptyHint) return "";
      any = true;
      return `<section class="pn lsec">${pnh(s.icon, esc(s.title), `<span class="count num">${shown.length}</span>`, esc(s.sub))}${shown.length ? `<div class="flist">${shown.map((x) => x.html).join("")}</div>` : `<div class="note">${s.emptyHint}</div>`}</section>`;
    }).join("");
    $("#links").innerHTML = any ? `<div class="cols">${html}</div>` : `<div class="empty">No links match “${esc(linkQuery.trim())}”.</div>`;
  }

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
    const sb = $("#sb-archive"); sb.hidden = !arch.length; sb.textContent = String(arch.length); sb.className = "sbadge num gray";
    const ghArch = (D.github?.repos || []).filter((r) => r.archived);
    const dormant = dormantItems();

    let html = `<div class="bento"><section class="pn span12">${pnh("box", "Ready to delete", `<span id="arch-progress" class="count num">${doneCount}/${arch.length} done</span>`, "hidden from the dashboard, not monitored")}`;
    if (!arch.length) html += `<div class="empty">Nothing archived. Add project names to <code>archive</code> in pulse.config.json.</div>`;
    else html += `<ul class="checklist">${arch.map((x) => {
      const id = esc(key(x)); const plat = PLATFORM[x.platform] || x.platform;
      return `<li class="arch${done[key(x)] ? " is-done" : ""}">
        <label class="mcheck"><input type="checkbox" data-done="${id}"${done[key(x)] ? " checked" : ""}><span class="sr">Mark ${esc(x.name)} as done</span></label>
        <div class="arch-main"><div class="arch-name"><b>${esc(x.name)}</b><span class="pf">${esc(plat)}</span>${x.status ? `<span class="chip st-none">${esc(String(x.status).replace(/_/g, " ").toLowerCase())}</span>` : ""}</div>
        <div class="arch-sub">${x.lastDeployAt ? `<span title="${esc(fmtDateTime(x.lastDeployAt))} · ${esc(ago(x.lastDeployAt))}">Last deploy ${esc(fmtDate(x.lastDeployAt))}</span>` : "No deploy data"}</div></div>
        <div class="arch-actions">${extLink(x.url || x.dashboard, "Open " + EXT, "btn sm")}${extLink(x.deleteUrl, `Delete in ${esc(plat)} ${EXT}`, "btn sm danger")}</div></li>`;
    }).join("")}</ul><div class="hint">Checkboxes are a personal checklist saved in this browser. Nothing is deleted from here.</div>`;
    html += `</section>`;

    html += `<section class="pn span7">${pnh("clock", "Possibly dormant", `<span class="count num">${dormant.length}</span>`, `no deploy or push in ${DORMANT_DAYS}+ days`)}`;
    if (!dormant.length) html += `<div class="empty">Nothing looks dormant.</div>`;
    else html += `<ul class="checklist">${dormant.map((x) => `<li class="arch"><div class="arch-main"><div class="arch-name"><b>${esc(x.name)}</b><span class="chip st-none">${esc(x.what)}</span></div><div class="arch-sub"><span title="${esc(ago(new Date(x.at).toISOString()))}">Last activity ${esc(fmtDate(new Date(x.at).toISOString()))}</span></div></div><div class="arch-actions">${x.links.map(([l, u]) => extLink(u, `${esc(l)} ${EXT}`, "btn sm")).join("")}</div></li>`).join("")}</ul>
      <div class="hint">Suggestions only. Add a name to <code>archive</code> in pulse.config.json to move it here.</div>`;
    html += `</section>`;

    html += `<section class="pn span5">${pnh("git", "Archived GitHub repos", `<span class="count num">${ghArch.length}</span>`)}`;
    if (!ghArch.length) html += `<div class="empty">No archived repositories.</div>`;
    else html += `<ul class="checklist">${ghArch.map((r) => `<li class="arch"><div class="arch-main"><div class="arch-name"><b>${esc(r.name)}</b>${r.private ? LOCK_SVG : ""}${r.language ? `<span class="chip st-none">${esc(r.language)}</span>` : ""}</div><div class="arch-sub">${r.pushedAt ? `<span title="${esc(fmtDateTime(r.pushedAt))} · ${esc(ago(r.pushedAt))}">Last pushed ${esc(fmtDate(r.pushedAt))}</span>` : "No push data"}</div></div><div class="arch-actions">${extLink(r.url, "Open " + EXT, "btn sm")}${safeUrl(r.url) ? extLink(r.url + "/settings#danger-zone", "Delete in GitHub " + EXT, "btn sm danger") : ""}</div></li>`).join("")}</ul>`;
    html += `</section></div>`;
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

  // ---------- Load ----------
  async function load(password) {
    const bust = `?t=${Math.floor(Date.now() / 60000)}`;
    const [encLatest, encHistory] = await Promise.all([
      fetchEnc("latest", bust),
      fetchEnc("history", bust).catch(() => null),
    ]);
    const d = await decrypt(encLatest, password);
    const history = encHistory ? await decrypt(encHistory, password).catch((e) => { if (e.wrongPassword) return { runs: [] }; throw e; }) : { runs: [] };
    document.title = d.title || "Project Pulse";
    document.querySelectorAll(".js-title").forEach((el) => { el.textContent = d.title || "Project Pulse"; });
    const next = new Date(new Date(d.generatedAt).getTime() + (d.intervalMinutes || 60) * 60000);
    const stale = Date.now() - new Date(d.generatedAt).getTime() > (d.intervalMinutes || 60) * 120000;
    document.querySelectorAll(".js-updated").forEach((el) => {
      el.textContent = stale ? `Updated ${ago(d.generatedAt)}, refresh overdue` : `Updated ${ago(d.generatedAt)}`;
      el.title = `${new Date(d.generatedAt).toLocaleString()} · next ~${next.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    });
    D = d; HIST = history;
    const built = buildApps(d, history);
    APPS = built.apps; SPARE = built.spare;
    M = computeMetrics(d, history);
    buildIncidents(history, stale);
    renderKpis(stale);
    renderHealth(stale);
    renderIncidents();
    renderAvail();
    renderMatrix(history);
    renderResp();
    renderUsage(d);
    renderApps();
    renderSites(d, history);
    renderTraffic(d, history);
    renderLinks();
    renderArchive();
    renderSide(d);
    if (pendingApps && location.hash === "#apps") { pendingApps = false; $("#apps-section").scrollIntoView({ block: "start" }); }
    renderWarnings(d);
    if (curTab === "overview") redrawResp();
  }

  // ---------- Lock screen ----------
  const PASS_KEY = "pulse-pass";
  const showApp = () => { $("#lock").hidden = true; $("#app").hidden = false; document.body.classList.add("unlocked"); redrawResp(); drawChart(); syncSegs(); };
  const showLock = () => { $("#app").hidden = true; document.body.classList.remove("unlocked"); $("#lock").hidden = false; $("#lock-pass").focus(); };
  const noData = (e) => { $("#p-health").innerHTML = `${pnh("alert", "No data yet")}<p class="lead">Run the “Pulse” workflow once from the Actions tab. (${esc(e.message)})</p>`; };
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
