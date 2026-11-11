const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  if (options.method === 'HEAD') return new Response(null, { status: 200 });
  if (url.hostname === 'api.netlify.com') {
    if (url.pathname.endsWith('/sites')) return json([{ id: 'test', name: 'PRIVATE_SITE_SENTINEL', ssl_url: 'https://site.invalid', published_deploy: { state: 'ready' } }]);
    if (url.pathname.endsWith('/accounts')) return json([{ slug: 'private-team', name: 'Test', type_name: 'Free' }]);
    return json({ error: 'DO_NOT_LOG_PROVIDER_BODY_OR_TOKEN' }, 403);
  }
  if (url.hostname === 'api.github.com') return json([]);
  throw new Error('Unexpected test request');
};
