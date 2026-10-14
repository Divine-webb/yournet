import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { mikrotikOnActivate, mikrotikOnSuspend, mikrotikOnReconnect, mikrotikOnExpire } from './mikrotik.js';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET =
  process.env.JWT_SECRET || 'change-this-secret-before-production';

// DB_PATH lets this point at a persistent volume (e.g. on Railway) instead
// of the app's own ephemeral filesystem, which gets wiped on every
// redeploy. Locally, with no DB_PATH set, it just uses the project folder
// as before.
const db = new Database(process.env.DB_PATH || 'yournet.db');

db.pragma('journal_mode=WAL');

// ============================================================
// DATABASE + MIGRATIONS
// ============================================================

db.exec(`
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  room TEXT NOT NULL,
  phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'UNPAID',
  plan_id TEXT,
  expiry TEXT,
  created_at TEXT NOT NULL,
  usage_mb INTEGER NOT NULL DEFAULT 0,
  hotspot_password TEXT
);

CREATE TABLE IF NOT EXISTS plans(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price INTEGER NOT NULL,
  duration_value INTEGER NOT NULL DEFAULT 1,
  duration_unit TEXT NOT NULL DEFAULT 'day',
  devices INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS payments(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT UNIQUE NOT NULL,
  user_id INTEGER,
  plan_id TEXT,
  amount INTEGER NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TEXT NOT NULL,
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS announcements(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin TEXT,
  action TEXT,
  meta TEXT,
  created_at TEXT NOT NULL
);
`);

// ------------------------------------------------------------
// DATABASE MIGRATION
// ------------------------------------------------------------

function columns(table) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((x) => x.name);
}

const userColumns = columns('users');

if (!userColumns.includes('email')) {
  db.exec(`ALTER TABLE users ADD COLUMN email TEXT`);
}

if (!userColumns.includes('hotspot_password')) {
  db.exec(`ALTER TABLE users ADD COLUMN hotspot_password TEXT`);
}

// Phone needs to be unique once it's used for login, same as email.
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone)`);

function normalizePhone(phone) {
  // Keeps digits only, so "0803 000 0000" and "0803-000-0000" match.
  return String(phone || '').replace(/\D/g, '');
}

const planColumns = columns('plans');

if (!planColumns.includes('mikrotik_profile')) {
  db.exec(`ALTER TABLE plans ADD COLUMN mikrotik_profile TEXT`);
}

if (!planColumns.includes('duration_value')) {
  db.exec(`
    ALTER TABLE plans
    ADD COLUMN duration_value INTEGER NOT NULL DEFAULT 1
  `);
}

if (!planColumns.includes('duration_unit')) {
  db.exec(`
    ALTER TABLE plans
    ADD COLUMN duration_unit TEXT NOT NULL DEFAULT 'day'
  `);
}

// Convert old "days" plans where applicable
if (planColumns.includes('days')) {
  db.prepare(`
    UPDATE plans
    SET
      duration_value =
        CASE
          WHEN duration_value = 1 AND days > 1
          THEN days
          ELSE duration_value
        END,
      duration_unit = 'day'
    WHERE days IS NOT NULL
  `).run();
}

// ============================================================
// HELPERS
// ============================================================

const now = () => new Date().toISOString();

function getSetting(key) {
  return (
    db
      .prepare('SELECT value FROM settings WHERE key=?')
      .get(key)?.value || ''
  );
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings(key,value)
    VALUES(?,?)
    ON CONFLICT(key)
    DO UPDATE SET value=excluded.value
  `).run(key, String(value ?? ''));
}

// ------------------------------------------------------------
// DEFAULT SETTINGS
// ------------------------------------------------------------

const defaults = {
  businessName: 'Yournet Wi-Fi',
  whatsapp: '09139152391',
  phone: '',
  email: '',
  bank: '',
  accountName: '',
  accountNumber: '',
  instructions:
    'Complete payment using the checkout option. Never send OTPs or passwords to support.',
  paymentProvider: 'manual'
};

for (const [key, value] of Object.entries(defaults)) {
  if (getSetting(key) === '') {
    setSetting(key, value);
  }
}

// ------------------------------------------------------------
// DEFAULT PLANS
// ------------------------------------------------------------

if (!db.prepare('SELECT 1 FROM plans LIMIT 1').get()) {
  const insert = db.prepare(`
    INSERT INTO plans(
      id,
      name,
      price,
      duration_value,
      duration_unit,
      devices,
      enabled
    )
    VALUES(?,?,?,?,?,?,1)
  `);

  insert.run(
    'daily',
    'Daily',
    500,
    1,
    'day',
    1
  );

  insert.run(
    'weekly',
    'Weekly',
    3000,
    1,
    'week',
    2
  );

  insert.run(
    'monthly',
    'Monthly',
    6000,
    1,
    'month',
    3
  );
}

// ============================================================
// DURATION SYSTEM
// ============================================================

function durationMs(value, unit) {
  const number = Number(value);

  if (!Number.isFinite(number) || number < 1) {
    throw new Error('Invalid duration');
  }

  const units = {
    minute: 60 * 1000,
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000
  };

  if (units[unit]) {
    return number * units[unit];
  }

  if (unit === 'month') {
    return number * 30 * 24 * 60 * 60 * 1000;
  }

  throw new Error('Invalid duration unit');
}

// ============================================================
// USERNAME SYSTEM
// ============================================================

function generateUsername(name, room) {
  const base =
    (
      'yn-' +
      String(name)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .slice(0, 10) +
      '-' +
      String(room).replace(/[^a-z0-9]/gi, '')
    ).slice(0, 28) || 'yn-user';

  let username = base;
  let number = 1;

  while (
    db
      .prepare('SELECT 1 FROM users WHERE username=?')
      .get(username)
  ) {
    username = `${base}-${++number}`;
  }

  return username;
}

function generateHotspotPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'; // no confusing 0/O/1/l/i
  let out = '';
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// ============================================================
// AUTHENTICATION
// ============================================================

function signToken(payload, days = 7) {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: `${days}d`
  });
}

function auth(role) {
  return (req, res, next) => {
    try {
      const token = req.cookies.yournet_session;

      const payload = jwt.verify(
        token,
        JWT_SECRET
      );

      if (payload.role !== role) {
        return res.status(403).json({
          error: 'Forbidden'
        });
      }

      req.user = payload;

      next();
    } catch {
      return res.status(401).json({
        error: 'Authentication required'
      });
    }
  };
}

// ============================================================
// AUDIT LOG
// ============================================================

function audit(req, action, meta = {}) {
  db.prepare(`
    INSERT INTO audit(
      admin,
      action,
      meta,
      created_at
    )
    VALUES(?,?,?,?)
  `).run(
    req.user?.sub || 'system',
    action,
    JSON.stringify(meta),
    now()
  );
}

// ============================================================
// PUBLIC PLANS
// ============================================================

function publicPlans() {
  return db
    .prepare(`
      SELECT
        id,
        name,
        price,
        duration_value,
        duration_unit,
        devices
      FROM plans
      WHERE enabled=1
      ORDER BY price
    `)
    .all();
}

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(cookieParser());

app.use(
  express.json({
    limit: '200kb'
  })
);

app.use(
  express.urlencoded({
    extended: false
  })
);

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false
  })
);

// ============================================================
// UI
// ============================================================

function page(isAdmin = false) {
  return `
<!doctype html>

<html lang="en">

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>
  ${isAdmin ? 'Yournet Admin' : 'Yournet Wi-Fi'}
</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #060a14;
  color: #e7ecf7;
  font-family:
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    sans-serif;
}

main {
  max-width: 1000px;
  margin: auto;
  padding: 24px;
}

.top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 25px;
}

.brand {
  font-size: 23px;
  font-weight: 800;
}

.muted {
  color: #7c8bb0;
}

.small {
  color: #7c8bb0;
  font-size: 12px;
}

.card {
  background: #0d172a;
  border: 1px solid #1c2d4d;
  border-radius: 18px;
  padding: 18px;
  margin: 14px 0;
}

.grid {
  display: grid;
  grid-template-columns:
    repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}

input,
select,
textarea {
  width: 100%;
  padding: 12px;
  border-radius: 10px;
  border: 1px solid #263b61;
  background: #081120;
  color: #e7ecf7;
  margin-top: 6px;
}

textarea {
  min-height: 90px;
}

button {
  border: 0;
  border-radius: 10px;
  padding: 11px 15px;
  background: #3d8bff;
  color: white;
  font-weight: 700;
  cursor: pointer;
  margin: 6px 4px 6px 0;
}

button:hover {
  opacity: .9;
}

.danger {
  background: #b83255;
}

.green {
  background: #15966d;
}

.plan {
  border: 1px solid #22385e;
  border-radius: 14px;
  padding: 15px;
  margin: 10px 0;
}

.row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}

.notice {
  padding: 12px;
  border-radius: 12px;
  background: #10243d;
  margin: 12px 0;
}

.nav button {
  background: #162642;
}

.active {
  background: #3d8bff !important;
}

.table {
  overflow: auto;
}

.table table {
  width: 100%;
  border-collapse: collapse;
}

.table th,
.table td {
  text-align: left;
  padding: 9px;
  border-bottom: 1px solid #1b2b47;
  white-space: nowrap;
}

h1,
h2,
h3 {
  margin-top: 0;
}

hr {
  border: 0;
  border-top: 1px solid #1c2d4d;
  margin: 25px 0;
}

@media(max-width:600px) {

  main {
    padding: 14px;
  }

}

</style>

</head>

<body>

<main>

${isAdmin ? adminHTML() : customerHTML()}

</main>

<script>

${clientJS(isAdmin)}

</script>

</body>

</html>
`;
}

// ============================================================
// CUSTOMER HTML
// ============================================================

function customerHTML() {
  return `
<div class="top">

  <div class="brand">
    Yournet
    <span class="muted">Wi-Fi</span>
  </div>

  <button onclick="logout()">
    Logout
  </button>

</div>

<div id="app"></div>
`;
}

// ============================================================
// ADMIN HTML
// ============================================================

function adminHTML() {
  return `
<div class="top">

  <div class="brand">
    Yournet
    <span class="muted">Admin</span>
  </div>

  <button onclick="logout()">
    Logout
  </button>

</div>

<div class="nav">

  <button
    class="active"
    onclick="tab('plans',this)"
  >
    Plans
  </button>

  <button onclick="tab('users',this)">
    Customers
  </button>

  <button onclick="tab('settings',this)">
    Settings
  </button>

  <button onclick="tab('content',this)">
    Content
  </button>

</div>

<div id="adminApp"></div>
`;
}

// ============================================================
// CLIENT JAVASCRIPT
// ============================================================

function clientJS(isAdmin) {

  return `
(async () => {

const $ = selector =>
  document.querySelector(selector);

const esc = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[character])
  );

async function api(url, options = {}) {

  const response = await fetch(
    url,
    {
      credentials: 'same-origin',
      ...options
    }
  );

  let data = {};

  try {
    data = await response.json();
  } catch {}

  if (!response.ok) {
    throw new Error(
      data.error || 'Request failed'
    );
  }

  return data;
}

async function logout() {

  await api(
    '/api/auth/logout',
    {
      method: 'POST'
    }
  );

  location.reload();
}

window.logout = logout;

${isAdmin ? adminJS() : customerJS()}

})();
`;
}

// ============================================================
// CUSTOMER JAVASCRIPT
// ============================================================

function customerJS() {

  return `

async function boot() {

  try {

    const account =
      await api('/api/me');

    showAccount(account);

  } catch {

    showAuth();

  }

}

function showAuth() {

  $('#app').innerHTML = \`

<div class="card">

  <h1>
    Create your Yournet account
  </h1>

  <div class="grid">

    <label>
      Name
      <input id="name">
    </label>

    <label>
      Room
      <input id="room">
    </label>

    <label>
      WhatsApp
      <input id="phone">
    </label>

    <label>
      Email
      <input
        id="email"
        type="email"
      >
    </label>

    <label>
      Password
      <input
        id="pass"
        type="password"
        minlength="8"
      >
    </label>

  </div>

  <button onclick="register()">
    Create account
  </button>

  <hr>

  <h2>
    Already have an account?
  </h2>

  <div class="grid">

    <label>
      Email or phone number
      <input id="le">
    </label>

    <label>
      Password
      <input
        id="lp"
        type="password"
      >
    </label>

  </div>

  <button onclick="login()">
    Login
  </button>

  <p
    id="msg"
    class="muted"
  ></p>

</div>

\`;

}

async function register() {

  try {

    await api(
      '/api/auth/register',
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/json'
        },
        body: JSON.stringify({

          name:
            $('#name').value,

          room:
            $('#room').value,

          phone:
            $('#phone').value,

          email:
            $('#email').value,

          password:
            $('#pass').value

        })
      }
    );

    location.reload();

  } catch (error) {

    $('#msg').textContent =
      error.message;

  }

}

async function login() {

  try {

    await api(
      '/api/auth/login',
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/json'
        },
        body: JSON.stringify({

          identifier:
            $('#le').value,

          password:
            $('#lp').value

        })
      }
    );

    location.reload();

  } catch (error) {

    $('#msg').textContent =
      error.message;

  }

}

async function showAccount(account) {

  const config =
    await api('/api/public/config');

  const user =
    account.user;

  $('#app').innerHTML = \`

<div class="card">

  <h1>
    Welcome,
    \${esc(user.name)}
  </h1>

  <p class="muted">

    Room
    \${esc(user.room)}

    ·

    \${esc(user.email || '')}

  </p>

  <div class="notice">

    Status:
    <b>
      \${esc(user.status)}
    </b>

    \${user.expiry
      ? ' · Expires ' +
        new Date(
          user.expiry
        ).toLocaleString()
      : ''}

  </div>

  \${user.status === 'ACTIVE'
    ? \`<div class="notice">
        Wi-Fi login — username:
        <b>\${esc(user.username)}</b>,
        password:
        <b>\${esc(user.hotspot_password)}</b>.
        Enter these on the Wi-Fi
        login page to connect.
      </div>\`
    : ''}

</div>

\${user.status !== 'ACTIVE'
  ? \`<div class="card" style="border-color:#b83255;">
      <h2 style="color:#ff93ab;">
        \${user.status === 'UNPAID'
          ? "You're not connected yet"
          : "Your plan has ended"}
      </h2>
      <p class="muted">
        \${user.status === 'UNPAID'
          ? 'Pick a plan below and pay to get connected.'
          : "You're disconnected from the internet until you pay for another plan. Your Wi-Fi login still works to reach this page."}
      </p>
    </div>\`
  : ''}

<div class="card">

  <h2>
    Choose a plan
  </h2>

  <div>

    \${config.plans.map(plan => \`

      <div class="plan">

        <h3>
          \${esc(plan.name)}
        </h3>

        <b>
          ₦\${Number(
            plan.price
          ).toLocaleString()}
        </b>

        <p>

          \${plan.duration_value}
          \${plan.duration_unit}

          ·

          \${plan.devices}
          device\${plan.devices === 1
            ? ''
            : 's'}

        </p>

        <button
          onclick="pay('\${esc(plan.id)}')"
        >
          Pay & activate
        </button>

      </div>

    \`).join('')}

  </div>

</div>

<div class="card">

  <h2>
    Notice
  </h2>

  <p>
    \${esc(
      config.announcement ||
      'No current announcements.'
    )}
  </p>

  <p class="muted">

    \${esc(
      config.settings.instructions
    )}

  </p>

</div>

\`;

}

async function pay(planId) {

  try {

    const result =
      await api(
        '/api/payments/create',
        {
          method: 'POST',
          headers: {
            'Content-Type':
              'application/json'
          },
          body: JSON.stringify({
            planId
          })
        }
      );

    if (
      result.authorization_url
    ) {

      location.href =
        result.authorization_url;

      return;

    }

    alert(
      result.message ||
      'Payment is not configured yet.'
    );

  } catch (error) {

    alert(error.message);

  }

}

window.register = register;
window.login = login;
window.pay = pay;

boot();

`;
}

// ============================================================
// ADMIN JAVASCRIPT
// ============================================================

function adminJS() {

  return `

async function boot() {

  try {

    await api(
      '/api/admin/settings'
    );

    tab('plans');

  } catch {

    document.getElementById(
      'adminApp'
    ).innerHTML = \`

<div class="card">

  <h1>
    Admin login
  </h1>

  <div class="grid">

    <label>
      Username
      <input id="au">
    </label>

    <label>
      Password
      <input
        id="ap"
        type="password"
      >
    </label>

  </div>

  <button onclick="adminLogin()">
    Login
  </button>

  <p
    id="msg"
    class="muted"
  ></p>

</div>

\`;

  }

}

async function adminLogin() {

  try {

    await api(
      '/api/auth/admin-login',
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/json'
        },
        body: JSON.stringify({

          username:
            $('#au').value,

          password:
            $('#ap').value

        })
      }
    );

    location.reload();

  } catch (error) {

    $('#msg').textContent =
      error.message;

  }

}

async function tab(name, button) {

  document
    .querySelectorAll('.nav button')
    .forEach(
      element =>
        element.classList.remove(
          'active'
        )
    );

  if (button) {
    button.classList.add(
      'active'
    );
  }

  if (name === 'plans') {
    return plans();
  }

  if (name === 'users') {
    return users();
  }

  if (name === 'settings') {
    return settings();
  }

  if (name === 'content') {
    return content();
  }

}

// ============================================================
// ADMIN PLANS
// ============================================================

async function plans() {

  const result =
    await api('/api/admin/plans');

  document.getElementById(
    'adminApp'
  ).innerHTML = \`

<div class="card">

  <h2>
    Plans — Full Control
  </h2>

  <p class="muted">

    Change price, duration,
    duration unit, device limit,
    name and enabled status.

  </p>

  <div>

    \${result.plans
      .map(plan => planForm(plan))
      .join('')}

  </div>

  <hr>

  <h3>
    Create New Plan
  </h3>

  <div class="grid">

    <label>
      Name
      <input
        id="newName"
        value="New plan"
      >
    </label>

    <label>
      Price ₦
      <input
        id="newPrice"
        type="number"
        value="1000"
      >
    </label>

    <label>
      Duration
      <input
        id="newDur"
        type="number"
        value="1"
      >
    </label>

    <label>
      Unit

      <select id="newUnit">

        <option value="minute">
          Minutes
        </option>

        <option value="hour">
          Hours
        </option>

        <option
          value="day"
          selected
        >
          Days
        </option>

        <option value="week">
          Weeks
        </option>

        <option value="month">
          Months
        </option>

      </select>

    </label>

    <label>
      Devices
      <input
        id="newDev"
        type="number"
        value="1"
        min="1"
      >
    </label>

  </div>

  <button onclick="createPlan()">
    Create plan
  </button>

</div>

\`;

}

function planForm(plan) {

  return \`

<div class="plan">

  <div class="grid">

    <label>
      Name

      <input
        id="n-\${plan.id}"
        value="\${esc(plan.name)}"
      >

    </label>

    <label>
      Price ₦

      <input
        id="p-\${plan.id}"
        type="number"
        value="\${plan.price}"
      >

    </label>

    <label>
      Duration

      <input
        id="d-\${plan.id}"
        type="number"
        min="1"
        value="\${plan.duration_value}"
      >

    </label>

    <label>
      Unit

      <select id="u-\${plan.id}">

        \${[
          'minute',
          'hour',
          'day',
          'week',
          'month'
        ]
          .map(unit => \`

            <option
              value="\${unit}"
              \${unit === plan.duration_unit
                ? 'selected'
                : ''}
            >
              \${unit}
            </option>

          \`)
          .join('')}

      </select>

    </label>

    <label>
      Devices

      <input
        id="v-\${plan.id}"
        type="number"
        min="1"
        value="\${plan.devices}"
      >

    </label>

  </div>

  <label>

    <input
      id="e-\${plan.id}"
      type="checkbox"
      \${plan.enabled
        ? 'checked'
        : ''}
      style="width:auto"
    >

    Enabled

  </label>

  <br>

  <button
    onclick="savePlan('\${plan.id}')"
  >
    Save Plan
  </button>

</div>

\`;

}

async function savePlan(id) {

  await api(
    '/api/admin/plans/' +
      encodeURIComponent(id),
    {
      method: 'PUT',
      headers: {
        'Content-Type':
          'application/json'
      },
      body: JSON.stringify({

        name:
          $('#n-' + id).value,

        price:
          Number(
            $('#p-' + id).value
          ),

        duration_value:
          Number(
            $('#d-' + id).value
          ),

        duration_unit:
          $('#u-' + id).value,

        devices:
          Number(
            $('#v-' + id).value
          ),

        enabled:
          $('#e-' + id).checked
            ? 1
            : 0

      })
    }
  );

  alert('Plan saved');

  plans();

}

async function createPlan() {

  await api(
    '/api/admin/plans',
    {
      method: 'POST',
      headers: {
        'Content-Type':
          'application/json'
      },
      body: JSON.stringify({

        name:
          $('#newName').value,

        price:
          Number(
            $('#newPrice').value
          ),

        duration_value:
          Number(
            $('#newDur').value
          ),

        duration_unit:
          $('#newUnit').value,

        devices:
          Number(
            $('#newDev').value
          ),

        enabled: 1

      })
    }
  );

  plans();

}

// ============================================================
// CUSTOMERS
// ============================================================

async function users() {

  const result =
    await api('/api/admin/users');

  document.getElementById(
    'adminApp'
  ).innerHTML = \`

<div class="card">

  <h2>
    Customers
  </h2>

  <div class="table">

    <table>

      <tr>

        <th>Name</th>
        <th>Email</th>
        <th>Room</th>
        <th>Status</th>
        <th>Plan</th>
        <th>Expiry</th>
        <th>Actions</th>

      </tr>

      \${result.users.map(user => \`

        <tr>

          <td>
            \${esc(user.name)}
          </td>

          <td>
            \${esc(user.email)}
          </td>

          <td>
            \${esc(user.room)}
          </td>

          <td>
            \${esc(user.status)}
          </td>

          <td>
            \${esc(
              user.plan_name || '-'
            )}
          </td>

          <td>
            \${esc(
              user.expiry || '-'
            )}
          </td>

          <td>

            <button
              onclick="act(
                \${user.id},
                'suspend'
              )"
            >
              Suspend
            </button>

            <button
              class="green"
              onclick="act(
                \${user.id},
                'reconnect'
              )"
            >
              Reconnect
            </button>

          </td>

        </tr>

      \`).join('')}

    </table>

  </div>

</div>

\`;

}

async function act(id, action) {

  await api(
    '/api/admin/users/' +
      id +
      '/' +
      action,
    {
      method: 'POST'
    }
  );

  users();

}

// ============================================================
// SETTINGS
// ============================================================

async function settings() {

  const result =
    await api(
      '/api/admin/settings'
    );

  const s =
    result.settings;

  const fields = [
    ['businessName', 'Business name'],
    ['whatsapp', 'WhatsApp'],
    ['phone', 'Support phone'],
    ['email', 'Support email'],
    ['bank', 'Bank'],
    ['accountName', 'Account name'],
    ['accountNumber', 'Account number'],
    ['paymentProvider', 'Payment provider']
  ];

  document.getElementById(
    'adminApp'
  ).innerHTML = \`

<div class="card">

  <h2>
    Business & Payment Settings
  </h2>

  <div class="grid">

    \${fields.map(
      ([key, label]) => \`

        <label>

          \${label}

          <input
            id="s-\${key}"
            value="\${esc(s[key])}"
          >

        </label>

      \`
    ).join('')}

  </div>

  <label>

    Payment instructions

    <textarea
      id="s-instructions"
    >\${esc(
      s.instructions
    )}</textarea>

  </label>

  <button onclick="saveSettings()">
    Save Settings
  </button>

</div>

\`;

}

async function saveSettings() {

  const keys = [
    'businessName',
    'whatsapp',
    'phone',
    'email',
    'bank',
    'accountName',
    'accountNumber',
    'paymentProvider',
    'instructions'
  ];

  const values = {};

  for (const key of keys) {
    values[key] =
      $('#s-' + key).value;
  }

  await api(
    '/api/admin/settings',
    {
      method: 'PUT',
      headers: {
        'Content-Type':
          'application/json'
      },
      body: JSON.stringify(values)
    }
  );

  alert('Settings saved');

}

// ============================================================
// CONTENT
// ============================================================

async function content() {

  const result =
    await api(
      '/api/public/config'
    );

  document.getElementById(
    'adminApp'
  ).innerHTML = \`

<div class="card">

  <h2>
    Announcement
  </h2>

  <textarea
    id="ann"
  >\${esc(
    result.announcement || ''
  )}</textarea>

  <button onclick="publish()">
    Publish
  </button>

</div>

\`;

}

async function publish() {

  await api(
    '/api/admin/announcements',
    {
      method: 'POST',
      headers: {
        'Content-Type':
          'application/json'
      },
      body: JSON.stringify({
        body:
          $('#ann').value
      })
    }
  );

  alert('Published');

}

// ============================================================
// EXPOSE ADMIN FUNCTIONS
// ============================================================

window.adminLogin = adminLogin;
window.tab = tab;
window.savePlan = savePlan;
window.createPlan = createPlan;
window.act = act;
window.saveSettings = saveSettings;
window.publish = publish;

boot();

`;
}

// ============================================================
// PUBLIC CONFIG API
// ============================================================

app.get(
  '/api/public/config',
  (req, res) => {

    const keys =
      Object.keys(defaults);

    const settings =
      Object.fromEntries(
        keys.map(
          key => [
            key,
            getSetting(key)
          ]
        )
      );

    const announcement =
      db
        .prepare(`
          SELECT body
          FROM announcements
          ORDER BY id DESC
          LIMIT 1
        `)
        .get()?.body || '';

    res.json({
      settings,
      plans: publicPlans(),
      announcement
    });

  }
);

// ============================================================
// CUSTOMER REGISTRATION
// ============================================================

app.post(
  '/api/auth/register',
  async (req, res) => {

    try {

      const name =
        String(
          req.body.name || ''
        ).trim();

      const room =
        String(
          req.body.room || ''
        ).trim();

      const phone =
        normalizePhone(
          req.body.phone
        );

      const email =
        String(
          req.body.email || ''
        )
          .trim()
          .toLowerCase();

      const password =
        String(
          req.body.password || ''
        );

      if (
        !name ||
        !room ||
        !phone ||
        !email ||
        !password ||
        password.length < 8
      ) {

        return res.status(400).json({
          error:
            'Name, room, phone, email and an 8+ character password are required'
        });

      }

      if (
        !/^\S+@\S+\.\S+$/.test(
          email
        )
      ) {

        return res.status(400).json({
          error:
            'Enter a valid email address'
        });

      }

      if (
        db
          .prepare(
            'SELECT 1 FROM users WHERE email=?'
          )
          .get(email)
      ) {

        return res.status(409).json({
          error:
            'That email is already registered'
        });

      }

      if (phone.length < 7) {

        return res.status(400).json({
          error:
            'Enter a valid phone number'
        });

      }

      if (
        db
          .prepare(
            'SELECT 1 FROM users WHERE phone=?'
          )
          .get(phone)
      ) {

        return res.status(409).json({
          error:
            'That phone number is already registered'
        });

      }

      const username =
        generateUsername(
          name,
          room
        );

      const hotspotPassword =
        generateHotspotPassword();

      const passwordHash =
        await bcrypt.hash(
          password,
          12
        );

      const result =
        db
          .prepare(`
            INSERT INTO users(
              username,
              email,
              password_hash,
              name,
              room,
              phone,
              created_at,
              hotspot_password
            )
            VALUES(?,?,?,?,?,?,?,?)
          `)
          .run(
            username,
            email,
            passwordHash,
            name,
            room,
            phone,
            now(),
            hotspotPassword
          );

      res.cookie(
        'yournet_session',
        signToken({
          sub: result.lastInsertRowid,
          role: 'customer',
          email
        }),
        {
          httpOnly: true,
          sameSite: 'lax',
          secure:
            process.env.NODE_ENV ===
            'production',
          maxAge:
            7 * 86400000
        }
      );

      res.json({
        ok: true
      });

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error:
          'Could not create account'
      });

    }

  }
);

// ============================================================
// CUSTOMER LOGIN — EMAIL
// ============================================================

app.post(
  '/api/auth/login',
  async (req, res) => {

    try {

      const identifier =
        String(
          req.body.identifier || ''
        ).trim();

      // Accept either an email address or a phone number in the
      // same field — try email first, then phone.
      const asEmail =
        identifier.toLowerCase();

      const asPhone =
        normalizePhone(identifier);

      const user =
        db
          .prepare(
            "SELECT * FROM users WHERE email=? OR (phone=? AND ? != '')"
          )
          .get(asEmail, asPhone, asPhone);

      if (
        !user ||
        !(await bcrypt.compare(
          String(
            req.body.password || ''
          ),
          user.password_hash
        ))
      ) {

        return res.status(401).json({
          error:
            'Invalid email/phone or password'
        });

      }

      res.cookie(
        'yournet_session',
        signToken({
          sub: user.id,
          role: 'customer',
          email: user.email
        }),
        {
          httpOnly: true,
          sameSite: 'lax',
          secure:
            process.env.NODE_ENV ===
            'production',
          maxAge:
            7 * 86400000
        }
      );

      res.json({
        ok: true
      });

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error:
          'Could not log in'
      });

    }

  }
);

// ============================================================
// ADMIN LOGIN
// ============================================================

app.post(
  '/api/auth/admin-login',
  async (req, res) => {

    const username =
      process.env.ADMIN_USERNAME ||
      'admin';

    const password =
      process.env.ADMIN_PASSWORD ||
      '';

    if (
      req.body.username !==
        username ||
      !password ||
      req.body.password !==
        password
    ) {

      return res.status(401).json({
        error:
          'Invalid admin credentials'
      });

    }

    res.cookie(
      'yournet_session',
      signToken(
        {
          sub: username,
          role: 'admin'
        },
        1
      ),
      {
        httpOnly: true,
        sameSite: 'lax',
        secure:
          process.env.NODE_ENV ===
          'production',
        maxAge:
          86400000
      }
    );

    res.json({
      ok: true
    });

  }
);

// ============================================================
// LOGOUT
// ============================================================

app.post(
  '/api/auth/logout',
  (req, res) => {

    res.clearCookie(
      'yournet_session'
    );

    res.json({
      ok: true
    });

  }
);

// ============================================================
// CUSTOMER ACCOUNT
// ============================================================

app.get(
  '/api/me',
  auth('customer'),
  (req, res) => {

    const user =
      db
        .prepare(`
          SELECT
            id,
            username,
            email,
            name,
            room,
            phone,
            status,
            plan_id,
            expiry,
            usage_mb,
            created_at,
            hotspot_password
          FROM users
          WHERE id=?
        `)
        .get(req.user.sub);

    if (!user) {

      return res.status(404).json({
        error:
          'Account not found'
      });

    }

    if (
      user.expiry &&
      Date.now() >
        Date.parse(user.expiry) &&
      user.status === 'ACTIVE'
    ) {

      db
        .prepare(`
          UPDATE users
          SET status='EXPIRED'
          WHERE id=?
        `)
        .run(user.id);

      user.status =
        'EXPIRED';

    }

    const plan =
      user.plan_id
        ? db
            .prepare(
              'SELECT * FROM plans WHERE id=?'
            )
            .get(
              user.plan_id
            )
        : null;

    res.json({
      user,
      plan
    });

  }
);

// ============================================================
// ADMIN SETTINGS
// ============================================================

app.get(
  '/api/admin/settings',
  auth('admin'),
  (req, res) => {

    const settings =
      Object.fromEntries(
        Object.keys(defaults).map(
          key => [
            key,
            getSetting(key)
          ]
        )
      );

    res.json({
      settings
    });

  }
);

app.put(
  '/api/admin/settings',
  auth('admin'),
  (req, res) => {

    for (
      const key of
      Object.keys(defaults)
    ) {

      if (
        req.body[key] !==
        undefined
      ) {

        setSetting(
          key,
          req.body[key]
        );

      }

    }

    audit(
      req,
      'settings.update'
    );

    res.json({
      ok: true
    });

  }
);

// ============================================================
// ADMIN PLAN LIST
// ============================================================

app.get(
  '/api/admin/plans',
  auth('admin'),
  (req, res) => {

    const plans =
      db
        .prepare(
          'SELECT * FROM plans ORDER BY price'
        )
        .all();

    res.json({
      plans
    });

  }
);

// ============================================================
// ADMIN CREATE PLAN
// ============================================================

app.post(
  '/api/admin/plans',
  auth('admin'),
  (req, res) => {

    try {

      const name =
        String(
          req.body.name || ''
        ).trim();

      const price =
        Number(
          req.body.price
        );

      const durationValue =
        Number(
          req.body.duration_value
        );

      const durationUnit =
        String(
          req.body.duration_unit
        );

      const devices =
        Number(
          req.body.devices
        );

      durationMs(
        durationValue,
        durationUnit
      );

      if (
        !name ||
        price < 0 ||
        devices < 1
      ) {

        return res.status(400).json({
          error:
            'Invalid plan'
        });

      }

      let id =
        name
          .toLowerCase()
          .replace(
            /[^a-z0-9]+/g,
            '-'
          )
          .replace(
            /^-|-$/g,
            ''
          ) || 'plan';

      const base = id;
      let number = 1;

      while (
        db
          .prepare(
            'SELECT 1 FROM plans WHERE id=?'
          )
          .get(id)
      ) {

        id =
          `${base}-${++number}`;

      }

      db
        .prepare(`
          INSERT INTO plans(
            id,
            name,
            price,
            duration_value,
            duration_unit,
            devices,
            enabled
          )
          VALUES(?,?,?,?,?,?,?)
        `)
        .run(
          id,
          name,
          Math.round(price),
          durationValue,
          durationUnit,
          devices,
          req.body.enabled === 0
            ? 0
            : 1
        );

      audit(
        req,
        'plan.create',
        { id }
      );

      res.json({
        ok: true,
        id
      });

    } catch (error) {

      res.status(400).json({
        error:
          error.message
      });

    }

  }
);

// ============================================================
// ADMIN EDIT PLAN
// ============================================================

app.put(
  '/api/admin/plans/:id',
  auth('admin'),
  (req, res) => {

    try {

      const plan =
        db
          .prepare(
            'SELECT * FROM plans WHERE id=?'
          )
          .get(
            req.params.id
          );

      if (!plan) {

        return res.status(404).json({
          error:
            'Plan not found'
        });

      }

      const name =
        req.body.name ===
        undefined
          ? plan.name
          : String(
              req.body.name
            ).trim();

      const price =
        req.body.price ===
        undefined
          ? plan.price
          : Number(
              req.body.price
            );

      const durationValue =
        req.body.duration_value ===
        undefined
          ? plan.duration_value
          : Number(
              req.body.duration_value
            );

      const durationUnit =
        req.body.duration_unit ===
        undefined
          ? plan.duration_unit
          : String(
              req.body.duration_unit
            );

      const devices =
        req.body.devices ===
        undefined
          ? plan.devices
          : Number(
              req.body.devices
            );

      const enabled =
        req.body.enabled ===
        undefined
          ? plan.enabled
          : req.body.enabled
            ? 1
            : 0;

      durationMs(
        durationValue,
        durationUnit
      );

      if (
        !name ||
        price < 0 ||
        devices < 1
      ) {

        throw new Error(
          'Invalid plan'
        );

      }

      db
        .prepare(`
          UPDATE plans
          SET
            name=?,
            price=?,
            duration_value=?,
            duration_unit=?,
            devices=?,
            enabled=?
          WHERE id=?
        `)
        .run(
          name,
          Math.round(price),
          durationValue,
          durationUnit,
          devices,
          enabled,
          req.params.id
        );

      audit(
        req,
        'plan.update',
        {
          id: req.params.id
        }
      );

      res.json({
        ok: true
      });

    } catch (error) {

      res.status(400).json({
        error:
          error.message
      });

    }

  }
);

// ============================================================
// ADMIN CUSTOMER LIST
// ============================================================

app.get(
  '/api/admin/users',
  auth('admin'),
  (req, res) => {

    const users =
      db
        .prepare(`
          SELECT
            u.id,
            u.username,
            u.email,
            u.name,
            u.room,
            u.phone,
            u.status,
            u.plan_id,
            u.expiry,
            u.usage_mb,
            u.created_at,
            p.name AS plan_name,
            p.price
          FROM users u
          LEFT JOIN plans p
            ON p.id=u.plan_id
          ORDER BY u.id DESC
        `)
        .all();

    res.json({
      users
    });

  }
);

// ============================================================
// SUSPEND CUSTOMER
// ============================================================

app.post(
  '/api/admin/users/:id/suspend',
  auth('admin'),
  (req, res) => {

    db
      .prepare(`
        UPDATE users
        SET status='SUSPENDED'
        WHERE id=?
      `)
      .run(req.params.id);

    audit(
      req,
      'user.suspend',
      {
        id: req.params.id
      }
    );

    const user = db
      .prepare('SELECT username FROM users WHERE id=?')
      .get(req.params.id);

    if (user) {
      mikrotikOnSuspend(user.username).catch((error) => {
        console.error('Mikrotik suspend failed:', error.message);
      });
    }

    res.json({
      ok: true
    });

  }
);

// ============================================================
// RECONNECT CUSTOMER
// ============================================================

app.post(
  '/api/admin/users/:id/reconnect',
  auth('admin'),
  (req, res) => {

    db
      .prepare(`
        UPDATE users
        SET status='ACTIVE'
        WHERE id=?
      `)
      .run(req.params.id);

    audit(
      req,
      'user.reconnect',
      {
        id: req.params.id
      }
    );

    const user = db
      .prepare('SELECT username FROM users WHERE id=?')
      .get(req.params.id);

    if (user) {
      mikrotikOnReconnect(user.username).catch((error) => {
        console.error('Mikrotik reconnect failed:', error.message);
      });
    }

    res.json({
      ok: true
    });

  }
);

// ============================================================
// ANNOUNCEMENTS
// ============================================================

app.post(
  '/api/admin/announcements',
  auth('admin'),
  (req, res) => {

    const body =
      String(
        req.body.body || ''
      ).trim();

    if (!body) {

      return res.status(400).json({
        error:
          'Announcement required'
      });

    }

    db
      .prepare(`
        INSERT INTO announcements(
          body,
          created_at
        )
        VALUES(?,?)
      `)
      .run(
        body,
        now()
      );

    audit(
      req,
      'announcement.publish'
    );

    res.json({
      ok: true
    });

  }
);

// ============================================================
// PAYMENT CREATION
// ============================================================

app.post(
  '/api/payments/create',
  auth('customer'),
  async (req, res) => {

    try {

      const plan =
        db
          .prepare(`
            SELECT *
            FROM plans
            WHERE id=?
            AND enabled=1
          `)
          .get(
            req.body.planId
          );

      if (!plan) {

        return res.status(400).json({
          error:
            'Invalid plan'
        });

      }

      const user =
        db
          .prepare(
            'SELECT * FROM users WHERE id=?'
          )
          .get(
            req.user.sub
          );

      const reference =
        'YN-' +
        crypto.randomUUID();

      const provider =
        getSetting(
          'paymentProvider'
        ) || 'manual';

      db
        .prepare(`
          INSERT INTO payments(
            reference,
            user_id,
            plan_id,
            amount,
            provider,
            status,
            created_at
          )
          VALUES(?,?,?,?,?,?,?)
        `)
        .run(
          reference,
          user.id,
          plan.id,
          plan.price,
          provider,
          'PENDING',
          now()
        );

      // ------------------------------------------------------
      // PAYSTACK
      // ------------------------------------------------------

      if (
        provider ===
          'paystack' &&
        process.env
          .PAYSTACK_SECRET_KEY
      ) {

        const response =
          await fetch(
            'https://api.paystack.co/transaction/initialize',
            {
              method: 'POST',

              headers: {
                Authorization:
                  `Bearer ${
                    process.env
                      .PAYSTACK_SECRET_KEY
                  }`,

                'Content-Type':
                  'application/json'
              },

              body: JSON.stringify({

                email:
                  user.email,

                amount:
                  plan.price * 100,

                reference,

                metadata: {

                  user_id:
                    user.id,

                  plan_id:
                    plan.id

                }

              })
            }
          );

        const data =
          await response.json();

        if (!data.status) {

          return res.status(502).json({
            error:
              'Payment provider could not create checkout'
          });

        }

        return res.json({

          reference,

          authorization_url:
            data.data.authorization_url

        });

      }

      res.json({

        reference,

        provider,

        message:
          'Payment provider is not configured for automatic checkout yet.'

      });

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error:
          'Could not create payment'
      });

    }

  }
);

// ============================================================
// PAYSTACK WEBHOOK
// ============================================================

app.post(
  '/api/webhooks/paystack',
  express.raw({
    type: 'application/json'
  }),
  (req, res) => {

    try {

      const secret =
        process.env
          .PAYSTACK_SECRET_KEY;

      const signature =
        req.headers[
          'x-paystack-signature'
        ];

      if (
        !secret ||
        !signature
      ) {

        return res.sendStatus(
          401
        );

      }

      const expected =
        crypto
          .createHmac(
            'sha512',
            secret
          )
          .update(req.body)
          .digest('hex');

      if (
        String(signature) !==
        expected
      ) {

        return res.sendStatus(
          401
        );

      }

      const event =
        JSON.parse(
          req.body.toString()
        );

      if (
        event.event !==
        'charge.success'
      ) {

        return res.sendStatus(
          200
        );

      }

      const paymentData =
        event.data;

      const payment =
        db
          .prepare(`
            SELECT *
            FROM payments
            WHERE reference=?
          `)
          .get(
            paymentData.reference
          );

      if (
        !payment ||
        payment.status ===
          'PAID'
      ) {

        return res.sendStatus(
          200
        );

      }

      if (
        paymentData.status !==
          'success' ||
        Number(
          paymentData.amount
        ) !==
          payment.amount * 100
      ) {

        return res.sendStatus(
          200
        );

      }

      const plan =
        db
          .prepare(
            'SELECT * FROM plans WHERE id=?'
          )
          .get(
            payment.plan_id
          );

      const user =
        db
          .prepare(
            'SELECT * FROM users WHERE id=?'
          )
          .get(
            payment.user_id
          );

      let expiryBase =
        user.expiry &&
        Date.parse(
          user.expiry
        ) > Date.now()
          ? new Date(
              user.expiry
            )
          : new Date();

      expiryBase =
        new Date(
          expiryBase.getTime() +
            durationMs(
              plan.duration_value,
              plan.duration_unit
            )
        );

      db.transaction(() => {

        db
          .prepare(`
            UPDATE payments
            SET
              status='PAID',
              paid_at=?
            WHERE id=?
          `)
          .run(
            now(),
            payment.id
          );

        db
          .prepare(`
            UPDATE users
            SET
              status='ACTIVE',
              plan_id=?,
              expiry=?
            WHERE id=?
          `)
          .run(
            plan.id,
            expiryBase.toISOString(),
            user.id
          );

      })();

      // Create or renew this customer's login on the Mikrotik
      // hotspot. This does not block the webhook response — if
      // the router is unreachable, the payment is still recorded
      // and you can sync manually (see mikrotik.js).
      mikrotikOnActivate({
        username: user.username,
        password: user.hotspot_password,
        profile: plan.mikrotik_profile || plan.id,
        expiry: expiryBase
      }).catch((error) => {
        console.error(
          'Mikrotik activate failed:',
          error.message
        );
      });

      res.sendStatus(200);

    } catch {

      res.sendStatus(400);

    }

  }
);

// ============================================================
// AUTOMATIC EXPIRY CHECK
// ============================================================

setInterval(
  () => {

    const expired =
      db
        .prepare(`
          SELECT id, username
          FROM users
          WHERE status='ACTIVE'
          AND expiry IS NOT NULL
          AND expiry <= ?
        `)
        .all(
          now()
        );

    if (!expired.length) {
      return;
    }

    db
      .prepare(`
        UPDATE users
        SET status='EXPIRED'
        WHERE id IN (
          ${expired
            .map(() => '?')
            .join(',')}
        )
      `)
      .run(
        ...expired.map(
          x => x.id
        )
      );

    for (const row of expired) {
      mikrotikOnExpire(row.username).catch((error) => {
        console.error('Mikrotik expire failed:', error.message);
      });
    }

  },
  60 * 1000
);

// ============================================================
// PAGES
// ============================================================

app.get(
  '/admin',
  (req, res) => {

    res
      .type('html')
      .send(
        page(true)
      );

  }
);

app.get(
  '*',
  (req, res) => {

    res
      .type('html')
      .send(
        page(false)
      );

  }
);

// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  () => {

    console.log(
      `Yournet running on http://localhost:${PORT}`
    );

  }
);
