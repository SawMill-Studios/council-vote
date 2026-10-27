# Council vote

A room votes on stickies. Phones join a session, post notes, and place dots. A presenter runs the beats on a big screen: framing, a hiring wall, a testing 2x2, and a harvest of offers.

Each session has its own admin key. That key advances the beats, reveals votes, and exports the board. It does not open any other session. A site-level creator key can start new sessions. It cannot run a session someone else created.

This app stores boards in its own Netlify Blobs store, `council-vote`. It does not read or write Mission Control's store, and it does not import anyone's previous council.

## Local development

You need Node 22.

```bash
npm ci
cp .env.example .env.local
npm test
npm run dev
```

Edit `.env.local` and set `COUNCIL_CREATOR_KEY` to a long random string before you create a session. `.env.local` stays on your machine. Do not commit it.

Without Netlify credentials, board data is written under `data/local/council`. That folder is gitignored.

`npm run build` produces the Next.js app Netlify serves.

## Environment variables

| Name | Where | Purpose |
| --- | --- | --- |
| `COUNCIL_CREATOR_KEY` | Netlify, and `.env.local` for local dev | Creates and lists sessions. It is not an admin key. |
| `COUNCIL_NETWORK_STICKY_CAP` | Optional | Stickies allowed from one IP. Default 200, for a room on shared Wi-Fi. |
| `COUNCIL_NETWORK_RATE_LIMIT` | Optional | Writes per minute from one IP. Default 400. |
| `COUNCIL_BASE_URL` | Your laptop, for the commands below | Site origin, such as `https://your-site.netlify.app`. The deployed site does not read this. |

There is no site-wide admin key and no fixed list of sessions. Leave a column blank when you create a session and the board starts from today's template (PM skills, Where to hunt, and the standard beats). The capture sheet heading in that template is the original council's wording until you replace it.

## Deploy to Netlify

1. In Netlify, add a site from this Git repository. The build command and publish directory are already in `netlify.toml` (`npm run build`, Node 22, Next.js runtime).
2. In Site configuration → Environment variables, set `COUNCIL_CREATOR_KEY` to a long random string. Mark it as a secret.
3. Deploy. The Blobs store `council-vote` is created the first time someone creates a session.
4. Open the site. You do not need to set `COUNCIL_BASE_URL` on Netlify.

## Create a new session

You can do this in the browser. You do not need the command line.

1. Ask the person who deployed the site for the creator key.
2. Open `https://your-site.netlify.app/create`.
3. Paste the creator key. It is sent only to create the session. The page does not save it.
4. Choose a slug. Use lowercase letters, numbers, and hyphens, up to 40 characters. Example: `tommy-2026-11-04`. The slug becomes part of the link and cannot be changed.
5. Type a title people will recognize, such as `Tuesday council`.
6. Optional: rename the two hiring columns, replace the opening line, or replace the capture sheet's closing heading. Leave a box blank to keep the template.
7. Press **Create session**.
8. Copy the admin key before you leave the page. It is shown once. The server stores only a hash of it, so it cannot be looked up later. If you lose it, create a new session.
9. Open the **admin** link once, on the presenter laptop. The site moves the key into the address-bar hash (`#admin=...`) so the key is not kept in the page itself. Bookmark that presenter page after it loads, or paste the key again from your notes.
10. Put the presenter page on the projector. Share the **join** link, or let people scan the QR code on the screen. Phones do not need an account.

The creator key can also list session titles and slugs. It cannot reset, reveal, or export a board.

### From the command line

On a machine that has this repo and Node 22, put the creator key and the site origin in `.env.local` (see `.env.example`). Then:

```bash
npm run create-session -- --slug tommy-2026-11-04 --title "Tuesday council"
```

Optional flags: `--pm`, `--channel`, `--testing`, `--harvest`, `--prompt`, `--capture-moves`.

The command prints JSON. It includes:

- `slug` and `title`
- `adminKey`, the per-session secret, shown this once
- `presenterUrl`, the big-screen page
- `joinUrl`, the phone page
- `adminUrl`, the presenter page with the key in the query. Opening it redirects so the key sits in the hash instead
- `content`, the title, short name, column names, and beat lines that were saved

List sessions (titles and slugs only, no keys and no stickies):

```bash
npm run list-sessions
```

Export one session. This needs that session's admin key, not the creator key:

```bash
npm run export-session -- --slug tommy-2026-11-04 --admin-key PASTE --format json
```

`--format` is `json`, `csv`, or `html`. Add `--out board.json` to write a file instead of printing.

The same export is `GET /api/council/export?session=SLUG&admin=KEY&format=json`. Creating a session is `POST /api/council/sessions` with `Authorization: Bearer CREATOR_KEY` and a JSON body `{ "slug", "title" }`. A wrong creator key is rejected. A query-string key is ignored.

## What a session looks like

The presenter moves through four beats. People post stickies from their phones. On the hiring beat they place two skill dots and one hunt dot. The testing beat is a 2x2. The harvest beat collects named offers.

Keyboard shortcuts on the presenter, once the admin key is loaded: arrow keys change beats, V opens voting, R reveals, M merges, Shift+M splits, E exports, F is fullscreen.
