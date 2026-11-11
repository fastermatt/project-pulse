# Project Pulse

One page showing whether all your sites and apps are up, plus how close you are to your Netlify, Vercel and Supabase free-tier limits.

It runs on **free GitHub Actions + GitHub Pages**, so it uses none of your Netlify, Vercel or Supabase hosting quota.

## What it shows

- **Uptime** for every Netlify site and Vercel project. The list is discovered automatically from your accounts, so new projects show up without editing anything. Each one shows a 48-hour status bar, the response time and the 30-day uptime %.
- **Supabase** project status (active or paused) and database size against the 500 MB free limit. It also shows how many of your 2 free active projects you're using.
- **Netlify** bandwidth and build minutes against your plan, plus days until the reset.
- **Vercel** production deploy health, which flags failed deploys. The Hobby plan has no usage API, so the card links to your usage page instead.
- **Recent GitHub repo activity.**

## How light it is

| Platform | What Pulse does each hour | Counts toward your limits? |
|---|---|---|
| Netlify | Management API reads + 1 `HEAD` request per site | API: no. `HEAD`: a few hundred bytes (~0.5 MB/month total) |
| Vercel | Management API reads + 1 `HEAD` per project | API: no. `HEAD`: ~720 edge requests/project/month out of 1M |
| Supabase | Management API reads + 1 catalog query (`pg_database_size`) per **active** project | No egress, and paused projects aren't woken |
| GitHub | ~1 minute of Actions per run | Free for public repos |

## Setup (about 5 minutes)

1. **Push this folder to a new GitHub repo.** It must be public for free Pages on a free GitHub plan. No secrets are stored in the repo.
2. **Add repository secrets** under Settings → Secrets and variables → Actions:
   | Secret | Where to get it |
   |---|---|
   | `NETLIFY_TOKEN` | Netlify → User settings → Applications → Personal access tokens |
   | `VERCEL_TOKEN` | vercel.com/account/settings/tokens. Scope it to your team. |
   | `VERCEL_TEAM_ID` | Vercel → Team Settings → General → Team ID (`team_…`) |
   | `SUPABASE_TOKEN` | supabase.com/dashboard/account/tokens |
   | `GH_REPOS_TOKEN` *(optional)* | A fine-grained token with read-only "Metadata" access. Without it, only public repos are listed. |
3. **Run it once** from Actions → Pulse → Run workflow. This creates a `gh-pages` branch.
4. **Turn on Pages** under Settings → Pages → Source: *Deploy from a branch* → `gh-pages` / root.
5. Open `https://<you>.github.io/project-pulse/`.

The workflow runs hourly at :17. To check more often, edit the cron in `.github/workflows/pulse.yml` (for example `*/30 * * * *`) and change `PULSE_INTERVAL_MINUTES` to match.

## Configure

Edit `pulse.config.json`:

- `limits`: your plan limits. API values take priority when the API returns them.
- `exclude`: project or site names to hide, such as old test sites.
- `extraChecks`: other URLs to monitor, as `{ "name": "My API", "url": "https://…" }`.
- `historyDays`: how much history to keep (default 30).

## Notes

- A Vercel URL that returns 401/403 because of Deployment Protection counts as **up (protected)**: the server responded.
- History lives on the `gh-pages` branch. It's force-pushed as a single commit each run, so the repo doesn't grow.
- GitHub pauses scheduled workflows after 60 days with no repository activity. If that happens, click "Enable workflow" in the Actions tab.
