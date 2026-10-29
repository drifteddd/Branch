# Branch

a free windows app for finding gorilla tag mods. made by Drifted.

open it, search or scroll, click a mod, press download. no account needed.

> Branch is an independent project. it isn't made by, endorsed by, or connected to Another Axiom or the Gorilla Tag team.

## what it does

- **browse and search** every published mod by name, description, author or tag
- **filter** by category and compatibility, and **sort** by recently updated, newest, name or downloads
- **mod pages** with screenshots, install steps, changelog, requirements, license and file checksum
- **downloads** with a progress bar, cancel button and "show in folder". Branch only saves the file. it never runs or installs anything and never asks for admin access
- **favorites and recently viewed**, saved only on your computer
- **reports** for broken, outdated, misleading, harmful or copyright problems. no account needed, and reports stay private
- **light, dark or match windows**, keyboard shortcuts (ctrl+f to search, alt+left to go back) and reduced motion
- an **admin panel** (in the browser) for adding mods, releases, pictures, categories, handling reports and turning off bad downloads

## how the project is laid out

```
app/
  ui/              the app's interface. plain html, css and javascript, no build step
    shared/        design tokens, the safe markdown renderer and the logo. the admin panel uses these too
    legal/         privacy notice, terms, takedown info and licenses shown inside the app
  src-tauri/       the rust side of the desktop app (tauri 2): network requests, save dialog, downloads
server/
  src/             the rust backend (axum + postgres). public api, admin api, uploads
  migrations/      database tables
  admin/           the admin panel web page, built into the server
  tests/           api tests that run against a real postgres database
  Dockerfile       how railway builds the server
dev/
  mock-server.mjs  a fake server with demo data so you can try the interface with just node
  e2e.mjs          clicks through the app and admin panel in a headless browser
scripts/
  make-icons.mjs   draws the app icons
tests/             markdown safety tests
.github/workflows/ cloud checks and the windows installer build
railway.json       railway settings for the server
```

the desktop app never talks to the database. it only calls the public api. no database passwords, admin secrets or storage keys are in the app.

## try it on your computer (only needs node)

you don't need rust or anything else for this. it uses demo data that's clearly marked as fake.

```
node dev/mock-server.mjs
```

then open http://localhost:5173 for the app and http://localhost:5173/admin for the admin panel. the demo admin login is `demo-admin` / `demo-password-1234`. that's only for the fake server, it doesn't exist anywhere real.

to run the automatic click-through tests (uses edge or chrome that's already installed):

```
node dev/e2e.mjs
node --test tests/markdown.test.mjs
```

screenshots from the click-through end up in `dev/.screens/`.

## building the real thing (in the cloud)

rust isn't needed on your computer. github builds everything.

### 1. checks

every push runs `.github/workflows/checks.yml`:

- **server**: clippy and all rust tests, including the api tests against a temporary postgres database
- **interface**: the markdown tests and the click-through tests in chrome
- **desktop app**: clippy and tests for the tauri app on windows

see the results in the **actions** tab on github.

### 2. the windows installer

1. on github go to **settings > secrets and variables > actions > variables** and add a variable called `BRANCH_API_URL` with your railway server address, like `https://branch-production.up.railway.app` (no slash at the end). this isn't secret, it's just where the app looks for mods.
2. go to **actions > windows build > run workflow**.
3. when it finishes, open the run and download **branch-windows-installer** at the bottom. inside is `Branch_0.1.0_x64-setup.exe`.

the installer installs for the current user only, so it doesn't need admin rights. it isn't code-signed yet, so windows smartscreen will show "windows protected your pc" the first time. click "more info" then "run anyway". signing needs a paid certificate (see below).

this workflow only makes a download on the workflow run. it doesn't publish a github release.

## setting up railway

railway hosts the server, the database and the file storage. railway is a paid service after any trial or free allowance, so check their current pricing.

1. **make a project** on railway and choose **deploy from github repo**, then pick this repo. railway reads `railway.json` and builds `server/Dockerfile`.
2. **add postgres**: in the project press **new > database > postgresql**.
3. **add storage for uploads**: add a railway **bucket** (or use any s3-style storage like cloudflare r2). uploads can't go on the server's normal disk because railway wipes it on every deploy. the server refuses to start if you try.
4. **set the server's variables** (service > variables). `.env.example` lists all of them:

   | variable | what to put |
   | --- | --- |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (railway fills it in) |
   | `SERVER_SECRET` | a long random string, 32+ characters. a password manager can make one |
   | `STORAGE_DRIVER` | `s3` |
   | `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | from your bucket's credentials page |
   | `ADMIN_BOOTSTRAP_USERNAME` | `meganight32` |
   | `ADMIN_BOOTSTRAP_PASSWORD` | your starting password (see below) |

5. **give it a public address**: service > settings > networking > generate domain. that's your `BRANCH_API_URL`.
6. the server runs the database migrations by itself every time it starts. check `https://<your-address>/health`. it should say `{"status":"ok"}`.

### making the first admin safely

the admin password is never in the code, the repo or the app.

1. put your starting password in `ADMIN_BOOTSTRAP_PASSWORD` in railway's variables (it's stored encrypted there), and `meganight32` in `ADMIN_BOOTSTRAP_USERNAME`.
2. deploy. on the first start, when there are no admins yet, the server saves a strong argon2 hash of the password, never the password itself.
3. **delete both bootstrap variables from railway right away.** the server ignores them once an admin exists and warns in the logs if they're still there.
4. open `https://<your-address>/admin` and log in. you'll have to pick a new password (12+ characters) before you can do anything else.

if you ever get locked out: in railway's postgres data tab, delete the row in the `admins` table, set the two bootstrap variables again and redeploy.

### backups

- **database**: railway can back up the postgres volume (look for **backups** on the postgres service; what's included depends on your plan). you can also run `pg_dump "<public DATABASE_URL>" > branch.sql` from any computer that has postgres tools, and restore with `psql "<url>" < branch.sql`.
- **files**: copy the bucket with your storage provider's tools, or turn on bucket versioning if it has it.
- dumps contain reports, which can include contact info people chose to share. keep backups private and don't upload them to github.

## keeping costs low

- images are resized and re-encoded on upload (thumbnails up to 960×540, screenshots up to 1920×1080) and cached forever by the app
- lists are paged (20 at a time) and the app only loads more when you scroll
- the app doesn't poll or run background requests
- hosted mod files are capped at 50 MB, images at 8 MB

## security notes

- every admin request is checked on the server: session cookie (httponly, samesite=strict, secure) plus a custom header that blocks cross-site requests
- sessions end after 2 hours idle or 12 hours total. logout and password changes end sessions
- logins are rate limited, and 8 wrong passwords lock the account for 15 minutes
- uploads are checked by content, not just name: images are decoded and re-encoded, mod files must really be a dll or zip, file names are cleaned, and storage keys are made by the server
- the server never fetches urls people type, so it can't be tricked into calling other servers
- links in descriptions only allow http and https, and markdown can't contain html
- logs never include passwords, report text or contact info

## contributing

1. fork the repo and make a branch
2. try your change with `node dev/mock-server.mjs`
3. run `node dev/e2e.mjs` and `node --test tests/markdown.test.mjs`
4. open a pull request. the checks run by themselves, and they never get access to secrets

keep code simple and comments short. explain *why*, not *what*.

## what's still missing before a public release

these need decisions or things I can't make up:

- **a contact address** for privacy and copyright requests. right now the report button is the only way to reach the admin. a real email or form should be added to the privacy notice and takedown page
- **code signing** for the installer, so windows doesn't show the smartscreen warning. that needs a code signing certificate (paid)
- **real mods with permission**. no real mods are included. each one needs its license checked before hosting a copy
- **legal review**. the privacy notice and terms are written to match what the app actually does, but they haven't been checked by a lawyer
- **one server only**. rate limits are kept in memory, which is fine for one railway instance. running more than one would need them moved into the database
- a full list of every third-party package and license can be generated from the `Cargo.lock` files that ci produces

## license

Branch's own code is MIT licensed (see `LICENSE`). that doesn't cover the mods listed in it, and it doesn't cover anything from gorilla tag.
