# Project Pulse

One page showing whether all your sites and apps are up, plus how close you are to your Netlify, Vercel and Supabase free-tier limits.

It runs on **free GitHub Actions + GitHub Pages**, so it uses none of your Netlify, Vercel or Supabase hosting quota.

## What it shows

- **Uptime** for every Netlify site and Vercel project. The list is discovered automatically from your accounts, so new projects show up without editing anything. Each one shows recent checks, response time and the percentage of successful recorded checks retained over up to 30 days.
- **Supabase** project status (active or paused) and database size against the 500 MB free limit. It also shows how many of your 2 free active projects you're using.
- **Netlify** bandwidth and build minutes against your plan, plus days until the reset.
- **Vercel** production deploy health, which flags failed deploys. The Hobby plan has no usage API, so the card links to your usage page instead.
- **Recent GitHub repo activity.**

## How light it is

| Platform | What Pulse does every three hours | Counts toward your limits? |
|---|---|---|
| Netlify | Management API reads + 1 `HEAD` request per site | About 240 site checks/site per 30 days; dynamic routes may execute server code |
| Vercel | Management API reads + 1 `HEAD` per project | About 240 site checks/project per 30 days; requests and any function work can count toward usage |
| Supabase | Management API reads + 1 read-only catalog query (`pg_database_size`) per **active** project | Tiny API responses; paused projects are skipped |
| GitHub | Short standard Linux Actions run + Pages deployment | Standard runners are free for public repos; deployment artifacts expire after 1 day |

## Setup (about 5 minutes)

1. **Push this folder to a new GitHub repo.** It must be public for free Pages on a free GitHub plan. No secrets are stored in the repo.
2. **Add repository secrets** under Settings → Secrets and variables → Actions:
   | Secret | Where to get it |
   |---|---|
   | `DASHBOARD_PASSWORD` | A unique passphrase of at least 16 characters — needed to open the dashboard |
   | `NETLIFY_TOKEN` | Netlify → User settings → Applications → Personal access tokens |
   | `VERCEL_TOKEN` | vercel.com/account/settings/tokens. Scope it to your team. |
   | `VERCEL_TEAM_ID` | Vercel → Team Settings → General → Team ID (`team_…`) |
   | `SUPABASE_TOKEN` | supabase.com/dashboard/account/tokens |
   | `GH_REPOS_TOKEN` *(optional)* | A fine-grained token with read-only "Metadata" access. Without it, only public repos are listed. |
3. **Enable Pages** under Settings → Pages → Source: *GitHub Actions*.
4. **Run it once** from Actions → Pulse → Run workflow. This saves encrypted history to `gh-pages` and explicitly deploys the site.
5. Open `https://<you>.github.io/project-pulse/`.

The workflow runs every three hours at :17 UTC (00:17, 03:17, and so on). To change the frequency, edit the cron in `.github/workflows/pulse.yml` and change `PULSE_INTERVAL_MINUTES` to match.

## Privacy

The Pages site is public, but all dashboard data is published only as AES-256-GCM encrypted files (`latest.enc.json`, `history.enc.json`) that the page decrypts in your browser with your `DASHBOARD_PASSWORD`. Without the password, a visitor sees only a lock screen. Provider credentials are read only by the collector in GitHub Actions and sent to the matching provider APIs. They are never included in published data. Public workflow logs contain counts only. If you change the password, the old history can't be decrypted and starts fresh on the next run.

## Configure

Edit `pulse.config.json`:

- `limits`: your plan limits. API values take priority when the API returns them.
- `exclude`: project or site names to hide, such as old test sites.
- `extraChecks`: other URLs to monitor, as `{ "name": "My API", "url": "https://…" }`.
- `historyDays`: how much history to keep (default 30).

## Notes

- A Vercel URL that returns 401/403 because of Deployment Protection counts as **up (protected)**: the server responded.
- Encrypted history lives on the `gh-pages` branch. It's force-pushed as a single commit each run, so the repo doesn't grow.
- GitHub pauses scheduled workflows after 60 days with no repository activity. If that happens, click "Enable workflow" in the Actions tab.


## Validation

Run `node --test tests/*.test.mjs` before release. The tests use fake provider responses and verify encryption, wrong-password/tampered-data rejection, history retention, missing-password failure, and log redaction. `node scripts/verify-public.mjs` enforces a published-file allowlist and encrypted data envelopes.

Use dedicated provider tokens for scheduled runs; a Vercel CLI OAuth access token expires and is unsuitable for GitHub secrets. Supabase requires project visibility/health and Database Read access; the collector uses the read-only query endpoint. Keep token master copies in your secret manager, not this repository.

The uptime percentage is the fraction of successful recorded checks, not continuous availability. Unknown intervals are not evidence of uptime. A 401/403 is classified as protected, which does not prove the app works after sign-in. Plan quotas are configured defaults unless returned by the provider; check the linked billing dashboard before making cost decisions.
