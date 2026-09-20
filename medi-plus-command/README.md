# Medi+ Command — Unified Hospital Network

A real-time, role-based hospital management system matching the access model:
**Hospital Admin** (full control) · **Doctor** (own patients) · **Nurse** (hospital-wide records, equipment, beds) · **Patient** (own record only).

## Stack
- **Backend:** Node.js, Express, Socket.IO (real-time push), SQLite via `better-sqlite3` (file-based, zero setup)
- **Frontend:** Single-page HTML/JS (no build step) using `fetch` for REST calls and `socket.io-client` for live updates

## Folder structure
```
medi-plus/
  backend/
    server.js      REST API + Socket.IO server
    db.js           SQLite schema + seed data
    package.json
  frontend/
    index.html      Full UI for all four roles
```

## Run it in VS Code

1. **Open the project**
   - `File → Open Folder…` → select the `medi-plus` folder.

2. **Install Node.js** (if not already installed)
   - Download from https://nodejs.org (v18 or later). Verify in a VS Code terminal:
     ```
     node -v
     npm -v
     ```

3. **Install backend dependencies**
   - Open a terminal in VS Code: `Terminal → New Terminal`.
     ```
     cd backend
     npm install
     ```

4. **Start the backend**
   ```
   npm start
   ```
   You should see: `Medi+ Command backend running on http://localhost:4000`
   The SQLite database (`medi-plus.db`) is created and seeded automatically on first run.

5. **Open the frontend**
   - In VS Code, right-click `frontend/index.html` → **"Open with Live Server"** (install the free *Live Server* extension by Ritwick Dey if you don't have it), or simply double-click `index.html` to open it in your browser.
   - The frontend talks to `http://localhost:4000`, so keep the backend terminal running.

6. **Log in** with any seeded demo account (shown on the login screen):
   | Role | ID | Password |
   |---|---|---|
   | Admin | ADM-1001 | admin123 |
   | Doctor | DR-1001 | doc123 |
   | Nurse | NR-1001 | nurse123 |
   | Patient | PT-001 | pat123 |

7. **See real-time sync**: open the app in two browser tabs (e.g., one logged in as Admin, one as Doctor). Add/edit a patient as Admin — the Doctor's tab updates instantly via Socket.IO, and a live notification toast appears.

## What's real vs. simplified
- Real: Express REST API, SQLite persistence, session tokens, server-enforced role permissions (a doctor's API calls are filtered/rejected server-side, not just hidden in the UI), Socket.IO broadcasts on every write so all connected clients refresh live.
- Simplified for a learning/demo build: passwords are stored in plain text in SQLite (fine for local demo; swap in `bcrypt` hashing before any real deployment) and sessions are in-memory (swap in Redis/JWT for a production, multi-server deployment).

## Newer features
- **Hospital location** — each hospital now has an address plus latitude/longitude, editable from the Admin → Hospitals view.
- **Blood availability** — a per-hospital blood bank (all 8 groups) visible to Admin (all hospitals), Nurse (own hospital, editable), and Patient (read-only, all hospitals). Editing a group's units below 4 automatically fires a live low-stock notification to Admin.
- **SOS on the login screen** — a red "SOS — Emergency Help" button on the login screen opens a form (phone required, name/hospital/reason optional) that anyone can submit **without logging in**. It posts to `POST /api/sos`, tries to attach the browser's geolocation, and instantly notifies Admin (and that hospital's nurse, if a hospital was chosen) over Socket.IO. Admins can review and resolve alerts under the "SOS Alerts" nav item.

## Next steps to harden for production
- Hash passwords with `bcrypt`; replace in-memory session map with JWT or Redis-backed sessions.
- Add HTTPS + environment-based config (`.env` for `PORT`, CORS origin).
- Move from SQLite to PostgreSQL for concurrent multi-instance deployments.
- Add input validation (e.g. `zod`) on every POST/PUT body.
