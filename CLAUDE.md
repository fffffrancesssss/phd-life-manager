# PhD Life Manager

A local, single-user app for managing PhD work: calendar time-blocking synced
with Apple Calendar, to-dos, research ideas, projects with memos, a phone-free
focus timer, and a weekly recap.

Everything runs on this machine. No cloud service, no accounts, no framework.

## Running it

```bash
.venv/bin/python3 server.py      # then http://127.0.0.1:8765
```

**Use `.venv/bin/python3`, not system python** — `caldav` and `icalendar` live
in the venv. The system Python has neither.

The usual entry point is the Mac app at `~/Desktop/PhD Life Manager.app`, which
starts the server itself and shows the UI in a WKWebView.

- **UI changes (`public/*`) need no rebuild** — they are served live from disk;
  ⌘R in the app picks them up.
- **Changes to `mac/main.swift` need `mac/build.sh`.**

## Layout

| Path | What |
|---|---|
| `server.py` | Whole backend: stdlib HTTP server, CalDAV, Google Calendar. No framework. |
| `public/index.html` `app.js` `styles.css` | Whole frontend. Vanilla JS, no build step. |
| `mac/main.swift` `build.sh` | Native app shell (WKWebView + server lifecycle). |
| `data/` | All user data. Plain text wherever a human might read it. |

Data files: `todos.json`, `calendar.json`, `focus_sessions.json`,
`caldav_config.json` (holds the iCloud app-specific password — never commit or
print it), `caldav_cache.json` (last-known iCloud snapshot; disposable — delete
it and the app just paints a beat later),
`google_config.json` (OAuth client + refresh token — never commit or print it),
`google_cache.json` (same idea as the iCloud one),
`sync_config.json` (which service is selected), `ideas.txt` (all ideas, one delimited
file),
`projects/<slug>/project.json` + `memos/<id>.txt`,
`journal/weekly/<monday>.txt` and `journal/daily/<date>.txt`.

## iCloud CalDAV — the hard-won parts

These are all real failures that were diagnosed and fixed. Do not "simplify"
them away.

1. **`event_by_uid()` does not work against iCloud.** Apple returns
   `412 Precondition Failed` for the calendar-query REPORT that python-caldav
   issues. Events are therefore looked up by their **stored direct URL**
   (`icloudUrl`), captured at creation. `caldav_find_url_by_uid()` exists only
   to backfill records written before that.

2. **iCloud drops idle connections.** The client and calendar list are cached
   for speed, so the first request after a pause hits a dead socket. Every read
   and write retries **once** after `reset_caldav_cache()` — see
   `caldav_write()` and the `attempt()` retry in
   `caldav_fetch_events_with_status()`. Removing this brings back intermittent
   "can't sync to iCloud" warnings.

3. **CalDAV I/O is serialised** behind `_caldav_io_lock`. A page load fires
   several calendar requests at once; letting them share the cached session
   concurrently produced sporadic failures. Requests that queue behind another
   pick up the response it just cached.

4. **Never infer deletions from a failed fetch.** `reconcile_todos_calendar()`
   deletes local events that have vanished from iCloud. A fetch failure that
   returned "no events" would therefore wipe the calendar — this actually
   happened in testing (7 events → 0). `caldav_fetch_events_with_status()`
   reports *which calendars failed*, and reconcile aborts rather than
   proceeding. Keep that distinction between "nothing there" and "couldn't look".

5. **Moving an event between calendars is create-then-delete**, not an edit
   (`caldav_move_event`). If the delete fails, say so — otherwise you silently
   duplicate the event.

6. **`caldav_cache.json` is a display cache and nothing else.** It exists so a
   page load never waits on Apple: `?cached=1` on `/api/caldav/status`,
   `/calendars` and `/events` answers off disk without touching the network,
   and `prewarm_caldav()` refreshes it in a thread at server start. It must
   never reach `reconcile_todos_calendar()` — a stale snapshot standing in for
   a live read is exactly the "couldn't look" case in point 4.

## Calendar sync is one service at a time

`sync_config.json` holds `"none"`, `"icloud"` or `"google"`, and that single
value decides everything: which events are fetched, which reconciler runs, and
where a new block is written. It is not a UI preference — **the server reads it
when creating a block** (`route_events` POST) rather than trusting a flag from
the page, so a stale tab cannot write into an account the user has switched
away from.

Two services at once was considered and rejected. A block lives on exactly one
calendar; if both accounts could claim to be that calendar you get duplicated
events and a reconciler with no way to tell which side is authoritative.

Switching does not migrate anything. Blocks already synced keep their
`icloudUid`/`googleId` and keep updating wherever they were created — losing
that link would orphan the event on the far side.

`ensure_data()` migrates an install that predates the setting: if
`caldav_config.json` has credentials, the provider defaults to `icloud`, not
`none`. Getting this wrong silently switches off a working calendar on upgrade.

## Google Calendar — how it differs from iCloud

1. **OAuth only.** No app-specific passwords, so the user has to make their own
   OAuth client in the Google Cloud console. `google_auth_url()` uses PKCE and
   `prompt=consent` — without the latter Google only returns a refresh token
   the *first* time an account authorises a client, so reconnecting later would
   silently produce a connection that dies in an hour.

2. **The REST API, not the client library.** `google-api-python-client` drags
   in a large dependency tree for what is a handful of JSON requests. The whole
   integration is `urllib`, which keeps the standard-library-only rule.

3. **`google_api()` retries once after a 401**, refreshing the token first —
   the same shape as the CalDAV stale-socket retry, for the same reason: the
   token can expire between the check and the call.

4. **The CalDAV rules are repeated here on purpose.** I/O is serialised behind
   `_google_io_lock`; `google_fetch_events_with_status()` reports *which*
   calendars failed and `reconcile_google_blocks()` aborts rather than reading
   an unreadable calendar as an empty one; the disk cache is display-only.

5. **Moving between calendars is a real endpoint** (`google_move_event`), so
   unlike CalDAV it is not create-then-delete and cannot half-fail into a
   duplicate.

6. **`tests/test_google_stub.py` is the only way this gets tested.** There is
   no way to reach the live API without an account and a browser round trip, so
   the stub is where regressions get caught. Run it after touching any of this.

## Data model

- **Local events** (`calendar.json`) are the app's own blocks. They carry
  `calendarName`, optionally `todoId`, and — depending on where they were
  created — either `icloudUid`/`icloudUrl` or `googleId`/`googleCalendarId`.
  Never both: the field that is set is what decides where an edit is pushed.
- **External events** are everything else in iCloud. They have no local record
  and are **edited in place by URL** (`/api/caldav/event`), not adopted.
- **Events on the Todos calendar created in Apple Calendar** get adopted into
  `calendar.json` by `reconcile_todos_calendar()` so they become editable here.
- **A project link lives on the to-do**, never on the event. The event shows it
  by carrying the project code in its title (`MA: prep访谈`), which is what
  syncs to iCloud. The to-do keeps the *bare* text — the sidebar adds the code
  when rendering, so storing it in both places would render `MA: MA: …`.
  See `normalize_event_title()`.

## Frontend conventions

- **One `--accent` triple swapped per section** via `body[data-domain]`. Every
  component reads `--accent` / `--accent-soft` / `--accent-strong`, so no
  component knows about sections. Calendar indigo, ideas amber, projects teal,
  focus orange, journal violet.
- **All calendar block positioning goes through `calBlockGeometry()`**, which
  clamps to the visible hours. Without it, anything before 7am gets a negative
  offset and paints over the headers, and an overnight session overflows the
  grid. Both were live bugs.
- **Never animate a full-viewport element or a panel from `opacity: 0`.** Two
  separate "page flashes" traced to exactly this: a tab-panel entrance
  animation, and `backdrop-filter` plus default `animation-fill-mode` on the
  modal backdrop. Dialogs use a transform-only animation with `backwards` fill.
- **Calendar writes are optimistic; nothing on the grid waits for iCloud.**
  A drag, an edit or a delete is applied to local state and painted in the same
  frame, the request runs behind it, and a failure rolls the change back and
  says so in a toast (`alert()` would put the waiting straight back). Three
  things this has to keep straight, all in the "optimistic calendar writes"
  section of `app.js`: refreshes hold off while `calendarWritesPending()`, or
  they paint an old value over a new one; a block created here has no server id
  for a moment, so writes queue behind its create and the real id is written
  into the same object every closure already holds; and a server response is
  only adopted wholesale when it is the last write for that block.
- **Deleting a synced block also drops its copy in `externalEvents`.** The last
  pull from iCloud still lists it, and it was only hidden because a local record
  claimed its uid — remove the record alone and the block reappears in another
  colour, which reads as the delete having failed.
- **The page keeps itself current** (see the liveness section of `app.js`):
  now-line every 30s, data on refocus, background pull every 5min. Refreshes
  are skipped while a dialog is open or a block is being dragged.

## Working practice that has paid off here

- **Verify against the real app, not by reasoning.** Every fix in this project
  was reproduced first (browser console, injected clock, simulated failures)
  and re-verified after.
- **Test with throwaway data and clean it up.** The user's calendar, to-dos,
  ideas and journal are real. Create test events/ideas/recaps, verify, then
  delete them. Never leave test artefacts behind, and revert any change made
  purely to demonstrate a feature.
- **Check contrast numerically** when touching colours; several palette values
  were adjusted after measuring rather than eyeballing.
