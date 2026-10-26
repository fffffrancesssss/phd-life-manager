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
`projects/<slug>/project.json` + `memos/<id>.txt` (+ `memos/<folder>/<id>.txt`
for a memo filed into a folder),
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

**The page never decides whether a write should be attempted.** It sends
`syncToCalendar` when a provider is *selected*; whether the connection is
healthy is the server's call at the moment of writing, and it reports failure
back as `syncWarning`. `syncEnabled()` exists only for what the toolbar says
and which calendars the editor lists. This distinction is load-bearing: when
the page gated the request on a status fetched at launch, one transient iCloud
hiccup switched sync off for the whole session — every block made afterwards
was created locally with no attempt and no warning, and nothing re-checked
until the app restarted. `refreshLiveData()` now re-checks the status too.

**A block that never reached the calendar retries when it is edited**
(`route_events` PUT). Every other sync branch needs an `icloudUid`/`googleId`
to address, so without this a block that missed its one chance stayed
stranded for good.

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

## Focus time is summed by task name

`summarize_sessions()` groups by the session's *label*, not by what it was
linked to. The same piece of work gets blocked out several times in a week —
different calendar blocks, sometimes different to-dos — and reading that back
as four separate twenty-minute rows hides that it was an afternoon's work.
Names match exactly, give or take surrounding whitespace, so two genuinely
different tasks never merge.

Both readers of it benefit: "where the hours went" in the weekly recap (top
three) and the by-task list in the Focus summary (all of them).

## Project time is read off the session, and shown by the week

`summarize_projects()` credits a session to a project by the code at the
front of its label (`MA: …`, full-width colon included), and failing that
through the to-do it was started from — a to-do keeps the bare text, so its
label carries no code. Most timed blocks are made in Apple Calendar and
titled by hand, which is why the label comes first.

Over a week or longer an active project with nothing logged is listed at
zero, because that is the row worth seeing. **A single day leaves idle
projects out.** Projects are a weekly commitment here, not a daily one, and
"nothing logged" against a Tuesday would be a reproach for something that was
never the plan. Like the rest of the recap's evidence, none of it feeds the
score.

## "Later" is a flag on the to-do, set only by dragging

To-dos that are further off fold away under **Later** at the foot of the
sidebar (`later: true` in `todos.json`). Nothing moves there by age: how old
a to-do is says little about whether it still matters, and a list that
rearranges itself is one that stops being trusted.

1. **A to-do with a calendar block is never shown as later**
   (`isLaterTodo()`), and linking a block clears the flag on the server. It
   has a date, so hiding it would hide a commitment — and it must not drop
   back out of sight if that block is deleted afterwards.
2. **The whole Later fold is the drop target, and it is pinned while folded.**
   Under twenty to-dos, a target that has to be scrolled to is one nobody
   drags to. Open, it sits in the flow so its contents scroll.
3. **Moving is optimistic**, like a memo into a folder: repaint first,
   roll back with a toast if the server refuses. Drop targets check
   `draggingTodoId`, the mirror of `draggingMemoId`.
4. `.todo-fold-list[hidden]` needs its own `display: none` — `.todo-list`
   sets `display`, which outranks the attribute.
5. **Done to-dos collect under a Done fold by themselves**, in the sidebar
   and on a project's page, most recently finished first. This one *is*
   automatic, unlike Later: being finished is a fact, not a judgement. A
   done to-do is under Done even if it was "later". The two sidebar folds
   share one pinned footer (`.todo-folds.pinned`), which lets go as soon as
   either is opened. The fold is hidden outright while nothing is done.

## Memo folders are directories, and nothing else

A folder under a project is a real directory in `memos/`, recorded nowhere
else. The filesystem is the model: a folder made or renamed in Finder is one
the app shows, with its memos intact. Listing folders in `project.json` as
well would give two answers to the same question, and the one on disk is the
one the user can see.

One level deep. A memo is either loose in the project or in one of its
folders, which is exactly as much as a drag onto a folder can say.

1. **A memo's address is its id alone.** Ids are unique within a project, so
   `/api/projects/<slug>/memos/<id>` finds the file wherever it sits
   (`find_memo_path()`). Moving one is a rename, and nothing already holding
   that id — an open dialog, a queued save — has to be told.

2. **Folder names travel in the request body, never in the path.** Path
   segments are not URL-decoded in `_dispatch()`, and these names are spaces
   and Chinese as often as not. That is also why `API.del` takes a body.

3. **Deleting a folder moves its memos back into the project.** It never
   takes them with it, and it refuses rather than removing a directory
   something is still left in. Tidying is not a gesture that should be able
   to throw away what was written — the same rule as autosaved memos.

4. **No folder name is validated by parsing it.** `folder_dir()` matches
   against the directories actually sitting there, so a crafted `..` is
   simply not one of them and resolves to nothing. `clean_folder_name()`
   only has to make a *typed* name usable as a directory name.

## Data model

- **Local events** (`calendar.json`) are the app's own blocks. They carry
  `calendarName`, optionally `todoId`, and — depending on where they were
  created — either `icloudUid`/`icloudUrl` or `googleId`/`googleCalendarId`.
  Never both: the field that is set is what decides where an edit is pushed.
- **External events** are everything else in iCloud. They have no local record
  and are **edited in place by URL** (`/api/caldav/event`), not adopted.
- **Events on the Todos calendar created in Apple Calendar** get adopted into
  `calendar.json` by `reconcile_todos_calendar()` so they become editable here.
- **A block is linked to a project by the code in its title** (`MA: prep访谈`),
  which is what syncs to the calendar and what project time is counted from.
  Any event can be linked from its dialog — the app's own blocks, and events
  that live only in iCloud or Google, which are simply renamed in place.
  **Linking never creates a to-do.** It used to, and the field only showed on
  Todos-calendar blocks, so a block of time could not be filed under a
  project without also becoming an item on a list.
- **A block that came from a to-do is linked through the to-do instead**,
  and its title follows. The to-do keeps the *bare* text — the sidebar adds
  the code when rendering, so storing it in both places would render
  `MA: MA: …`. `normalize_event_title()` therefore only rewrites the title of
  a block that has a to-do; with none to consult, the code in the title is
  the link and is left exactly as it stands.
- **Linking a block carries its logged focus time with it**
  (`retag_sessions()`). A session's label is a snapshot taken when the timer
  started, so without this a block linked afterwards would be linked and its
  hours still uncounted. Only the code in front of each label is swapped —
  a plain rename leaves history alone. Sessions are matched by link id, and
  also by the block's name on the block's day, because moving a block
  between iCloud calendars gives it a new uid and strands the old link.

## Frontend conventions

- **One accent, muted indigo, for the whole app** (`--accent` #5059b0,
  `--accent-soft`, `--accent-strong`). Sections used to own a hue each,
  which tinted every screen and made none of it mean anything. The accent is
  kept for the active tab, the one filled button, claimed time on the
  calendar and focus bars. Everything else is Notion's neutrals on a white
  ground, with grey (`--pane`) only for the side pane. Bright, saturated
  blues read as dated here — that was the reason for the change.
- **The side pane follows the tab** (`.pane[data-pane]`, shown by
  `body[data-domain]`): to-dos beside the calendar, the idea composer and tag
  filter beside the ideas, the project list — or, inside a project, its
  to-dos (`body.project-open`) — beside projects, the timer beside its log,
  the week list beside the recap. Each pane holds the very elements that used
  to sit in the page, ids intact, so no handler had to learn where they went.
- **Tags and project codes take Notion's pastel pairs** (`.hue-0`…`.hue-8`),
  picked by `hueClass(name)` from the name itself so a tag is the same colour
  everywhere. Linked-idea chips stay neutral on purpose.
- **Calendar blocks:** the app's own blocks are solid in their chosen colour
  with white text; every other calendar is a faint, desaturated wash with a
  thin inset edge, so the time you claimed reads first. A legend above the
  grid names the calendars that have something on the week shown, and hides
  when there is nothing to tell apart. `COLORS` in `app.js`
  is a muted six, every one holding white at 4.5:1, and
  `BLOCK_COLOR_MIGRATION` in `server.py` maps both older palettes onto it.
- **Every text/background pair is measured, not eyeballed** — body and
  secondary text at 4.5:1, hues used as graphics or carrying white labels at
  3:1. `--ink-3` is pitched against the palest grey it sits on (#f1f1ef),
  not just against white.
- **No web fonts.** Avenir Next throughout, headings set semibold with tight
  tracking (`--font-display`). It ships with the OS. Headings once came from
  Google Fonts, which meant an outbound request on every launch of an app
  that otherwise touches nothing.
- **The calendar shows the whole day and scrolls inside itself.** `HOURS` is
  0–23; the grid used to stop at 7am–11pm, which quietly refused to hold an
  early start or a late night. The panel is a flex column filling the window,
  `.cal-scroll` is the scroller, and the page itself does not scroll on that
  tab — so the toolbar stays put and there is no slab of empty paper under a
  short grid. The scroller is `flex: 0 1 auto`, not `1 1 auto`: stretching it
  past the grid would put the dead space *inside* the frame instead.
- **Two things that grid depends on, both easy to undo by accident:**
  - `.calendar-grid` must not have `overflow: hidden`. It carried it to round
    its own corners, and any clipping ancestor between a `position: sticky`
    element and its scroller disables sticky — which silently scrolled the day
    headers away. The frame and radius now live on `.cal-scroll` instead.
  - `renderCalendarGrid()` saves and restores `scrollTop`. Emptying the grid
    collapses the scroller to nothing, so without this every optimistic write
    would throw the view back to midnight mid-drag.
- **A 24-hour grid has to open somewhere sensible.** `parkDayScroller()` puts
  it near now when today is on screen and at 7am otherwise. Parking it at 7am
  unconditionally would just rebuild the old window by another means.
- **All calendar block positioning goes through `calBlockGeometry()`**, which
  clamps to the visible hours. Without it a session that runs past midnight
  overflows the grid, and any hour outside the range paints over the headers —
  both were live bugs when the range was narrower, and the clamp is what keeps
  the focus grid honest too.
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
- **Dragging a memo into a folder is optimistic**, like a calendar write:
  the grid repaints in the same frame, and a move the server refuses rolls
  back with a toast. Two details it depends on — the drop highlight is
  cleared on `dragleave` only once the cursor has really left the card, or
  crossing into a child flickers it for the whole hover; and `dragend`
  sweeps up any highlight left painted by a drop that landed on nothing.
  To-dos are draggable too, so a drop target checks `draggingMemoId` rather
  than reading `dataTransfer`, which is unreadable during a drag anyway.
- **Deleting a synced block also drops its copy in `externalEvents`.** The last
  pull from iCloud still lists it, and it was only hidden because a local record
  claimed its uid — remove the record alone and the block reappears in another
  colour, which reads as the delete having failed.
- **Nothing typed is lost to a stray click.** Memos and ideas that already
  exist autosave as you type, so their dialogs have a Done button and no
  Cancel — with autosave there is nothing coherent for Cancel to mean. Things
  not yet created (the New memo dialog, the idea composer) keep a draft in
  `localStorage` and put it back when reopened. Two rules do the work:
  `closeModal()` flushes a save that is still counting down, and **clicking
  outside keeps the draft while only Cancel discards it** — the stray click is
  the accident being guarded against, so it must not be the gesture that
  throws work away.
- **`mdEditors` can hold a handle to a node that is no longer in the document.**
  Dialogs are rebuilt from scratch each time they open, so reading or writing
  through a stale handle silently does nothing — that is how a restored draft
  came back with its title but not its body. Go through `liveEditor()`, which
  checks `isConnected` and drops what is dead.
- **Markdown renders live, in the editing surface** (`attachLiveMarkdown()`).
  Memos, ideas and the recap columns are `contenteditable`, not `<textarea>` —
  a textarea cannot show styled text. **The element's text content is always
  exactly the markdown source**: nothing is parsed away, `**` merely gets
  dimmed (`.md-mark`), so what is saved is what was typed. `mdReadValue()` is
  the only way to read a field; there is no `.value`.
- **Three things the live editor has to respect**, each of which breaks it
  outright if removed:
  - **Repainting is skipped between `compositionstart` and `compositionend`.**
    Rebuilding the DOM mid-composition tears out the IME's preedit, and Chinese
    becomes impossible to type.
  - **It keeps its own undo stack.** Rewriting `innerHTML` throws away the
    browser's, so ⌘Z / ⇧⌘Z are handled here, coalescing runs of typing.
  - **The caret is tracked as a character offset into the source**, not as a
    DOM position, because the DOM is rebuilt underneath it.
- **`mdReadValue()` collects lines and joins them.** Appending a separator
  "if one is needed" silently swallows blank lines, because an empty line
  contributes no characters — that bug ate the blank line between every
  paragraph. A `<br>` inside a line is a soft break; a *trailing* `<br>` is the
  browser's placeholder for an empty block and is not text.
- **Every offset into the source is measured with `mdReadValue()`**, including
  both ends of a selection. `Range.toString()` drops the newlines between
  lines, so deriving the end from its length replaced one character too few on
  any selection spanning more than one line — quietly corrupting paste, ⌘B, ⌘I
  and ⌘L alike.
- **Paste falls back to `text/plain`, and only prefers the converted HTML when
  that conversion produced something.** `htmlClipboardToMarkdown()` used to
  walk block elements only, so a fragment copied from inside a paragraph — a
  bare `<span>`, a `<b>`, a table cell, Word's selection wrapper — converted to
  an empty string that was then pasted over the perfectly good plain text
  sitting beside it on the clipboard. That was "sometimes I can't paste".
- **Tab nests a list item, Shift-Tab lifts it back out** — two spaces a level,
  which is what the clipboard converter emits and what every renderer reads.
  Two things it has to respect: an item may only go *one* level deeper than
  the item above it (anything more is indented text that no renderer treats as
  a sub-list), and Tab is only intercepted on a list line, so the editor never
  traps the keyboard.
- **A nested item is padded by its depth** (`--md-depth` on the line, set in
  `mdLineDiv()`). The indent has to stay in the text because the text *is* the
  source, but two spaces on their own are far too faint to read as a level.
- **⌘B / ⌘I / ⌘U / ⌘L work in every markdown field**, and lists carry on by
  themselves on Enter, ending when you press it on an empty item. Markdown has
  no underline, so ⌘U writes `<u>…</u>` — what Bear and Obsidian do, and what
  the renderer already passes through.
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
