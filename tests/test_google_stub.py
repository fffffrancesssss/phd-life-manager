#!/usr/bin/env python3
"""Drives the Google Calendar half against a stub that answers like Google does.

Google needs OAuth, so there is no way to exercise this code against the real
service without an account and a browser round trip. This stands a fake Google
up on a local port instead, which reaches the parts that would otherwise only
be tested in production: token refresh, the retry after a 401, pagination,
all-day events, the write calls, and — the one that matters most — that a
calendar which fails to read is reported as failed rather than as empty.

Run from the project root:

    .venv/bin/python3 tests/test_google_stub.py
"""
import http.server
import json
import threading
import urllib.parse
import datetime
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(ROOT)
import server                                        # noqa: E402

STATE = {"token_calls": 0, "fail_calendar": None, "written": [], "deleted": [],
         "moved": [], "force_401_once": False}

CALENDARS = [
    {"id": "primary@example.com", "summary": "Main", "primary": True, "accessRole": "owner"},
    {"id": "blocks@example.com", "summary": "PhD Blocks", "accessRole": "writer"},
    {"id": "shared@example.com", "summary": "Dept Seminars", "accessRole": "reader"},
]


def ev(i, start, end, allday=False, cancelled=False):
    node = (lambda v: {"date": v}) if allday else (lambda v: {"dateTime": v})
    return {"id": f"g{i}", "summary": f"event {i}",
            "status": "cancelled" if cancelled else "confirmed",
            "start": node(start), "end": node(end)}


EVENTS = {
    "primary@example.com": [
        ev(1, "2026-08-24T09:00:00-04:00", "2026-08-24T10:30:00-04:00"),
        ev(2, "2026-08-25", "2026-08-26", allday=True),
        ev(3, "2026-08-26T14:00:00Z", "2026-08-26T15:00:00Z"),
        ev(9, "2026-08-27T09:00:00-04:00", "2026-08-27T10:00:00-04:00", cancelled=True),
    ],
    "blocks@example.com": [
        ev(4, "2026-08-24T13:00:00-04:00", "2026-08-24T14:00:00-04:00"),
        ev(5, "2026-08-28T11:00:00-04:00", "2026-08-28T12:00:00-04:00"),
    ],
    "shared@example.com": [ev(6, "2026-08-25T16:00:00-04:00", "2026-08-25T17:00:00-04:00")],
}


class Stub(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/token":
            STATE["token_calls"] += 1
            return self._json({"access_token": f"tok{STATE['token_calls']}",
                               "expires_in": 3600, "refresh_token": "refresh-abc"})
        if path.endswith("/move"):
            q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(self.path).query))
            STATE["moved"].append((path, q.get("destination")))
            return self._json({"id": "g4-moved"})
        if "/events" in path:
            if STATE["force_401_once"]:
                STATE["force_401_once"] = False
                return self._json({"error": {"message": "Invalid Credentials"}}, 401)
            STATE["written"].append((path, json.loads(self._body() or b"{}")))
            return self._json({"id": "g-new-1"})
        return self._json({"error": {"message": "no"}}, 404)

    def do_PATCH(self):
        STATE["written"].append((urllib.parse.urlsplit(self.path).path,
                                 json.loads(self._body() or b"{}")))
        return self._json({"id": "patched"})

    def do_DELETE(self):
        STATE["deleted"].append(urllib.parse.urlsplit(self.path).path)
        return self._json({})

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        q = dict(urllib.parse.parse_qsl(u.query))
        if not (self.headers.get("Authorization") or "").startswith("Bearer "):
            return self._json({"error": {"message": "no auth"}}, 401)
        if u.path == "/users/me/calendarList":
            return self._json({"items": CALENDARS})
        if u.path.startswith("/calendars/") and u.path.endswith("/events"):
            cal = urllib.parse.unquote(u.path.split("/calendars/")[1].rsplit("/events", 1)[0])
            if cal == STATE["fail_calendar"]:
                return self._json({"error": {"message": "backend error"}}, 503)
            items = EVENTS.get(cal, [])
            # One item per page, so pagination is actually exercised.
            page = int(q.get("pageToken") or 0)
            body = {"items": items[page:page + 1]}
            if page + 1 < len(items):
                body["nextPageToken"] = str(page + 1)
            return self._json(body)
        return self._json({"error": {"message": "not found"}}, 404)


FAILURES = []


def check(name, cond, detail=""):
    print(("  PASS  " if cond else "  FAIL  ") + name + ("" if cond else f"   <- {detail}"))
    if not cond:
        FAILURES.append(name)


def main():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Stub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]

    server.GOOGLE_TOKEN_URL = f"http://127.0.0.1:{port}/token"
    server.GOOGLE_API_BASE = f"http://127.0.0.1:{port}"
    server.ensure_data()

    # This writes to data/, so it is run against a throwaway copy of the
    # calendar file and restored at the end.
    original_calendar = server.load_json(server.CALENDAR_FILE)
    original_google = server.load_google_config()
    try:
        run_checks()
    finally:
        server.save_json(server.CALENDAR_FILE, original_calendar)
        server.save_json(server.GOOGLE_CONFIG_FILE, original_google)
        server.reset_google_cache()

    print("\n" + ("ALL PASS" if not FAILURES else f"{len(FAILURES)} FAILED: {FAILURES}"))
    return 1 if FAILURES else 0


def run_checks():
    server.save_google_config({
        "client_id": "cid", "client_secret": "sec", "refresh_token": "refresh-abc",
        "access_token": "", "access_token_expires": 0,
        "blocks_calendar_id": "blocks@example.com", "blocks_calendar_name": "PhD Blocks",
    })
    server.reset_google_cache()
    start = datetime.datetime(2026, 8, 24)
    end = datetime.datetime(2026, 8, 31)

    print("\n-- calendars --")
    cals = server.google_list_calendars()
    check("lists all three", len(cals) == 3, cals)
    check("primary sorts first", cals[0]["primary"] is True, cals[0])
    check("read-only marked not writable",
          not next(c for c in cals if c["id"] == "shared@example.com")["writable"])

    print("\n-- events --")
    evs, failed = server.google_fetch_events_with_status(start, end)
    check("no calendar failed", failed == set(), failed)
    check("cancelled event dropped", not any(e["uid"] == "g9" for e in evs))
    check("paginated past page 1", len(evs) == 6, [e["uid"] for e in evs])
    g1 = next(e for e in evs if e["uid"] == "g1")
    check("offset time -> local naive", g1["start"] == "2026-08-24T09:00:00", g1["start"])
    g2 = next(e for e in evs if e["uid"] == "g2")
    check("all-day -> midnight span",
          (g2["start"], g2["end"]) == ("2026-08-25T00:00:00", "2026-08-26T00:00:00"), g2)
    g3 = next(e for e in evs if e["uid"] == "g3")
    zulu = datetime.datetime(2026, 8, 26, 14, 0, tzinfo=datetime.timezone.utc) \
        .astimezone().replace(tzinfo=None)
    check("Z suffix parsed", g3["start"] == zulu.isoformat(), g3["start"])
    check("provider tagged", all(e["provider"] == "google" for e in evs))

    print("\n-- a failing calendar is reported, never silently empty --")
    server.reset_google_cache()
    STATE["fail_calendar"] = "blocks@example.com"
    evs2, failed2 = server.google_fetch_events_with_status(start, end)
    check("failure surfaces by name", "PhD Blocks" in failed2, failed2)
    check("other calendars still returned", len(evs2) == 4, [e["uid"] for e in evs2])
    try:
        server.reconcile_google_blocks(start, end)
        check("reconcile aborts on a failed read", False, "did not raise")
    except server.ApiError as e:
        check("reconcile aborts on a failed read", "nothing was synced" in str(e), str(e))
    STATE["fail_calendar"] = None
    server.reset_google_cache()

    print("\n-- token handling --")
    before = STATE["token_calls"]
    server.google_list_calendars()
    server.google_list_calendars()
    check("token reused, not re-fetched", STATE["token_calls"] == before,
          STATE["token_calls"] - before)
    STATE["force_401_once"] = True
    server.google_create_event("retry me", "2026-08-24T09:00:00", "2026-08-24T10:00:00")
    check("retries once after a 401", STATE["token_calls"] > before, STATE["token_calls"])

    print("\n-- writes --")
    STATE["written"].clear()
    eid, cid = server.google_create_event("new block", "2026-08-24T09:00:00", "2026-08-24T10:00:00")
    check("create returns id + calendar", (eid, cid) == ("g-new-1", "blocks@example.com"), (eid, cid))
    path, body = STATE["written"][-1]
    check("create targets the blocks calendar",
          "blocks@example.com" in urllib.parse.unquote(path), path)
    sent = body["start"]["dateTime"]
    check("start sent with a UTC offset", "+" in sent[10:] or "-" in sent[10:], sent)
    server.google_delete_event("g4", "blocks@example.com")
    check("delete addressed by id", any("g4" in d for d in STATE["deleted"]), STATE["deleted"])
    server.google_move_event("g4", "blocks@example.com", "primary@example.com")
    check("move uses the move endpoint",
          STATE["moved"] and STATE["moved"][-1][1] == "primary@example.com", STATE["moved"])

    print("\n-- reconcile --")
    server.reset_google_cache()
    server.save_json(server.CALENDAR_FILE, [])
    r = server.reconcile_google_blocks(start, end)
    check("adopts blocks made in Google", r["adopted"] == 2 and r["changed"], r)
    kept = server.load_json(server.CALENDAR_FILE)
    check("adopted rows carry googleId", all(e.get("googleId") for e in kept), kept)
    check("only the blocks calendar is adopted", len(kept) == 2, [e["title"] for e in kept])
    server.reset_google_cache()
    check("second run is a no-op", not server.reconcile_google_blocks(start, end)["changed"])
    kept[0]["title"] = "renamed locally"
    server.save_json(server.CALENDAR_FILE, kept)
    server.reset_google_cache()
    check("remote wins on a difference",
          server.reconcile_google_blocks(start, end)["updated"] == 1)
    kept = server.load_json(server.CALENDAR_FILE)
    kept.append({"id": "evt-x", "title": "vanished", "start": "2026-08-25T09:00:00",
                 "end": "2026-08-25T10:00:00", "color": "#5b7fd6", "todoId": None,
                 "type": "block", "icloudUid": None, "icloudUrl": None,
                 "googleId": "gone-from-google", "googleCalendarId": "blocks@example.com",
                 "calendarName": "PhD Blocks"})
    server.save_json(server.CALENDAR_FILE, kept)
    server.reset_google_cache()
    check("a deletion in Google removes it here",
          server.reconcile_google_blocks(start, end)["removed"] == 1)

    print("\n-- disk cache --")
    server.reset_google_cache()
    server.google_fetch_events_with_status(start, end)
    cached, _ = server.cached_google_window(start, end)
    check("window served from disk", cached is not None and len(cached) == 6,
          cached and len(cached))
    narrow, _ = server.cached_google_window(datetime.datetime(2026, 8, 25),
                                            datetime.datetime(2026, 8, 27))
    check("narrower range filtered from a wider window",
          narrow is not None and len(narrow) < 6, narrow and len(narrow))


if __name__ == "__main__":
    sys.exit(main())
