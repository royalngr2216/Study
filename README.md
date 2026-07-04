# StudyQuest v2 — with login + cross-device sync

What's new vs. your original PWA:

1. **Permanent daily class quests** — Maths, G.S., and English Revision (×2) show up every single day on the dashboard automatically. They're not deletable like your extra study tasks; they just reset each day.
2. **Skip tracking** — each quest gets marked ✅ Done or 🚫 Skipped. A new **History** tab (📊 in the nav) shows a day-by-day table for the last 30 days, plus attendance % per subject.
3. **Login / Register** — real accounts with hashed passwords.
4. **Cross-device sync** — log into the same account on your phone and laptop and both stay in sync (auto-syncs every ~25s, on app focus, and instantly after anything you change).

## How the sync works
This now needs a small backend (it didn't before, since it was pure local storage). I wrote it with **zero external dependencies** — just Node's built-in modules — so there's nothing to `npm install` and nothing that can fail to build on a free host. `data/db.json` is the "database" (usernames, password hashes, and each user's quests/tasks/journal).

## Run it locally first (optional, to try it out)
```
cd studyquest-app
node server.js
```
Then open `http://localhost:3000` in your browser.

## Deploy so your phone AND laptop can reach it
You already do this for your Discord bot, so this will feel familiar.

**Render (Web Service, not Static Site this time):**
1. Push this folder to a GitHub repo.
2. Render dashboard → New → Web Service → connect the repo.
3. Build command: (leave blank)
4. Start command: `node server.js`
5. Deploy → you get a `https://yourapp.onrender.com` URL.
6. Open that URL on your phone and your laptop, register once, then log in with the same account on both.

**⚠️ Important caveat about free hosting:** Render's free tier disk is *not* guaranteed to persist forever — a redeploy or plan change can wipe `data/db.json`. For a personal app like this it's normally fine (the disk survives idle spin-downs), but if you ever want bulletproof persistence, swap the JSON-file storage for a real database (e.g. a free Postgres) later. Happy to help with that migration if you want it — the API layer (`/api/register`, `/api/login`, `/api/state`) would stay exactly the same.

## Installing on your phone
Same as before:
- **Android (Chrome):** open the URL → ⋮ menu → "Add to Home screen".
- **iPhone (Safari):** open the URL → Share icon → "Add to Home Screen".

## Editing your subjects
Open `public/index.html` and find `PERMANENT_QUESTS` near the top of the `<script>` block:
```js
const PERMANENT_QUESTS = [
  { id:'math', title:'Maths Class',        icon:'➗', xp:20 },
  { id:'gs',   title:'G.S. Class',          icon:'🌍', xp:20 },
  { id:'eng1', title:'English Revision #1', icon:'📖', xp:15 },
  { id:'eng2', title:'English Revision #2', icon:'📖', xp:15 },
];
```
Add, remove, or rename entries here — the history table and dashboard pick them up automatically. Keep each `id` unique and don't change an existing `id` once you've started tracking it, or its past history will "detach" from the renamed quest.
