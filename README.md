# Yournet

A small backend for a compound Wi-Fi business: customer sign-up, flexible
plans, Paystack payments, an admin dashboard, and (once you have the router)
automatic Mikrotik hotspot account creation and disconnect.

## Running it locally (to try it out first)

```bash
npm install
cp .env.example .env
# edit .env — at minimum set JWT_SECRET and ADMIN_PASSWORD
npm start
```

Visit `http://localhost:3000` for the customer site, and
`http://localhost:3000/admin` for the admin dashboard.

## Deploying so it's live on the internet

This is a real server with a database file, so it needs actual hosting —
not GitHub Pages or Netlify (those only serve static files). Any of these
work well and have a free tier:

### Option A: Railway (easiest)
1. Create a free account at railway.app.
2. "New Project" → "Deploy from GitHub repo" (push this folder to a new
   GitHub repo first), or use their CLI to deploy directly from your
   computer.
3. In the project's Variables tab, add everything from `.env.example`
   with real values.
4. Railway builds and starts it automatically using `npm start`.

### Option B: Render
1. Create a free account at render.com.
2. "New" → "Web Service" → connect your GitHub repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Add the same environment variables under the Environment tab.

### Option C: A VPS (more control, more setup)
If you want your own server (e.g. a cheap DigitalOcean or Contabo box),
I can walk through that separately — it's more steps (installing Node,
setting up a process manager like pm2, and a reverse proxy for HTTPS)
but gives you full control and no platform fees.

## After deploying

1. Visit your live URL and create a test customer account to confirm it
   works end to end.
2. Visit `/admin` and log in with your `ADMIN_USERNAME`/`ADMIN_PASSWORD`.
3. If you're using Paystack, set `paymentProvider` to `paystack` in
   Admin → Settings, and register your webhook URL
   (`https://your-domain/api/webhooks/paystack`) in your Paystack
   dashboard under Settings → API Keys & Webhooks.
4. Point your domain (if you bought one) at the host's provided address —
   each host's dashboard has simple instructions for this.

## Connecting the Mikrotik (once you have it)

See the detailed walkthrough and first-time test checklist inside
`mikrotik.js`. Short version: fill in the `MIKROTIK_*` variables in your
`.env`, redeploy, and run through the checklist with a throwaway test
account before trusting it with real customers.

Until then, the site works completely normally — it just logs a reminder
telling you to add the customer to the router by hand, exactly like
before.
