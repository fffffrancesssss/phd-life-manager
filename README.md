<img src="docs/icon.png" width="104" alt="">

# PhD Life Manager

A local, single-user app for managing PhD work: calendar time-blocking synced
with Apple or Google Calendar, to-dos, research ideas, projects with memos, a
phone-free focus timer, and a weekly recap.

Everything runs on your own machine. No cloud service, no accounts, no
framework, no build step. The backend is one Python file using only the
standard library; the interface is one HTML file, one CSS file and one JS file,
served straight off disk.

![The calendar](docs/screenshot-calendar.png)

## What it does

- **Calendar** — drag to-dos onto a week grid to block time for them. Blocks
  sync both ways with **either** a calendar in iCloud **or** one in Google, so
  what you plan here shows up on your phone, and what you change on your phone
  shows up here. One service at a time, by design: a block lives on exactly one
  calendar, and letting two services both claim to be that calendar duplicates
  events and leaves the reconciler unable to tell which side is right.
- **Idea board** — somewhere to put research ideas before they are projects.
  Tags, starring, linking between ideas, and a "move to project" when one grows
  up.
- **Projects** — each with its own to-dos and plain-text memos.
- **Focus** — a timer for phone-free work, linked to the to-do or block you are
  working on, with a weekly breakdown of where the hours actually went.
- **Journal** — a weekly recap: what moved, what didn't, three self-rated dials,
  and a compare view across weeks.

## Requirements

- macOS 12 or later
- Python 3.9 or later (the one macOS ships with is fine)
- Xcode Command Line Tools, for `swiftc` — `xcode-select --install`

## Setting it up

```bash
git clone <your-fork-url> "PhD Life Manager"
cd "PhD Life Manager"
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
./mac/build.sh
```

`build.sh` compiles the app shell, generates the icon, and installs to
`~/Applications/PhD Life Manager.app`. Put it somewhere else with
`INSTALL_DIR=/Applications ./mac/build.sh`.

The app records the checkout it was built from, so it knows where to find the
Python half of itself. **If you move the project folder, run `build.sh` again.**

### Or run it without the app

```bash
.venv/bin/python3 server.py     # then open http://127.0.0.1:8765
```

The dependencies are only needed for iCloud sync. Without them the app still
runs — the calendar simply stays local to your machine.

## Connecting a calendar (optional)

Click the sync button in the calendar toolbar and pick **Off**, **Apple
iCloud**, or **Google**. Switching services changes where *new* blocks are
written; it never copies what is already on the other one.

### Apple iCloud

1. In Apple Calendar, make a calendar named **Todos**. This is the one the app
   writes its own blocks to; everything else in your account is shown but never
   modified unless you edit it here deliberately.
2. Generate an app-specific password at
   [appleid.apple.com](https://appleid.apple.com) → Sign-In and Security →
   App-Specific Passwords. Your normal Apple ID password will not work.
3. Enter your Apple ID and that password.

### Google

Google has no app-specific passwords, so this needs an OAuth client of your
own. It is a one-time setup, and it keeps your calendar data between you and
Google — nothing is proxied through anyone else.

1. At [console.cloud.google.com](https://console.cloud.google.com), create a
   project.
2. Under *APIs & Services*, enable the **Google Calendar API**.
3. Under *OAuth consent screen*, choose **External**, and add your own address
   under **Test users**. (You do not need to publish the app or get it
   verified — a test user can use it indefinitely.)
4. Under *Credentials*, create an **OAuth client ID** of type *Web
   application*, and add this exact redirect URI:
   `http://127.0.0.1:8765/api/google/callback`
5. Paste the client ID and secret into the app, click **Connect Google…**, sign
   in, then choose which calendar the app should write its blocks to.

Credentials and tokens are stored in `data/caldav_config.json` and
`data/google_config.json` on your machine, in plain text, and go nowhere else.
`data/` is gitignored — do not commit it.

## Where your data lives

Everything is under `data/`, in formats meant to be readable without this app:

| Path | What |
|---|---|
| `todos.json`, `calendar.json`, `focus_sessions.json` | structured records |
| `ideas.txt` | every idea, one delimited text file |
| `projects/<slug>/project.json` + `memos/<id>.txt` | one memo per file |
| `journal/weekly/<monday>.txt`, `journal/daily/<date>.txt` | plain text |
| `caldav_config.json` | your Apple ID and app-specific password |
| `google_config.json` | your Google OAuth client and refresh token |
| `sync_config.json` | which calendar service is selected, if any |
| `caldav_cache.json`, `google_cache.json` | last-known snapshots; safe to delete |

To back it up, copy `data/`. To move machines, copy `data/` across.

## Developing

The interface is served live from disk — edit `public/*` and press ⌘R in the
app. Changes to `server.py` need the app restarted. Only `mac/main.swift` and
`mac/makeicon.swift` need `./mac/build.sh`.

`CLAUDE.md` documents the parts that are not obvious from reading the code —
particularly the iCloud sync, which has several hard-won details that look like
they could be simplified and cannot.

## A note on signing

`build.sh` signs the app ad-hoc (`codesign --sign -`). That is enough for an app
you compiled yourself on your own machine. It is *not* enough to hand someone a
prebuilt `.app` — macOS Gatekeeper will refuse to open it, and getting past that
properly needs a paid Apple Developer account and notarisation. Building from
source, as above, avoids the problem entirely.

## Tests

There is one test suite, for the part that most needs it. The Google
integration cannot be exercised against the real service without an account and
a browser sign-in, so it is driven against a stub that answers the way Google
does:

```bash
.venv/bin/python3 tests/test_google_stub.py
```

It covers token refresh, the retry after a 401, pagination, all-day events, the
write calls, and that a calendar which fails to read is reported as failed
rather than as empty. It restores `data/calendar.json` and
`data/google_config.json` when it finishes, but run it on a copy if you are
cautious.

## Status

This is a personal tool, built for one person's working habits, shared in case
it is useful. Beyond the suite above it has no tests, no migrations, and no
upgrade path — if you change the data formats, you are on your own. Fork it and
make it yours.

## Licence

MIT — see [LICENSE](LICENSE). Use it, change it, ship it; just keep the
copyright notice.
