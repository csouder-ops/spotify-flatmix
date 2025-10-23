# Flat Mix – group Spotify recommender

Flat Mix lets a house share quickly blend everyone’s listening habits into a single Spotify playlist. Each roommate authenticates with Spotify, the app gathers their recent and top tracks, and a scoring model picks 50 tracks that balance popularity, audio features, and fairness.

## Features

- **Join a flat:** Share a flat code and let roommates authenticate via Spotify OAuth.
- **Automatic data refresh:** Recent plays, top tracks (short & medium term), and audio features are aggregated for every member.
- **Scoring & guardrails:** Tracks are ranked by blended popularity and audio-feature fit, capped at two tracks per artist, and every roommate gets at least two songs they played in the last two weeks.
- **One-click playlist build:** Creates `Flat Mix – YYYY-MM-DD (FLAT_CODE)` playlists with Spotify Web API, adding tracks in batches and surfacing warnings if data is sparse.
- **Token hygiene:** Access tokens refresh automatically; refresh tokens are encrypted at rest in SQLite.
- **Debug visibility:** Playlist responses include centroid and selection data for quick inspection.

## Requirements

- Node.js 18+
- SQLite (bundled via [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3))
- A Spotify developer application with Web API access

## Getting started

1. **Clone & install**

   ```bash
   git clone <repo>
   cd spotify-flatmix
   npm install
   ```

2. **Create a Spotify app**

  - Visit [Spotify for Developers](https://developer.spotify.com/dashboard) and create an app.
  - Add `http://127.0.0.1:3000/callback` as a redirect URI (Spotify now requires the numeric loopback address).
   - Note the Client ID and Client Secret.

3. **Configure environment**

   Create a `.env` file in the project root:

   ```bash
   SPOTIFY_CLIENT_ID=your-client-id
   SPOTIFY_CLIENT_SECRET=your-client-secret
  SPOTIFY_REDIRECT_URI=http://127.0.0.1:3000/callback
   FLAT_CODE=riasa-apt-12
   PORT=3000
   ENCRYPTION_KEY=32+character-random-secret
   ```

   **Required scopes:**

   ```
   user-read-recently-played user-top-read playlist-modify-public playlist-modify-private
   ```

   Optional environment variables:

   - `DATA_DIR`: Directory for the SQLite database (defaults to `data/`).
   - `DB_PATH`: Override the full path to the SQLite file.

4. **Run the dev server**

   ```bash
   npm run dev
   ```

   Visit [http://localhost:3000](http://localhost:3000) and share the flat code. The landing page shows current members, and the “Join Flat Mix” button starts OAuth.

5. **Building a playlist**

   After at least one roommate joins, the “Build Playlist” button calls the scoring algorithm and returns a link to the new playlist. Warnings are shown if:

   - Spotify data is missing or tokens fail.
   - Fewer than three members contributed.
   - A roommate doesn’t have two recent tracks in the last 14 days.

6. **Reset a flat**

   Clear stored tokens and stats for a flat code:

   ```bash
   npm run reset:flat        # uses FLAT_CODE
   npm run reset:flat other-flat
   ```

## Architecture

- **Server:** `server.ts` (Express + TypeScript). Serves the UI, manages OAuth, and orchestrates playlist builds.
- **Spotify helpers:** `lib/spotify.ts` wraps the Authorization Code flow, handles refresh, API retries, playlist creation, and data fetching.
- **Persistence:** `lib/store.ts` stores encrypted refresh tokens and user stats in SQLite. AES-256-GCM encryption uses the `ENCRYPTION_KEY` secret.
- **Front-end:** `views/index.html` (vanilla JS) and `public/main.css`. The UI polls `/api/flat`, launches `/login`, and triggers `/build`. Playlist responses expose debug JSON (selected track IDs + centroid) in a collapsible block.

## Token refresh & security

- Access tokens refresh automatically if they expire within two minutes.
- Refresh tokens are encrypted with AES-256-GCM using a key derived from `ENCRYPTION_KEY` (hashed to 32 bytes).
- On build errors caused by invalid tokens, affected members are skipped and warned.

## Production build

```bash
npm run build
npm start
```

The build step compiles TypeScript into `dist/`. Ensure `views/` and `public/` are available alongside the compiled server when deploying (e.g., copy them or serve statically via a reverse proxy).

## Data storage

- SQLite database lives at `data/flatmix.db` by default.
- Each row stores: flat code, Spotify user ID, display name, tokens, expiry, last join timestamp, and the latest contributed track count.
- Audio features and listening history are fetched live from Spotify; only aggregates are persisted.

## Debugging tips

- Use `npm run dev` for hot reload via `ts-node-dev`.
- Check terminal logs for per-user fetch warnings (rate limits, expired tokens, etc.).
- The playlist response includes `debug.selectedTrackIds` and the feature centroid for quick auditing.

Enjoy the mix!
