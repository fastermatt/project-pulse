(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Theme toggle (remembered per browser).
  const root = document.documentElement;
  try { const t = localStorage.getItem("pulse-theme"); if (t) root.dataset.theme = t; } catch {}
  $("#theme").addEventListener("click", () => {
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
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
  const PLATFORM = { netlify: "Netlify", vercel: "Vercel", supabase: "Supabase", custom: "Custom" };

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

  function meter(label, usedTxt, limitTxt, pct, foot, opts = {}) {
    const p = Math.min(100, opts.bar ?? pct ?? 0);
    return `<div class="meter">
      <div class="meter-top"><span class="label">${esc(label)}</span>
        <span class="val num">${usedTxt}${limitTxt ? ` <small>/ ${limitTxt}</small>` : ""}${pct != null ? ` <small>· ${Math.round(pct)}%</small>` : ""}</span></div>
      <div class="bar"><i style="width:${p}%;--c:${opts.color || levelColor(p)}"></i></div>
      ${foot ? `<div class="meter-foot">${foot}</div>` : ""}
    </div>`;
  }

  function cardHead(key, title, sub, href, linkTxt = "Usage ↗") {
    const letter = { netlify: "N", vercel: "▲", supabase: "S" }[key];
    return `<div class="card-head"><div class="logo ${key}">${letter}</div>
      <div><h3>${esc(title)}</h3>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>
      ${href ? `<a class="out" href="${esc(href)}" target="_blank" rel="noopener">${linkTxt}</a>` : ""}</div>`;
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
        body += meter("Bandwidth", fmtBytes(bw.usedBytes), bw.includedBytes ? fmtBytes(bw.includedBytes) : "", pct, left != null ? `Resets in ${left} day${left === 1 ? "" : "s"}` : "");
      }
      const bm = a.buildMinutes;
      if (bm?.used != null) {
        const pct = bm.included ? (bm.used / bm.included) * 100 : null;
        body += meter("Build minutes", `${bm.used}`, bm.included ? `${bm.included}` : "", pct);
      }
      if (!body) body = `<div class="note">Netlify didn't return usage numbers for this team (newer credit-based plans hide them from the API). Use the usage link for credits.</div>`;
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
        body += meter("Active projects (free tier)", `${active.length}`, `${sb.activeLimit}`, pct,
          active.length >= sb.activeLimit ? "At the limit: restoring a paused project needs another one paused first" : "");
      }
      for (const p of active) {
        const pct = p.dbLimitBytes && p.dbBytes != null ? (p.dbBytes / p.dbLimitBytes) * 100 : null;
        body += meter(`${p.name} · database`, fmtMiB(p.dbBytes), p.dbLimitBytes ? fmtMiB(p.dbLimitBytes) : "", pct);
      }
      const paused = sb.projects.filter((p) => p.status !== "ACTIVE_HEALTHY");
      if (paused.length) body += `<div class="chips">${paused.map((p) => `<span class="chip paused">${esc(p.name)} · ${esc(p.status.toLowerCase().replace(/_/g, " "))}</span>`).join("")}</div>`;
      cards.push(`<div class="card">${cardHead("supabase", "Supabase", `${sb.projects.length} projects`, sb.projects[0]?.usageDashboard)}${body}</div>`);
    }

    // Vercel
    if (!d.vercel?.configured) cards.push(notConfigured("vercel", "Vercel", "VERCEL_TOKEN"));
    else {
      const vs = (d.sites || []).filter((s) => s.platform === "vercel");
      const ok = vs.filter((s) => s.deploy?.state === "ready").length;
      const failed = vs.filter((s) => s.deploy?.state === "error");
      let body = meter("Production deploys ready", `${ok}`, `${vs.length}`, null, "",
        { bar: vs.length ? (ok / vs.length) * 100 : 0, color: failed.length ? "var(--warn)" : "var(--up)" });
      const u = d.vercel.usage;
      if (u?.source === "billing" && u.services) {
        const rows = Object.entries(u.services).sort((a, b) => b[1].quantity - a[1].quantity).slice(0, 6);
        body += rows.map(([k, v]) => `<div class="dim-row"><span>${esc(k)}</span><span class="num">${Math.round(v.quantity).toLocaleString()} ${esc(v.unit)}</span></div>`).join("");
      } else {
        body += `<div class="note">Vercel's Hobby plan doesn't expose usage through its API. The <b>Usage ↗</b> link opens your live meters.</div>`;
      }
      if (failed.length) body += `<div class="chips">${failed.map((s) => `<span class="chip bad">${esc(s.name)} · last deploy failed</span>`).join("")}</div>`;
      cards.push(`<div class="card">${cardHead("vercel", "Vercel", `${u?.plan ? u.plan + " · " : ""}${vs.length} projects`, u?.dashboard)}${body}</div>`);
    }

    $("#usage").innerHTML = cards.join("");
  }

  function siteHistory(id, history, n) {
    const runs = history?.runs || [];
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

  let filter = "all";
  function renderSites(d, history) {
    const N = matchMedia("(max-width: 760px)").matches ? 36 : 48;
    const sites = (d.sites || []).map((s) => ({ ...s, h: siteHistory(s.id, history, N), state: s.check?.state || "unknown" }));
    const rank = { down: 0, degraded: 1, unknown: 2, up: 3, protected: 3, paused: 4 };
    const deployBad = (s) => s.deploy?.state === "error";
    sites.sort((a, b) => (rank[a.state] - rank[b.state]) || (deployBad(b) - deployBad(a)) || a.name.localeCompare(b.name));

    const issues = sites.filter((s) => ["down", "degraded"].includes(s.state) || deployBad(s));
    const tabs = [["all", "All", sites.length], ...["netlify", "vercel", "supabase", "custom"].map((p) => [p, PLATFORM[p], sites.filter((s) => s.platform === p).length]).filter((t) => t[2]), ["issues", "Issues", issues.length]];
    $("#filters").innerHTML = tabs.map(([k, l, c]) => `<button role="tab" data-k="${k}" aria-selected="${filter === k}">${l}<span class="count num">${c}</span></button>`).join("");
    $("#filters").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; filter = b.dataset.k; renderSites(d, history); };

    const shown = sites.filter((s) => filter === "all" || (filter === "issues" ? issues.includes(s) : s.platform === filter));
    if (!shown.length) { $("#sites").innerHTML = `<div class="empty">${filter === "issues" ? "No issues. Everything's healthy." : "Nothing here yet."}</div>`; return; }

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
      const link = s.platform === "supabase" ? s.dashboard : s.url;
      return `<div class="site">
        <div class="site-name"><span class="dot" style="--c:${st.c}" title="${st.label}"></span>
          <div class="txt"><div class="nrow"><a class="n" href="${esc(link)}" target="_blank" rel="noopener">${esc(s.name)}</a>${deployBad(s) ? `<span class="chip bad sm">deploy failed</span>` : ""}</div>
          <div class="host"><span class="pf ${s.platform}">${PLATFORM[s.platform]}</span><span>${esc(host)}${deploy}</span></div></div></div>
        <div class="ticks-wrap"><div class="ticks">${ticks}</div><div class="lbl"><span>${N}h ago</span><span>${esc(st.label)}${s.check?.status ? ` · HTTP ${s.check.status}` : ""}</span><span>now</span></div></div>
        <div class="ms num">${s.check?.ms != null ? `${s.check.ms} ms` : "—"}<small>response</small></div>
        <div class="pct num">${s.state === "paused" ? "—" : s.h.pct != null ? `${s.h.pct >= 99.95 ? "100" : s.h.pct.toFixed(1)}%` : "—"}<small>uptime</small></div>
      </div>`;
    }).join("");
  }

  function renderHero(d, history) {
    const sites = d.sites || [];
    const down = sites.filter((s) => s.check?.state === "down");
    const degraded = sites.filter((s) => s.check?.state === "degraded");
    const failedDeploys = sites.filter((s) => s.deploy?.state === "error");
    const checked = sites.filter((s) => s.check && s.check.state !== "paused");
    const upCount = checked.filter((s) => ["up", "protected"].includes(s.check.state)).length;

    let c = "var(--up)", h = "All systems operational", p = `${checked.length} sites and apps are responding.`;
    if (!checked.length) { c = "var(--paused)"; h = "Waiting for the first check"; p = "The first scheduled run will fill this in."; }
    else if (down.length) { c = "var(--down)"; h = `${down.length} down`; p = down.map((s) => s.name).join(", "); }
    else if (degraded.length || failedDeploys.length) {
      c = "var(--warn)"; h = "Mostly operational";
      p = [degraded.length && `${degraded.length} degraded`, failedDeploys.length && `${failedDeploys.length} failed deploy${failedDeploys.length > 1 ? "s" : ""}`].filter(Boolean).join(" · ");
    }
    const ms = checked.map((s) => s.check.ms).filter((x) => x != null && x > 0);
    const avg = ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null;
    const all = checked.map((s) => siteHistory(s.id, history, 1).pct).filter((x) => x != null);
    const overall = all.length ? all.reduce((a, b) => a + b, 0) / all.length : null;

    $("#hero").innerHTML = `<span class="pulse" style="--c:${c}"></span>
      <div><h2>${esc(h)}</h2><p>${esc(p)}</p></div>
      <div class="stats">
        <div class="stat"><b class="num">${upCount}/${checked.length}</b><span>up now</span></div>
        <div class="stat"><b class="num">${overall != null ? overall.toFixed(overall >= 99.95 ? 0 : 1) + "%" : "—"}</b><span>uptime (${(history?.runs || []).length > 24 ? "30d" : "so far"})</span></div>
        <div class="stat"><b class="num">${avg != null ? avg + " ms" : "—"}</b><span>avg response</span></div>
      </div>`;
  }

  function renderRepos(d) {
    const repos = d.github?.repos || [];
    if (!repos.length) return;
    $("#repos-section").hidden = false;
    $("#repos").innerHTML = repos.slice(0, 12).map((r) => `<a class="repo" href="${esc(r.url)}" target="_blank" rel="noopener">
      <b>${esc(r.name)}</b><span>${r.private ? "Private · " : ""}${esc(r.language || "")}${r.language ? " · " : ""}pushed ${ago(r.pushedAt)}</span></a>`).join("");
  }

  function renderWarnings(d) {
    const errs = d.errors || [];
    if (!errs.length) return;
    const el = $("#warnings"); el.hidden = false;
    el.querySelector("summary").textContent = `${errs.length} collector warning${errs.length > 1 ? "s" : ""}`;
    el.querySelector("ul").innerHTML = errs.map((e) => `<li>${esc(e)}</li>`).join("");
  }

  async function load() {
    const bust = `?t=${Math.floor(Date.now() / 60000)}`;
    const [d, history] = await Promise.all([
      fetch(`data/latest.json${bust}`).then((r) => r.json()),
      fetch(`data/history.json${bust}`).then((r) => (r.ok ? r.json() : { runs: [] })).catch(() => ({ runs: [] })),
    ]);
    document.title = d.title || "Project Pulse";
    $("#title").textContent = d.title || "Project Pulse";
    const next = new Date(new Date(d.generatedAt).getTime() + (d.intervalMinutes || 60) * 60000);
    $("#updated").innerHTML = `Updated <b>${ago(d.generatedAt)}</b> · next ~${next.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    $("#updated").title = new Date(d.generatedAt).toLocaleString();
    renderHero(d, history);
    renderUsage(d);
    renderSites(d, history);
    renderRepos(d);
    renderWarnings(d);
  }

  load().catch((e) => { $("#hero").innerHTML = `<div><h2>No data yet</h2><p>Run the “Pulse” workflow once from the Actions tab. (${esc(e.message)})</p></div>`; });
  setInterval(() => load().catch(() => {}), 5 * 60000);
})();
