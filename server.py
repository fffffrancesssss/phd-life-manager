#!/usr/bin/env python3
"""
PhD Life Manager - local single-user web app.
Standard library only. Run with: python3 server.py
Then open http://127.0.0.1:8765 in a browser.

Data layout:
  data/todos.json              - list of todo items
  data/calendar.json           - list of scheduled time-block events
  data/ideas.txt                - all scattered research ideas, one text file
  data/projects/<slug>/project.json      - project title + basic info
  data/projects/<slug>/memos/<id>.txt    - one memo per file (plain text)
"""

import base64
import concurrent.futures
import hashlib
import http.server
import json
import os
import re
import shutil
import threading
import time
import uuid
import datetime
import urllib.error
import urllib.parse
import urllib.request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
PUBLIC_DIR = os.path.join(BASE_DIR, "public")
IDEAS_FILE = os.path.join(DATA_DIR, "ideas.txt")
CALENDAR_FILE = os.path.join(DATA_DIR, "calendar.json")
TODOS_FILE = os.path.join(DATA_DIR, "todos.json")
PROJECTS_DIR = os.path.join(DATA_DIR, "projects")
CALDAV_CONFIG_FILE = os.path.join(DATA_DIR, "caldav_config.json")
CALDAV_CACHE_FILE = os.path.join(DATA_DIR, "caldav_cache.json")
GOOGLE_CONFIG_FILE = os.path.join(DATA_DIR, "google_config.json")
GOOGLE_CACHE_FILE = os.path.join(DATA_DIR, "google_cache.json")
SYNC_CONFIG_FILE = os.path.join(DATA_DIR, "sync_config.json")
ICLOUD_CALDAV_URL = "https://caldav.icloud.com/"
FOCUS_SESSIONS_FILE = os.path.join(DATA_DIR, "focus_sessions.json")
JOURNAL_DIR = os.path.join(DATA_DIR, "journal")
JOURNAL_DAILY_DIR = os.path.join(JOURNAL_DIR, "daily")
JOURNAL_WEEKLY_DIR = os.path.join(JOURNAL_DIR, "weekly")

PORT = 8765

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


class ApiError(Exception):
    def __init__(self, message, code=400):
        super().__init__(message)
        self.code = code


# ---------------------------------------------------------------- utilities

def ensure_data():
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(PROJECTS_DIR, exist_ok=True)
    if not os.path.exists(IDEAS_FILE):
        open(IDEAS_FILE, "w", encoding="utf-8").close()
    if not os.path.exists(CALENDAR_FILE):
        save_json(CALENDAR_FILE, [])
    if not os.path.exists(TODOS_FILE):
        save_json(TODOS_FILE, [])
    if not os.path.exists(FOCUS_SESSIONS_FILE):
        save_json(FOCUS_SESSIONS_FILE, [])
    ensure_google_config()
    if not os.path.exists(SYNC_CONFIG_FILE):
        # Existing installs predate this setting and were, by definition,
        # either syncing with iCloud or not syncing at all. Defaulting to
        # "none" would quietly switch off a working calendar on upgrade.
        try:
            cfg = load_json(CALDAV_CONFIG_FILE)
            was_icloud = bool(cfg.get("icloud_username") and cfg.get("icloud_app_password"))
        except (OSError, ValueError):
            was_icloud = False
        save_json(SYNC_CONFIG_FILE, {"provider": "icloud" if was_icloud else "none"})
    os.makedirs(JOURNAL_DAILY_DIR, exist_ok=True)
    os.makedirs(JOURNAL_WEEKLY_DIR, exist_ok=True)


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def new_id(prefix):
    return f"{prefix}-{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}"


def now_iso():
    return datetime.datetime.now().isoformat(timespec="seconds")


def slugify(text):
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s or "project"


def derive_code(title):
    words = [w for w in re.split(r"\s+", title.strip()) if re.search(r"[A-Za-z0-9]", w)]
    if len(words) >= 2:
        code = "".join(w[0] for w in words[:4]).upper()
    else:
        code = re.sub(r"[^A-Za-z0-9]", "", title)[:4].upper()
    return code or "PRJ"


# --------------------------------------------------------- iCloud CalDAV
# Read-only view of all iCloud calendars, plus write access to a single
# named calendar ("Todos" by default) for routine time-blocks created here.

def ensure_caldav_config():
    if not os.path.exists(CALDAV_CONFIG_FILE):
        save_json(CALDAV_CONFIG_FILE, {
            "icloud_username": "",
            "icloud_app_password": "",
            "todos_calendar_name": "Todos",
        })


SYNC_PROVIDERS = ("none", "icloud", "google")


def sync_provider():
    """Which calendar service this app syncs with: "none", "icloud" or "google".

    Deliberately one at a time. A block lives on exactly one calendar, and
    letting two services both claim to be that calendar is how you end up with
    duplicated events and a reconciler that cannot tell which side is right.
    """
    try:
        value = load_json(SYNC_CONFIG_FILE).get("provider")
    except (OSError, ValueError):
        return "none"
    return value if value in SYNC_PROVIDERS else "none"


def set_sync_provider(value):
    if value not in SYNC_PROVIDERS:
        raise ApiError(f"Unknown sync provider: {value}", 400)
    save_json(SYNC_CONFIG_FILE, {"provider": value})
    return value


def load_caldav_config():
    ensure_caldav_config()
    return load_json(CALDAV_CONFIG_FILE)


def save_caldav_config(patch):
    cfg = load_caldav_config()
    if "icloud_username" in patch:
        cfg["icloud_username"] = patch["icloud_username"]
    if "todos_calendar_name" in patch:
        cfg["todos_calendar_name"] = patch["todos_calendar_name"] or "Todos"
    if patch.get("icloud_app_password"):
        cfg["icloud_app_password"] = patch["icloud_app_password"]
    save_json(CALDAV_CONFIG_FILE, cfg)
    # Everything remembered about iCloud was remembered about the old account.
    reset_caldav_cache()
    update_caldav_disk_cache({"status": {}, "calendars": [], "windows": {}})
    return cfg


def _caldav_module():
    try:
        import caldav
        return caldav
    except ImportError:
        raise ApiError(
            "The 'caldav' package isn't installed. Run: .venv/bin/pip install caldav icalendar", 500
        )


_caldav_lock = threading.Lock()
# One CalDAV conversation at a time. The page opens several calendar
# requests at once and they all share a single cached client/session;
# letting them overlap produced sporadic failures that looked like
# "can't sync to iCloud". Re-entrant so reconcile can read then write.
_caldav_io_lock = threading.RLock()
_caldav_cache = {"principal": None, "calendars": None, "cfg_signature": None}
_caldav_events_cache = {}  # (start_iso, end_iso) -> (fetched_at, events)
CALDAV_EVENTS_CACHE_TTL = 20  # seconds


# ------------------------------------------------- last-known iCloud, on disk
# The in-memory caches above are empty every time the server starts, so the
# first page load after launch used to sit and wait on iCloud — several
# seconds of empty calendar. A successful read is therefore also written to
# disk, and the "cached" routes serve it back instantly.
#
# This is a *display* cache and nothing else. reconcile_todos_calendar() must
# never see it: it deletes local events that are absent from iCloud, and a
# stale snapshot standing in for a live read is exactly the "couldn't look"
# case that once wiped the calendar. Only live fetches feed the reconciler.

_caldav_disk_lock = threading.Lock()
CALDAV_DISK_WINDOWS_KEPT = 8


def load_caldav_disk_cache():
    with _caldav_disk_lock:
        try:
            data = load_json(CALDAV_CACHE_FILE)
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}


def update_caldav_disk_cache(patch):
    with _caldav_disk_lock:
        try:
            data = load_json(CALDAV_CACHE_FILE)
            if not isinstance(data, dict):
                data = {}
        except (OSError, ValueError):
            data = {}
        data.update(patch)
        try:
            save_json(CALDAV_CACHE_FILE, data)
        except OSError:
            pass          # a cache that can't be written is not worth failing over


def remember_events_window(start_local, end_local, events, failed):
    """Keep the newest few windows; anything older is of no use to a first paint."""
    if failed:
        return            # a partial read would look like a complete one later
    data = load_caldav_disk_cache()
    windows = data.get("windows")
    windows = dict(windows) if isinstance(windows, dict) else {}
    windows[f"{dt_to_iso(start_local)}|{dt_to_iso(end_local)}"] = {
        "fetchedAt": time.time(),
        "events": events,
    }
    newest = sorted(windows.items(), key=lambda kv: kv[1].get("fetchedAt", 0), reverse=True)
    update_caldav_disk_cache({"windows": dict(newest[:CALDAV_DISK_WINDOWS_KEPT])})


def cached_events_window(start_local, end_local):
    """Events for this range as last read from iCloud, without touching the network.

    Returns (events, fetched_at), or (None, None) when nothing on record covers
    the range. A wider stored window counts as a hit — its events are filtered
    down — so a slightly shifted request still paints immediately.
    """
    best = None
    for key, entry in (load_caldav_disk_cache().get("windows") or {}).items():
        try:
            w_start, w_end = (datetime.datetime.fromisoformat(x) for x in key.split("|"))
        except (ValueError, AttributeError):
            continue
        if w_start > start_local or w_end < end_local:
            continue
        fetched = entry.get("fetchedAt", 0)
        if best is None or fetched > best[1]:
            best = (entry.get("events") or [], fetched)

    if best is None:
        return None, None
    return [e for e in best[0] if _event_overlaps(e, start_local, end_local)], best[1]


def _event_overlaps(event, start_local, end_local):
    try:
        s = datetime.datetime.fromisoformat(event["start"])
        e = datetime.datetime.fromisoformat(event["end"])
    except (KeyError, TypeError, ValueError):
        return False
    return not (e < start_local or s > end_local)


def get_caldav_principal():
    caldav = _caldav_module()
    cfg = load_caldav_config()
    if not cfg.get("icloud_username") or not cfg.get("icloud_app_password"):
        raise ApiError("iCloud isn't connected yet. Add your Apple ID and app-specific password in Calendar settings.", 400)
    sig = (cfg["icloud_username"], cfg["icloud_app_password"])
    with _caldav_lock:
        if _caldav_cache["principal"] is not None and _caldav_cache["cfg_signature"] == sig:
            return _caldav_cache["principal"], cfg
    with _caldav_io_lock:
        client = caldav.DAVClient(url=ICLOUD_CALDAV_URL, username=cfg["icloud_username"], password=cfg["icloud_app_password"])
        try:
            principal = client.principal()
        except Exception as e:
            raise ApiError(f"Could not connect to iCloud: {e}", 502)
    with _caldav_lock:
        _caldav_cache["principal"] = principal
        _caldav_cache["calendars"] = None
        _caldav_cache["cfg_signature"] = sig
    return principal, cfg


def get_caldav_calendars(principal):
    with _caldav_lock:
        if _caldav_cache["calendars"] is not None:
            return _caldav_cache["calendars"]
    with _caldav_io_lock:
        cals = principal.calendars()
    with _caldav_lock:
        _caldav_cache["calendars"] = cals
    return cals


def reset_caldav_cache():
    with _caldav_lock:
        _caldav_cache["principal"] = None
        _caldav_cache["calendars"] = None
        _caldav_cache["cfg_signature"] = None
        _caldav_events_cache.clear()


def invalidate_caldav_events_cache():
    with _caldav_lock:
        _caldav_events_cache.clear()


def find_todos_calendar(principal, cfg):
    name = (cfg.get("todos_calendar_name") or "Todos").strip().lower()
    try:
        cals = get_caldav_calendars(principal)
    except Exception as e:
        raise ApiError(f"Could not list iCloud calendars: {e}", 502)
    for cal in cals:
        if (cal.name or "").strip().lower() == name:
            return cal
    raise ApiError(f'No iCloud calendar named "{cfg.get("todos_calendar_name", "Todos")}" found. Create it in the Calendar app first.', 404)


def normalize_dt(dt):
    if isinstance(dt, datetime.datetime):
        if dt.tzinfo is not None:
            return dt.astimezone().replace(tzinfo=None)
        return dt
    if isinstance(dt, datetime.date):
        return datetime.datetime(dt.year, dt.month, dt.day)
    return dt


def dt_to_iso(dt):
    return dt.replace(microsecond=0).isoformat()


def _parse_vevents_from_obj(obj, cal_name, start_local, end_local):
    found = []
    try:
        comps = obj.icalendar_instance.walk("VEVENT")
    except Exception:
        return found
    try:
        obj_url = str(obj.url)
    except Exception:
        obj_url = None
    for comp in comps:
        try:
            uid = str(comp.get("uid"))
            summary = str(comp.get("summary", "Untitled"))
            dtstart = normalize_dt(comp.get("dtstart").dt)
            dtend_prop = comp.get("dtend")
            if dtend_prop is not None:
                dtend = normalize_dt(dtend_prop.dt)
            else:
                dur = comp.get("duration")
                dtend = dtstart + (dur.dt if dur else datetime.timedelta(hours=1))
            if dtend < start_local or dtstart > end_local:
                continue
            found.append({
                "uid": uid,
                "title": summary,
                "start": dt_to_iso(dtstart),
                "end": dt_to_iso(dtend),
                "calendar": cal_name,
                "url": obj_url,
            })
        except Exception:
            continue
    return found


def caldav_fetch_events_with_status(start_local, end_local):
    """Returns (events, failed_calendar_names).

    A calendar that errors out is reported rather than silently treated as
    empty — callers that draw conclusions from an absence of events (the
    reconciler) must be able to tell "nothing there" from "couldn't look".
    """
    start_q = (start_local - datetime.timedelta(days=1)).astimezone(datetime.timezone.utc)
    end_q = (end_local + datetime.timedelta(days=1)).astimezone(datetime.timezone.utc)
    cache_key = (start_q.isoformat(), end_q.isoformat())

    def cached_hit():
        with _caldav_lock:
            c = _caldav_events_cache.get(cache_key)
            return c if c and (time.time() - c[0]) < CALDAV_EVENTS_CACHE_TTL else None

    hit = cached_hit()
    if hit:
        return hit[1], hit[2]

    def attempt():
        principal, cfg = get_caldav_principal()
        try:
            cals = get_caldav_calendars(principal)
        except Exception as e:
            raise ApiError(f"Could not list iCloud calendars: {e}", 502)

        def fetch_one(cal):
            try:
                return cal, cal.date_search(start_q, end_q), None
            except Exception as e:
                return cal, [], e

        found, bad = [], set()
        if cals:
            with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, len(cals))) as executor:
                for cal, objs, err in executor.map(fetch_one, cals):
                    if err is not None:
                        bad.add((cal.name or "").strip().lower())
                        continue
                    for obj in objs:
                        found.extend(_parse_vevents_from_obj(obj, cal.name, start_local, end_local))
        return found, bad

    with _caldav_io_lock:
        # A request that queued behind another may find it already done.
        hit = cached_hit()
        if hit:
            return hit[1], hit[2]
        results, failed = attempt()
        if failed:
            # Same stale-connection case the writes hit: iCloud drops idle
            # sockets, so retry once against a fresh client before concluding
            # a calendar is unreadable.
            reset_caldav_cache()
            results, failed = attempt()

        with _caldav_lock:
            _caldav_events_cache[cache_key] = (time.time(), results, failed)
        remember_events_window(start_local, end_local, results, failed)
        return results, failed


def caldav_fetch_events(start_local, end_local):
    return caldav_fetch_events_with_status(start_local, end_local)[0]


def reconcile_todos_calendar(start_local, end_local):
    """Pull changes made in the Apple 'Todos' calendar back into the local store.

    Events edited there are updated here, ones created there are adopted so
    they stay editable in the app, and ones deleted there are dropped here.
    Only events inside the given window are considered, so an event outside
    it is never mistaken for a deletion. Recurring events are left alone —
    the local model holds single blocks only.
    """
    principal, cfg = get_caldav_principal()
    cal = find_todos_calendar(principal, cfg)
    cal_name = (cal.name or "").strip().lower()

    remote_events, failed = caldav_fetch_events_with_status(start_local, end_local)
    if cal_name in failed:
        # Reading the calendar failed. An empty result here would otherwise
        # look identical to "everything was deleted in Apple Calendar" and
        # wipe the local copies, so bail out and change nothing.
        raise ApiError(
            f'Could not read the iCloud "{cal.name}" calendar just now, so nothing was synced. '
            "Your events are unchanged; this will retry on the next refresh.", 502)

    by_uid = {}
    for ev in remote_events:
        if (ev.get("calendar") or "").strip().lower() != cal_name:
            continue
        by_uid.setdefault(ev["uid"], []).append(ev)
    # A uid with several instances in the window is a recurring event.
    remote = {uid: evs[0] for uid, evs in by_uid.items() if len(evs) == 1}
    recurring_uids = {uid for uid, evs in by_uid.items() if len(evs) > 1}

    events = load_json(CALENDAR_FILE)
    adopted = updated = removed = 0
    kept = []
    seen_uids = set()

    for e in events:
        uid = e.get("icloudUid")
        if not uid:
            kept.append(e)
            continue
        seen_uids.add(uid)
        if uid in recurring_uids:
            kept.append(e)
            continue
        if uid in remote:
            r = remote[uid]
            if e.get("title") != r["title"] or e.get("start") != r["start"] or e.get("end") != r["end"]:
                e["title"], e["start"], e["end"] = r["title"], r["start"], r["end"]
                updated += 1
            if r.get("url") and e.get("icloudUrl") != r["url"]:
                e["icloudUrl"] = r["url"]
            kept.append(e)
            continue
        # Not on iCloud any more. Only treat as deleted if it sat in the
        # window we actually looked at.
        try:
            e_start = datetime.datetime.fromisoformat(e["start"])
        except (KeyError, ValueError):
            kept.append(e)
            continue
        if start_local <= e_start <= end_local:
            removed += 1
        else:
            kept.append(e)

    for uid, r in remote.items():
        if uid in seen_uids:
            continue
        kept.append({
            "id": new_id("evt"),
            "title": r["title"],
            "start": r["start"],
            "end": r["end"],
            "color": "#5b7fd6",
            "todoId": None,
            "type": "block",
            "icloudUid": uid,
            "icloudUrl": r.get("url"),
            "calendarName": cal.name,
        })
        adopted += 1

    changed = bool(adopted or updated or removed)
    if changed:
        save_json(CALENDAR_FILE, kept)
        if removed:
            todos = load_json(TODOS_FILE)
            live_ids = {e["id"] for e in kept}
            touched = False
            for t in todos:
                if t.get("eventId") and t["eventId"] not in live_ids:
                    t["eventId"] = None
                    touched = True
            if touched:
                save_json(TODOS_FILE, todos)

    return {"changed": changed, "adopted": adopted, "updated": updated, "removed": removed, "events": kept}


def find_calendar_by_name(principal, cfg, name=None):
    """Any writable calendar by display name; falls back to the Todos one."""
    if not name:
        return find_todos_calendar(principal, cfg)
    wanted = name.strip().lower()
    try:
        cals = get_caldav_calendars(principal)
    except Exception as e:
        raise ApiError(f"Could not list iCloud calendars: {e}", 502)
    for cal in cals:
        if (cal.name or "").strip().lower() == wanted:
            return cal
    raise ApiError(f'No iCloud calendar named "{name}" found.', 404)


def list_writable_calendars():
    principal, cfg = get_caldav_principal()
    try:
        cals = get_caldav_calendars(principal)
    except Exception as e:
        raise ApiError(f"Could not list iCloud calendars: {e}", 502)
    default = (cfg.get("todos_calendar_name") or "Todos").strip().lower()
    out = []
    for cal in cals:
        nm = (cal.name or "").strip()
        if nm:
            out.append({"name": nm, "isDefault": nm.lower() == default})
    out = sorted(out, key=lambda c: (not c["isDefault"], c["name"].lower()))
    update_caldav_disk_cache({"calendars": out})
    return out


def cached_writable_calendars():
    """The calendar list as last seen, so the event editor can be built at once."""
    cals = load_caldav_disk_cache().get("calendars")
    return cals if isinstance(cals, list) else []


def caldav_status(live=True):
    """Whether iCloud is connected and the routine calendar exists.

    `live` asks iCloud, which costs a round trip. Without it the last known
    answer is served from disk, so opening the app never waits on the network
    to know what to draw. The live check refreshes what is remembered.
    """
    cfg = load_caldav_config()
    configured = bool(cfg.get("icloud_username") and cfg.get("icloud_app_password"))
    todos_name = cfg.get("todos_calendar_name", "Todos")
    result = {
        "configured": configured,
        "icloudUsername": cfg.get("icloud_username", ""),
        "todosCalendarName": todos_name,
        "connected": False,
        "todosCalendarFound": False,
        "error": None,
    }
    if not configured:
        return result

    if not live:
        remembered = load_caldav_disk_cache().get("status") or {}
        # The routine calendar may have been renamed in settings since this was
        # written, in which case the old verdict says nothing about the new name.
        if remembered.get("todosCalendarName") == todos_name:
            result["connected"] = bool(remembered.get("connected"))
            result["todosCalendarFound"] = bool(remembered.get("todosCalendarFound"))
        result["cached"] = True
        return result

    try:
        principal, cfg2 = get_caldav_principal()
        result["connected"] = True
        try:
            find_todos_calendar(principal, cfg2)
            result["todosCalendarFound"] = True
        except ApiError as e:
            result["error"] = str(e)
    except ApiError as e:
        result["error"] = str(e)
    update_caldav_disk_cache({"status": {
        "connected": result["connected"],
        "todosCalendarFound": result["todosCalendarFound"],
        "todosCalendarName": todos_name,
    }})
    return result


def caldav_write(op, what):
    """Run a CalDAV write, refreshing a stale connection once first.

    The client and calendar list are cached so the calendar loads quickly,
    but iCloud closes idle connections — which surfaced as intermittent
    "could not sync" warnings on the first save after a pause. A failed
    attempt is retried against a fresh connection before being reported.
    """
    with _caldav_io_lock:
        try:
            return op()
        except Exception:
            reset_caldav_cache()
            try:
                return op()
            except Exception as e:
                raise ApiError(f"Could not {what} iCloud event: {e}", 502)


def caldav_create_event(title, start_iso, end_iso, uid=None, calendar_name=None):
    start_dt = datetime.datetime.fromisoformat(start_iso)
    end_dt = datetime.datetime.fromisoformat(end_iso)
    new_uid = uid or str(uuid.uuid4())

    def op():
        principal, cfg = get_caldav_principal()
        cal = find_calendar_by_name(principal, cfg, calendar_name)
        return cal.save_event(dtstart=start_dt, dtend=end_dt, summary=title, uid=new_uid)

    ev = caldav_write(op, "create")
    invalidate_caldav_events_cache()
    return new_uid, str(ev.url)


# NOTE: iCloud's CalDAV server returns "412 Precondition Failed" on the
# calendar-query REPORT that caldav's event_by_uid()/object_by_uid() issue,
# so events are looked up by their stored direct URL instead of by UID.

def _caldav_event_by_url(cal, url):
    caldav = _caldav_module()
    ev = caldav.Event(client=cal.client, url=url, parent=cal)
    ev.load()
    return ev


def caldav_update_event(url, title, start_iso, end_iso, calendar_name=None):
    """Edit an event in place on whichever calendar currently holds it.

    Moving between calendars is not a CalDAV edit — it means writing the
    event into the target collection and removing the original — so the
    caller gets back the new url/uid when that happens.
    """
    def op():
        principal, cfg = get_caldav_principal()
        cal = find_calendar_by_name(principal, cfg, calendar_name)
        ev = _caldav_event_by_url(cal, url)
        comp = ev.icalendar_component
        comp.pop("dtstart", None)
        comp.pop("dtend", None)
        comp.pop("summary", None)
        comp.add("dtstart", datetime.datetime.fromisoformat(start_iso))
        comp.add("dtend", datetime.datetime.fromisoformat(end_iso))
        comp.add("summary", title)
        ev.save()
        return {"url": str(ev.url), "uid": str(comp.get("uid"))}

    res = caldav_write(op, "update")
    invalidate_caldav_events_cache()
    return res


def caldav_move_event(url, title, start_iso, end_iso, from_calendar, to_calendar):
    """Recreate on the target calendar, then drop the original."""
    uid, new_url = caldav_create_event(title, start_iso, end_iso, calendar_name=to_calendar)
    try:
        caldav_delete_event(url, calendar_name=from_calendar)
    except ApiError:
        # The copy landed; leaving the original would duplicate it, so say so.
        raise ApiError("Event was copied to the new calendar, but the original could not be removed.", 502)
    return {"url": new_url, "uid": uid}


def caldav_find_url_by_uid(uid):
    """Backfill helper for events synced before icloudUrl was stored."""
    principal, cfg = get_caldav_principal()
    cal = find_todos_calendar(principal, cfg)
    try:
        for ev in cal.events():
            try:
                comps = ev.icalendar_instance.walk("VEVENT")
            except Exception:
                continue
            for comp in comps:
                if str(comp.get("uid")) == uid:
                    return str(ev.url)
    except Exception as e:
        raise ApiError(f"Could not look up iCloud event: {e}", 502)
    return None


def caldav_delete_event(url, calendar_name=None):
    def op():
        principal, cfg = get_caldav_principal()
        cal = find_calendar_by_name(principal, cfg, calendar_name)
        caldav = _caldav_module()
        caldav.Event(client=cal.client, url=url, parent=cal).delete()

    caldav_write(op, "delete")
    invalidate_caldav_events_cache()


# ------------------------------------------------------------- ideas.txt IO
# Ideas are stored as delimited blocks in one text file so the whole thing
# stays a plain, greppable .txt document.

IDEA_RE = re.compile(r"<<<IDEA (.*?)>>>\n(.*?)\n<<<END>>>\n?", re.DOTALL)
ATTR_RE = re.compile(r'(\w+)="([^"]*)"')


# ===========================================================================
# Google Calendar
#
# The second calendar this app can sync with. It works differently from
# iCloud in one way that shapes everything below: Google has no app-specific
# passwords, so there is no username/password to store. Access is OAuth 2.0
# only, which means a one-time browser round trip and a refresh token that
# has to be spent for a short-lived access token before every call.
#
# Deliberately not using google-api-python-client: it drags in a large
# dependency tree for what is, over the REST API, a handful of JSON requests
# that urllib can make. The app stays standard-library-only.
#
# The hard-won CalDAV rules apply here too and are repeated on purpose:
#   · Google I/O is serialised behind a lock, because a page load fires
#     several calendar requests at once.
#   · A failed fetch is never read as "everything was deleted" — see
#     google_fetch_events_with_status() and reconcile_google_blocks().
#   · Reads are cached to disk so a page load never waits on the network.

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_API_BASE = "https://www.googleapis.com/calendar/v3"
GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar"
GOOGLE_EVENTS_CACHE_TTL = 20  # seconds, matching the CalDAV one

_google_lock = threading.Lock()
# One conversation with Google at a time, for the same reason CalDAV has one.
_google_io_lock = threading.RLock()
_google_events_cache = {}      # (start_iso, end_iso) -> (fetched_at, events, failed)
_google_pending_auth = {}      # state -> code_verifier, for the callback to match


def ensure_google_config():
    if not os.path.exists(GOOGLE_CONFIG_FILE):
        save_json(GOOGLE_CONFIG_FILE, {
            "client_id": "",
            "client_secret": "",
            "refresh_token": "",
            "access_token": "",
            "access_token_expires": 0,
            "blocks_calendar_id": "",
            "blocks_calendar_name": "",
        })


def load_google_config():
    ensure_google_config()
    return load_json(GOOGLE_CONFIG_FILE)


def save_google_config(patch):
    cfg = load_google_config()
    cfg.update(patch)
    save_json(GOOGLE_CONFIG_FILE, cfg)
    return cfg


def google_redirect_uri():
    return f"http://127.0.0.1:{PORT}/api/google/callback"


def reset_google_cache():
    with _google_lock:
        _google_events_cache.clear()


# ---------------------------------------------------------------- transport

def _http_json(url, data=None, headers=None, method=None, form=False):
    """One JSON request. Raises ApiError with Google's own message on failure."""
    body = None
    hdrs = dict(headers or {})
    if data is not None:
        if form:
            body = urllib.parse.urlencode(data).encode()
            hdrs["Content-Type"] = "application/x-www-form-urlencoded"
        else:
            body = json.dumps(data).encode()
            hdrs["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=hdrs, method=method or ("POST" if body else "GET"))
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            payload = json.loads(e.read())
            detail = (payload.get("error", {}) or {}).get("message") \
                or payload.get("error_description") or payload.get("error") or ""
        except Exception:
            pass
        raise ApiError(f"Google refused the request ({e.code})"
                       + (f": {detail}" if detail else ""), 502)
    except urllib.error.URLError as e:
        raise ApiError(f"Could not reach Google: {e.reason}", 502)


def google_access_token(force_refresh=False):
    """A valid access token, refreshing it if it has expired or is about to.

    Tokens last an hour; refreshing a minute early avoids losing a request to
    a token that expires mid-flight.
    """
    cfg = load_google_config()
    if not cfg.get("client_id") or not cfg.get("client_secret"):
        raise ApiError("Google isn't set up yet. Add your OAuth client ID and secret in Calendar settings.", 400)
    if not cfg.get("refresh_token"):
        raise ApiError("Google isn't connected yet. Click Connect in Calendar settings.", 400)

    if not force_refresh and cfg.get("access_token") and time.time() < (cfg.get("access_token_expires") or 0) - 60:
        return cfg["access_token"]

    with _google_io_lock:
        cfg = load_google_config()      # another thread may have just refreshed it
        if not force_refresh and cfg.get("access_token") and time.time() < (cfg.get("access_token_expires") or 0) - 60:
            return cfg["access_token"]
        payload = _http_json(GOOGLE_TOKEN_URL, {
            "client_id": cfg["client_id"],
            "client_secret": cfg["client_secret"],
            "refresh_token": cfg["refresh_token"],
            "grant_type": "refresh_token",
        }, form=True)
        token = payload.get("access_token")
        if not token:
            raise ApiError("Google did not return an access token. Try disconnecting and connecting again.", 502)
        save_google_config({
            "access_token": token,
            "access_token_expires": time.time() + int(payload.get("expires_in", 3600)),
        })
        return token


def google_api(path, data=None, method=None, params=None):
    """A Calendar API call, retrying once on 401 with a fresh token.

    An access token can be revoked or expire between the check and the call;
    one retry turns that into a hiccup rather than an error the user sees.
    """
    url = f"{GOOGLE_API_BASE}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)

    def attempt(force):
        token = google_access_token(force_refresh=force)
        return _http_json(url, data=data, method=method,
                          headers={"Authorization": f"Bearer {token}"})

    with _google_io_lock:
        try:
            return attempt(False)
        except ApiError as e:
            if "(401)" not in str(e):
                raise
            return attempt(True)


# ---------------------------------------------------------------- oauth flow

def google_auth_url():
    """The consent URL to send the browser to, plus the state that matches it.

    PKCE is used even though this is a loopback client: it costs nothing and
    means an intercepted authorization code is useless on its own.
    """
    cfg = load_google_config()
    if not cfg.get("client_id") or not cfg.get("client_secret"):
        raise ApiError("Add your Google OAuth client ID and secret first.", 400)
    verifier = base64.urlsafe_b64encode(os.urandom(64)).decode().rstrip("=")
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    state = uuid.uuid4().hex
    with _google_lock:
        _google_pending_auth.clear()      # only one sign-in can be in flight
        _google_pending_auth[state] = verifier
    query = urllib.parse.urlencode({
        "client_id": cfg["client_id"],
        "redirect_uri": google_redirect_uri(),
        "response_type": "code",
        "scope": GOOGLE_SCOPE,
        "access_type": "offline",
        # Without this Google only returns a refresh token the very first
        # time an account authorises the client, so reconnecting later would
        # silently produce a connection that dies in an hour.
        "prompt": "consent",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    })
    return f"{GOOGLE_AUTH_URL}?{query}"


def google_exchange_code(code, state):
    with _google_lock:
        verifier = _google_pending_auth.pop(state, None)
    if not verifier:
        raise ApiError("That sign-in link has expired or was not started here. Try connecting again.", 400)
    cfg = load_google_config()
    payload = _http_json(GOOGLE_TOKEN_URL, {
        "client_id": cfg["client_id"],
        "client_secret": cfg["client_secret"],
        "code": code,
        "code_verifier": verifier,
        "grant_type": "authorization_code",
        "redirect_uri": google_redirect_uri(),
    }, form=True)
    if not payload.get("refresh_token"):
        raise ApiError("Google did not return a refresh token. Remove this app at "
                       "myaccount.google.com/permissions and connect again.", 502)
    save_google_config({
        "refresh_token": payload["refresh_token"],
        "access_token": payload.get("access_token", ""),
        "access_token_expires": time.time() + int(payload.get("expires_in", 3600)),
    })
    reset_google_cache()


def google_disconnect():
    """Forget the tokens. The client id and secret stay, so reconnecting is
    one click rather than a trip back to the Google console."""
    save_google_config({"refresh_token": "", "access_token": "", "access_token_expires": 0})
    reset_google_cache()
    update_google_disk_cache({"status": {}, "calendars": [], "windows": {}})


# ---------------------------------------------------------------- disk cache

_google_disk_lock = threading.Lock()


def load_google_disk_cache():
    with _google_disk_lock:
        try:
            data = load_json(GOOGLE_CACHE_FILE)
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}


def update_google_disk_cache(patch):
    with _google_disk_lock:
        try:
            data = load_json(GOOGLE_CACHE_FILE)
            if not isinstance(data, dict):
                data = {}
        except (OSError, ValueError):
            data = {}
        data.update(patch)
        try:
            save_json(GOOGLE_CACHE_FILE, data)
        except OSError:
            pass


def remember_google_window(start_local, end_local, events, failed):
    if failed:
        return          # a partial read must not be replayed as a complete one
    data = load_google_disk_cache()
    windows = data.get("windows")
    windows = dict(windows) if isinstance(windows, dict) else {}
    windows[f"{dt_to_iso(start_local)}|{dt_to_iso(end_local)}"] = {
        "fetchedAt": time.time(), "events": events,
    }
    newest = sorted(windows.items(), key=lambda kv: kv[1].get("fetchedAt", 0), reverse=True)
    update_google_disk_cache({"windows": dict(newest[:CALDAV_DISK_WINDOWS_KEPT])})


def cached_google_window(start_local, end_local):
    best = None
    for key, entry in (load_google_disk_cache().get("windows") or {}).items():
        try:
            w_start, w_end = (datetime.datetime.fromisoformat(x) for x in key.split("|"))
        except (ValueError, AttributeError):
            continue
        if w_start > start_local or w_end < end_local:
            continue
        fetched = entry.get("fetchedAt", 0)
        if best is None or fetched > best[1]:
            best = (entry.get("events") or [], fetched)
    if best is None:
        return None, None
    return [e for e in best[0] if _event_overlaps(e, start_local, end_local)], best[1]


# ---------------------------------------------------------------- times

def google_parse_dt(node):
    """A Google start/end object to a local naive datetime.

    Timed events carry an offset; all-day events carry a bare date, which is
    treated as midnight so it lands on the grid like everything else.
    """
    if not node:
        return None
    raw = node.get("dateTime")
    if raw:
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        return normalize_dt(datetime.datetime.fromisoformat(raw))
    day = node.get("date")
    if day:
        d = datetime.date.fromisoformat(day)
        return datetime.datetime(d.year, d.month, d.day)
    return None


def google_dt_payload(local_iso):
    """Local wall-clock ISO to what the API wants: the same instant with this
    machine's UTC offset attached, so Google stores the time meant rather than
    guessing a zone."""
    dt = datetime.datetime.fromisoformat(local_iso)
    return {"dateTime": dt.astimezone().isoformat()}


# ---------------------------------------------------------------- reading

def google_list_calendars():
    payload = google_api("/users/me/calendarList", params={"maxResults": 250})
    out = []
    for item in payload.get("items", []):
        if item.get("deleted"):
            continue
        out.append({
            "id": item.get("id"),
            "name": item.get("summaryOverride") or item.get("summary") or item.get("id"),
            "primary": bool(item.get("primary")),
            # owner/writer can be written to; reader/freeBusyReader cannot.
            "writable": item.get("accessRole") in ("owner", "writer"),
        })
    out.sort(key=lambda c: (not c["primary"], c["name"].lower()))
    update_google_disk_cache({"calendars": out})
    return out


def cached_google_calendars():
    cals = load_google_disk_cache().get("calendars")
    return cals if isinstance(cals, list) else []


def google_fetch_events_with_status(start_local, end_local):
    """Returns (events, failed_calendar_names).

    Same contract as the CalDAV version, and for the same reason: a caller
    that concludes anything from an absence of events has to be able to tell
    "nothing there" from "couldn't look".
    """
    cache_key = (dt_to_iso(start_local), dt_to_iso(end_local))

    def cached_hit():
        with _google_lock:
            c = _google_events_cache.get(cache_key)
            return c if c and (time.time() - c[0]) < GOOGLE_EVENTS_CACHE_TTL else None

    hit = cached_hit()
    if hit:
        return hit[1], hit[2]

    with _google_io_lock:
        hit = cached_hit()
        if hit:
            return hit[1], hit[2]

        try:
            calendars = google_list_calendars()
        except ApiError as e:
            raise ApiError(f"Could not list Google calendars: {e}", 502)

        time_min = start_local.astimezone().isoformat()
        time_max = end_local.astimezone().isoformat()
        found, failed = [], set()
        for cal in calendars:
            try:
                page_token, guard = None, 0
                while True:
                    params = {
                        "timeMin": time_min, "timeMax": time_max,
                        "singleEvents": "true", "orderBy": "startTime", "maxResults": 250,
                    }
                    if page_token:
                        params["pageToken"] = page_token
                    payload = google_api(f"/calendars/{urllib.parse.quote(cal['id'], safe='')}/events",
                                         params=params)
                    for item in payload.get("items", []):
                        if item.get("status") == "cancelled":
                            continue
                        s = google_parse_dt(item.get("start"))
                        e = google_parse_dt(item.get("end"))
                        if not s or not e:
                            continue
                        found.append({
                            "uid": item.get("id"),
                            "title": item.get("summary") or "Untitled",
                            "start": dt_to_iso(s),
                            "end": dt_to_iso(e),
                            "calendar": cal["name"],
                            "calendarId": cal["id"],
                            "url": item.get("id"),      # what an edit is addressed by
                            "provider": "google",
                            "writable": cal["writable"],
                        })
                    page_token = payload.get("nextPageToken")
                    guard += 1
                    if not page_token or guard > 20:
                        break
            except ApiError:
                failed.add(cal["name"])
                continue

        with _google_lock:
            _google_events_cache[cache_key] = (time.time(), found, failed)
        remember_google_window(start_local, end_local, found, failed)
        return found, failed


def google_fetch_events(start_local, end_local):
    return google_fetch_events_with_status(start_local, end_local)[0]


def google_status(live=True):
    """Whether Google is set up, connected, and has a calendar to write to."""
    cfg = load_google_config()
    configured = bool(cfg.get("client_id") and cfg.get("client_secret"))
    result = {
        "configured": configured,
        "connected": bool(cfg.get("refresh_token")),
        "blocksCalendarId": cfg.get("blocks_calendar_id", ""),
        "blocksCalendarName": cfg.get("blocks_calendar_name", ""),
        "blocksCalendarFound": False,
        "redirectUri": google_redirect_uri(),
        "error": None,
    }
    if not (configured and result["connected"]):
        return result

    if not live:
        remembered = load_google_disk_cache().get("status") or {}
        result["blocksCalendarFound"] = bool(remembered.get("blocksCalendarFound")) \
            and remembered.get("blocksCalendarId") == result["blocksCalendarId"]
        result["cached"] = True
        return result

    try:
        cals = google_list_calendars()
        wanted = result["blocksCalendarId"]
        match = next((c for c in cals if c["id"] == wanted), None)
        if match and match["writable"]:
            result["blocksCalendarFound"] = True
            result["blocksCalendarName"] = match["name"]
        elif wanted and not match:
            result["error"] = "The calendar this app writes to is no longer in your Google account."
        elif match:
            result["error"] = f'You only have read access to "{match["name"]}".'
    except ApiError as e:
        result["connected"] = False
        result["error"] = str(e)

    update_google_disk_cache({"status": {
        "blocksCalendarFound": result["blocksCalendarFound"],
        "blocksCalendarId": result["blocksCalendarId"],
    }})
    return result


# ---------------------------------------------------------------- writing

def google_blocks_calendar_id():
    cfg = load_google_config()
    cal_id = cfg.get("blocks_calendar_id")
    if not cal_id:
        raise ApiError("No Google calendar is chosen for this app's blocks yet.", 400)
    return cal_id


def google_create_event(title, start_iso, end_iso, calendar_id=None):
    cal_id = calendar_id or google_blocks_calendar_id()
    payload = google_api(f"/calendars/{urllib.parse.quote(cal_id, safe='')}/events",
                         data={"summary": title,
                               "start": google_dt_payload(start_iso),
                               "end": google_dt_payload(end_iso)},
                         method="POST")
    reset_google_cache()
    return payload.get("id"), cal_id


def google_update_event(event_id, title, start_iso, end_iso, calendar_id):
    google_api(f"/calendars/{urllib.parse.quote(calendar_id, safe='')}/events/{urllib.parse.quote(event_id, safe='')}",
               data={"summary": title,
                     "start": google_dt_payload(start_iso),
                     "end": google_dt_payload(end_iso)},
               method="PATCH")
    reset_google_cache()


def google_delete_event(event_id, calendar_id):
    try:
        google_api(f"/calendars/{urllib.parse.quote(calendar_id, safe='')}/events/{urllib.parse.quote(event_id, safe='')}",
                   method="DELETE")
    except ApiError as e:
        # Already gone is the outcome we wanted.
        if "(404)" not in str(e) and "(410)" not in str(e):
            raise
    reset_google_cache()


def google_move_event(event_id, from_calendar, to_calendar):
    """Google has a real move endpoint, so unlike CalDAV this is not a
    create-then-delete and cannot half-fail into a duplicate."""
    payload = google_api(
        f"/calendars/{urllib.parse.quote(from_calendar, safe='')}/events/{urllib.parse.quote(event_id, safe='')}/move",
        params={"destination": to_calendar}, method="POST")
    reset_google_cache()
    return payload.get("id") or event_id


# ---------------------------------------------------------------- reconcile

def reconcile_google_blocks(start_local, end_local):
    """Pull changes made in Google back into the local store.

    Mirrors reconcile_todos_calendar(), including the rule that matters most:
    a calendar that could not be read is never treated as a calendar with
    nothing in it. Only events on the app's own blocks calendar are touched;
    everything else in the account is displayed but never adopted.
    """
    cfg = load_google_config()
    cal_id = cfg.get("blocks_calendar_id")
    if not cal_id:
        return {"changed": False, "adopted": 0, "updated": 0, "removed": 0,
                "events": load_json(CALENDAR_FILE)}

    remote_events, failed = google_fetch_events_with_status(start_local, end_local)
    cal_name = cfg.get("blocks_calendar_name") or ""
    if cal_name in failed:
        raise ApiError(
            f'Could not read the Google "{cal_name}" calendar just now, so nothing was synced. '
            "Your events are unchanged; this will retry on the next refresh.", 502)

    by_id = {}
    for ev in remote_events:
        if ev.get("calendarId") != cal_id:
            continue
        by_id.setdefault(ev["uid"], []).append(ev)
    # An id appearing more than once in the window is a recurring event; the
    # local model holds single blocks only, so those are left alone.
    remote = {k: v[0] for k, v in by_id.items() if len(v) == 1}
    recurring = {k for k, v in by_id.items() if len(v) > 1}

    events = load_json(CALENDAR_FILE)
    adopted = updated = removed = 0
    kept, seen = [], set()

    for e in events:
        gid = e.get("googleId")
        if not gid:
            kept.append(e)
            continue
        seen.add(gid)
        if gid in recurring:
            kept.append(e)
            continue
        if gid in remote:
            r = remote[gid]
            if e.get("title") != r["title"] or e.get("start") != r["start"] or e.get("end") != r["end"]:
                e["title"], e["start"], e["end"] = r["title"], r["start"], r["end"]
                updated += 1
            kept.append(e)
            continue
        try:
            e_start = datetime.datetime.fromisoformat(e["start"])
        except (KeyError, ValueError):
            kept.append(e)
            continue
        if start_local <= e_start <= end_local:
            removed += 1
        else:
            kept.append(e)

    for gid, r in remote.items():
        if gid in seen:
            continue
        kept.append({
            "id": new_id("evt"),
            "title": r["title"], "start": r["start"], "end": r["end"],
            "color": "#5b7fd6", "todoId": None, "type": "block",
            "icloudUid": None, "icloudUrl": None,
            "googleId": gid, "googleCalendarId": cal_id,
            "calendarName": r["calendar"],
        })
        adopted += 1

    changed = bool(adopted or updated or removed)
    if changed:
        save_json(CALENDAR_FILE, kept)
        if removed:
            todos = load_json(TODOS_FILE)
            live = {e["id"] for e in kept}
            touched = False
            for t in todos:
                if t.get("eventId") and t["eventId"] not in live:
                    t["eventId"] = None
                    touched = True
            if touched:
                save_json(TODOS_FILE, todos)

    return {"changed": changed, "adopted": adopted, "updated": updated,
            "removed": removed, "events": kept}


def google_result_page(heading, message):
    """The page Google's redirect lands on. Deliberately self-contained: it is
    served before the app's stylesheet is in play and is read once, in a tab
    the person is about to close."""
    return f"""<!doctype html><html><head><meta charset="utf-8">
<title>{escape_html(heading)} — PhD Life Manager</title></head>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
             background:#faf8f4;color:#23211c;
             font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
  <div style="max-width:30rem;padding:2.5rem;text-align:center">
    <h1 style="font:600 22px/1.3 Georgia,serif;margin:0 0 .6rem">{escape_html(heading)}</h1>
    <p style="margin:0;color:#635e54">{escape_html(message)}</p>
  </div>
</body></html>"""


def escape_html(text):
    return (str(text).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def parse_ideas():
    if not os.path.exists(IDEAS_FILE):
        return []
    with open(IDEAS_FILE, "r", encoding="utf-8") as f:
        content = f.read()
    ideas = []
    for m in IDEA_RE.finditer(content):
        header, body = m.group(1), m.group(2)
        attrs = dict(ATTR_RE.findall(header))
        ideas.append({
            "id": attrs.get("id", ""),
            "created": attrs.get("created", ""),
            "title": attrs.get("title", ""),
            "tags": [t for t in attrs.get("tags", "").split(",") if t],
            "links": [l for l in attrs.get("links", "").split(",") if l],
            "starred": attrs.get("starred", "") == "1",
            "text": body,
        })
    return ideas


def derive_title_from_text(text):
    stripped = text.strip()
    if not stripped:
        return "Untitled idea"
    first_line = stripped.splitlines()[0].lstrip("#").strip()
    first_line = re.sub(r"[*_`]+", "", first_line).strip()
    return first_line[:80] + ("…" if len(first_line) > 80 else "")


def serialize_idea(idea):
    safe_title = (idea.get("title") or "").replace('"', "'").replace("\n", " ")
    header = (
        f'<<<IDEA id="{idea["id"]}" created="{idea["created"]}" '
        f'title="{safe_title}" '
        f'tags="{",".join(idea.get("tags", []))}" '
        f'links="{",".join(idea.get("links", []))}" '
        f'starred="{"1" if idea.get("starred") else "0"}">>>'
    )
    return f'{header}\n{idea["text"]}\n<<<END>>>\n\n'


def write_ideas(ideas):
    with open(IDEAS_FILE, "w", encoding="utf-8") as f:
        for idea in ideas:
            f.write(serialize_idea(idea))


# ---------------------------------------------------------------- memo IO

def parse_memo_file(path):
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()
    parts = content.split("<<<BODY>>>\n", 1)
    header = parts[0]
    body = parts[1] if len(parts) > 1 else ""
    meta = {}
    for line in header.splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            meta[k.strip()] = v.strip()
    return meta, body


def write_memo_file(path, title, synopsis, created, body):
    with open(path, "w", encoding="utf-8") as f:
        f.write(f"title: {title}\n")
        f.write(f"created: {created}\n")
        f.write(f"synopsis: {synopsis}\n")
        f.write("<<<BODY>>>\n")
        f.write(body)


# ------------------------------------------------------------- focus timer
# One toggle: press to start a phone-free focus session linked to a
# calendar item or to-do, press again to stop it. Sessions are logged so a
# daily summary can total focus time and break it down per linked item.

def load_focus_sessions():
    if not os.path.exists(FOCUS_SESSIONS_FILE):
        return []
    return load_json(FOCUS_SESSIONS_FILE)


def save_focus_sessions(sessions):
    save_json(FOCUS_SESSIONS_FILE, sessions)


def find_running_session(sessions):
    for s in sessions:
        if s.get("end") is None:
            return s
    return None


def session_duration_seconds(s, now=None):
    now = now or datetime.datetime.now()
    start = datetime.datetime.fromisoformat(s["start"])
    end = datetime.datetime.fromisoformat(s["end"]) if s.get("end") else now
    return max(0, (end - start).total_seconds())


def compute_focus_recommendation():
    events = load_json(CALENDAR_FILE)
    if not events:
        return None
    now = datetime.datetime.now()
    for e in events:
        try:
            s = datetime.datetime.fromisoformat(e["start"])
            en = datetime.datetime.fromisoformat(e["end"])
        except (KeyError, ValueError):
            continue
        if s <= now <= en:
            return {"linkType": "event", "linkId": e["id"], "linkLabel": e["title"]}
    try:
        closest = min(events, key=lambda e: abs((datetime.datetime.fromisoformat(e["start"]) - now).total_seconds()))
        return {"linkType": "event", "linkId": closest["id"], "linkLabel": closest["title"]}
    except (KeyError, ValueError):
        return None


def local_date_of(iso_str):
    return datetime.datetime.fromisoformat(iso_str).date().isoformat()


def summarize_sessions(sessions):
    total = sum(session_duration_seconds(s) for s in sessions)
    groups = {}
    for s in sessions:
        key = f"{s.get('linkType')}:{s.get('linkId')}"
        if key not in groups:
            groups[key] = {
                "linkType": s.get("linkType"),
                "linkId": s.get("linkId"),
                "linkLabel": s.get("linkLabel") or "Unlinked",
                "seconds": 0,
            }
        groups[key]["seconds"] += session_duration_seconds(s)
    return total, sorted(groups.values(), key=lambda g: -g["seconds"])


# ------------------------------------------------------------------ journal
# Daily and weekly reflections, one plain-text markdown file per entry.
# "Weekly" entries are keyed by the Monday date of that week.

def journal_dir(kind):
    return JOURNAL_DAILY_DIR if kind == "daily" else JOURNAL_WEEKLY_DIR


def journal_key_safe(key):
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", key or ""):
        raise ApiError("invalid date key, expected YYYY-MM-DD", 400)
    return key


def journal_path(kind, key):
    return os.path.join(journal_dir(kind), f"{journal_key_safe(key)}.txt")


def read_journal_entry(kind, key):
    path = journal_path(kind, key)
    if not os.path.isfile(path):
        return {"key": key, "body": "", "updatedAt": None}
    with open(path, "r", encoding="utf-8") as f:
        body = f.read()
    updated = datetime.datetime.fromtimestamp(os.path.getmtime(path)).isoformat(timespec="seconds")
    return {"key": key, "body": body, "updatedAt": updated}


def write_journal_entry(kind, key, body):
    path = journal_path(kind, key)
    with open(path, "w", encoding="utf-8") as f:
        f.write(body)
    updated = datetime.datetime.fromtimestamp(os.path.getmtime(path)).isoformat(timespec="seconds")
    return {"key": key, "body": body, "updatedAt": updated}


def list_journal_entries(kind):
    d = journal_dir(kind)
    entries = []
    if os.path.isdir(d):
        for fname in sorted(os.listdir(d), reverse=True):
            if not fname.endswith(".txt"):
                continue
            key = fname[:-4]
            path = os.path.join(d, fname)
            with open(path, "r", encoding="utf-8") as f:
                body = f.read()
            snippet = body.strip().replace("\n", " ")[:140]
            updated = datetime.datetime.fromtimestamp(os.path.getmtime(path)).isoformat(timespec="seconds")
            entries.append({"key": key, "snippet": snippet, "updatedAt": updated})
    return entries


# ------------------------------------------------------------ weekly recap
# Study / Life / Summary prose plus a few self-rated dials, kept as one
# readable .txt per week (keyed by that week's Monday) so the folder stays
# legible outside the app, like memos and ideas.

RECAP_SECTIONS = ("study", "life", "summary")
RECAP_DIALS = ("studyProgress", "lifeBalance", "efficiency")
RECAP_SECTION_RE = re.compile(r"<<<(STUDY|LIFE|SUMMARY)>>>\n(.*?)(?=\n<<<|\Z)", re.DOTALL)
RECAP_EVENTS_RE = re.compile(r"<<<(STUDY|LIFE)_EVENTS>>>\n(.*?)(?=\n<<<|\Z)", re.DOTALL)


def _parse_linked_event_titles(block):
    """Titles out of an old <<<STUDY_EVENTS>>> block.

    Linked events used to be stored as their own pipe-delimited records and
    drawn in a panel of their own. They are ordinary bullets in the prose now
    — see _fold_linked_events() — so this only has to read what older versions
    wrote. Nothing writes these blocks any more.
    """
    titles = []
    for line in (block or "").splitlines():
        if not line.strip():
            continue
        parts = [p.strip() for p in line.split("|")]
        if len(parts) >= 4 and parts[3]:
            titles.append(parts[3])
    return titles


def _fold_linked_events(text, titles):
    """Append linked events to a section as bullets, skipping any already there."""
    body = (text or "").strip("\n")
    have = {ln.strip().lstrip("*-").strip() for ln in body.splitlines()}
    fresh = [t for t in titles if t not in have]
    if not fresh:
        return body
    bullets = "\n".join(f"* {t}" for t in fresh)
    if not body.strip():
        return bullets
    # A blank line so the bullets start a list rather than continuing a
    # paragraph — unless the section already ends in one, where a blank line
    # would split it in two.
    gap = "\n" if body.rstrip().splitlines()[-1].lstrip().startswith(("*", "-")) else "\n\n"
    return f"{body}{gap}{bullets}"


def empty_recap(key):
    return {
        "key": key, "study": "", "life": "", "summary": "",
        "dials": {d: None for d in RECAP_DIALS},
        "mood": None, "score": None, "updatedAt": None, "hasEntry": False,
    }


def _clamp_rating(v):
    try:
        n = int(v)
    except (TypeError, ValueError):
        return None
    return n if 1 <= n <= 5 else None


def recap_score(dials):
    vals = [dials.get(d) for d in RECAP_DIALS]
    if any(v is None for v in vals):
        return None
    return round(sum(vals) / len(vals), 1)


def read_recap(key):
    path = journal_path("weekly", key)
    if not os.path.isfile(path):
        return empty_recap(key)
    with open(path, "r", encoding="utf-8") as f:
        raw = f.read()
    head, _, rest = raw.partition("<<<STUDY>>>")
    meta = {}
    for line in head.splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            meta[k.strip()] = v.strip()
    entry = empty_recap(key)
    entry["hasEntry"] = True
    body = ("<<<STUDY>>>" + rest) if rest else raw
    for m in RECAP_SECTION_RE.finditer(body):
        entry[m.group(1).lower()] = m.group(2).strip("\n")
    # A recap written before linked events became prose still carries its own
    # blocks. Fold them in on read so nothing disappears from view; the next
    # save writes them as ordinary text and the blocks are gone for good.
    for m in RECAP_EVENTS_RE.finditer(body):
        section = "study" if m.group(1) == "STUDY" else "life"
        entry[section] = _fold_linked_events(entry[section], _parse_linked_event_titles(m.group(2)))
    entry["dials"] = {
        "studyProgress": _clamp_rating(meta.get("study_progress")),
        "lifeBalance": _clamp_rating(meta.get("life_balance")),
        "efficiency": _clamp_rating(meta.get("efficiency")),
    }
    entry["mood"] = _clamp_rating(meta.get("mood"))
    entry["score"] = recap_score(entry["dials"])
    entry["updatedAt"] = datetime.datetime.fromtimestamp(os.path.getmtime(path)).isoformat(timespec="seconds")
    return entry


def write_recap(key, payload):
    dials = payload.get("dials") or {}
    entry = {
        "key": journal_key_safe(key),
        "study": payload.get("study", "") or "",
        "life": payload.get("life", "") or "",
        "summary": payload.get("summary", "") or "",
        "dials": {d: _clamp_rating(dials.get(d)) for d in RECAP_DIALS},
        "mood": _clamp_rating(payload.get("mood")),
    }
    entry["score"] = recap_score(entry["dials"])

    def fmt(v):
        return "" if v is None else str(v)

    path = journal_path("weekly", key)
    with open(path, "w", encoding="utf-8") as f:
        f.write(f"week_of: {entry['key']}\n")
        f.write(f"score: {fmt(entry['score'])}\n")
        f.write(f"study_progress: {fmt(entry['dials']['studyProgress'])}\n")
        f.write(f"life_balance: {fmt(entry['dials']['lifeBalance'])}\n")
        f.write(f"efficiency: {fmt(entry['dials']['efficiency'])}\n")
        f.write(f"mood: {fmt(entry['mood'])}\n\n")
        for name in RECAP_SECTIONS:
            f.write(f"<<<{name.upper()}>>>\n{entry[name]}\n\n")
    entry["updatedAt"] = datetime.datetime.fromtimestamp(os.path.getmtime(path)).isoformat(timespec="seconds")
    entry["hasEntry"] = True
    return entry


def monday_of(d):
    return d - datetime.timedelta(days=d.weekday())


def week_evidence(monday):
    """Facts about a week, drawn from what the app already recorded.

    Deliberately descriptive — none of this feeds the score. Its job is to
    remind you what the week actually contained before you judge it.
    """
    start = datetime.datetime.combine(monday, datetime.time.min)
    end = start + datetime.timedelta(days=7)

    sessions = [s for s in load_focus_sessions()
                if start <= datetime.datetime.fromisoformat(s["start"]) < end]
    total, by_task = summarize_sessions(sessions)
    active_days = len({local_date_of(s["start"]) for s in sessions})
    longest = max((session_duration_seconds(s) for s in sessions), default=0)

    todos = load_json(TODOS_FILE)
    completed = sum(1 for t in todos if t.get("completedAt")
                    and start <= datetime.datetime.fromisoformat(t["completedAt"]) < end)
    added = sum(1 for t in todos if t.get("createdAt")
                and start <= datetime.datetime.fromisoformat(t["createdAt"]) < end)

    ideas = sum(1 for i in parse_ideas() if i.get("created")
                and start <= datetime.datetime.fromisoformat(i["created"]) < end)

    memos = 0
    if os.path.isdir(PROJECTS_DIR):
        for slug in os.listdir(PROJECTS_DIR):
            mdir = os.path.join(PROJECTS_DIR, slug, "memos")
            if not os.path.isdir(mdir):
                continue
            for fname in os.listdir(mdir):
                if not fname.endswith(".txt"):
                    continue
                meta, _ = parse_memo_file(os.path.join(mdir, fname))
                created = meta.get("created")
                if created:
                    try:
                        if start <= datetime.datetime.fromisoformat(created) < end:
                            memos += 1
                    except ValueError:
                        pass

    return {
        "focusSeconds": total,
        "focusDailyAverage": total / 7,
        "activeDays": active_days,
        "longestSessionSeconds": longest,
        "sessionCount": len(sessions),
        "topTasks": by_task[:3],
        "todosCompleted": completed,
        "todosAdded": added,
        "ideasCaptured": ideas,
        "memosWritten": memos,
    }


def project_code_of(slug):
    meta = os.path.join(PROJECTS_DIR, slug or "", "project.json")
    return (load_json(meta).get("code") or "").strip() if os.path.isfile(meta) else ""


def all_project_codes():
    codes = []
    if os.path.isdir(PROJECTS_DIR):
        for slug in os.listdir(PROJECTS_DIR):
            code = project_code_of(slug)
            if code:
                codes.append(code)
    return codes


def strip_project_prefix(title):
    for code in all_project_codes():
        if title.startswith(code + ":"):
            return title[len(code) + 1:].lstrip()
    return title


def normalize_event_title(event):
    """A block carries its project's code in the name, so the project shows
    up on the calendar itself (and on the phone) without needing a field of
    its own. The to-do keeps the bare text — the sidebar adds the code when
    it renders, and doubling it up would read as "MA: MA: …".
    """
    todos = load_json(TODOS_FILE)
    todo = next((t for t in todos if t["id"] == event.get("todoId")), None)
    base = strip_project_prefix(event.get("title") or "")
    code = project_code_of(todo.get("projectSlug")) if todo and todo.get("projectSlug") else ""
    event["title"] = f"{code}: {base}" if code else base
    if todo and todo.get("text") != base:
        todo["text"] = base
        save_json(TODOS_FILE, todos)


def apply_event_project(event, project_slug):
    """Assign a Todos-calendar block to a project, creating the to-do that
    carries the link if the block came from Apple Calendar and has none.

    Returns True when todos.json changed.
    """
    todos = load_json(TODOS_FILE)
    changed = False
    todo = next((t for t in todos if t["id"] == event.get("todoId")), None)

    if todo is None:
        if not project_slug:
            return False
        todo = {
            "id": new_id("todo"),
            "text": strip_project_prefix(event.get("title") or "") or "Untitled",
            "done": False,
            "createdAt": now_iso(),
            "completedAt": None,
            "eventId": event["id"],
            "projectSlug": project_slug,
        }
        todos.append(todo)
        event["todoId"] = todo["id"]
        changed = True
    else:
        if todo.get("projectSlug") != (project_slug or None):
            todo["projectSlug"] = project_slug or None
            changed = True
        if todo.get("eventId") != event["id"]:
            todo["eventId"] = event["id"]
            changed = True

    if changed:
        save_json(TODOS_FILE, todos)
    return changed


def recent_weeks(count):
    """Newest first, including weeks with no recap written yet."""
    this_monday = monday_of(datetime.date.today())
    out = []
    for i in range(count):
        monday = this_monday - datetime.timedelta(weeks=i)
        key = monday.isoformat()
        entry = read_recap(key)
        out.append({
            "key": key,
            "hasEntry": entry["hasEntry"],
            "score": entry["score"],
            "mood": entry["mood"],
            "focusSeconds": week_evidence(monday)["focusSeconds"],
            "isCurrent": i == 0,
        })
    return out


# --------------------------------------------------------------- HTTP handler

class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "PhDManager/1.0"

    def log_message(self, fmt, *args):
        pass  # keep the terminal quiet

    # ---- low level helpers
    def _send_json(self, data, code=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, html, code=200):
        body = html.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            raise ApiError("invalid JSON body", 400)

    def _serve_static(self, path):
        if path == "/":
            path = "/index.html"
        file_path = os.path.normpath(os.path.join(PUBLIC_DIR, path.lstrip("/")))
        if not file_path.startswith(os.path.abspath(PUBLIC_DIR)):
            self.send_response(403)
            self.end_headers()
            return
        if not os.path.isfile(file_path):
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"not found")
            return
        ext = os.path.splitext(file_path)[1]
        ctype = CONTENT_TYPES.get(ext, "application/octet-stream")
        with open(file_path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---- dispatch
    def do_GET(self):
        if self.path.startswith("/api/"):
            self._dispatch()
        else:
            self._serve_static(urllib.parse.urlsplit(self.path).path)

    def do_POST(self):
        self._dispatch()

    def do_PUT(self):
        self._dispatch()

    def do_DELETE(self):
        self._dispatch()

    def _dispatch(self):
        if not self.path.startswith("/api/"):
            self._send_json({"error": "not found"}, 404)
            return
        parsed = urllib.parse.urlsplit(self.path)
        parts = [p for p in parsed.path.split("/") if p]  # e.g. ['api','todos','id']
        method = self.command
        try:
            if len(parts) >= 2 and parts[1] == "todos":
                self.route_todos(method, parts)
            elif len(parts) >= 2 and parts[1] == "events":
                self.route_events(method, parts)
            elif len(parts) >= 2 and parts[1] == "ideas":
                self.route_ideas(method, parts)
            elif len(parts) >= 2 and parts[1] == "projects":
                self.route_projects(method, parts)
            elif len(parts) >= 2 and parts[1] == "caldav":
                self.route_caldav(method, parts)
            elif len(parts) >= 2 and parts[1] == "google":
                self.route_google(method, parts)
            elif len(parts) >= 2 and parts[1] == "sync":
                self.route_sync(method, parts)
            elif len(parts) >= 2 and parts[1] == "focus":
                self.route_focus(method, parts)
            elif len(parts) >= 2 and parts[1] == "journal":
                self.route_journal(method, parts)
            else:
                self._send_json({"error": "not found"}, 404)
        except ApiError as e:
            self._send_json({"error": str(e)}, e.code)
        except Exception as e:  # keep the server alive on unexpected errors
            self._send_json({"error": f"server error: {e}"}, 500)

    # ---- /api/todos
    def route_todos(self, method, parts):
        todos = load_json(TODOS_FILE)
        if len(parts) == 2:
            if method == "GET":
                self._send_json(todos)
            elif method == "POST":
                body = self._read_json_body()
                text = (body.get("text") or "").strip()
                if not text:
                    raise ApiError("text required", 400)
                todo = {
                    "id": new_id("todo"),
                    "text": text,
                    "done": False,
                    "createdAt": now_iso(),
                    "eventId": None,
                    "projectSlug": body.get("projectSlug"),
                }
                todos.append(todo)
                save_json(TODOS_FILE, todos)
                self._send_json(todo, 201)
            else:
                raise ApiError("method not allowed", 405)
            return
        if len(parts) == 3:
            tid = parts[2]
            idx = next((i for i, t in enumerate(todos) if t["id"] == tid), None)
            if idx is None:
                raise ApiError("todo not found", 404)
            if method == "PUT":
                body = self._read_json_body()
                was_done = bool(todos[idx].get("done"))
                for k in ("text", "done", "eventId", "projectSlug"):
                    if k in body:
                        todos[idx][k] = body[k]
                # Stamp the moment of completion so the weekly recap can say
                # what actually got finished in a given week.
                if "done" in body:
                    if body["done"] and not was_done:
                        todos[idx]["completedAt"] = now_iso()
                    elif not body["done"]:
                        todos[idx]["completedAt"] = None
                save_json(TODOS_FILE, todos)
                self._send_json(todos[idx])
            elif method == "DELETE":
                removed = todos.pop(idx)
                save_json(TODOS_FILE, todos)
                if removed.get("eventId"):
                    events = load_json(CALENDAR_FILE)
                    events = [e for e in events if e["id"] != removed["eventId"]]
                    save_json(CALENDAR_FILE, events)
                self._send_json({"ok": True})
            else:
                raise ApiError("method not allowed", 405)
            return
        raise ApiError("not found", 404)

    # ---- /api/events
    def route_events(self, method, parts):
        events = load_json(CALENDAR_FILE)
        if len(parts) == 2:
            if method == "GET":
                self._send_json(events)
            elif method == "POST":
                body = self._read_json_body()
                if not body.get("start") or not body.get("end"):
                    raise ApiError("start and end required", 400)
                event = {
                    "id": new_id("evt"),
                    "title": body.get("title") or "Untitled block",
                    "start": body["start"],
                    "end": body["end"],
                    "color": body.get("color") or "#5b7fd6",
                    "todoId": body.get("todoId"),
                    "type": body.get("type") or "block",
                    "icloudUid": None,
                    "icloudUrl": None,
                    "googleId": None,
                    "googleCalendarId": None,
                    "calendarName": body.get("calendarName") or None,
                }
                sync_warning = None
                # Where a new block syncs is the server's call, taken from the
                # one selected provider — not something the page asks for. A
                # stale tab then cannot write into an account the user has
                # since switched away from.
                if body.get("syncToCalendar"):
                    provider = sync_provider()
                    try:
                        if provider == "icloud":
                            event["icloudUid"], event["icloudUrl"] = caldav_create_event(
                                event["title"], event["start"], event["end"],
                                calendar_name=event["calendarName"])
                        elif provider == "google":
                            event["googleId"], event["googleCalendarId"] = google_create_event(
                                event["title"], event["start"], event["end"],
                                calendar_id=body.get("googleCalendarId") or None)
                    except ApiError as e:
                        sync_warning = str(e)
                events.append(event)
                save_json(CALENDAR_FILE, events)
                if event["todoId"]:
                    todos = load_json(TODOS_FILE)
                    for t in todos:
                        if t["id"] == event["todoId"]:
                            t["eventId"] = event["id"]
                    save_json(TODOS_FILE, todos)
                result = dict(event)
                if sync_warning:
                    result["syncWarning"] = sync_warning
                self._send_json(result, 201)
            else:
                raise ApiError("method not allowed", 405)
            return
        if len(parts) == 3:
            eid = parts[2]
            idx = next((i for i, e in enumerate(events) if e["id"] == eid), None)
            if idx is None:
                raise ApiError("event not found", 404)
            if method == "PUT":
                body = self._read_json_body()
                target_calendar = body.pop("calendarName", None)
                has_project = "projectSlug" in body
                project_slug = body.pop("projectSlug", None)
                before = {k: events[idx].get(k) for k in ("title", "start", "end")}
                for k in ("title", "start", "end", "color", "todoId", "type"):
                    if k in body:
                        events[idx][k] = body[k]
                # Assign the project first: it can rewrite the title, and that
                # rewrite has to be part of what gets pushed to iCloud.
                if has_project:
                    apply_event_project(events[idx], project_slug)
                normalize_event_title(events[idx])
                moving = (target_calendar and events[idx].get("calendarName")
                          and target_calendar.strip().lower() != (events[idx]["calendarName"] or "").strip().lower())
                sync_warning = None
                changed_fields = any(events[idx].get(k) != before[k] for k in before)
                if events[idx].get("icloudUid") and changed_fields:
                    try:
                        url = events[idx].get("icloudUrl")
                        if not url:
                            url = caldav_find_url_by_uid(events[idx]["icloudUid"])
                            events[idx]["icloudUrl"] = url
                        if url and moving:
                            res = caldav_move_event(url, events[idx]["title"], events[idx]["start"],
                                                    events[idx]["end"], events[idx].get("calendarName"), target_calendar)
                            events[idx]["icloudUrl"] = res["url"]
                            events[idx]["icloudUid"] = res["uid"]
                            events[idx]["calendarName"] = target_calendar
                        elif url:
                            caldav_update_event(url, events[idx]["title"], events[idx]["start"],
                                                events[idx]["end"], events[idx].get("calendarName"))
                        else:
                            sync_warning = "Could not find this event on iCloud to update it."
                    except ApiError as e:
                        sync_warning = str(e)
                elif events[idx].get("googleId") and changed_fields:
                    try:
                        google_update_event(
                            events[idx]["googleId"], events[idx]["title"],
                            events[idx]["start"], events[idx]["end"],
                            events[idx].get("googleCalendarId") or google_blocks_calendar_id())
                    except ApiError as e:
                        sync_warning = str(e)
                save_json(CALENDAR_FILE, events)
                result = dict(events[idx])
                if sync_warning:
                    result["syncWarning"] = sync_warning
                self._send_json(result)
            elif method == "DELETE":
                removed = events.pop(idx)
                save_json(CALENDAR_FILE, events)
                if removed.get("icloudUid"):
                    try:
                        url = removed.get("icloudUrl") or caldav_find_url_by_uid(removed["icloudUid"])
                        if url:
                            caldav_delete_event(url, removed.get("calendarName"))
                    except ApiError:
                        pass
                elif removed.get("googleId") and removed.get("googleCalendarId"):
                    try:
                        google_delete_event(removed["googleId"], removed["googleCalendarId"])
                    except ApiError:
                        pass
                if removed.get("todoId"):
                    todos = load_json(TODOS_FILE)
                    for t in todos:
                        if t["id"] == removed["todoId"]:
                            t["eventId"] = None
                    save_json(TODOS_FILE, todos)
                self._send_json({"ok": True})
            else:
                raise ApiError("method not allowed", 405)
            return
        raise ApiError("not found", 404)

    # ---- /api/caldav
    def _wants_cached(self):
        """?cached=1 means: answer from what is already known, never dial out."""
        qs = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        return (qs.get("cached") or [""])[0] == "1"

    def route_caldav(self, method, parts):
        if len(parts) == 3 and parts[2] == "status":
            if method != "GET":
                raise ApiError("method not allowed", 405)
            self._send_json(caldav_status(live=not self._wants_cached()))
            return

        if len(parts) == 3 and parts[2] == "config":
            if method == "GET":
                cfg = load_caldav_config()
                self._send_json({
                    "icloudUsername": cfg.get("icloud_username", ""),
                    "todosCalendarName": cfg.get("todos_calendar_name", "Todos"),
                    "hasPassword": bool(cfg.get("icloud_app_password")),
                })
            elif method == "POST":
                body = self._read_json_body()
                save_caldav_config({
                    "icloud_username": (body.get("icloudUsername") or "").strip(),
                    "icloud_app_password": body.get("icloudAppPassword") or "",
                    "todos_calendar_name": (body.get("todosCalendarName") or "Todos").strip(),
                })
                self._send_json({"ok": True})
            else:
                raise ApiError("method not allowed", 405)
            return

        if len(parts) == 3 and parts[2] == "events":
            if method != "GET":
                raise ApiError("method not allowed", 405)
            qs = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            start_s = (qs.get("start") or [None])[0]
            end_s = (qs.get("end") or [None])[0]
            if not start_s or not end_s:
                raise ApiError("start and end query params required", 400)
            start_local = datetime.datetime.fromisoformat(start_s)
            end_local = datetime.datetime.fromisoformat(end_s)
            if self._wants_cached():
                # Draw-now path: whatever was last read, or nothing. Never waits.
                events, _ = cached_events_window(start_local, end_local)
                self._send_json(events or [])
                return
            self._send_json(caldav_fetch_events(start_local, end_local))
            return

        if len(parts) == 3 and parts[2] == "calendars":
            if method != "GET":
                raise ApiError("method not allowed", 405)
            if self._wants_cached():
                self._send_json(cached_writable_calendars())
                return
            self._send_json(list_writable_calendars())
            return

        # Direct edit/delete of any iCloud event by its URL. Events outside
        # the app's own calendar have no local record, so they are changed
        # in place rather than adopted.
        if len(parts) == 3 and parts[2] == "event":
            body = self._read_json_body() if method in ("PUT", "DELETE") else {}
            qs = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            url = body.get("url") or (qs.get("url") or [None])[0]
            if not url:
                raise ApiError("url required", 400)
            if method == "PUT":
                for f in ("title", "start", "end"):
                    if not body.get(f):
                        raise ApiError(f"{f} required", 400)
                current = body.get("calendarName")
                target = body.get("targetCalendarName") or current
                if target and current and target.strip().lower() != current.strip().lower():
                    res = caldav_move_event(url, body["title"], body["start"], body["end"], current, target)
                else:
                    res = caldav_update_event(url, body["title"], body["start"], body["end"], current)
                res["calendarName"] = target or current
                self._send_json(res)
            elif method == "DELETE":
                caldav_delete_event(url, body.get("calendarName") or (qs.get("calendarName") or [None])[0])
                self._send_json({"ok": True})
            else:
                raise ApiError("method not allowed", 405)
            return

        if len(parts) == 3 and parts[2] == "sync":
            if method != "POST":
                raise ApiError("method not allowed", 405)
            qs = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            start_s = (qs.get("start") or [None])[0]
            end_s = (qs.get("end") or [None])[0]
            if not start_s or not end_s:
                raise ApiError("start and end query params required", 400)
            start_local = datetime.datetime.fromisoformat(start_s)
            end_local = datetime.datetime.fromisoformat(end_s)
            self._send_json(reconcile_todos_calendar(start_local, end_local))
            return

        raise ApiError("not found", 404)

    # ---- /api/sync
    # One question — which calendar service, if any — and the single status
    # the page needs to draw itself. Everything provider-specific hangs off
    # /api/caldav and /api/google; this is the switch above them.
    def route_sync(self, method, parts):
        if len(parts) != 3 or parts[2] != "provider":
            raise ApiError("not found", 404)
        if method == "GET":
            provider = sync_provider()
            cached = self._wants_cached()
            result = {"provider": provider, "icloud": None, "google": None}
            if provider == "icloud":
                result["icloud"] = caldav_status(live=not cached)
            elif provider == "google":
                result["google"] = google_status(live=not cached)
            self._send_json(result)
            return
        if method == "POST":
            body = self._read_json_body()
            wanted = (body.get("provider") or "none").strip()
            previous = sync_provider()
            set_sync_provider(wanted)
            # Switching away releases the other service's session and its
            # cached reads, so nothing from the old account lingers on the
            # grid. Credentials are kept, so switching back is one click.
            if wanted != previous:
                if previous == "icloud":
                    reset_caldav_cache()
                elif previous == "google":
                    reset_google_cache()
            self._send_json({"provider": wanted})
            return
        raise ApiError("method not allowed", 405)

    # ---- /api/google
    def route_google(self, method, parts):
        qs = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        leaf = parts[2] if len(parts) > 2 else ""

        if leaf == "status":
            if method != "GET":
                raise ApiError("method not allowed", 405)
            self._send_json(google_status(live=not self._wants_cached()))
            return

        if leaf == "config":
            if method == "GET":
                cfg = load_google_config()
                self._send_json({
                    "clientId": cfg.get("client_id", ""),
                    "hasSecret": bool(cfg.get("client_secret")),
                    "blocksCalendarId": cfg.get("blocks_calendar_id", ""),
                    "blocksCalendarName": cfg.get("blocks_calendar_name", ""),
                    "redirectUri": google_redirect_uri(),
                })
            elif method == "POST":
                body = self._read_json_body()
                patch = {}
                if "clientId" in body:
                    patch["client_id"] = (body.get("clientId") or "").strip()
                # A blank secret means "keep the one already stored", so the
                # settings form never has to echo it back to be re-saved.
                if body.get("clientSecret"):
                    patch["client_secret"] = body["clientSecret"].strip()
                if "blocksCalendarId" in body:
                    patch["blocks_calendar_id"] = (body.get("blocksCalendarId") or "").strip()
                    patch["blocks_calendar_name"] = (body.get("blocksCalendarName") or "").strip()
                # Changing the client invalidates any token issued to the old one.
                if patch.get("client_id") and patch["client_id"] != load_google_config().get("client_id"):
                    patch.update({"refresh_token": "", "access_token": "", "access_token_expires": 0})
                save_google_config(patch)
                reset_google_cache()
                self._send_json({"ok": True})
            else:
                raise ApiError("method not allowed", 405)
            return

        # Hands the browser the Google consent screen to open.
        if leaf == "auth":
            if method != "POST":
                raise ApiError("method not allowed", 405)
            self._send_json({"url": google_auth_url()})
            return

        # Where Google sends the browser back to. This is the one route that
        # answers a person rather than the app's own fetch(), so it replies
        # with a page instead of JSON.
        if leaf == "callback":
            if method != "GET":
                raise ApiError("method not allowed", 405)
            err = (qs.get("error") or [None])[0]
            code = (qs.get("code") or [None])[0]
            state = (qs.get("state") or [None])[0]
            if err:
                self._send_html(google_result_page(
                    "Not connected", f"Google reported: {err}. Nothing was changed."), 400)
                return
            if not code or not state:
                self._send_html(google_result_page(
                    "Not connected", "That link was missing its authorisation code."), 400)
                return
            try:
                google_exchange_code(code, state)
            except ApiError as e:
                self._send_html(google_result_page("Not connected", str(e)), 502)
                return
            self._send_html(google_result_page(
                "Connected", "Google Calendar is connected. You can close this tab "
                             "and go back to the app."))
            return

        if leaf == "disconnect":
            if method != "POST":
                raise ApiError("method not allowed", 405)
            google_disconnect()
            self._send_json({"ok": True})
            return

        if leaf == "calendars":
            if method != "GET":
                raise ApiError("method not allowed", 405)
            if self._wants_cached():
                self._send_json(cached_google_calendars())
                return
            self._send_json(google_list_calendars())
            return

        if leaf == "events":
            if method != "GET":
                raise ApiError("method not allowed", 405)
            start_s = (qs.get("start") or [None])[0]
            end_s = (qs.get("end") or [None])[0]
            if not start_s or not end_s:
                raise ApiError("start and end query params required", 400)
            start_local = datetime.datetime.fromisoformat(start_s)
            end_local = datetime.datetime.fromisoformat(end_s)
            if self._wants_cached():
                events, _ = cached_google_window(start_local, end_local)
                self._send_json(events or [])
                return
            self._send_json(google_fetch_events(start_local, end_local))
            return

        # Edit or delete any Google event in place, by its own id.
        if leaf == "event":
            body = self._read_json_body() if method in ("PUT", "DELETE") else {}
            event_id = body.get("id") or (qs.get("id") or [None])[0]
            calendar_id = body.get("calendarId") or (qs.get("calendarId") or [None])[0]
            if not event_id or not calendar_id:
                raise ApiError("id and calendarId required", 400)
            if method == "PUT":
                for f in ("title", "start", "end"):
                    if not body.get(f):
                        raise ApiError(f"{f} required", 400)
                target = body.get("targetCalendarId") or calendar_id
                if target != calendar_id:
                    event_id = google_move_event(event_id, calendar_id, target)
                google_update_event(event_id, body["title"], body["start"], body["end"], target)
                self._send_json({"id": event_id, "calendarId": target})
            elif method == "DELETE":
                google_delete_event(event_id, calendar_id)
                self._send_json({"ok": True})
            else:
                raise ApiError("method not allowed", 405)
            return

        if leaf == "sync":
            if method != "POST":
                raise ApiError("method not allowed", 405)
            start_s = (qs.get("start") or [None])[0]
            end_s = (qs.get("end") or [None])[0]
            if not start_s or not end_s:
                raise ApiError("start and end query params required", 400)
            self._send_json(reconcile_google_blocks(
                datetime.datetime.fromisoformat(start_s),
                datetime.datetime.fromisoformat(end_s)))
            return

        raise ApiError("not found", 404)

    # ---- /api/focus
    def route_focus(self, method, parts):
        if len(parts) == 3 and parts[2] == "current":
            if method != "GET":
                raise ApiError("method not allowed", 405)
            sessions = load_focus_sessions()
            running = find_running_session(sessions)
            self._send_json({
                "running": running,
                "recommendation": compute_focus_recommendation(),
            })
            return

        if len(parts) == 3 and parts[2] == "start":
            if method != "POST":
                raise ApiError("method not allowed", 405)
            body = self._read_json_body()
            sessions = load_focus_sessions()
            running = find_running_session(sessions)
            if running:
                running["end"] = now_iso()
            session = {
                "id": new_id("focus"),
                "start": now_iso(),
                "end": None,
                "linkType": body.get("linkType"),
                "linkId": body.get("linkId"),
                "linkLabel": body.get("linkLabel") or "Unlinked",
            }
            sessions.append(session)
            save_focus_sessions(sessions)
            self._send_json(session, 201)
            return

        if len(parts) == 3 and parts[2] == "stop":
            if method != "POST":
                raise ApiError("method not allowed", 405)
            sessions = load_focus_sessions()
            running = find_running_session(sessions)
            if not running:
                raise ApiError("no focus session is running", 400)
            running["end"] = now_iso()
            save_focus_sessions(sessions)
            self._send_json(running)
            return

        if len(parts) == 3 and parts[2] == "sessions":
            if method != "GET":
                raise ApiError("method not allowed", 405)
            qs = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            date = (qs.get("date") or [None])[0]
            start = (qs.get("start") or [None])[0]
            end = (qs.get("end") or [None])[0]
            sessions = load_focus_sessions()
            if date:
                sessions = [s for s in sessions if local_date_of(s["start"]) == date]
            elif start and end:
                sessions = [s for s in sessions if start <= local_date_of(s["start"]) <= end]
            self._send_json(sessions)
            return

        if len(parts) == 3 and parts[2] == "summary":
            if method != "GET":
                raise ApiError("method not allowed", 405)
            qs = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            date = (qs.get("date") or [None])[0]
            if not date:
                raise ApiError("date query param required", 400)
            sessions = [s for s in load_focus_sessions() if local_date_of(s["start"]) == date]
            total, byTask = summarize_sessions(sessions)
            self._send_json({"date": date, "totalSeconds": total, "sessionCount": len(sessions), "byTask": byTask})
            return

        if len(parts) == 3 and parts[2] == "range-summary":
            if method != "GET":
                raise ApiError("method not allowed", 405)
            qs = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            start = (qs.get("start") or [None])[0]
            end = (qs.get("end") or [None])[0]
            if not start or not end:
                raise ApiError("start and end query params required (YYYY-MM-DD)", 400)
            try:
                start_date = datetime.date.fromisoformat(start)
                end_date = datetime.date.fromisoformat(end)
            except ValueError:
                raise ApiError("start and end must be YYYY-MM-DD", 400)
            day_totals = {}
            d = start_date
            while d <= end_date:
                day_totals[d.isoformat()] = 0.0
                d += datetime.timedelta(days=1)
            relevant = []
            for s in load_focus_sessions():
                key = local_date_of(s["start"])
                if key in day_totals:
                    day_totals[key] += session_duration_seconds(s)
                    relevant.append(s)
            total, byTask = summarize_sessions(relevant)
            days = [{"date": k, "totalSeconds": v} for k, v in sorted(day_totals.items())]
            num_days = len(days)
            avg = total / num_days if num_days else 0
            self._send_json({
                "start": start, "end": end, "days": days,
                "totalSeconds": total, "averageSecondsPerDay": avg,
                "sessionCount": len(relevant), "byTask": byTask,
            })
            return

        if len(parts) == 4 and parts[2] == "sessions":
            sid = parts[3]
            sessions = load_focus_sessions()
            idx = next((i for i, s in enumerate(sessions) if s["id"] == sid), None)
            if idx is None:
                raise ApiError("session not found", 404)
            if method == "PUT":
                body = self._read_json_body()
                for k in ("start", "end", "linkType", "linkId", "linkLabel"):
                    if k in body:
                        sessions[idx][k] = body[k]
                save_focus_sessions(sessions)
                self._send_json(sessions[idx])
            elif method == "DELETE":
                sessions.pop(idx)
                save_focus_sessions(sessions)
                self._send_json({"ok": True})
            else:
                raise ApiError("method not allowed", 405)
            return

        raise ApiError("not found", 404)

    # ---- /api/journal
    def route_journal(self, method, parts):
        # Structured weekly recap (the daily routes below are kept intact
        # so existing entries stay readable, just no longer surfaced).
        if len(parts) == 3 and parts[2] == "recap":
            qs = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            key = (qs.get("key") or [None])[0]
            if not key:
                raise ApiError("key query param required (YYYY-MM-DD)", 400)
            if method == "GET":
                entry = read_recap(key)
                monday = datetime.date.fromisoformat(journal_key_safe(key))
                entry["evidence"] = week_evidence(monday)
                self._send_json(entry)
            elif method == "PUT":
                self._send_json(write_recap(key, self._read_json_body()))
            else:
                raise ApiError("method not allowed", 405)
            return

        if len(parts) == 4 and parts[2] == "recap" and parts[3] == "weeks":
            if method != "GET":
                raise ApiError("method not allowed", 405)
            qs = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            try:
                count = min(52, max(1, int((qs.get("count") or ["8"])[0])))
            except ValueError:
                count = 8
            weeks = recent_weeks(count)
            # Only ever nudge about the week that just ended. Walking further
            # back would turn the reminder into a demand to backfill history,
            # which is not what a weekly ritual is for.
            last_week = weeks[1] if len(weeks) > 1 else None
            pending = last_week["key"] if last_week and not last_week["hasEntry"] else None
            self._send_json({"weeks": weeks, "pendingKey": pending})
            return

        if len(parts) == 3 and parts[2] in ("daily", "weekly"):
            kind = parts[2]
            if method == "GET":
                qs = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
                key = (qs.get("key") or [None])[0]
                if not key:
                    raise ApiError("key query param required (YYYY-MM-DD)", 400)
                self._send_json(read_journal_entry(kind, key))
            elif method == "PUT":
                qs = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
                key = (qs.get("key") or [None])[0]
                if not key:
                    raise ApiError("key query param required (YYYY-MM-DD)", 400)
                body = self._read_json_body()
                self._send_json(write_journal_entry(kind, key, body.get("body", "")))
            else:
                raise ApiError("method not allowed", 405)
            return

        if len(parts) == 4 and parts[2] in ("daily", "weekly") and parts[3] == "list":
            if method != "GET":
                raise ApiError("method not allowed", 405)
            self._send_json(list_journal_entries(parts[2]))
            return

        raise ApiError("not found", 404)

    # ---- /api/ideas
    def route_ideas(self, method, parts):
        if len(parts) == 2:
            if method == "GET":
                self._send_json(parse_ideas())
            elif method == "POST":
                body = self._read_json_body()
                text = (body.get("text") or "").strip()
                if not text:
                    raise ApiError("text required", 400)
                title = (body.get("title") or "").strip() or derive_title_from_text(text)
                idea = {
                    "id": new_id("idea"),
                    "created": now_iso(),
                    "title": title,
                    "tags": body.get("tags", []),
                    "links": body.get("links", []),
                    "starred": bool(body.get("starred")),
                    "text": text,
                }
                ideas = parse_ideas()
                ideas.append(idea)
                write_ideas(ideas)
                self._send_json(idea, 201)
            else:
                raise ApiError("method not allowed", 405)
            return
        if len(parts) == 3:
            iid = parts[2]
            ideas = parse_ideas()
            idx = next((i for i, x in enumerate(ideas) if x["id"] == iid), None)
            if idx is None:
                raise ApiError("idea not found", 404)
            if method == "PUT":
                body = self._read_json_body()
                for k in ("text", "title", "tags", "links"):
                    if k in body:
                        ideas[idx][k] = body[k]
                if "starred" in body:
                    ideas[idx]["starred"] = bool(body["starred"])
                if "text" in body and not (ideas[idx].get("title") or "").strip():
                    ideas[idx]["title"] = derive_title_from_text(ideas[idx]["text"])
                write_ideas(ideas)
                self._send_json(ideas[idx])
            elif method == "DELETE":
                ideas.pop(idx)
                write_ideas(ideas)
                self._send_json({"ok": True})
            else:
                raise ApiError("method not allowed", 405)
            return
        if len(parts) == 4 and parts[3] == "promote" and method == "POST":
            iid = parts[2]
            ideas = parse_ideas()
            idx = next((i for i, x in enumerate(ideas) if x["id"] == iid), None)
            if idx is None:
                raise ApiError("idea not found", 404)
            idea = ideas[idx]
            body = self._read_json_body()
            slug = body.get("projectSlug")
            if not slug:
                title = (body.get("newProjectTitle") or "").strip()
                if not title:
                    raise ApiError("projectSlug or newProjectTitle required", 400)
                slug = self.create_project_internal(title, body.get("newProjectDescription", ""))
            proj_dir = os.path.join(PROJECTS_DIR, slug)
            if not os.path.isdir(proj_dir):
                raise ApiError("project not found", 404)
            memo_id = new_id("memo")
            stripped = idea["text"].strip()
            title = (idea.get("title") or "").strip() or derive_title_from_text(stripped)
            synopsis = stripped.replace("\n", " ")[:140]
            memos_dir = os.path.join(proj_dir, "memos")
            os.makedirs(memos_dir, exist_ok=True)
            write_memo_file(os.path.join(memos_dir, f"{memo_id}.txt"), title, synopsis, idea["created"], idea["text"])
            ideas.pop(idx)
            write_ideas(ideas)
            self._send_json({"projectSlug": slug, "memoId": memo_id})
            return
        raise ApiError("not found", 404)

    # ---- /api/projects
    def create_project_internal(self, title, description="", code=None):
        base_slug = slugify(title)
        slug = base_slug
        i = 2
        while os.path.exists(os.path.join(PROJECTS_DIR, slug)):
            slug = f"{base_slug}-{i}"
            i += 1
        proj_dir = os.path.join(PROJECTS_DIR, slug)
        os.makedirs(os.path.join(proj_dir, "memos"), exist_ok=True)
        meta = {
            "slug": slug,
            "title": title,
            "description": description,
            "status": "active",
            "tags": [],
            "code": (code or derive_code(title)),
            "createdAt": now_iso(),
        }
        save_json(os.path.join(proj_dir, "project.json"), meta)
        return slug

    def route_projects(self, method, parts):
        if len(parts) == 2:
            if method == "GET":
                result = []
                if os.path.isdir(PROJECTS_DIR):
                    for slug in sorted(os.listdir(PROJECTS_DIR)):
                        pdir = os.path.join(PROJECTS_DIR, slug)
                        meta_path = os.path.join(pdir, "project.json")
                        if os.path.isfile(meta_path):
                            meta = load_json(meta_path)
                            memos_dir = os.path.join(pdir, "memos")
                            count = 0
                            if os.path.isdir(memos_dir):
                                count = len([f for f in os.listdir(memos_dir) if f.endswith(".txt")])
                            meta["memoCount"] = count
                            result.append(meta)
                self._send_json(result)
            elif method == "POST":
                body = self._read_json_body()
                title = (body.get("title") or "").strip()
                if not title:
                    raise ApiError("title required", 400)
                slug = self.create_project_internal(title, body.get("description", ""), (body.get("code") or "").strip() or None)
                meta_path = os.path.join(PROJECTS_DIR, slug, "project.json")
                meta = load_json(meta_path)
                if "status" in body:
                    meta["status"] = body["status"]
                if "tags" in body:
                    meta["tags"] = body["tags"]
                save_json(meta_path, meta)
                self._send_json(meta, 201)
            else:
                raise ApiError("method not allowed", 405)
            return

        slug = parts[2]
        pdir = os.path.join(PROJECTS_DIR, slug)
        meta_path = os.path.join(pdir, "project.json")

        if len(parts) == 3:
            if not os.path.isfile(meta_path):
                raise ApiError("project not found", 404)
            if method == "GET":
                meta = load_json(meta_path)
                memos_dir = os.path.join(pdir, "memos")
                memos = []
                if os.path.isdir(memos_dir):
                    for fname in sorted(os.listdir(memos_dir)):
                        if fname.endswith(".txt"):
                            meta2, _ = parse_memo_file(os.path.join(memos_dir, fname))
                            memos.append({
                                "id": fname[:-4],
                                "title": meta2.get("title", "Untitled"),
                                "synopsis": meta2.get("synopsis", ""),
                                "created": meta2.get("created", ""),
                            })
                meta["memos"] = memos
                self._send_json(meta)
            elif method == "PUT":
                body = self._read_json_body()
                meta = load_json(meta_path)
                for k in ("title", "description", "status", "tags", "code"):
                    if k in body:
                        meta[k] = body[k]
                save_json(meta_path, meta)
                self._send_json(meta)
            elif method == "DELETE":
                shutil.rmtree(pdir)
                todos = load_json(TODOS_FILE)
                changed = False
                for t in todos:
                    if t.get("projectSlug") == slug:
                        t["projectSlug"] = None
                        changed = True
                if changed:
                    save_json(TODOS_FILE, todos)
                self._send_json({"ok": True})
            else:
                raise ApiError("method not allowed", 405)
            return

        if len(parts) == 4 and parts[3] == "memos":
            if not os.path.isdir(pdir):
                raise ApiError("project not found", 404)
            memos_dir = os.path.join(pdir, "memos")
            os.makedirs(memos_dir, exist_ok=True)
            if method == "GET":
                memos = []
                for fname in sorted(os.listdir(memos_dir)):
                    if fname.endswith(".txt"):
                        meta2, _ = parse_memo_file(os.path.join(memos_dir, fname))
                        memos.append({
                            "id": fname[:-4],
                            "title": meta2.get("title", "Untitled"),
                            "synopsis": meta2.get("synopsis", ""),
                            "created": meta2.get("created", ""),
                        })
                self._send_json(memos)
            elif method == "POST":
                body = self._read_json_body()
                title = (body.get("title") or "Untitled").strip() or "Untitled"
                memo_body = body.get("body", "")
                synopsis = (body.get("synopsis") or "").strip()
                if not synopsis:
                    synopsis = memo_body.replace("\n", " ")[:140]
                memo_id = new_id("memo")
                created = now_iso()
                write_memo_file(os.path.join(memos_dir, f"{memo_id}.txt"), title, synopsis, created, memo_body)
                self._send_json({"id": memo_id, "title": title, "synopsis": synopsis, "created": created, "body": memo_body}, 201)
            else:
                raise ApiError("method not allowed", 405)
            return

        if len(parts) == 5 and parts[3] == "memos":
            memo_id = parts[4]
            mpath = os.path.join(pdir, "memos", f"{memo_id}.txt")
            if method == "GET":
                if not os.path.isfile(mpath):
                    raise ApiError("memo not found", 404)
                meta2, body = parse_memo_file(mpath)
                self._send_json({
                    "id": memo_id,
                    "title": meta2.get("title", "Untitled"),
                    "synopsis": meta2.get("synopsis", ""),
                    "created": meta2.get("created", ""),
                    "body": body,
                })
            elif method == "PUT":
                if not os.path.isfile(mpath):
                    raise ApiError("memo not found", 404)
                meta2, body = parse_memo_file(mpath)
                req = self._read_json_body()
                title = req.get("title", meta2.get("title", "Untitled"))
                synopsis = req.get("synopsis", meta2.get("synopsis", ""))
                new_body = req.get("body", body)
                created = meta2.get("created", now_iso())
                write_memo_file(mpath, title, synopsis, created, new_body)
                self._send_json({"id": memo_id, "title": title, "synopsis": synopsis, "created": created, "body": new_body})
            elif method == "DELETE":
                if os.path.isfile(mpath):
                    os.remove(mpath)
                self._send_json({"ok": True})
            else:
                raise ApiError("method not allowed", 405)
            return

        raise ApiError("not found", 404)


def watch_parent_process():
    """Exit when the process that launched us goes away.

    The Mac app runs this server as a child and stops it on quit, but a
    crash or a force-quit skips that path — without this the server would
    linger and hold the port. Only active when the launcher asks for it,
    so running the server from a terminal is unaffected.
    """
    raw = os.environ.get("PHD_PARENT_PID")
    if not raw:
        return
    try:
        parent = int(raw)
    except ValueError:
        return

    def poll():
        while True:
            time.sleep(2)
            try:
                os.kill(parent, 0)      # signal 0 just tests for existence
            except OSError:
                os._exit(0)

    threading.Thread(target=poll, daemon=True).start()


def prewarm_caldav():
    """Fetch this week from iCloud in the background as soon as we start.

    The app launches the server and opens the UI in the same breath, so this
    usually finishes before the first page load asks — and even when it does
    not, the page has already painted from the disk cache and simply picks up
    the fresher answer. Failures are silent: this is a head start, not a step
    anything depends on.
    """
    def run():
        try:
            if sync_provider() != "icloud":
                return
            status = caldav_status(live=True)
            if not (status.get("connected") and status.get("todosCalendarFound")):
                return
            list_writable_calendars()
            today = datetime.datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
            monday = today - datetime.timedelta(days=today.weekday())
            # A day of padding either side, so the exact week the calendar
            # asks for is covered by this one window.
            caldav_fetch_events(monday - datetime.timedelta(days=1),
                                monday + datetime.timedelta(days=8))
        except Exception:
            pass

    def run_google():
        try:
            if sync_provider() != "google":
                return
            if not google_status(live=True).get("connected"):
                return
            today = datetime.datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
            monday = today - datetime.timedelta(days=today.weekday())
            google_fetch_events(monday - datetime.timedelta(days=1),
                                monday + datetime.timedelta(days=8))
        except Exception:
            pass

    threading.Thread(target=run_google, daemon=True).start()

    threading.Thread(target=run, daemon=True).start()


def main():
    ensure_data()
    watch_parent_process()
    prewarm_caldav()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"PhD Life Manager running at http://127.0.0.1:{PORT}  (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
