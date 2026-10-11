// ============================================================
// MIKROTIK INTEGRATION
// ============================================================
//
// This talks to your Mikrotik hAP's built-in REST API (available
// in RouterOS 7+) to create, disable, and re-enable hotspot
// users as payments come in and expire.
//
// IMPORTANT — read before relying on this in production:
// This code is written correctly against Mikrotik's documented
// REST API, but it has not been tested against a real device
// (you didn't have the hAP yet when this was written). The very
// first time you have the router available, run through the
// "First-time test" checklist at the bottom of this file with
// Claude before trusting it with real customers. Until then,
// every function below fails safely: if it can't reach the
// router, it logs the error and does nothing destructive — your
// website's own records stay correct either way.
//
// ------------------------------------------------------------
// ONE-TIME ROUTER SETUP (do this in Winbox before using this file)
// ------------------------------------------------------------
// 1. Enable the REST API:
//      IP → Services → api-ssl (or 'www-ssl' for the REST API
//      over HTTPS) — turn it on, note the port (default 443 for
//      www-ssl, or 8729 for api-ssl).
// 2. Create a dedicated API user (don't use your main admin login):
//      System → Users → Add
//      Name: yournet-api
//      Group: full (or a custom group limited to the hotspot
//      menu, if you want to be stricter)
//      Set a strong password.
// 3. Create hotspot user profiles matching your plans (if you
//    haven't already) under IP → Hotspot → User Profiles, with
//    names matching MIKROTIK_PROFILE_MAP below (e.g. "daily",
//    "weekly", "monthly") — each with its shared-users and
//    rate-limit already set as we discussed earlier.
// 4. Put the router's LAN-facing IP (or a dynamic DNS name if
//    you access it remotely) and the API credentials into your
//    .env file — see .env.example.
//
// ------------------------------------------------------------

const MIKROTIK_HOST = process.env.MIKROTIK_HOST || '';
const MIKROTIK_USER = process.env.MIKROTIK_API_USER || '';
const MIKROTIK_PASSWORD = process.env.MIKROTIK_API_PASSWORD || '';
const MIKROTIK_PORT = process.env.MIKROTIK_PORT || '443';

// If your router's HTTPS certificate is self-signed (the default
// on Mikrotik), Node will refuse it unless you either install a
// proper cert on the router or set this to true. Self-signed is
// fine on a private LAN; just know this disables certificate
// checking for requests to the router specifically.
const ALLOW_SELF_SIGNED = process.env.MIKROTIK_ALLOW_SELF_SIGNED === 'true';

function configured() {
  return Boolean(MIKROTIK_HOST && MIKROTIK_USER && MIKROTIK_PASSWORD);
}

async function routerFetch(path, options = {}) {
  if (!configured()) {
    throw new Error(
      'Mikrotik is not configured yet (set MIKROTIK_HOST / MIKROTIK_API_USER / MIKROTIK_API_PASSWORD in .env). Skipping router action.'
    );
  }

  const url = `https://${MIKROTIK_HOST}:${MIKROTIK_PORT}/rest${path}`;
  const auth = Buffer.from(`${MIKROTIK_USER}:${MIKROTIK_PASSWORD}`).toString('base64');

  const fetchOptions = {
    ...options,
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  };

  // Node's fetch doesn't take a per-request TLS override directly;
  // this env var is the documented way to allow self-signed certs
  // for local/private-network devices like a home router.
  if (ALLOW_SELF_SIGNED) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  const response = await fetch(url, fetchOptions);

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Mikrotik API ${response.status}: ${body.slice(0, 200)}`);
  }

  if (response.status === 204) return null;
  return response.json().catch(() => null);
}

// Finds an existing hotspot user by username, or null.
async function findUser(username) {
  const results = await routerFetch(
    `/ip/hotspot/user?name=${encodeURIComponent(username)}`
  );
  return Array.isArray(results) && results.length ? results[0] : null;
}

// ------------------------------------------------------------
// PUBLIC FUNCTIONS — called from server.js
// ------------------------------------------------------------

// Called when a payment is confirmed. Creates the hotspot user
// if it doesn't exist yet, or updates its profile/password if it
// does (covers plan changes and renewals).
export async function mikrotikOnActivate({ username, password, profile }) {
  if (!configured()) {
    console.log(
      `[mikrotik] Not configured — skipping activation for ${username}. ` +
      `Create this user manually in Winbox for now: username="${username}", ` +
      `password="${password}", profile="${profile}".`
    );
    return;
  }

  const existing = await findUser(username);

  if (existing) {
    await routerFetch(`/ip/hotspot/user/${existing['.id']}`, {
      method: 'PATCH',
      body: JSON.stringify({
        password,
        profile,
        disabled: 'false'
      })
    });
  } else {
    await routerFetch('/ip/hotspot/user', {
      method: 'PUT',
      body: JSON.stringify({
        name: username,
        password,
        profile
      })
    });
  }

  console.log(`[mikrotik] Activated ${username} on profile ${profile}`);
}

// Called when admin manually suspends an account (e.g. a dispute
// or a WhatsApp-confirmed payment that turned out to be wrong).
export async function mikrotikOnSuspend(username) {
  if (!configured()) {
    console.log(`[mikrotik] Not configured — skipping suspend for ${username}.`);
    return;
  }

  const existing = await findUser(username);
  if (!existing) return;

  await routerFetch(`/ip/hotspot/user/${existing['.id']}`, {
    method: 'PATCH',
    body: JSON.stringify({ disabled: 'true' })
  });

  // Also kick them if they're currently connected, so suspension
  // takes effect immediately rather than at their next login.
  const active = await routerFetch(
    `/ip/hotspot/active?user=${encodeURIComponent(username)}`
  );
  if (Array.isArray(active)) {
    for (const session of active) {
      await routerFetch(`/ip/hotspot/active/${session['.id']}`, {
        method: 'DELETE'
      }).catch(() => {});
    }
  }

  console.log(`[mikrotik] Suspended ${username}`);
}

// Called when admin manually reconnects a suspended account.
export async function mikrotikOnReconnect(username) {
  if (!configured()) {
    console.log(`[mikrotik] Not configured — skipping reconnect for ${username}.`);
    return;
  }

  const existing = await findUser(username);
  if (!existing) return;

  await routerFetch(`/ip/hotspot/user/${existing['.id']}`, {
    method: 'PATCH',
    body: JSON.stringify({ disabled: 'false' })
  });

  console.log(`[mikrotik] Reconnected ${username}`);
}

// Called automatically by the expiry check every 60 seconds.
// Same effect as suspend, kept as a separate function in case you
// want different behaviour later (e.g. a grace period).
export async function mikrotikOnExpire(username) {
  return mikrotikOnSuspend(username);
}

// ------------------------------------------------------------
// FIRST-TIME TEST CHECKLIST — run through this once you have
// the router, before trusting it with real customers
// ------------------------------------------------------------
//
// 1. Fill in MIKROTIK_HOST, MIKROTIK_API_USER, MIKROTIK_API_PASSWORD
//    in your .env file.
// 2. Register a throwaway test account on your Yournet site.
// 3. Confirm a test payment (or call the webhook manually) and
//    check your server logs for "[mikrotik] Activated ...".
// 4. Open Winbox → IP → Hotspot → Users and confirm the test
//    account appears there with the right profile.
// 5. Connect a device to your hotspot Wi-Fi and log in with the
//    test account's username/password — confirm it gets online.
// 6. In the admin dashboard, click "Suspend" on the test account
//    and confirm the device gets disconnected within a few
//    seconds.
// 7. Click "Reconnect" and confirm the device can log in again.
// 8. Delete the test hotspot user from Winbox when you're done.
//
// If any step fails, the error messages above (and your server's
// console log) will say exactly what went wrong — bring that back
// here and we'll fix it together.
