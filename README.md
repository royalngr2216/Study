# StudyQuest v2 — with login + cross-device sync

What's new vs. your original PWA:

1. **Permanent daily class quests** — Maths, G.S., and English Revision (×2) show up every single day on the dashboard automatically. They're not deletable like your extra study tasks; they just reset each day.
2. **Skip tracking** — each quest gets marked ✅ Done or 🚫 Skipped. A new **History** tab (📊 in the nav) shows a day-by-day table for the last 30 days, plus attendance % per subject.
3. **Login / Register** — real accounts with hashed passwords.
4. **Cross-device sync** — log into the same account on your phone and laptop and both stay in sync (auto-syncs every ~25s, on app focus, and instantly after anything you change).

## How the sync works
This now needs a small backend (it didn't before, since it was pure local storage). I wrote it with **zero external dependencies** — just Node's built-in modules — so there's nothing to `npm install` and nothing that can fail to build on a free host. `data/db.json` is the "database" (usernames, password hashes, and each user's quests/tasks/journal).

## Storage: MongoDB (recommended) or local file
The server now supports two storage backends:

- **MongoDB** — set a `MONGODB_URI` environment variable and everything (accounts, sessions, quest/task/journal data) is stored there. This survives restarts, redeploys, and Render's free-tier disk wipes.
- **Local JSON file** (`data/db.json`) — used automatically if `MONGODB_URI` is not set. Fine for quick local testing, but **not persistent** on most hosts (this was the cause of "everything gets deleted on restart").

### Setting up a free MongoDB (takes ~5 minutes)
1. Go to https://www.mongodb.com/cloud/atlas/register and create a free account.
2. Create a free **M0 cluster** (no credit card needed).
3. Under **Database Access**, create a database user (username + password).
4. Under **Network Access**, add `0.0.0.0/0` (allow access from anywhere) — simplest for a small personal app on a host with a dynamic IP like Render.
5. Click **Connect** → **Drivers** → copy the connection string. It looks like:
   `mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`
6. Add a database name to the path so all your data lands in one place, e.g.:
   `mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/studyquest?retryWrites=true&w=majority`
7. Replace `<password>` with your actual database user password (URL-encode any special characters).

## Run it locally first (optional, to try it out)
```
cd studyquest-app
npm install
node server.js
```
Then open `http://localhost:3000` in your browser. Without a `MONGODB_URI` set, this uses the local file store — good enough to click around.

To test with real MongoDB locally, set the env var first:
```
MONGODB_URI="mongodb+srv://..." node server.js
```

## Deploy so your phone AND laptop can reach it
You already do this for your Discord bot, so this will feel familiar.

**Render (Web Service, not Static Site this time):**
1. Push this folder to a GitHub repo.
2. Render dashboard → New → Web Service → connect the repo.
3. Build command: `npm install`
4. Start command: `node server.js`
5. Under **Environment**, add a variable: `MONGODB_URI` = your connection string from above.
6. Deploy → you get a `https://yourapp.onrender.com` URL.
7. Open that URL on your phone and your laptop, register once, then log in with the same account on both.

With `MONGODB_URI` set, your data now lives in MongoDB Atlas — restarts, redeploys, and spin-downs won't touch it anymore.

## Installing on your phone
Same as before:
- **Android (Chrome):** open the URL → ⋮ menu → "Add to Home screen".
- **iPhone (Safari):** open the URL → Share icon → "Add to Home Screen".

## Editing your subjects
Open `public/index.html` and find `PERMANENT_QUESTS` near the top of the `<script>` block:
```js
const PERMANENT_QUESTS = [
  { id:'math', title:'Maths Class',        icon:'➗', xp:20 },
  { id:'gs',   title:'G.S. Class #1',       icon:'🌍', xp:20 },
  { id:'gs2',  title:'G.S. Class #2',       icon:'🌍', xp:20 },
  { id:'eng1', title:'English Revision #1', icon:'📖', xp:15 },
  { id:'eng2', title:'English Revision #2', icon:'📖', xp:15 },
];
```
Add, remove, or rename entries here — the history table and dashboard pick them up automatically. Keep each `id` unique and don't change an existing `id` once you've started tracking it, or its past history will "detach" from the renamed quest.
