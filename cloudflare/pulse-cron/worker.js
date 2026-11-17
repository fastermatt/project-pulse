// Project Pulse refresh trigger.
// A Cloudflare cron trigger runs this every 3 hours. It asks GitHub to start the
// "Pulse" workflow (workflow_dispatch), because GitHub's own scheduler starts
// only a few of the scheduled runs on small repos.
//
// Needs one secret on the Worker: GITHUB_TOKEN, a fine-grained token limited to
// fastermatt/project-pulse with "Actions: Read and write". Nothing else.

const DISPATCH_URL =
  "https://api.github.com/repos/fastermatt/project-pulse/actions/workflows/pulse.yml/dispatches";

async function startRefresh(env) {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN secret is not set");
  const res = await fetch(DISPATCH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "project-pulse-cron",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  // GitHub answers 204 No Content when the run is queued.
  if (res.status !== 204) {
    throw new Error(`GitHub refused the dispatch: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(startRefresh(env));
  },
  // No public endpoint: anyone visiting the workers.dev URL gets a 404.
  async fetch() {
    return new Response("Not found", { status: 404 });
  },
};
