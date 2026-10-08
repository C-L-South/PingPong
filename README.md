# Carroll Ping Pong Club — Elo & Match Tracker

A responsive full-stack web application for Carroll High School Ping Pong Club to track player rankings, match histories, and calculate Elo ratings with a secure dual-confirmation verification system that **syncs in real time across all devices**.

## Features

- **Cross-Device Persistent Storage**: Accounts, player ratings, and match records are stored centrally and synchronized in real time across all devices and phones.
- **Dedicated Create Account & Login**: Distinct views to easily create a new player profile or sign in.
- **Delete Account**: One-click account deletion to permanently remove profile and cleanup match data.
- **Admin Desk**: Add roster players without accounts and record official results directly.
- **Elo Rating Engine**: Calculates rating adjustments using the standard Elo algorithm with a baseline rating of 1000 and a K-factor of 32.
- **Dual-Confirmation Verification**: Reported matches remain pending until both participants verify the result, preventing fraudulent or erroneous rating changes.
- **Dynamic Leaderboard**: Real-time club rankings sorted by Elo, matches played, win-loss records, and win percentages.
- **Vercel-Ready**: Pre-configured for seamless 1-click deployment on Vercel with Vercel Serverless Functions and Vercel KV / Upstash Redis support.

## Deploying to Vercel (Step-by-Step)

### 1. Import Project into Vercel
1. Go to [Vercel.com](https://vercel.com) and click **Add New...** > **Project**.
2. Select your GitHub repository (`pingpongclub`).
3. Click **Deploy**.

### 2. Enable Persistent Cross-Device Storage (Vercel KV)
Because serverless functions on Vercel are stateless, add free persistent storage in 1 click:
1. In your Vercel Project Dashboard, click the **Storage** tab.
2. Click **Create Database** and choose **KV** (or Upstash Redis).
3. Connect it to your project. Vercel automatically injects the environment variables (`KV_REST_API_URL` and `KV_REST_API_TOKEN`).
4. Redeploy (or push a new commit) — your app is now 100% persistent across all devices globally!

## Local Development

```bash
npm start
# or
node server.js
```

Open `http://localhost:8000` in your browser.


## Admin desk (existing data is preserved)

The **Admin** navigation item opens a separate administrator sign-in. The administrator can:

- Add a named roster player without creating a username, password, or account.
- Select any existing roster players and save an official match immediately.
- Update Elo and win/loss records once, without player confirmations. Retrying the same submission does not double-count it.

Player accounts and their normal login/confirmation flow remain supported. Existing IDs, credentials, ratings, custom database fields, and match history are retained. Guest players have `accountId: null`; they are not fake login accounts. Admin results are marked `verification: "admin"` and include an audit username and timestamp.

### Enable the admin account

Set these **server-side environment variables** in the existing hosting service, then restart/redeploy:

- `ADMIN_USERNAME`: the administrator's chosen username.
- `ADMIN_PASSWORD`: a unique password of at least 12 characters.
- `ADMIN_SESSION_SECRET`: a randomly generated secret of at least 32 characters (for example, `openssl rand -hex 32`).

There is no default password and these values must never be committed or placed in the HTML. The admin account is configured separately from player accounts; no existing account is renamed or overwritten. Sessions use a signed HttpOnly, SameSite cookie and expire after eight hours. Use HTTPS in production. Changing the password or session secret invalidates existing sessions.

### Preserve the current production database

Keep the existing `DATABASE_URL`, KV credentials, and database contents. Do not replace or reset `data/db.json`. This change requires **no data migration or reset**, and the source update does not include database files. On Render, use the existing PostgreSQL database or a persistent disk (`DATA_DIR` can point to its directory). Run a single Node server instance for file/in-memory storage. On Vercel, configure the existing KV store; writes now require durable KV and detect concurrent changes rather than overwriting another request.

Storage read failures stop startup/return an error instead of silently starting an empty database. Admin writes are acknowledged only after storage succeeds. The old unauthenticated reset, restore, and client data import endpoints are disabled, and full database backup requires an admin session. Back up the current database using the hosting service before deploying. Do not copy preview/sample data into production.

### Verification

Run `npm test` (Node 18+). The tests use temporary fictional data, exercise both server entry points, reject forged admin access, verify duplicate submissions and invalid scores, preserve legacy account/history records, restart the server, and simulate KV conflicts and outages. They do not connect to the production database.
