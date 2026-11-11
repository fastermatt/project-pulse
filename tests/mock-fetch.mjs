const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
// MOCK_DAY0 (YYYY-MM-DD) anchors the daily traffic series; MOCK_SHIFT moves it forward N days.
const day = (offset) => {
  const d = new Date(`${process.env.MOCK_DAY0 || '2026-01-10'}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(process.env.MOCK_SHIFT || 0) + offset);
  return d.toISOString().slice(0, 10) + 'T00:00:00Z';
};
const shift = Number(process.env.MOCK_SHIFT || 0);
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  if (options.method === 'HEAD') return new Response(null, { status: 200 });
  if (url.hostname === 'api.netlify.com') {
    if (url.pathname.endsWith('/sites')) return json([
      { id: 'test', name: 'PRIVATE_SITE_SENTINEL', ssl_url: 'https://site.invalid', published_deploy: { state: 'ready' } },
      { id: 'arch1', name: 'Fastidious-Pasca-123116', ssl_url: 'https://arch.invalid', admin_url: 'https://app.netlify.com/projects/fastidious-pasca-123116', updated_at: '2025-01-01T00:00:00Z', published_deploy: { state: 'ready', published_at: '2025-01-01T00:00:00Z' } },
    ]);
    if (url.pathname.endsWith('/accounts')) return json([{ slug: 'private-team', name: 'Test', type_name: 'Free' }]);
    if (url.pathname === '/api/v1/sites/test/forms') return json([{ id: 'f1', name: 'contact', submission_count: 7, last_submission_at: '2026-01-05T00:00:00Z' }, { id: 'f2', name: 'empty', submission_count: 0 }]);
    return json({ error: 'DO_NOT_LOG_PROVIDER_BODY_OR_TOKEN' }, 403);
  }
  if (url.hostname === 'api.vercel.com') {
    if (url.pathname.startsWith('/v2/teams/')) return json({ slug: 'vteam' });
    if (url.pathname === '/v10/projects') return json({ projects: [
      { id: 'prj_live', name: 'live-proj' },
      { id: 'prj_arch', name: 'Family-Quest-Prod', updatedAt: 1700000000000, targets: { production: { alias: ['fqp.example.com'] } } },
    ] });
    if (url.pathname === '/v7/deployments') return url.searchParams.get('projectId') === 'prj_arch' ? json({}, 500) : json({ deployments: [{ state: 'READY', created: 1700000000000 }] });
    if (url.pathname.startsWith('/v9/projects/')) return url.pathname.includes('prj_arch') ? json({}, 500) : json({ domains: [{ name: 'live.example.com' }] });
    return json({}, 404);
  }
  if (url.hostname === 'api.supabase.com') {
    if (url.pathname === '/v1/projects') return json([
      { id: 'liveref', ref: 'liveref', name: 'sb-live', status: 'ACTIVE_HEALTHY', region: 'us-east-1', organization_slug: 'orgslug' },
      { id: 'archref', ref: 'archref', name: 'coffinder', status: 'INACTIVE', region: 'us-east-1', organization_slug: 'orgslug' },
    ]);
    if (url.pathname.includes('/archref/')) return json({}, 500);
    if (url.pathname.endsWith('/database/query/read-only')) {
      const q = JSON.parse(options.body).query;
      return json(q.includes('auth.users')
        ? [{ users: 12, last_sign_in: '2026-01-09T00:00:00Z', last_signup: '2026-01-08T00:00:00Z' }]
        : [{ bytes: 1048576 }]);
    }
    if (url.pathname.endsWith('/health')) return json([{ name: 'db', healthy: true }]);
    return json({}, 404);
  }
  if (url.hostname === 'api.github.com') {
    if (url.pathname.endsWith('/repos')) return json([
      { name: 'alpha', html_url: 'https://github.com/o/alpha', private: false, fork: false, archived: false, pushed_at: '2026-01-01T00:00:00Z', stargazers_count: 3, forks_count: 1, watchers_count: 3, subscribers_count: 2, open_issues_count: 4, description: 'd', created_at: '2025-01-01T00:00:00Z', size: 120, default_branch: 'main', topics: ['x'] },
      { name: 'old', html_url: 'https://github.com/o/old', fork: false, archived: true },
      { name: 'forked', html_url: 'https://github.com/o/forked', fork: true, archived: false },
    ]);
    const m = url.pathname.match(/^\/repos\/[^/]+\/([^/]+)\/traffic\/(.+)$/);
    if (m) {
      if (m[1] !== 'alpha') return json({}, 500);
      if (m[2] === 'views') return json({ count: 30 + shift, uniques: 9, views: [-2, -1, 0].map((o, i) => ({ timestamp: day(o), count: 10 + i + shift * 100 + (o + shift === 0 ? 1000 : 0), uniques: 3 })) });
      if (m[2] === 'clones') return json({ count: 5, uniques: 2, clones: [-1, 0].map((o) => ({ timestamp: day(o), count: 2, uniques: 1 })) });
      if (m[2] === 'popular/referrers') return json([1, 2, 3, 4, 5, 6].map((i) => ({ referrer: `ref${i}`, count: 10 - i, uniques: i })));
      if (m[2] === 'popular/paths') return json([{ path: '/o/alpha', title: 'alpha', count: 5, uniques: 2 }]);
    }
    return json([]);
  }
  throw new Error('Unexpected test request');
};
