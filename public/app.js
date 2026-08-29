/* PhD Life Manager — vanilla JS, talks to the local Python API. */

// ---------------------------------------------------------------- helpers

function pad(n) { return String(n).padStart(2, "0"); }
function toLocalISO(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function dateKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function sameDate(a, b) { return dateKey(a) === dateKey(b); }
function startOfWeek(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function hourLabel(h) { const period = h < 12 ? "AM" : "PM"; let hh = h % 12; if (hh === 0) hh = 12; return `${hh} ${period}`; }
function fmtTime(d) {
  let h = d.getHours(); const m = d.getMinutes();
  const period = h < 12 ? "AM" : "PM"; let hh = h % 12; if (hh === 0) hh = 12;
  return `${hh}:${pad(m)} ${period}`;
}
function fmtShort(d) { return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
function escapeHtml(s) {
  return (s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const escapeAttr = escapeHtml;

// ---------------------------------------------------------------- markdown

if (window.marked) {
  marked.setOptions({ breaks: true, gfm: true });
}
function renderMarkdown(src) {
  if (!src || !src.trim()) return "";
  return window.marked ? marked.parse(src) : `<p>${escapeHtml(src)}</p>`;
}

// Converts pasted rich HTML (e.g. from Word) into markdown, keeping only
// heading levels and list structure — everything else becomes plain text.
function htmlClipboardToMarkdown(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const lines = [];

  function directText(el) {
    let text = "";
    el.childNodes.forEach(n => {
      if (n.nodeType === Node.TEXT_NODE) text += n.textContent;
      else if (n.nodeType === Node.ELEMENT_NODE && n.tagName !== "UL" && n.tagName !== "OL") text += n.textContent;
    });
    return text.replace(/\s+/g, " ").trim();
  }

  function walkList(listEl, ordered, depth) {
    let i = 1;
    Array.from(listEl.children).forEach(li => {
      if (li.tagName !== "LI") return;
      const indent = "  ".repeat(depth);
      const text = directText(li);
      if (text) lines.push(`${indent}${ordered ? i + ". " : "- "}${text}`);
      i++;
      Array.from(li.children).forEach(child => {
        if (child.tagName === "UL") walkList(child, false, depth + 1);
        else if (child.tagName === "OL") walkList(child, true, depth + 1);
      });
    });
  }

  function walk(container) {
    Array.from(container.children).forEach(el => {
      const tag = el.tagName;
      if (/^H[1-6]$/.test(tag)) {
        const text = directText(el);
        if (text) { lines.push("#".repeat(Number(tag[1])) + " " + text, ""); }
      } else if (tag === "UL" || tag === "OL") {
        walkList(el, tag === "OL", 0);
        lines.push("");
      } else if (tag === "P" || tag === "DIV" || tag === "LI") {
        const text = directText(el);
        if (text) { lines.push(text, ""); }
        else walk(el);
      } else if (tag === "BR") {
        // skip
      } else {
        walk(el);
      }
    });
  }

  walk(doc.body);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart, end = textarea.selectionEnd;
  const val = textarea.value;
  textarea.value = val.slice(0, start) + text + val.slice(end);
  const pos = start + text.length;
  textarea.selectionStart = textarea.selectionEnd = pos;
}

function attachMarkdownPaste(textarea, onChange) {
  textarea.addEventListener("paste", (e) => {
    const html = e.clipboardData && e.clipboardData.getData("text/html");
    if (!html) return; // plain-text paste: let the browser handle it normally
    e.preventDefault();
    const md = htmlClipboardToMarkdown(html);
    insertAtCursor(textarea, md || (e.clipboardData.getData("text/plain") || ""));
    if (onChange) onChange();
  });
}

const HOURS = Array.from({ length: 17 }, (_, i) => i + 7); // 7am .. 11pm
const CAL_HOUR_PX = 40;

// Places a block in a day column, clamped to the hours the grid actually
// shows. Without this, anything starting before the first hour gets a
// negative offset (drawing over the headers) and anything running long —
// an overnight session someone forgot to stop, an all-day Apple event —
// overflows the grid and pushes the page around.
function calBlockGeometry(start, end) {
  const gridStart = HOURS[0];
  const gridEnd = HOURS[HOURS.length - 1] + 1;
  const gridPx = (gridEnd - gridStart) * CAL_HOUR_PX;
  const startH = start.getHours() + start.getMinutes() / 60 + start.getSeconds() / 3600;
  const endH = startH + Math.max(0, (end - start) / 3600000);
  const top = Math.min(Math.max(0, (Math.max(startH, gridStart) - gridStart) * CAL_HOUR_PX), gridPx - 10);
  const bottom = Math.min(Math.max((Math.min(endH, gridEnd) - gridStart) * CAL_HOUR_PX, top + 10), gridPx);
  return {
    top,
    height: Math.max(10, bottom - top - 2),
    clipped: startH < gridStart || endH > gridEnd,
  };
}
const COLORS = [
  { value: "#5b7fd6", label: "Blue" },
  { value: "#4fa37b", label: "Green" },
  { value: "#c1533f", label: "Red" },
  { value: "#c98a2c", label: "Amber" },
  { value: "#8a5bd6", label: "Purple" },
  { value: "#5c6570", label: "Slate" },
];

async function handleApiResponse(r) {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

const API = {
  get: (p) => fetch(p).then(handleApiResponse),
  post: (p, b) => fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then(handleApiResponse),
  put: (p, b) => fetch(p, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then(handleApiResponse),
  del: (p) => fetch(p, { method: "DELETE" }).then(handleApiResponse),
};

const state = {
  todos: [], events: [], ideas: [], projects: [],
  ideaTagFilter: "",
  weekStart: startOfWeek(new Date()),
  currentProject: null,
  icloudStatus: null,
  externalEvents: [],
  calendars: [],
  focus: {
    running: null, recommendation: null, selectedLink: null, externalEvents: [],
    summaryMode: "day", summaryAnchor: new Date(),
    calendarWeekStart: startOfWeek(new Date()), calendarSessions: [],
  },
  recap: { weeks: [], selectedKey: null, entry: null, editing: false,
           view: "single", pendingKey: null, nudgeDismissed: false },
};

// ---------------------------------------------------------------- toasts
// Saving no longer blocks the page, so anything that goes wrong turns up
// after you have moved on. An alert() would put the waiting back; these say
// it in the corner and leave.

const TOAST_MS = 6000;

function showToast(message, kind = "info") {
  const stack = document.getElementById("toast-stack");
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = message;
  stack.appendChild(el);
  const dismiss = () => {
    if (!el.isConnected || el.classList.contains("leaving")) return;
    el.classList.add("leaving");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  };
  el.addEventListener("click", dismiss);
  setTimeout(dismiss, TOAST_MS);
}

// ---------------------------------------------------------------- modal

function openModal(html, opts = {}) {
  const modalEl = document.getElementById("modal");
  modalEl.innerHTML = html;
  modalEl.classList.toggle("modal-lg", !!opts.large);
  document.getElementById("modal-backdrop").classList.remove("hidden");
}
function closeModal() {
  document.getElementById("modal-backdrop").classList.add("hidden");
  const modalEl = document.getElementById("modal");
  modalEl.innerHTML = "";
  modalEl.classList.remove("modal-lg");
}
document.getElementById("modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "modal-backdrop") closeModal();
});

// ---------------------------------------------------------------- todos

async function addTodo(text, projectSlug = null) {
  const t = await API.post("/api/todos", { text, projectSlug });
  state.todos.push(t);
  renderTodos();
  renderProjectTodos();
}
async function updateTodo(id, patch) {
  const t = await API.put(`/api/todos/${id}`, patch);
  const i = state.todos.findIndex(x => x.id === id);
  state.todos[i] = t;
  renderTodos();
  renderProjectTodos();
  renderCalendarGrid();
}
async function deleteTodo(id) {
  await API.del(`/api/todos/${id}`);
  state.todos = state.todos.filter(t => t.id !== id);
  state.events = await API.get("/api/events");
  renderTodos();
  renderProjectTodos();
  renderCalendarGrid();
}

function projectCodeFor(slug) {
  const p = state.projects.find(x => x.slug === slug);
  return p ? p.code : null;
}

function todoDisplayText(t) {
  const code = t.projectSlug ? projectCodeFor(t.projectSlug) : null;
  return code ? `${code}: ${t.text}` : t.text;
}

function buildTodoLi(t, { showProjectPrefix }) {
  const li = document.createElement("li");
  li.className = "todo-item" + (t.done ? " done" : "") + (t.eventId ? " scheduled" : "");
  li.draggable = true;
  li.addEventListener("dragstart", e => e.dataTransfer.setData("text/plain", t.id));

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = t.done;
  cb.addEventListener("change", () => updateTodo(t.id, { done: cb.checked }));

  const txt = document.createElement("div");
  txt.className = "todo-text";
  const code = showProjectPrefix && t.projectSlug ? projectCodeFor(t.projectSlug) : null;
  if (code) {
    const prefix = document.createElement("span");
    prefix.className = "todo-code";
    prefix.textContent = code + ": ";
    txt.appendChild(prefix);
  }
  txt.appendChild(document.createTextNode(t.text));
  if (t.eventId) {
    const ev = state.events.find(e => e.id === t.eventId);
    if (ev) {
      const meta = document.createElement("div");
      meta.className = "todo-meta";
      meta.textContent = fmtTime(new Date(ev.start)) + " · " + fmtShort(new Date(ev.start));
      txt.appendChild(meta);
    }
  }

  const del = document.createElement("button");
  del.className = "todo-del";
  del.textContent = "✕";
  del.addEventListener("click", () => { if (confirm("Delete this to-do?")) deleteTodo(t.id); });

  li.append(cb, txt, del);
  return li;
}

function renderEmptyState(container, message) {
  const div = document.createElement("div");
  div.className = "empty-state";
  div.textContent = message;
  container.appendChild(div);
}

function renderTodos() {
  const list = document.getElementById("todo-list");
  list.innerHTML = "";
  const todos = state.todos.slice().sort((a, b) => (a.done - b.done) || (new Date(b.createdAt) - new Date(a.createdAt)));
  if (todos.length === 0) { renderEmptyState(list, "No to-dos yet — add one above."); return; }
  todos.forEach(t => list.appendChild(buildTodoLi(t, { showProjectPrefix: true })));
}

function renderProjectTodos() {
  const list = document.getElementById("project-todo-list");
  if (!list || !state.currentProject) return;
  const slug = state.currentProject.slug;
  list.innerHTML = "";
  const todos = state.todos.filter(t => t.projectSlug === slug).slice()
    .sort((a, b) => (a.done - b.done) || (new Date(b.createdAt) - new Date(a.createdAt)));
  if (todos.length === 0) { renderEmptyState(list, "No to-dos for this project yet."); return; }
  todos.forEach(t => list.appendChild(buildTodoLi(t, { showProjectPrefix: false })));
}

document.getElementById("todo-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("todo-input");
  const text = input.value.trim();
  if (!text) return;
  await addTodo(text);
  input.value = "";
});

document.getElementById("project-todo-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.currentProject) return;
  const input = document.getElementById("project-todo-input");
  const text = input.value.trim();
  if (!text) return;
  await addTodo(text, state.currentProject.slug);
  input.value = "";
});

// ---------------------------------------------------------------- calendar

// ------------------------------------------------ optimistic calendar writes
//
// An iCloud round trip takes seconds, and nothing on the grid waits for one.
// Every change is applied to local state and painted at once, the request runs
// behind it, and if the server refuses, the change is rolled back and a toast
// says why. Three things fall out of that, all handled here:
//
//  · A background refresh must not paint over an edit that is still in the
//    air, so refreshes hold off while any write is outstanding — see
//    `calendarWritesPending()` and `isBusyEditing()`.
//  · A block created here has no server id for a moment. Later writes to it
//    are queued behind its create and address it by the id the create
//    returns, which is written into the same object every holder already has.
//  · A server response is only adopted wholesale when it is the last write
//    for that block. Otherwise a newer edit is already queued and the
//    response describes the past; only the identity fields are taken.

const eventWrites = new Map();   // event id -> { queue, outstanding }
let externalWrites = 0;

function calendarWritesPending() { return eventWrites.size > 0 || externalWrites > 0; }

function queueEventWrite(id, run) {
  const slot = eventWrites.get(id) || { queue: Promise.resolve(), outstanding: 0 };
  slot.outstanding++;
  eventWrites.set(id, slot);
  slot.queue = slot.queue.catch(() => {}).then(async () => {
    try {
      await run(() => slot.outstanding === 1);
    } finally {
      slot.outstanding--;
      if (slot.outstanding === 0 && eventWrites.get(id) === slot) eventWrites.delete(id);
    }
  });
  return slot.queue;
}

// Mirrors normalize_event_title() on the server, so a block painted before the
// response lands already carries the right project code instead of picking it
// up a second later.
function stripProjectPrefix(title) {
  for (const p of state.projects) {
    if (p.code && title.startsWith(p.code + ":")) return title.slice(p.code.length + 1).trimStart();
  }
  return title;
}
function eventTitleWithProject(title, projectSlug) {
  const base = stripProjectPrefix(title || "");
  const code = projectSlug ? projectCodeFor(projectSlug) : null;
  return code ? `${code}: ${base}` : base;
}

const SERVER_OWNED = ["id", "icloudUid", "icloudUrl"];
const EVENT_FIELDS = ["title", "start", "end", "color", "calendarName", "todoId", "type"];

function adoptServerEvent(local, saved, authoritative) {
  const { syncWarning, ...record } = saved;
  // The id can change here (a freshly created block trades its temporary one
  // for the real one). Mutating in place rather than swapping the object keeps
  // every closure holding it — a drag in flight, an open editor — pointing at
  // the same block.
  SERVER_OWNED.forEach(k => { if (k in record) local[k] = record[k]; });
  if (authoritative) EVENT_FIELDS.forEach(k => { if (k in record) local[k] = record[k]; });
  delete local.pending;
  if (syncWarning) showToast("Saved here, but iCloud sync failed: " + syncWarning, "warn");
  renderCalendarGrid();
  renderTodos();
}

function createEvent(payload) {
  // Drawn now under a temporary id; the real one arrives with the response.
  const local = {
    id: `tmp-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    title: payload.title || "Untitled block",
    start: payload.start,
    end: payload.end,
    color: payload.color || COLORS[0].value,
    todoId: payload.todoId || null,
    type: payload.type || "block",
    icloudUid: null,
    icloudUrl: null,
    calendarName: payload.calendarName || null,
    pending: true,
  };
  state.events.push(local);
  if (payload.todoId) {
    const t = state.todos.find(x => x.id === payload.todoId);
    if (t) t.eventId = local.id;
  }
  renderCalendarGrid();
  renderTodos();

  queueEventWrite(local.id, async (isLast) => {
    try {
      adoptServerEvent(local, await API.post("/api/events", payload), isLast());
    } catch (e) {
      state.events = state.events.filter(x => x !== local);
      if (payload.todoId) {
        const t = state.todos.find(x => x.id === payload.todoId);
        if (t && t.eventId === local.id) t.eventId = null;
      }
      renderCalendarGrid();
      renderTodos();
      showToast("Couldn't add that block: " + e.message, "error");
    }
  });
  return local;
}

// `patch` is what goes to the server; only the fields the grid draws are
// applied locally, so `projectSlug` (which lives on the to-do) is left out.
function updateEvent(id, patch) {
  const ev = state.events.find(x => x.id === id);
  if (!ev) return Promise.resolve();
  const before = { ...ev };
  EVENT_FIELDS.forEach(k => { if (k in patch) ev[k] = patch[k]; });
  if ("projectSlug" in patch && ev.todoId) {
    const t = state.todos.find(x => x.id === ev.todoId);
    if (t) t.projectSlug = patch.projectSlug || null;
  }
  renderCalendarGrid();
  renderTodos();

  return queueEventWrite(ev.id, async (isLast) => {
    try {
      adoptServerEvent(ev, await API.put(`/api/events/${ev.id}`, patch), isLast());
    } catch (e) {
      Object.assign(ev, before);
      renderCalendarGrid();
      renderTodos();
      showToast("Couldn't save that change: " + e.message, "error");
    }
  });
}

function deleteEvent(id) {
  const ev = state.events.find(x => x.id === id);
  if (!ev) return Promise.resolve();
  const at = state.events.indexOf(ev);
  state.events.splice(at, 1);
  const todo = ev.todoId ? state.todos.find(x => x.id === ev.todoId) : null;
  if (todo) todo.eventId = null;
  // The last pull from iCloud still lists this block, and it was only hidden
  // because a local record claimed its uid. Dropping that record without
  // dropping the copy makes the block reappear in another colour until the
  // next pull, which reads as the delete having failed.
  const twins = ev.icloudUid ? state.externalEvents.filter(x => x.uid === ev.icloudUid) : [];
  if (twins.length) state.externalEvents = state.externalEvents.filter(x => !twins.includes(x));
  renderCalendarGrid();
  renderTodos();

  return queueEventWrite(ev.id, async () => {
    try {
      await API.del(`/api/events/${ev.id}`);
    } catch (e) {
      state.events.splice(Math.min(at, state.events.length), 0, ev);
      if (todo) todo.eventId = ev.id;
      state.externalEvents = state.externalEvents.concat(twins);
      renderCalendarGrid();
      renderTodos();
      showToast("Couldn't delete that block: " + e.message, "error");
    }
  });
}

// ------------------------------------------------- external (iCloud) events
// These have no local record, so the edit is held against the event's URL.
// iCloud can read back its own write stale for a few seconds; without a pin
// the next background pull would snap the block back to where it was and then
// forward again. The pin is dropped as soon as iCloud agrees, or after a
// minute, whichever comes first.

const externalPins = new Map();   // url -> { patch, until }
const EXTERNAL_PIN_MS = 60 * 1000;

function pinExternal(url, patch) {
  externalPins.set(url, { patch, until: Date.now() + EXTERNAL_PIN_MS });
}

function applyExternalPins(list) {
  if (!externalPins.size) return list;
  const now = Date.now();
  for (const [url, pin] of externalPins) if (pin.until < now) externalPins.delete(url);
  return list.map(ev => {
    const pin = externalPins.get(ev.url);
    if (!pin) return ev;
    if (Object.keys(pin.patch).every(k => ev[k] === pin.patch[k])) {
      externalPins.delete(ev.url);   // iCloud has caught up
      return ev;
    }
    return { ...ev, ...pin.patch };
  });
}

function updateExternalEvent(ev, patch) {
  const before = { start: ev.start, end: ev.end, title: ev.title, calendar: ev.calendar };
  Object.assign(ev, patch);
  pinExternal(ev.url, { ...patch });
  renderCalendarGrid();

  externalWrites++;
  return API.put("/api/caldav/event", {
    url: ev.url,
    title: ev.title,
    start: ev.start,
    end: ev.end,
    calendarName: before.calendar,
    targetCalendarName: ev.calendar,
  }).then(res => {
    // A move to another calendar rewrites the event, so the URL it is edited
    // by changes with it.
    if (res && res.url && res.url !== ev.url) {
      externalPins.delete(ev.url);
      ev.url = res.url;
      if (res.uid) ev.uid = res.uid;
      pinExternal(ev.url, { ...patch });
    }
  }).catch(e => {
    externalPins.delete(ev.url);
    Object.assign(ev, before);
    renderCalendarGrid();
    showToast("Couldn't save that iCloud event: " + e.message, "error");
  }).finally(() => { externalWrites--; });
}

function deleteExternalEvent(ev) {
  const at = state.externalEvents.indexOf(ev);
  if (at >= 0) state.externalEvents.splice(at, 1);
  renderCalendarGrid();

  externalWrites++;
  return API.del(`/api/caldav/event?url=${encodeURIComponent(ev.url)}&calendarName=${encodeURIComponent(ev.calendar)}`)
    .catch(e => {
      if (at >= 0) state.externalEvents.splice(Math.min(at, state.externalEvents.length), 0, ev);
      renderCalendarGrid();
      showToast("Couldn't delete that iCloud event: " + e.message, "error");
    })
    .finally(() => { externalWrites--; });
}

function canSyncToICloud() {
  return !!(state.icloudStatus && state.icloudStatus.configured && state.icloudStatus.todosCalendarFound);
}

function scheduleTodoOnDrop(todoId, day, hour) {
  const todo = state.todos.find(t => t.id === todoId);
  if (!todo) return;
  const start = new Date(day); start.setHours(hour, 0, 0, 0);
  const end = new Date(start.getTime() + 60 * 60000);
  createEvent({
    title: todoDisplayText(todo), start: toLocalISO(start), end: toLocalISO(end), todoId: todo.id,
    syncToICloud: canSyncToICloud(),
  });
}

function updateCalRangeLabel() {
  const end = addDays(state.weekStart, 6);
  document.getElementById("cal-range").textContent =
    `${state.weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${end.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

// --------------------------------------------------- drag / resize on grid
// Blocks move and stretch directly on the calendar, snapping to 15 minutes,
// the way Apple and Google Calendar behave. A press that never really moves
// is treated as a click so opening an event still works.

const SNAP_MINUTES = 15;
const DRAG_THRESHOLD_PX = 4;

function snapMinutes(mins) { return Math.round(mins / SNAP_MINUTES) * SNAP_MINUTES; }

function makeBlockInteractive(el, model, ctx) {
  // ctx: { days, getStart, getEnd, commit(startDate, endDate) }
  const grip = document.createElement("div");
  grip.className = "block-grip";
  el.appendChild(grip);

  const begin = (e, mode) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const grid = el.closest(".calendar-grid");
    const cols = Array.from(grid.querySelectorAll(".cal-daycol"));
    const startCol = el.parentElement;
    const startDate = new Date(ctx.getStart(model));
    const endDate = new Date(ctx.getEnd(model));
    const durationMs = endDate - startDate;
    const originX = e.clientX, originY = e.clientY;
    let moved = false, newStart = startDate, newEnd = endDate;

    const onMove = (me) => {
      const dx = me.clientX - originX, dy = me.clientY - originY;
      if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      moved = true;
      el.classList.add("dragging");

      const minutesDelta = snapMinutes((dy / CAL_HOUR_PX) * 60);

      if (mode === "move") {
        // Which column is the pointer over? That decides the day.
        let targetCol = startCol;
        for (const c of cols) {
          const r = c.getBoundingClientRect();
          if (me.clientX >= r.left && me.clientX <= r.right) { targetCol = c; break; }
        }
        const dayShift = cols.indexOf(targetCol) - cols.indexOf(startCol);
        newStart = new Date(startDate.getTime() + minutesDelta * 60000);
        if (dayShift) newStart = addDays(newStart, dayShift);
        newEnd = new Date(newStart.getTime() + durationMs);
      } else {
        newStart = startDate;
        newEnd = new Date(endDate.getTime() + minutesDelta * 60000);
        if (newEnd - newStart < SNAP_MINUTES * 60000) {
          newEnd = new Date(newStart.getTime() + SNAP_MINUTES * 60000);
        }
      }

      const geo = calBlockGeometry(newStart, newEnd);
      el.style.top = geo.top + "px";
      el.style.height = geo.height + "px";
      const nameEl = el.querySelector(".ev-time");
      if (nameEl) nameEl.textContent = `${fmtTime(newStart)}–${fmtTime(newEnd)}`;
    };

    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      el.classList.remove("dragging");
      if (!moved) { ctx.onClick(model); return; }
      // The block is already where it was dropped. commit() records that and
      // sends it on; it never blocks the release, and it puts the block back
      // itself if the write is refused.
      ctx.commit(model, newStart, newEnd);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  el.addEventListener("mousedown", (e) => begin(e, "move"));
  grip.addEventListener("mousedown", (e) => begin(e, "resize"));
}

// ------------------------------------------------- colour blocks by calendar
// Each calendar gets a stable hue derived from its name, so the mapping
// survives reloads and new calendars don't reshuffle the existing ones.
// Hues skip the indigo band the app's own accent occupies.
const CALENDAR_HUES = [352, 18, 38, 62, 88, 112, 148, 172, 192, 262, 288, 318];

function calendarHue(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return CALENDAR_HUES[h % CALENDAR_HUES.length];
}

function isTodosCalendar(name) {
  const todos = (state.icloudStatus && state.icloudStatus.todosCalendarName) || "Todos";
  return !!name && name.trim().toLowerCase() === todos.trim().toLowerCase();
}

// Todos stays solid and saturated; every other calendar is tinted back so
// the work you scheduled here reads first.
function paintBlockByCalendar(el, calendarName, solidColor) {
  if (!calendarName || isTodosCalendar(calendarName)) {
    el.classList.add("solid");
    el.style.background = solidColor || "var(--c-calendar)";
  } else {
    el.classList.add("tinted");
    el.style.setProperty("--block-hue", calendarHue(calendarName));
  }
}

function renderCalendarGrid() {
  const grid = document.getElementById("calendar-grid");
  grid.innerHTML = "";

  const corner = document.createElement("div");
  corner.className = "cal-corner";
  grid.appendChild(corner);

  const days = Array.from({ length: 7 }, (_, i) => addDays(state.weekStart, i));
  const todayKey = dateKey(new Date());

  days.forEach(d => {
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    const head = document.createElement("div");
    head.className = "cal-head" + (dateKey(d) === todayKey ? " today" : "") + (isWeekend ? " weekend" : "");
    head.textContent = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    grid.appendChild(head);
  });

  const labelCol = document.createElement("div");
  HOURS.forEach(h => {
    const lbl = document.createElement("div");
    lbl.className = "cal-hourlabel";
    lbl.style.height = "40px";
    lbl.textContent = hourLabel(h);
    labelCol.appendChild(lbl);
  });
  grid.appendChild(labelCol);

  const now = new Date();
  days.forEach(d => {
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    const col = document.createElement("div");
    col.className = "cal-daycol" + (isWeekend ? " weekend" : "") + (dateKey(d) === todayKey ? " today" : "");
    HOURS.forEach(h => {
      const cell = document.createElement("div");
      cell.className = "cal-cell";
      cell.addEventListener("click", () => openEventModal({ day: d, hour: h }));
      cell.addEventListener("dragover", e => e.preventDefault());
      cell.addEventListener("drop", e => {
        e.preventDefault();
        const todoId = e.dataTransfer.getData("text/plain");
        if (todoId) scheduleTodoOnDrop(todoId, d, h);
      });
      col.appendChild(cell);
    });

    state.events
      .filter(ev => sameDate(new Date(ev.start), d))
      .forEach(ev => {
        const evEl = document.createElement("div");
        evEl.className = "cal-event";
        const s = new Date(ev.start), en = new Date(ev.end);
        const geo = calBlockGeometry(s, en);
        evEl.style.top = geo.top + "px";
        evEl.style.height = geo.height + "px";
        paintBlockByCalendar(evEl, ev.calendarName, ev.color || "#5b7fd6");
        const synced = ev.icloudUid ? " ☁︎" : "";
        evEl.title = `${ev.title} · ${fmtTime(s)}–${fmtTime(en)}`;
        evEl.innerHTML = `<span class="ev-name">${escapeHtml(ev.title)}${synced}</span>`
          + `<span class="ev-time">${fmtTime(s)}–${fmtTime(en)}</span>`;
        makeBlockInteractive(evEl, ev, {
          getStart: (m) => m.start, getEnd: (m) => m.end,
          onClick: (m) => openEventModal({ event: m }),
          commit: (m, ns, ne) => updateEvent(m.id, { start: toLocalISO(ns), end: toLocalISO(ne) }),
        });
        col.appendChild(evEl);
      });

    const localUids = new Set(state.events.map(e => e.icloudUid).filter(Boolean));
    state.externalEvents
      .filter(ev => !localUids.has(ev.uid) && sameDate(new Date(ev.start), d))
      .forEach(ev => {
        const evEl = document.createElement("div");
        evEl.className = "cal-event external";
        paintBlockByCalendar(evEl, ev.calendar, null);
        const s = new Date(ev.start), en = new Date(ev.end);
        const geo = calBlockGeometry(s, en);
        evEl.style.top = geo.top + "px";
        evEl.style.height = geo.height + "px";
        evEl.innerHTML = `<span class="ev-name">${escapeHtml(ev.title)}</span>`
          + `<span class="ev-time">${fmtTime(s)}–${fmtTime(en)}</span>`;
        evEl.title = `${ev.title} · ${fmtTime(s)}–${fmtTime(en)} (iCloud · ${ev.calendar})`;
        makeBlockInteractive(evEl, ev, {
          getStart: (m) => m.start, getEnd: (m) => m.end,
          onClick: (m) => openEventModal({ external: m }),
          commit: (m, ns, ne) => updateExternalEvent(m, { start: toLocalISO(ns), end: toLocalISO(ne) }),
        });
        col.appendChild(evEl);
      });

    if (sameDate(now, d)) {
      const nowHour = now.getHours() + now.getMinutes() / 60;
      if (nowHour >= HOURS[0] && nowHour <= HOURS[HOURS.length - 1] + 1) {
        const nowLine = document.createElement("div");
        nowLine.className = "cal-now-line";
        nowLine.style.top = ((nowHour - HOURS[0]) * 40) + "px";
        col.appendChild(nowLine);
      }
    }

    grid.appendChild(col);
  });
}

function toDatetimeLocalValue(d) { return toLocalISO(d).slice(0, 16); }

// One editor for every block on the grid. `opts.event` is an app block
// (has an id, may be linked to a to-do); `opts.external` is an event that
// lives only on iCloud and is edited in place on its own calendar.
function openEventModal(opts) {
  const ext = opts.external || null;
  const ev = opts.event || null;
  const isEdit = !!(ev || ext);

  let defaultStart, defaultEnd, defaultTitle = "";
  if (ev) { defaultStart = new Date(ev.start); defaultEnd = new Date(ev.end); defaultTitle = ev.title; }
  else if (ext) { defaultStart = new Date(ext.start); defaultEnd = new Date(ext.end); defaultTitle = ext.title; }
  else {
    defaultStart = new Date(opts.day);
    defaultStart.setHours(opts.hour, opts.minute || 0, 0, 0);
    defaultEnd = new Date(defaultStart.getTime() + 60 * 60000);
  }

  const defaultCal = state.icloudStatus ? state.icloudStatus.todosCalendarName : "Todos";
  const currentCal = ext ? ext.calendar : (ev && ev.calendarName) || defaultCal;
  const cals = state.calendars || [];
  // A to-do's block belongs with the to-dos; moving it elsewhere would break
  // the link the sidebar relies on.
  const lockedToTodos = !!(ev && ev.todoId);

  const calField = cals.length ? `
    <label>Calendar</label>
    <select id="ev-calendar" ${lockedToTodos ? "disabled" : ""}>
      ${cals.map(c => `<option value="${escapeAttr(c.name)}" ${c.name === currentCal ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}
    </select>
    ${lockedToTodos ? `<div class="hint" style="margin-top:5px;">Stays on "${escapeHtml(defaultCal)}" because it is scheduled from a to-do.</div>` : ""}` : "";

  // Only Todos blocks carry a to-do, and the to-do is what holds the
  // project link — so the field appears there and nowhere else.
  const showProject = !ext && isTodosCalendar(currentCal);
  const linkedTodo = ev && ev.todoId ? state.todos.find(t => t.id === ev.todoId) : null;
  const currentProject = linkedTodo ? (linkedTodo.projectSlug || "") : "";
  const projectField = showProject ? `
    <label>Project</label>
    <select id="ev-project">
      <option value="">No project</option>
      ${state.projects.map(p => `<option value="${escapeAttr(p.slug)}" ${p.slug === currentProject ? "selected" : ""}>${escapeHtml(p.title)}</option>`).join("")}
    </select>
    <div class="hint" style="margin-top:5px;">Adds this to your to-dos and the project's list.</div>` : "";

  const colorField = ext ? "" : `
    <label>Color</label>
    <select id="ev-color">
      ${COLORS.map(c => `<option value="${c.value}" ${ev && ev.color === c.value ? "selected" : ""}>${c.label}</option>`).join("")}
    </select>`;

  openModal(`
    <h3>${isEdit ? "Edit event" : "New event"}</h3>
    <label>Title</label>
    <input type="text" id="ev-title" value="${escapeAttr(defaultTitle)}" placeholder="What are you working on?" />
    <div class="field-row">
      <div><label>Start</label><input type="datetime-local" id="ev-start" value="${toDatetimeLocalValue(defaultStart)}"/></div>
      <div><label>End</label><input type="datetime-local" id="ev-end" value="${toDatetimeLocalValue(defaultEnd)}"/></div>
    </div>
    ${calField}
    ${projectField}
    ${colorField}
    <div class="modal-actions">
      ${isEdit ? '<button class="danger-btn" id="ev-delete">Delete</button>' : ""}
      <div class="spacer"></div>
      <button class="secondary-btn" id="ev-cancel">Cancel</button>
      <button class="primary-btn" id="ev-save">${isEdit ? "Save" : "Add event"}</button>
    </div>
  `);

  // Moving the start drags the end along, keeping the duration — the way
  // Apple and Google Calendar behave. Editing the end sets a new duration.
  const startEl = document.getElementById("ev-start");
  const endEl = document.getElementById("ev-end");
  let durationMs = defaultEnd - defaultStart;
  startEl.addEventListener("change", () => {
    if (!startEl.value) return;
    const s = new Date(startEl.value);
    endEl.value = toDatetimeLocalValue(new Date(s.getTime() + durationMs));
  });
  endEl.addEventListener("change", () => {
    if (!startEl.value || !endEl.value) return;
    const d = new Date(endEl.value) - new Date(startEl.value);
    if (d > 0) durationMs = d;
  });

  document.getElementById("ev-cancel").onclick = closeModal;

  if (isEdit) {
    document.getElementById("ev-delete").onclick = () => {
      if (!confirm("Delete this event?")) return;
      // Gone from the grid at once; the request follows, and puts it back if
      // it fails.
      if (ev) deleteEvent(ev.id);
      else deleteExternalEvent(ext);
      closeModal();
    };
  }

  // Saving does not wait on the network. The change is validated, applied to
  // the grid, and the dialog closes; the request goes out behind it and
  // reports back through a toast if the server disagrees.
  document.getElementById("ev-save").onclick = () => {
    const title = document.getElementById("ev-title").value.trim() || "Untitled event";
    const start = startEl.value, end = endEl.value;
    // A toast rather than an alert: the dialog stays open on the bad value so
    // it can be corrected, which a modal on top of it would only get in the way of.
    if (!start || !end || start >= end) { showToast("End must be after start.", "error"); return; }
    const calEl = document.getElementById("ev-calendar");
    const targetCal = calEl && !calEl.disabled ? calEl.value : currentCal;
    const colorEl = document.getElementById("ev-color");
    const projEl = document.getElementById("ev-project");

    if (ext) {
      updateExternalEvent(ext, {
        title, start: start + ":00", end: end + ":00", calendar: targetCal,
      });
    } else if (ev) {
      const patch = {
        title, start: start + ":00", end: end + ":00",
        color: colorEl ? colorEl.value : ev.color,
        calendarName: targetCal,
      };
      if (projEl) {
        patch.projectSlug = projEl.value || null;
        // The server prefixes the block with the project's code; do the same
        // here so the title on the grid doesn't change again a second later.
        patch.title = eventTitleWithProject(title, patch.projectSlug);
      }
      updateEvent(ev.id, patch).then(() => {
        // The to-do carrying the link may have just been created, or moved
        // between projects.
        if (projEl) refreshTodosQuietly();
      });
    } else {
      createEvent({
        title, start: start + ":00", end: end + ":00",
        color: colorEl ? colorEl.value : COLORS[0].value,
        syncToICloud: canSyncToICloud(), calendarName: targetCal,
      });
    }
    closeModal();
  };
}

async function refreshTodosQuietly() {
  try {
    state.todos = await API.get("/api/todos");
    renderTodos();
    renderProjectTodos();
  } catch (e) { /* the next refresh will pick it up */ }
}

document.getElementById("cal-prev").addEventListener("click", () => { state.weekStart = addDays(state.weekStart, -7); showCalendarWeek(); });
document.getElementById("cal-next").addEventListener("click", () => { state.weekStart = addDays(state.weekStart, 7); showCalendarWeek(); });
document.getElementById("cal-today").addEventListener("click", () => { state.weekStart = startOfWeek(new Date()); showCalendarWeek(); });

// ---------------------------------------------------------------- iCloud

async function loadICloudStatus() {
  try {
    state.icloudStatus = await API.get("/api/caldav/status");
  } catch (e) {
    state.icloudStatus = { configured: false, connected: false, error: String(e) };
  }
  updateICloudButton();
}

function updateICloudButton() {
  const btn = document.getElementById("icloud-status-btn");
  const s = state.icloudStatus;
  btn.classList.remove("connected", "error");
  if (!s || !s.configured) {
    btn.textContent = "iCloud: connect…";
  } else if (s.connected && s.todosCalendarFound) {
    btn.textContent = `iCloud: connected ✓`;
    btn.classList.add("connected");
  } else if (s.connected) {
    btn.textContent = `iCloud: connected, no "${s.todosCalendarName}" calendar`;
    btn.classList.add("error");
  } else {
    btn.textContent = "iCloud: connection error";
    btn.classList.add("error");
  }
}

async function loadCalendars() {
  if (!state.icloudStatus || !state.icloudStatus.connected) { state.calendars = []; return; }
  try { state.calendars = await API.get("/api/caldav/calendars"); }
  catch (e) { state.calendars = []; }
}

function calendarWeekQuery() {
  const start = toLocalISO(state.weekStart);
  const end = toLocalISO(addDays(state.weekStart, 7));
  return `start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
}

// What iCloud looked like the last time anyone asked, served off disk. No
// network, so a week paints in the same frame as the local data instead of a
// few seconds later.
async function loadCachedExternalEvents() {
  if (!state.icloudStatus || !state.icloudStatus.configured) { state.externalEvents = []; return; }
  try {
    state.externalEvents = applyExternalPins(await API.get(`/api/caldav/events?${calendarWeekQuery()}&cached=1`));
  } catch (e) {
    state.externalEvents = [];
  }
}

// The slow half. Talks to iCloud, so it is never on the path to a first paint.
async function loadExternalEvents() {
  if (!state.icloudStatus || !state.icloudStatus.configured) { state.externalEvents = []; renderCalendarGrid(); return; }
  const qs = calendarWeekQuery();

  // Pull any edits made in the Apple "Todos" calendar back in first, so
  // events changed or created there show up here and stay editable.
  if (state.icloudStatus.todosCalendarFound) {
    try {
      const res = await API.post(`/api/caldav/sync?${qs}`, {});
      // A write of our own that is still in the air is newer than anything
      // this reply can know about, so it is left to land on its own.
      if (res.changed && !calendarWritesPending()) {
        state.events = res.events;
        renderTodos();
      }
    } catch (e) {
      /* leave local events as they are if the pull fails */
    }
  }

  try {
    state.externalEvents = applyExternalPins(await API.get(`/api/caldav/events?${qs}`));
  } catch (e) {
    state.externalEvents = [];
  }
  renderCalendarGrid();
}

// Changing week: draw what is known, then go and check. Both passes repaint,
// and the cached one is usually the only one you notice.
function showCalendarWeek() {
  renderCalendarGrid();
  updateCalRangeLabel();
  loadCachedExternalEvents().then(() => {
    renderCalendarGrid();
    return loadExternalEvents();
  });
}

document.getElementById("icloud-status-btn").addEventListener("click", openICloudSettingsModal);

async function openICloudSettingsModal() {
  const cfg = await API.get("/api/caldav/config");
  const s = state.icloudStatus;
  let statusLine = "Not connected yet.";
  if (s && s.configured) {
    if (s.connected && s.todosCalendarFound) statusLine = `Connected. Writing routine blocks to "${escapeHtml(s.todosCalendarName)}".`;
    else if (s.connected) statusLine = `Connected to iCloud, but no calendar named "${escapeHtml(s.todosCalendarName)}" was found. Create it in the Calendar app.`;
    else statusLine = `Configured, but connection failed: ${escapeHtml(s.error || "unknown error")}`;
  }
  openModal(`
    <h3>Connect iCloud Calendar</h3>
    <div class="hint">${statusLine}</div>
    <label>Apple ID (email)</label>
    <input type="text" id="ic-username" value="${escapeAttr(cfg.icloudUsername)}" placeholder="you@icloud.com" />
    <label>App-specific password</label>
    <input type="password" id="ic-password" placeholder="${cfg.hasPassword ? "•••••••••••• (leave blank to keep)" : "xxxx-xxxx-xxxx-xxxx"}" />
    <div class="hint">Generate one at <strong>appleid.apple.com</strong> → Sign-In and Security → App-Specific Passwords. Your regular Apple ID password won't work here. This is stored only in <code>data/caldav_config.json</code> on your machine.</div>
    <label>Routine calendar name</label>
    <input type="text" id="ic-calendar-name" value="${escapeAttr(cfg.todosCalendarName)}" placeholder="Todos" />
    <div class="hint">Must match a calendar you've already created in the Calendar app / iCloud.</div>
    <div class="modal-actions">
      <div class="spacer"></div>
      <button class="secondary-btn" id="ic-cancel">Close</button>
      <button class="primary-btn" id="ic-save">Save & test</button>
    </div>
  `);
  document.getElementById("ic-cancel").onclick = closeModal;
  document.getElementById("ic-save").onclick = async () => {
    const icloudUsername = document.getElementById("ic-username").value.trim();
    const icloudAppPassword = document.getElementById("ic-password").value;
    const todosCalendarName = document.getElementById("ic-calendar-name").value.trim() || "Todos";
    await API.post("/api/caldav/config", { icloudUsername, icloudAppPassword, todosCalendarName });
    await loadICloudStatus();
    await loadExternalEvents();
    closeModal();
    openICloudSettingsModal();
  };
}

// ---------------------------------------------------------------- ideas

// Filter values are namespaced so the starred pseudo-filter can never
// collide with a real tag. (A bare sentinel using \u0000 does not survive
// HTML parsing — the browser rewrites it and the <select> stops matching.)
const STARRED_FILTER = "starred";
const TAG_PREFIX = "tag:";
function activeTagFilter() {
  const f = state.ideaTagFilter || "";
  return f.startsWith(TAG_PREFIX) ? f.slice(TAG_PREFIX.length) : null;
}

async function toggleIdeaStar(idea) {
  const next = !idea.starred;
  idea.starred = next;                     // optimistic, so the press feels instant
  renderIdeas();
  try {
    const updated = await API.put(`/api/ideas/${idea.id}`, { starred: next });
    Object.assign(idea, updated);
  } catch (e) {
    idea.starred = !next;                  // put it back if the save failed
    alert("Could not save the star: " + e.message);
  }
  renderIdeas();
}

function ideaDisplayTitle(idea) {
  if (idea.title && idea.title.trim()) return idea.title.trim();
  const firstLine = idea.text.trim().split("\n")[0].replace(/^#+\s*/, "").replace(/[*_`]+/g, "").trim();
  return firstLine.slice(0, 80) || "Untitled idea";
}

function computeIdeaTagCounts() {
  const counts = {};
  state.ideas.forEach(idea => {
    (idea.tags || []).forEach(t => { counts[t] = (counts[t] || 0) + 1; });
  });
  return counts;
}

function renderIdeaTagFilterOptions() {
  const select = document.getElementById("idea-tag-filter");
  const tagCounts = computeIdeaTagCounts();
  const sortedTags = Object.keys(tagCounts).sort((a, b) => tagCounts[b] - tagCounts[a] || a.localeCompare(b));
  const starred = state.ideas.filter(i => i.starred).length;
  select.innerHTML = `<option value="">All tags (${state.ideas.length})</option>`
    + (starred ? `<option value="${STARRED_FILTER}">\u2605 Starred (${starred})</option>` : "")
    + sortedTags.map(t => `<option value="${escapeAttr(TAG_PREFIX + t)}">${escapeHtml(t)} (${tagCounts[t]})</option>`).join("");
  select.value = state.ideaTagFilter || "";
  state.ideaTagFilter = select.value; // in case the previously selected tag no longer exists
}

function renderIdeas() {
  const grid = document.getElementById("idea-grid");
  grid.innerHTML = "";
  renderIdeaTagFilterOptions();
  const ideas = state.ideas
    .filter(idea => {
      if (!state.ideaTagFilter) return true;
      if (state.ideaTagFilter === STARRED_FILTER) return !!idea.starred;
      const tag = activeTagFilter();
      return tag === null || (idea.tags || []).includes(tag);
    })
    .slice()
    .sort((a, b) => new Date(b.created) - new Date(a.created));
  if (ideas.length === 0) {
    renderEmptyState(grid, !state.ideaTagFilter ? "No ideas yet — jot one down above."
      : state.ideaTagFilter === STARRED_FILTER ? "No starred ideas yet."
      : `No ideas tagged "${activeTagFilter()}".`);
    return;
  }
  ideas
    .forEach(idea => {
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        <button class="star-btn${idea.starred ? " on" : ""}" title="${idea.starred ? "Starred" : "Star this idea"}"
          aria-pressed="${!!idea.starred}">${idea.starred ? "\u2605" : "\u2606"}</button>
        <div class="card-title">${escapeHtml(ideaDisplayTitle(idea))}</div>
        <div class="card-preview">${escapeHtml(idea.text.slice(0, 200))}${idea.text.length > 200 ? "…" : ""}</div>
        <div class="card-tags">${idea.tags.map(t => `<span class="tag-chip">${escapeHtml(t)}</span>`).join("")}</div>
        <div class="card-footer">${fmtShort(new Date(idea.created))}${idea.links.length ? ` · ${idea.links.length} link(s)` : ""}</div>
      `;
      card.addEventListener("click", () => openIdeaModal(idea));
      // Starring is a one-press action, so it must not open the idea.
      card.querySelector(".star-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        toggleIdeaStar(idea);
      });
      grid.appendChild(card);
    });
}

document.getElementById("idea-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const titleEl = document.getElementById("idea-title-input");
  const textEl = document.getElementById("idea-input");
  const tagsEl = document.getElementById("idea-tags-input");
  const text = textEl.value.trim();
  if (!text) return;
  const title = titleEl.value.trim();
  const tags = tagsEl.value.split(",").map(s => s.trim()).filter(Boolean);
  const idea = await API.post("/api/ideas", { title, text, tags });
  state.ideas.push(idea);
  titleEl.value = ""; textEl.value = ""; tagsEl.value = "";
  document.getElementById("idea-input-preview").innerHTML = "";
  renderIdeas();
});

document.getElementById("idea-tag-filter").addEventListener("change", (e) => {
  state.ideaTagFilter = e.target.value;
  renderIdeas();
});

function openIdeaModal(idea) {
  let editing = false;
  let links = idea.links.slice();

  function renderView() {
    openModal(`
      <div class="modal-header-row">
        <h3>${escapeHtml(ideaDisplayTitle(idea))}</h3>
        <div class="modal-header-actions">
          <button class="star-btn inline${idea.starred ? " on" : ""}" id="idea-star-btn"
            title="${idea.starred ? "Starred" : "Star this idea"}">${idea.starred ? "\u2605" : "\u2606"}</button>
          <button class="secondary-btn" id="idea-edit-btn">Edit</button>
        </div>
      </div>
      <div class="text-view">${renderMarkdown(idea.text)}</div>
      <div class="card-tags" style="margin-top:16px;">${idea.tags.map(t => `<span class="tag-chip">${escapeHtml(t)}</span>`).join("") || '<span class="hint">no tags</span>'}</div>
      <div class="hint" style="margin-top:14px;">Linked ideas</div>
      <div class="card-tags" style="margin-top:4px;">${idea.links.map(lid => {
        const li = state.ideas.find(i => i.id === lid);
        return `<span class="tag-chip">${li ? escapeHtml(ideaDisplayTitle(li)) : lid}</span>`;
      }).join("") || '<span class="hint">none</span>'}</div>
      <div class="hint" style="margin-top:16px;">${fmtShort(new Date(idea.created))}</div>
      <div class="modal-actions">
        <button class="danger-btn" id="idea-delete">Delete</button>
        <button class="secondary-btn" id="idea-move">Move to project…</button>
        <div class="spacer"></div>
        <button class="secondary-btn" id="idea-close">Close</button>
      </div>
    `, { large: true });
    document.getElementById("idea-close").onclick = closeModal;
    document.getElementById("idea-star-btn").onclick = async () => {
      await toggleIdeaStar(idea);
      renderView();
    };
    document.getElementById("idea-edit-btn").onclick = () => { editing = true; renderEdit(); };
    wireCommonActions();
  }

  function renderEdit() {
    const otherIdeas = state.ideas.filter(i => i.id !== idea.id);
    openModal(`
      <div class="modal-header-row"><h3>Edit idea</h3></div>
      <input type="text" id="idea-edit-title" class="plain-field title-edit" value="${escapeAttr(idea.title || "")}" placeholder="Title (optional — auto-filled from the first line if left blank)" />
      <div class="md-edit-split" style="margin-top:14px;">
        <div class="md-edit-col">
          <div class="md-col-label">Markdown</div>
          <textarea id="idea-edit-text" class="plain-field body-edit md-source" rows="14">${escapeHtml(idea.text)}</textarea>
        </div>
        <div class="md-edit-col">
          <div class="md-col-label">Preview</div>
          <div id="idea-edit-preview" class="text-view md-preview"></div>
        </div>
      </div>
      <label>Tags (comma separated)</label>
      <input type="text" id="idea-edit-tags" class="plain-field" value="${escapeAttr(idea.tags.join(", "))}" />
      <label style="margin-top:14px;">Linked ideas</label>
      <div id="idea-links-list">${links.map(lid => {
        const li = state.ideas.find(i => i.id === lid);
        return `<span class="tag-chip" style="margin:2px 4px 2px 0; display:inline-block;">${li ? escapeHtml(ideaDisplayTitle(li)) : lid} <span data-unlink="${lid}" style="cursor:pointer;">✕</span></span>`;
      }).join("") || '<span class="hint">none</span>'}</div>
      <select id="idea-link-select">
        <option value="">Link another idea…</option>
        ${otherIdeas.map(i => `<option value="${i.id}">${escapeHtml(ideaDisplayTitle(i))}</option>`).join("")}
      </select>
      <div class="modal-actions">
        <button class="danger-btn" id="idea-delete">Delete</button>
        <button class="secondary-btn" id="idea-move">Move to project…</button>
        <div class="spacer"></div>
        <button class="secondary-btn" id="idea-cancel">Cancel</button>
        <button class="primary-btn" id="idea-save">Save</button>
      </div>
    `, { large: true });
    const ideaTextEl = document.getElementById("idea-edit-text");
    const ideaPreviewEl = document.getElementById("idea-edit-preview");
    const updateIdeaPreview = () => { ideaPreviewEl.innerHTML = renderMarkdown(ideaTextEl.value); };
    updateIdeaPreview();
    ideaTextEl.addEventListener("input", updateIdeaPreview);
    attachMarkdownPaste(ideaTextEl, updateIdeaPreview);
    document.querySelectorAll("[data-unlink]").forEach(el => {
      el.addEventListener("click", () => { links = links.filter(l => l !== el.dataset.unlink); el.parentElement.remove(); });
    });
    document.getElementById("idea-link-select").addEventListener("change", (e) => {
      const val = e.target.value;
      if (val && !links.includes(val)) links.push(val);
      e.target.value = "";
    });
    document.getElementById("idea-cancel").onclick = () => { links = idea.links.slice(); editing = false; renderView(); };
    document.getElementById("idea-save").onclick = async () => {
      const title = document.getElementById("idea-edit-title").value.trim();
      const text = document.getElementById("idea-edit-text").value.trim();
      const tags = document.getElementById("idea-edit-tags").value.split(",").map(s => s.trim()).filter(Boolean);
      const updated = await API.put(`/api/ideas/${idea.id}`, { title, text, tags, links });
      Object.assign(idea, updated);
      const i = state.ideas.findIndex(x => x.id === idea.id);
      state.ideas[i] = idea;
      renderIdeas();
      editing = false;
      renderView();
    };
    wireCommonActions();
  }

  function wireCommonActions() {
    document.getElementById("idea-delete").onclick = async () => {
      if (confirm("Delete this idea permanently?")) {
        await API.del(`/api/ideas/${idea.id}`);
        state.ideas = state.ideas.filter(i => i.id !== idea.id);
        renderIdeas(); closeModal();
      }
    };
    document.getElementById("idea-move").onclick = () => openMoveIdeaModal(idea);
  }

  renderView();
}

function openMoveIdeaModal(idea) {
  openModal(`
    <h3>Move idea to a project</h3>
    <label>Existing project</label>
    <select id="move-project-select">
      <option value="">— choose —</option>
      ${state.projects.map(p => `<option value="${p.slug}">${escapeHtml(p.title)}</option>`).join("")}
    </select>
    <label>…or create a new project</label>
    <input type="text" id="move-new-title" placeholder="New project title" />
    <div class="modal-actions">
      <div class="spacer"></div>
      <button class="secondary-btn" id="move-cancel">Cancel</button>
      <button class="primary-btn" id="move-confirm">Move</button>
    </div>
  `);
  document.getElementById("move-cancel").onclick = closeModal;
  document.getElementById("move-confirm").onclick = async () => {
    const slug = document.getElementById("move-project-select").value;
    const newTitle = document.getElementById("move-new-title").value.trim();
    if (!slug && !newTitle) { alert("Pick a project or enter a new title."); return; }
    const payload = slug ? { projectSlug: slug } : { newProjectTitle: newTitle };
    await API.post(`/api/ideas/${idea.id}/promote`, payload);
    state.ideas = state.ideas.filter(i => i.id !== idea.id);
    state.projects = await API.get("/api/projects");
    renderIdeas(); renderProjects();
    closeModal();
  };
}

// ---------------------------------------------------------------- projects

function renderProjects() {
  const grid = document.getElementById("project-grid");
  grid.innerHTML = "";
  const projects = state.projects.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (projects.length === 0) { renderEmptyState(grid, "No projects yet — create one, or move an idea into one."); return; }
  projects
    .forEach(p => {
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        <div class="badge-row">
          <div class="status-badge">${escapeHtml(p.status || "active")}</div>
          <div class="code-badge">${escapeHtml(p.code || "")}</div>
        </div>
        <div class="card-title">${escapeHtml(p.title)}</div>
        <div class="card-preview">${escapeHtml(p.description || "")}</div>
        <div class="card-tags">${(p.tags || []).map(t => `<span class="tag-chip">${escapeHtml(t)}</span>`).join("")}</div>
        <div class="card-footer">${p.memoCount || 0} memo(s) · ${fmtShort(new Date(p.createdAt))}</div>
      `;
      card.addEventListener("click", () => openProjectDetail(p.slug));
      grid.appendChild(card);
    });
}

function deriveCode(title) {
  const words = title.trim().split(/\s+/).filter(w => /[a-zA-Z0-9]/.test(w));
  if (words.length >= 2) return words.slice(0, 4).map(w => w[0].toUpperCase()).join("");
  return (title.replace(/[^a-zA-Z0-9]/g, "").slice(0, 4) || "PRJ").toUpperCase();
}

document.getElementById("new-project-btn").addEventListener("click", () => {
  openModal(`
    <h3>New project</h3>
    <label>Title</label><input type="text" id="np-title" />
    <div class="field-row">
      <div>
        <label>Code <span class="hint">(shown on to-dos synced from this project)</span></label>
        <input type="text" id="np-code" maxlength="8" style="text-transform:uppercase;" />
      </div>
      <div>
        <label>Status</label>
        <select id="np-status"><option value="active">active</option><option value="planning">planning</option><option value="on hold">on hold</option><option value="done">done</option></select>
      </div>
    </div>
    <label>Description</label><textarea id="np-desc" rows="3"></textarea>
    <label>Tags (comma separated)</label><input type="text" id="np-tags" />
    <div class="modal-actions">
      <div class="spacer"></div>
      <button class="secondary-btn" id="np-cancel">Cancel</button>
      <button class="primary-btn" id="np-save">Create</button>
    </div>
  `);
  const titleEl = document.getElementById("np-title");
  const codeEl = document.getElementById("np-code");
  let codeTouched = false;
  codeEl.addEventListener("input", () => { codeTouched = true; });
  titleEl.addEventListener("input", () => { if (!codeTouched) codeEl.value = deriveCode(titleEl.value); });
  document.getElementById("np-cancel").onclick = closeModal;
  document.getElementById("np-save").onclick = async () => {
    const title = titleEl.value.trim();
    if (!title) { alert("Title required."); return; }
    const code = codeEl.value.trim().toUpperCase() || deriveCode(title);
    const description = document.getElementById("np-desc").value.trim();
    const status = document.getElementById("np-status").value;
    const tags = document.getElementById("np-tags").value.split(",").map(s => s.trim()).filter(Boolean);
    const p = await API.post("/api/projects", { title, code, description, status, tags });
    state.projects.push(p);
    renderProjects(); closeModal();
  };
});

async function openProjectDetail(slug) {
  const data = await API.get(`/api/projects/${slug}`);
  state.currentProject = data;
  document.getElementById("projects-list-view").classList.add("hidden");
  document.getElementById("project-detail-view").classList.remove("hidden");
  renderProjectDetailHeader();
  renderProjectTodos();
  renderMemoGrid();
}

function backToProjects() {
  document.getElementById("project-detail-view").classList.add("hidden");
  document.getElementById("projects-list-view").classList.remove("hidden");
  state.currentProject = null;
}
document.getElementById("back-to-projects").addEventListener("click", backToProjects);

function renderProjectDetailHeader() {
  const p = state.currentProject;
  document.getElementById("project-detail-header").innerHTML = `
    <div class="badge-row">
      <div class="status-badge">${escapeHtml(p.status)}</div>
      <div class="code-badge">${escapeHtml(p.code || "")}</div>
    </div>
    <div class="card-title">${escapeHtml(p.title)}</div>
    <div class="card-preview">${escapeHtml(p.description || "")}</div>
    <div class="card-tags">${(p.tags || []).map(t => `<span class="tag-chip">${escapeHtml(t)}</span>`).join("")}</div>
    <div class="modal-actions" style="margin-top:10px; justify-content:flex-start;">
      <button class="secondary-btn" id="edit-project-btn">Edit info</button>
      <button class="danger-btn" id="delete-project-btn">Delete project</button>
    </div>
  `;
  document.getElementById("edit-project-btn").onclick = openEditProjectModal;
  document.getElementById("delete-project-btn").onclick = async () => {
    if (confirm(`Delete project "${p.title}" and all its memos? This cannot be undone.`)) {
      await API.del(`/api/projects/${p.slug}`);
      state.projects = state.projects.filter(x => x.slug !== p.slug);
      backToProjects();
      renderProjects();
    }
  };
}

function openEditProjectModal() {
  const p = state.currentProject;
  openModal(`
    <h3>Edit project</h3>
    <label>Title</label><input type="text" id="ep-title" value="${escapeAttr(p.title)}" />
    <div class="field-row">
      <div>
        <label>Code <span class="hint">(shown on to-dos synced from this project)</span></label>
        <input type="text" id="ep-code" maxlength="8" style="text-transform:uppercase;" value="${escapeAttr(p.code || "")}" />
      </div>
      <div>
        <label>Status</label>
        <select id="ep-status">
          ${["active", "planning", "on hold", "done"].map(s => `<option value="${s}" ${p.status === s ? "selected" : ""}>${s}</option>`).join("")}
        </select>
      </div>
    </div>
    <label>Description</label><textarea id="ep-desc" rows="3">${escapeHtml(p.description || "")}</textarea>
    <label>Tags (comma separated)</label><input type="text" id="ep-tags" value="${escapeAttr((p.tags || []).join(", "))}" />
    <div class="modal-actions">
      <div class="spacer"></div>
      <button class="secondary-btn" id="ep-cancel">Cancel</button>
      <button class="primary-btn" id="ep-save">Save</button>
    </div>
  `);
  document.getElementById("ep-cancel").onclick = closeModal;
  document.getElementById("ep-save").onclick = async () => {
    const title = document.getElementById("ep-title").value.trim();
    const code = document.getElementById("ep-code").value.trim().toUpperCase() || deriveCode(title);
    const description = document.getElementById("ep-desc").value.trim();
    const status = document.getElementById("ep-status").value;
    const tags = document.getElementById("ep-tags").value.split(",").map(s => s.trim()).filter(Boolean);
    const updated = await API.put(`/api/projects/${p.slug}`, { title, code, description, status, tags });
    state.currentProject = { ...state.currentProject, ...updated };
    const idx = state.projects.findIndex(x => x.slug === p.slug);
    if (idx >= 0) state.projects[idx] = { ...state.projects[idx], ...updated };
    renderProjectDetailHeader();
    closeModal();
  };
}

function renderMemoGrid() {
  const grid = document.getElementById("memo-grid");
  if (!state.currentProject) return;
  grid.innerHTML = "";
  const memos = (state.currentProject.memos || []).slice().sort((a, b) => new Date(b.created) - new Date(a.created));
  if (memos.length === 0) { renderEmptyState(grid, "No memos yet — add one, or move an idea in."); return; }
  memos
    .forEach(m => {
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        <div class="card-title">${escapeHtml(m.title)}</div>
        <div class="card-preview">${escapeHtml(m.synopsis)}</div>
        <div class="card-footer">${fmtShort(new Date(m.created))}</div>
      `;
      card.addEventListener("click", () => openMemoModal(m.id));
      grid.appendChild(card);
    });
}

document.getElementById("new-memo-btn").addEventListener("click", () => {
  openModal(`
    <h3>New memo</h3>
    <label>Title</label><input type="text" id="nm-title" />
    <label>Synopsis (optional — auto-filled from body if left blank)</label><input type="text" id="nm-synopsis" />
    <label>Body</label>
    <div class="md-edit-split">
      <div class="md-edit-col">
        <div class="md-col-label">Markdown</div>
        <textarea id="nm-body" class="md-source body-edit compact" rows="8"></textarea>
      </div>
      <div class="md-edit-col">
        <div class="md-col-label">Preview</div>
        <div id="nm-body-preview" class="text-view md-preview compact"></div>
      </div>
    </div>
    <div class="modal-actions">
      <div class="spacer"></div>
      <button class="secondary-btn" id="nm-cancel">Cancel</button>
      <button class="primary-btn" id="nm-save">Create</button>
    </div>
  `, { large: true });
  const nmBodyEl = document.getElementById("nm-body");
  const nmPreviewEl = document.getElementById("nm-body-preview");
  const updateNmPreview = () => { nmPreviewEl.innerHTML = renderMarkdown(nmBodyEl.value); };
  nmBodyEl.addEventListener("input", updateNmPreview);
  attachMarkdownPaste(nmBodyEl, updateNmPreview);
  document.getElementById("nm-cancel").onclick = closeModal;
  document.getElementById("nm-save").onclick = async () => {
    const title = document.getElementById("nm-title").value.trim() || "Untitled";
    const synopsis = document.getElementById("nm-synopsis").value.trim();
    const body = document.getElementById("nm-body").value;
    const memo = await API.post(`/api/projects/${state.currentProject.slug}/memos`, { title, synopsis, body });
    state.currentProject.memos.push(memo);
    const idx = state.projects.findIndex(x => x.slug === state.currentProject.slug);
    if (idx >= 0) state.projects[idx].memoCount = (state.projects[idx].memoCount || 0) + 1;
    renderMemoGrid();
    closeModal();
  };
});

async function openMemoModal(id) {
  const projectSlug = state.currentProject.slug;
  let memo = await API.get(`/api/projects/${projectSlug}/memos/${id}`);
  let editing = false;

  function renderView() {
    openModal(`
      <div class="modal-header-row">
        <h3>${escapeHtml(memo.title)}</h3>
        <button class="secondary-btn" id="mm-edit-btn">Edit</button>
      </div>
      ${memo.synopsis ? `<div class="hint" style="margin-bottom:14px;">${escapeHtml(memo.synopsis)}</div>` : ""}
      <div class="text-view">${renderMarkdown(memo.body)}</div>
      <div class="hint" style="margin-top:16px;">Created ${fmtShort(new Date(memo.created))}</div>
      <div class="modal-actions">
        <button class="danger-btn" id="mm-delete">Delete</button>
        <div class="spacer"></div>
        <button class="secondary-btn" id="mm-close">Close</button>
      </div>
    `, { large: true });
    document.getElementById("mm-close").onclick = closeModal;
    document.getElementById("mm-edit-btn").onclick = () => { editing = true; renderEdit(); };
    wireDelete();
  }

  function renderEdit() {
    openModal(`
      <input type="text" id="mm-title" class="plain-field title-edit" value="${escapeAttr(memo.title)}" placeholder="Title" />
      <input type="text" id="mm-synopsis" class="plain-field synopsis-edit" style="margin-top:6px;" value="${escapeAttr(memo.synopsis)}" placeholder="One-line synopsis" />
      <div class="md-edit-split" style="margin-top:16px;">
        <div class="md-edit-col">
          <div class="md-col-label">Markdown</div>
          <textarea id="mm-body" class="plain-field body-edit md-source" rows="16">${escapeHtml(memo.body)}</textarea>
        </div>
        <div class="md-edit-col">
          <div class="md-col-label">Preview</div>
          <div id="mm-body-preview" class="text-view md-preview"></div>
        </div>
      </div>
      <div class="modal-actions">
        <button class="danger-btn" id="mm-delete">Delete</button>
        <div class="spacer"></div>
        <button class="secondary-btn" id="mm-cancel">Cancel</button>
        <button class="primary-btn" id="mm-save">Save</button>
      </div>
    `, { large: true });
    const mmBodyEl = document.getElementById("mm-body");
    const mmPreviewEl = document.getElementById("mm-body-preview");
    const updateMmPreview = () => { mmPreviewEl.innerHTML = renderMarkdown(mmBodyEl.value); };
    updateMmPreview();
    mmBodyEl.addEventListener("input", updateMmPreview);
    attachMarkdownPaste(mmBodyEl, updateMmPreview);
    document.getElementById("mm-cancel").onclick = () => { editing = false; renderView(); };
    document.getElementById("mm-save").onclick = async () => {
      const title = document.getElementById("mm-title").value.trim() || "Untitled";
      const synopsis = document.getElementById("mm-synopsis").value.trim();
      const body = document.getElementById("mm-body").value;
      const updated = await API.put(`/api/projects/${projectSlug}/memos/${id}`, { title, synopsis, body });
      memo = updated;
      const idx = state.currentProject.memos.findIndex(m => m.id === id);
      state.currentProject.memos[idx] = memo;
      renderMemoGrid();
      editing = false;
      renderView();
    };
    wireDelete();
  }

  function wireDelete() {
    document.getElementById("mm-delete").onclick = async () => {
      if (confirm("Delete this memo?")) {
        await API.del(`/api/projects/${projectSlug}/memos/${id}`);
        state.currentProject.memos = state.currentProject.memos.filter(m => m.id !== id);
        const idx = state.projects.findIndex(x => x.slug === projectSlug);
        if (idx >= 0) state.projects[idx].memoCount = Math.max(0, (state.projects[idx].memoCount || 1) - 1);
        renderMemoGrid(); closeModal();
      }
    };
  }

  renderView();
}

// ---------------------------------------------------------------- focus timer

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return [h, m, sec].map(n => String(n).padStart(2, "0")).join(":");
}
function formatDurationHuman(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

async function loadFocusExternalEvents() {
  if (!state.icloudStatus || !state.icloudStatus.configured) { state.focus.externalEvents = []; return; }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = toLocalISO(addDays(today, -3));
  const end = toLocalISO(addDays(today, 8));
  try {
    state.focus.externalEvents = await API.get(`/api/caldav/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
  } catch (e) {
    state.focus.externalEvents = [];
  }
}

function mergedCalendarItems() {
  const localUids = new Set(state.events.map(e => e.icloudUid).filter(Boolean));
  const local = state.events.map(e => ({ linkType: "event", linkId: e.id, linkLabel: e.title, start: e.start, end: e.end }));
  const external = (state.focus.externalEvents || [])
    .filter(ev => !localUids.has(ev.uid))
    .map(ev => ({ linkType: "externalEvent", linkId: ev.uid, linkLabel: ev.title, start: ev.start, end: ev.end, calendar: ev.calendar }));
  return local.concat(external);
}

function computeFocusRecommendation() {
  const items = mergedCalendarItems();
  if (items.length === 0) return null;
  const now = new Date();
  for (const item of items) {
    if (new Date(item.start) <= now && now <= new Date(item.end)) {
      return { linkType: item.linkType, linkId: item.linkId, linkLabel: item.linkLabel };
    }
  }
  let closest = null, closestDiff = Infinity;
  for (const item of items) {
    const diff = Math.abs(new Date(item.start) - now);
    if (diff < closestDiff) { closestDiff = diff; closest = item; }
  }
  return closest ? { linkType: closest.linkType, linkId: closest.linkId, linkLabel: closest.linkLabel } : null;
}

async function loadFocusCurrent() {
  const data = await API.get("/api/focus/current");
  state.focus.running = data.running;
  await loadFocusExternalEvents();
  state.focus.recommendation = computeFocusRecommendation();
  if (!state.focus.running && !state.focus.selectedLink && state.focus.recommendation) {
    state.focus.selectedLink = state.focus.recommendation;
  }
  if (state.focus.running) {
    state.focus.selectedLink = { linkType: state.focus.running.linkType, linkId: state.focus.running.linkId, linkLabel: state.focus.running.linkLabel };
  }
  renderFocusPanel();
}

function renderFocusPanel() {
  const btn = document.getElementById("focus-toggle-btn");
  const linkBtn = document.getElementById("focus-link-btn");
  const running = state.focus.running;
  btn.textContent = running ? "Stop Focus" : "Start Focus";
  btn.classList.toggle("running", !!running);
  const link = running ? { linkLabel: running.linkLabel } : state.focus.selectedLink;
  linkBtn.textContent = link && link.linkLabel ? link.linkLabel : "Choose a task…";
  linkBtn.disabled = !!running;
  updateFocusTimerDisplay();
}

function updateFocusTimerDisplay() {
  const el = document.getElementById("focus-timer-display");
  if (!el) return;
  const running = state.focus.running;
  if (!running) { el.textContent = "00:00:00"; return; }
  const seconds = (Date.now() - new Date(running.start).getTime()) / 1000;
  el.textContent = formatDuration(seconds);
  const block = document.querySelector(".focus-block.running");
  if (block) {
    const geo = calBlockGeometry(new Date(running.start), new Date());
    block.style.top = geo.top + "px";
    block.style.height = geo.height + "px";
  }
}

setInterval(updateFocusTimerDisplay, 1000);

function focusCalRangeLabel() {
  const start = state.focus.calendarWeekStart;
  const end = addDays(start, 6);
  return `${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${end.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

async function loadFocusCalendar() {
  const start = state.focus.calendarWeekStart;
  const end = addDays(start, 6);
  document.getElementById("focus-cal-range").textContent = focusCalRangeLabel();
  state.focus.calendarSessions = await API.get(`/api/focus/sessions?start=${dateKey(start)}&end=${dateKey(end)}`);
  renderFocusCalendarGrid();
}

function renderFocusCalendarGrid() {
  const grid = document.getElementById("focus-calendar-grid");
  grid.innerHTML = "";

  const corner = document.createElement("div");
  corner.className = "cal-corner";
  grid.appendChild(corner);

  const days = Array.from({ length: 7 }, (_, i) => addDays(state.focus.calendarWeekStart, i));
  const todayKey = dateKey(new Date());

  days.forEach(d => {
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    const head = document.createElement("div");
    head.className = "cal-head" + (dateKey(d) === todayKey ? " today" : "") + (isWeekend ? " weekend" : "");
    head.textContent = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    grid.appendChild(head);
  });

  const labelCol = document.createElement("div");
  HOURS.forEach(h => {
    const lbl = document.createElement("div");
    lbl.className = "cal-hourlabel";
    lbl.style.height = "40px";
    lbl.textContent = hourLabel(h);
    labelCol.appendChild(lbl);
  });
  grid.appendChild(labelCol);

  const now = new Date();
  days.forEach(d => {
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    const col = document.createElement("div");
    col.className = "cal-daycol" + (isWeekend ? " weekend" : "") + (dateKey(d) === todayKey ? " today" : "");
    HOURS.forEach(() => {
      const cell = document.createElement("div");
      cell.className = "cal-cell";
      cell.style.cursor = "default";
      col.appendChild(cell);
    });

    state.focus.calendarSessions
      .filter(s => sameDate(new Date(s.start), d))
      .forEach(s => {
        const start = new Date(s.start);
        const end = s.end ? new Date(s.end) : now;
        const geo = calBlockGeometry(start, end);
        const block = document.createElement("div");
        block.className = "focus-block" + (!s.end ? " running" : "");
        block.style.top = geo.top + "px";
        block.style.height = geo.height + "px";
        const label = s.linkLabel || "Unlinked";
        const spans = !sameDate(start, end) ? ` → ${fmtShort(end)}` : "";
        block.title = `${label} · ${fmtTime(start)}–${s.end ? fmtTime(end) : "now"}${spans}`
          + ` · ${formatDurationHuman((end - start) / 1000)} (click to edit)`;
        block.textContent = label;
        block.addEventListener("click", (e) => { e.stopPropagation(); openFocusSessionModal(s); });
        col.appendChild(block);
      });

    if (sameDate(now, d)) {
      const nowHour = now.getHours() + now.getMinutes() / 60;
      if (nowHour >= HOURS[0] && nowHour <= HOURS[HOURS.length - 1] + 1) {
        const nowLine = document.createElement("div");
        nowLine.className = "cal-now-line";
        nowLine.style.top = ((nowHour - HOURS[0]) * 40) + "px";
        col.appendChild(nowLine);
      }
    }

    grid.appendChild(col);
  });
}

document.getElementById("focus-cal-prev").addEventListener("click", () => {
  state.focus.calendarWeekStart = addDays(state.focus.calendarWeekStart, -7);
  loadFocusCalendar();
});
document.getElementById("focus-cal-next").addEventListener("click", () => {
  state.focus.calendarWeekStart = addDays(state.focus.calendarWeekStart, 7);
  loadFocusCalendar();
});
document.getElementById("focus-cal-today").addEventListener("click", () => {
  state.focus.calendarWeekStart = startOfWeek(new Date());
  loadFocusCalendar();
});

async function refreshAfterFocusSessionEdit(sessionId, updatedOrNull) {
  if (state.focus.running && state.focus.running.id === sessionId) {
    if (!updatedOrNull || updatedOrNull.end) {
      state.focus.running = null;
    } else {
      state.focus.running = updatedOrNull;
    }
    renderFocusPanel();
  }
  await loadFocusCalendar();
  await loadFocusSummary();
}

function openFocusSessionModal(session, draft) {
  const isRunning = !session.end;
  // `draft` carries the in-progress form values back when the link picker
  // has to take over the modal, so reopening here doesn't discard edits.
  const d = draft || {};
  const chosenLink = d.link || { linkType: session.linkType, linkId: session.linkId, linkLabel: session.linkLabel || "Unlinked" };
  const startVal = d.start || toDatetimeLocalValue(new Date(session.start));
  const endVal = d.end || toDatetimeLocalValue(session.end ? new Date(session.end) : new Date());
  const keepRunningInit = d.keepRunning !== undefined ? d.keepRunning : true;
  openModal(`
    <h3>Edit focus session</h3>
    <label>Linked to</label>
    <button class="secondary-btn" id="fs-link-btn" style="width:100%; text-align:left;">${escapeHtml(chosenLink.linkLabel)}</button>
    <div class="field-row" style="margin-top:14px;">
      <div><label>Start</label><input type="datetime-local" id="fs-start" value="${startVal}"/></div>
      <div><label>End</label><input type="datetime-local" id="fs-end" value="${endVal}" ${isRunning && keepRunningInit ? "disabled" : ""}/></div>
    </div>
    ${isRunning ? `<label style="display:flex; align-items:center; gap:6px; margin-top:10px;"><input type="checkbox" id="fs-still-running" ${keepRunningInit ? "checked" : ""} style="width:auto;" /> Still running — leave it going</label>` : ""}
    <div class="modal-actions">
      <button class="danger-btn" id="fs-delete">Delete</button>
      <div class="spacer"></div>
      <button class="secondary-btn" id="fs-cancel">Cancel</button>
      <button class="primary-btn" id="fs-save">Save</button>
    </div>
  `);
  const snapshot = () => ({
    link: chosenLink,
    start: document.getElementById("fs-start").value,
    end: document.getElementById("fs-end").value,
    keepRunning: !!(document.getElementById("fs-still-running") || {}).checked,
  });
  document.getElementById("fs-link-btn").onclick = () => {
    // The picker reuses the single modal surface, so hand it the current
    // form values and rebuild this dialog from them once a task is chosen.
    const pending = snapshot();
    openLinkPickerModal(
      (link) => openFocusSessionModal(session, { ...pending, link: link || { linkType: null, linkId: null, linkLabel: "Unlinked" } }),
      () => openFocusSessionModal(session, pending),
    );
  };
  const stillRunningEl = document.getElementById("fs-still-running");
  if (stillRunningEl) {
    stillRunningEl.addEventListener("change", (e) => {
      document.getElementById("fs-end").disabled = e.target.checked;
    });
  }
  document.getElementById("fs-cancel").onclick = closeModal;
  document.getElementById("fs-delete").onclick = async () => {
    if (!confirm("Delete this focus session?")) return;
    await API.del(`/api/focus/sessions/${session.id}`);
    await refreshAfterFocusSessionEdit(session.id, null);
    closeModal();
  };
  document.getElementById("fs-save").onclick = async () => {
    const startVal = document.getElementById("fs-start").value;
    const endVal = document.getElementById("fs-end").value;
    const keepRunning = isRunning && stillRunningEl && stillRunningEl.checked;
    if (!startVal) { alert("Start time required."); return; }
    if (!keepRunning && !endVal) { alert("End time required (or check \"Still running\")."); return; }
    if (!keepRunning && endVal <= startVal) { alert("End must be after start."); return; }
    const payload = {
      start: startVal + ":00",
      linkType: chosenLink.linkType,
      linkId: chosenLink.linkId,
      linkLabel: chosenLink.linkLabel,
    };
    if (!keepRunning) payload.end = endVal + ":00";
    const updated = await API.put(`/api/focus/sessions/${session.id}`, payload);
    await refreshAfterFocusSessionEdit(session.id, updated);
    closeModal();
  };
}

document.getElementById("focus-toggle-btn").addEventListener("click", async () => {
  if (state.focus.running) {
    await API.post("/api/focus/stop", {});
    state.focus.running = null;
    renderFocusPanel();
    await loadFocusSummary();
    await loadFocusCalendar();
  } else {
    const link = state.focus.selectedLink || state.focus.recommendation;
    const payload = link
      ? { linkType: link.linkType, linkId: link.linkId, linkLabel: link.linkLabel }
      : { linkType: null, linkId: null, linkLabel: "Unlinked" };
    state.focus.running = await API.post("/api/focus/start", payload);
    renderFocusPanel();
    await loadFocusCalendar();
  }
});

document.getElementById("focus-link-btn").addEventListener("click", () => {
  if (state.focus.running) return;
  openLinkPickerModal((link) => {
    state.focus.selectedLink = link || { linkType: null, linkId: null, linkLabel: "Unlinked" };
    renderFocusPanel();
  });
});

// When `onCancel` is supplied the picker is standing in front of another
// dialog: the callbacks are then responsible for restoring it, so the
// picker must not close the shared modal itself.
function openLinkPickerModal(onPick, onCancel) {
  const nested = typeof onCancel === "function";
  const finish = (link) => { onPick(link); if (!nested) closeModal(); };
  openModal(`
    <h3>Link focus session to…</h3>
    <input type="text" id="link-picker-search" class="link-picker-search" placeholder="Search to-dos and calendar items…" />
    <div id="link-picker-results" class="link-picker-results"></div>
    <div class="modal-actions">
      <button class="secondary-btn" id="link-picker-none">No link</button>
      <div class="spacer"></div>
      <button class="secondary-btn" id="link-picker-cancel">Cancel</button>
    </div>
  `);
  const searchEl = document.getElementById("link-picker-search");
  const resultsEl = document.getElementById("link-picker-results");

  function buildRow(item) {
    const row = document.createElement("div");
    row.className = "link-picker-row";
    row.innerHTML = `<span>${escapeHtml(item.linkLabel)}</span>${item.meta ? `<span class="hint">${escapeHtml(item.meta)}</span>` : ""}`;
    row.addEventListener("click", () => finish(item));
    return row;
  }

  function renderResults(query) {
    const q = query.trim().toLowerCase();
    const now = new Date();
    const eventItems = mergedCalendarItems()
      .filter(e => !q || e.linkLabel.toLowerCase().includes(q))
      .sort((a, b) => Math.abs(new Date(a.start) - now) - Math.abs(new Date(b.start) - now))
      .map(e => ({
        linkType: e.linkType, linkId: e.linkId, linkLabel: e.linkLabel,
        meta: `${fmtTime(new Date(e.start))} · ${fmtShort(new Date(e.start))}${e.calendar ? " · " + e.calendar : ""}`,
      }));
    const todoItems = state.todos
      .filter(t => !t.done && (!q || t.text.toLowerCase().includes(q)))
      .map(t => ({ linkType: "todo", linkId: t.id, linkLabel: todoDisplayText(t) }));
    resultsEl.innerHTML = "";
    if (eventItems.length) {
      const h = document.createElement("div"); h.className = "link-picker-group-label"; h.textContent = "Calendar (closest in time first)";
      resultsEl.appendChild(h);
      eventItems.forEach(item => resultsEl.appendChild(buildRow(item)));
    }
    if (todoItems.length) {
      const h = document.createElement("div"); h.className = "link-picker-group-label"; h.textContent = "To-dos";
      resultsEl.appendChild(h);
      todoItems.forEach(item => resultsEl.appendChild(buildRow(item)));
    }
    if (!eventItems.length && !todoItems.length) renderEmptyState(resultsEl, "No matches.");
  }

  searchEl.addEventListener("input", () => renderResults(searchEl.value));
  renderResults("");
  document.getElementById("link-picker-none").onclick = () => finish(null);
  document.getElementById("link-picker-cancel").onclick = () => { if (nested) onCancel(); else closeModal(); };
  searchEl.focus();
}

function focusPeriodRange(mode, anchor) {
  if (mode === "day") return { start: new Date(anchor), end: new Date(anchor) };
  if (mode === "week") {
    const start = startOfWeek(anchor);
    return { start, end: addDays(start, 6) };
  }
  const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const monthEnd = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  // Pad to full Mon–Sun weeks so the chart can bucket cleanly into weeks.
  const start = startOfWeek(monthStart);
  const end = addDays(startOfWeek(monthEnd), 6);
  return { start, end, monthStart, monthEnd };
}

function focusPeriodLabel(mode, range) {
  if (mode === "day") return range.start.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", year: "numeric" });
  if (mode === "week") return `${range.start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${range.end.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
  return range.monthStart.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function focusPeriodStep(mode, anchor, dir) {
  if (mode === "day") return addDays(anchor, dir);
  if (mode === "week") return addDays(anchor, dir * 7);
  const d = new Date(anchor);
  d.setDate(1);
  d.setMonth(d.getMonth() + dir);
  return d;
}

async function loadFocusSummary() {
  const mode = state.focus.summaryMode;
  const range = focusPeriodRange(mode, state.focus.summaryAnchor);
  document.getElementById("focus-summary-range").textContent = focusPeriodLabel(mode, range);
  if (mode === "month") {
    const [monthData, chartData] = await Promise.all([
      API.get(`/api/focus/range-summary?start=${dateKey(range.monthStart)}&end=${dateKey(range.monthEnd)}`),
      API.get(`/api/focus/range-summary?start=${dateKey(range.start)}&end=${dateKey(range.end)}`),
    ]);
    renderFocusSummary(mode, monthData, range, chartData);
  } else {
    const data = await API.get(`/api/focus/range-summary?start=${dateKey(range.start)}&end=${dateKey(range.end)}`);
    renderFocusSummary(mode, data, range);
  }
}

function renderFocusSummary(mode, data, range, chartData) {
  const el = document.getElementById("focus-summary");
  el.innerHTML = "";

  const statEl = document.createElement("div");
  statEl.className = "focus-summary-total";
  if (mode === "day") {
    statEl.innerHTML = `<span class="focus-summary-total-value">${formatDurationHuman(data.totalSeconds)}</span> focused across ${data.sessionCount} session${data.sessionCount === 1 ? "" : "s"}`;
  } else {
    statEl.innerHTML = `<div><span class="focus-summary-total-value">${formatDurationHuman(data.averageSecondsPerDay)}</span> daily average</div><div class="hint" style="margin-top:2px;">${formatDurationHuman(data.totalSeconds)} total across ${data.sessionCount} session${data.sessionCount === 1 ? "" : "s"}</div>`;
  }
  el.appendChild(statEl);

  if (mode === "week" && data.days && data.days.length) {
    const chart = document.createElement("div");
    chart.className = "focus-chart";
    const max = Math.max(1, ...data.days.map(d => d.totalSeconds));
    data.days.forEach(d => {
      const date = new Date(d.date + "T00:00:00");
      const col = document.createElement("div");
      col.className = "focus-bar-col";
      col.title = `${fmtShort(date)}: ${formatDurationHuman(d.totalSeconds)}`;
      const bar = document.createElement("div");
      bar.className = "focus-bar";
      const pct = d.totalSeconds > 0 ? Math.max(3, Math.round((d.totalSeconds / max) * 100)) : 1;
      bar.style.height = pct + "%";
      col.appendChild(bar);
      const label = document.createElement("div");
      label.className = "focus-bar-label";
      label.textContent = date.toLocaleDateString(undefined, { weekday: "short" })[0];
      col.appendChild(label);
      chart.appendChild(col);
    });
    el.appendChild(chart);
  } else if (mode === "month" && chartData && chartData.days && chartData.days.length) {
    const weeks = [];
    for (let i = 0; i < chartData.days.length; i += 7) weeks.push(chartData.days.slice(i, i + 7));
    // The range is week-aligned, but average over the days actually present
    // rather than assuming a full seven, so a short trailing week can't
    // understate itself or index past the end of the array.
    const weekStats = weeks.map(w => ({
      start: new Date(w[0].date + "T00:00:00"),
      end: new Date(w[w.length - 1].date + "T00:00:00"),
      avg: w.reduce((sum, d) => sum + d.totalSeconds, 0) / w.length,
    }));
    const chart = document.createElement("div");
    chart.className = "focus-chart";
    const max = Math.max(1, ...weekStats.map(w => w.avg));
    weekStats.forEach(w => {
      const col = document.createElement("div");
      col.className = "focus-bar-col";
      col.title = `${fmtShort(w.start)} – ${fmtShort(w.end)}: ${formatDurationHuman(w.avg)}/day avg`;
      const bar = document.createElement("div");
      bar.className = "focus-bar";
      const pct = w.avg > 0 ? Math.max(3, Math.round((w.avg / max) * 100)) : 1;
      bar.style.height = pct + "%";
      col.appendChild(bar);
      const label = document.createElement("div");
      label.className = "focus-bar-label";
      label.textContent = w.start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      col.appendChild(label);
      chart.appendChild(col);
    });
    el.appendChild(chart);
  }

  const listLabel = document.createElement("div");
  listLabel.className = "focus-tasklist-label";
  listLabel.textContent = mode === "day" ? "By task" : "By task (period total)";
  el.appendChild(listLabel);

  if (data.byTask.length === 0) { renderEmptyState(el, "No focus sessions in this period."); return; }
  const list = document.createElement("div");
  list.className = "focus-task-list";
  data.byTask.forEach(t => {
    const row = document.createElement("div");
    row.className = "focus-task-row";
    row.innerHTML = `<span>${escapeHtml(t.linkLabel)}</span><span class="focus-task-duration">${formatDurationHuman(t.seconds)}</span>`;
    list.appendChild(row);
  });
  el.appendChild(list);
}

document.querySelectorAll("#focus-summary-mode-toggle .focus-seg-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#focus-summary-mode-toggle .focus-seg-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    state.focus.summaryMode = btn.dataset.mode;
    loadFocusSummary();
  });
});
document.getElementById("focus-summary-prev").addEventListener("click", () => {
  state.focus.summaryAnchor = focusPeriodStep(state.focus.summaryMode, state.focus.summaryAnchor, -1);
  loadFocusSummary();
});
document.getElementById("focus-summary-next").addEventListener("click", () => {
  state.focus.summaryAnchor = focusPeriodStep(state.focus.summaryMode, state.focus.summaryAnchor, 1);
  loadFocusSummary();
});
document.getElementById("focus-summary-today").addEventListener("click", () => {
  state.focus.summaryAnchor = new Date();
  loadFocusSummary();
});

// ----------------------------------------------------------- weekly recap
// One recap per week, keyed by that week's Monday. The page pairs what the
// app recorded (evidence, never scored) with what only you can supply
// (three 1–5 dials, averaged into the score, plus mood kept outside it).

const RECAP_DIALS = [
  { key: "studyProgress", label: "Study progress" },
  { key: "lifeBalance", label: "Life balance" },
  { key: "efficiency", label: "Efficiency" },
];
const RECAP_SECTIONS = [
  { key: "study", label: "Study", placeholder: "What moved forward? What stalled?" },
  { key: "life", label: "Life", placeholder: "Energy, people, rest — how did the week feel?" },
  { key: "summary", label: "Summary", placeholder: "The through-line, and one thing to change next week." },
];

function mondayOf(d) { return startOfWeek(d); }

function weekRangeLabel(key, opts = {}) {
  const start = new Date(key + "T00:00:00");
  const end = addDays(start, 6);
  const sameMonth = start.getMonth() === end.getMonth();
  const a = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const b = end.toLocaleDateString(undefined, sameMonth ? { day: "numeric" } : { month: "short", day: "numeric" });
  return opts.withYear ? `${a} – ${b}, ${end.getFullYear()}` : `${a} – ${b}`;
}

async function loadRecapWeeks() {
  const data = await API.get("/api/journal/recap/weeks?count=10");
  state.recap.weeks = data.weeks;
  state.recap.pendingKey = data.pendingKey;
  if (!state.recap.selectedKey) {
    // Land on the week that still needs writing, else the current one.
    state.recap.selectedKey = data.pendingKey || (data.weeks[0] && data.weeks[0].key);
  }
  renderRecapStrip();
  renderRecapNudge();
  updateRecapTabBadge();
}

function updateRecapTabBadge() {
  const btn = document.querySelector('.tab-btn[data-tab="journal"]');
  if (btn) btn.classList.toggle("has-dot", !!state.recap.pendingKey);
}

function renderRecapNudge() {
  const el = document.getElementById("recap-nudge");
  const key = state.recap.pendingKey;
  if (!key || state.recap.nudgeDismissed) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  el.innerHTML = `
    <div>
      <strong>${escapeHtml(weekRangeLabel(key))}</strong> is ready to review — you haven't written that recap yet.
    </div>
    <div class="recap-nudge-actions">
      <button class="primary-btn" id="recap-nudge-go">Write it</button>
      <button class="secondary-btn" id="recap-nudge-later">Later</button>
    </div>`;
  document.getElementById("recap-nudge-go").onclick = () => selectRecapWeek(key);
  document.getElementById("recap-nudge-later").onclick = () => {
    state.recap.nudgeDismissed = true;
    renderRecapNudge();
  };
}

function renderRecapStrip() {
  const strip = document.getElementById("recap-strip");
  strip.innerHTML = "";
  const maxFocus = Math.max(1, ...state.recap.weeks.map(w => w.focusSeconds));
  state.recap.weeks.forEach(w => {
    const chip = document.createElement("button");
    chip.className = "recap-chip"
      + (w.key === state.recap.selectedKey ? " selected" : "")
      + (w.hasEntry ? " written" : "");
    const pct = Math.round((w.focusSeconds / maxFocus) * 100);
    chip.innerHTML = `
      <span class="recap-chip-range">${escapeHtml(weekRangeLabel(w.key))}${w.isCurrent ? " · now" : ""}</span>
      <span class="recap-chip-score">${w.score !== null ? w.score.toFixed(1) : "–"}</span>
      <span class="recap-chip-bar"><span style="width:${pct}%"></span></span>
      <span class="recap-chip-focus">${formatDurationHuman(w.focusSeconds)}</span>`;
    chip.title = w.hasEntry ? "Recap written" : "No recap yet";
    chip.addEventListener("click", () => selectRecapWeek(w.key));
    strip.appendChild(chip);
  });
}

async function selectRecapWeek(key) {
  state.recap.selectedKey = key;
  state.recap.editing = false;
  if (state.recap.view === "compare") setRecapView("single");
  renderRecapStrip();
  await loadRecap();
}

async function loadRecap() {
  if (!state.recap.selectedKey) return;
  state.recap.entry = await API.get(`/api/journal/recap?key=${state.recap.selectedKey}`);
  renderRecap();
}

function renderRecap() {
  renderRecapEvidence();
  renderRecapRatings();
  renderRecapSections();
}

function statTile(value, label, hint) {
  return `<div class="stat-tile">
    <div class="stat-value">${escapeHtml(value)}</div>
    <div class="stat-label">${escapeHtml(label)}</div>
    ${hint ? `<div class="stat-hint">${escapeHtml(hint)}</div>` : ""}
  </div>`;
}

function renderRecapEvidence() {
  const el = document.getElementById("recap-evidence");
  const e = state.recap.entry.evidence;
  const tasks = e.topTasks.length
    ? e.topTasks.map(t => `<li><span>${escapeHtml(t.linkLabel)}</span><span class="recap-task-time">${formatDurationHuman(t.seconds)}</span></li>`).join("")
    : `<li class="hint">No focus sessions logged this week.</li>`;
  el.innerHTML = `
    <div class="recap-week-head">
      <h3>${escapeHtml(weekRangeLabel(state.recap.selectedKey, { withYear: true }))}</h3>
      <div class="hint">${state.recap.entry.updatedAt ? "Last edited " + fmtShort(new Date(state.recap.entry.updatedAt)) : "Not written yet"}</div>
    </div>
    <div class="recap-evidence">
      <div class="recap-evidence-label">What the week actually held</div>
      <div class="stat-row">
        ${statTile(formatDurationHuman(e.focusSeconds), "focused", `${e.sessionCount} session${e.sessionCount === 1 ? "" : "s"}`)}
        ${statTile(`${e.activeDays}/7`, "days active", "consistency")}
        ${statTile(formatDurationHuman(e.longestSessionSeconds), "longest run", "")}
        ${statTile(String(e.todosCompleted), "to-dos done", `${e.todosAdded} added`)}
        ${statTile(String(e.memosWritten), "memos", "")}
        ${statTile(String(e.ideasCaptured), "ideas", "")}
      </div>
      <div class="recap-tasks">
        <div class="recap-evidence-label">Where the hours went</div>
        <ul>${tasks}</ul>
      </div>
    </div>`;
}

function dialRow(dial, value, interactive) {
  const dots = [1, 2, 3, 4, 5].map(n =>
    `<button class="dot${value !== null && n <= value ? " on" : ""}"
      ${interactive ? `data-dial="${dial.key}" data-val="${n}"` : "disabled"}
      title="${n} of 5"></button>`).join("");
  return `<div class="dial">
    <div class="dial-label">${escapeHtml(dial.label)}</div>
    <div class="dial-dots">${dots}</div>
  </div>`;
}

function renderRecapRatings() {
  const el = document.getElementById("recap-ratings");
  const entry = state.recap.entry;
  const editing = state.recap.editing;
  const score = entry.score;
  el.innerHTML = `
    <div class="recap-ratings">
      <div class="recap-score">
        <div class="recap-score-value">${score !== null ? score.toFixed(1) : "–"}</div>
        <div class="recap-score-label">week score</div>
      </div>
      <div class="recap-dials">
        ${RECAP_DIALS.map(d => dialRow(d, entry.dials[d.key], editing)).join("")}
        ${dialRow({ key: "mood", label: "Mood (not scored)" }, entry.mood, editing)}
      </div>
    </div>`;
  if (!editing) return;
  el.querySelectorAll("[data-dial]").forEach(b => {
    b.addEventListener("click", () => {
      const key = b.dataset.dial, val = Number(b.dataset.val);
      if (key === "mood") entry.mood = entry.mood === val ? null : val;
      else entry.dials[key] = entry.dials[key] === val ? null : val;
      const vals = RECAP_DIALS.map(d => entry.dials[d.key]);
      entry.score = vals.every(v => v !== null)
        ? Math.round((vals.reduce((a, b2) => a + b2, 0) / vals.length) * 10) / 10
        : null;
      renderRecapRatings();
    });
  });
}

// ------------------------------------------------ linking events to a recap
// Study draws on the calendars where work happens; Life on the ones where
// the rest of it does. Appointments feeds both — a supervisor meeting is
// study, a dentist is life — so the same event can sit on either side.

function todosCalendarName() {
  return (state.icloudStatus && state.icloudStatus.todosCalendarName) || "Todos";
}

function recapSources(kind) {
  return kind === "life"
    ? ["Appointments", "Habits"]
    : ["Appointments", "Routine", todosCalendarName()];
}

function eventDurationSeconds(e) {
  return Math.max(0, (new Date(e.end) - new Date(e.start)) / 1000);
}

// Everything on the allowed calendars in a given week, normalised to one
// shape and carrying whatever project its to-do points at.
async function recapWeekCandidates(weekKey) {
  const start = new Date(weekKey + "T00:00:00");
  const end = addDays(start, 7);
  const inWeek = (d) => { const t = new Date(d); return t >= start && t < end; };

  let external = [];
  try {
    external = await API.get(
      `/api/caldav/events?start=${encodeURIComponent(toLocalISO(start))}&end=${encodeURIComponent(toLocalISO(end))}`);
  } catch (e) { external = []; }

  const localUids = new Set(state.events.map(e => e.icloudUid).filter(Boolean));
  const locals = state.events.filter(e => inWeek(e.start)).map(e => {
    const todo = e.todoId ? state.todos.find(t => t.id === e.todoId) : null;
    const proj = todo && todo.projectSlug ? state.projects.find(p => p.slug === todo.projectSlug) : null;
    return {
      key: "L" + e.id, title: e.title, start: e.start, end: e.end,
      calendar: e.calendarName || todosCalendarName(),
      projectSlug: proj ? proj.slug : null, projectName: proj ? proj.title : null,
    };
  });
  const externals = external
    .filter(e => !localUids.has(e.uid) && inWeek(e.start))
    .map(e => ({
      key: "E" + e.uid, title: e.title, start: e.start, end: e.end,
      calendar: e.calendar, projectSlug: null, projectName: null,
    }));

  return locals.concat(externals).sort((a, b) => new Date(a.start) - new Date(b.start));
}

// Events picked here are appended to the section as plain bullets rather than
// kept as a list of their own, so they can be reworded, reordered or deleted
// like anything else you wrote.
function appendBullets(text, titles) {
  const body = (text || "").replace(/\n+$/, "");
  const have = new Set(body.split("\n").map(l => l.trim().replace(/^[*-]\s*/, "")));
  const fresh = titles.filter(t => !have.has(t));
  if (!fresh.length) return body;
  const bullets = fresh.map(t => `* ${t}`).join("\n");
  if (!body.trim()) return bullets;
  // A blank line so the bullets start a list rather than continuing a
  // paragraph — unless the section already ends in one, where a blank line
  // would split it in two.
  const last = body.replace(/\s+$/, "").split("\n").pop().trimStart();
  return body + (/^[*-]\s/.test(last) ? "\n" : "\n\n") + bullets;
}

async function openRecapLinkPicker(kind) {
  const allowed = recapSources(kind).map(c => c.toLowerCase());
  const section = kind === "life" ? "life" : "study";

  openModal(`
    <h3>Add events to ${kind === "life" ? "Life" : "Study"}</h3>
    <div class="hint">From ${escapeHtml(recapSources(kind).join(", "))}. Ticked events are added as bullets at the end of the section, where you can edit them.</div>
    <div id="rl-list" class="link-picker-results" style="margin-top:14px;"><div class="empty-state">Loading…</div></div>
    <div class="modal-actions">
      <div class="spacer"></div>
      <button class="secondary-btn" id="rl-cancel">Cancel</button>
      <button class="primary-btn" id="rl-save">Add</button>
    </div>
  `, { large: true });

  document.getElementById("rl-cancel").onclick = () => { closeModal(); renderRecap(); };
  const listEl = document.getElementById("rl-list");

  const candidates = (await recapWeekCandidates(state.recap.selectedKey))
    .filter(c => allowed.includes((c.calendar || "").toLowerCase()));

  if (!candidates.length) {
    listEl.innerHTML = `<div class="empty-state">Nothing on those calendars this week.</div>`;
  } else {
    let currentDay = "";
    listEl.innerHTML = "";
    candidates.forEach(c => {
      const day = fmtShort(new Date(c.start));
      if (day !== currentDay) {
        currentDay = day;
        const h = document.createElement("div");
        h.className = "link-picker-group-label";
        h.textContent = day;
        listEl.appendChild(h);
      }
      const row = document.createElement("label");
      row.className = "rl-row";
      row.innerHTML = `
        <input type="checkbox" />
        <span class="rl-title">${escapeHtml(c.title)}</span>
        <span class="hint">${escapeHtml(c.calendar)}${c.projectName ? " · " + escapeHtml(c.projectName) : ""}</span>`;
      row.__cand = c;
      listEl.appendChild(row);
    });
  }

  document.getElementById("rl-save").onclick = () => {
    const titles = Array.from(listEl.querySelectorAll(".rl-row"))
      .filter(r => r.querySelector("input").checked)
      .map(r => r.__cand.title);
    state.recap.entry[section] = appendBullets(state.recap.entry[section], titles);
    closeModal();
    renderRecap();
  };
}

function renderRecapSections() {
  const el = document.getElementById("recap-sections");
  const entry = state.recap.entry;
  const editing = state.recap.editing;
  el.innerHTML = `
    <div class="recap-actions">
      ${editing
        ? `<button class="secondary-btn" id="recap-cancel">Cancel</button>
           <button class="primary-btn" id="recap-save">Save recap</button>`
        : `<button class="secondary-btn" id="recap-edit">${entry.hasEntry ? "Edit" : "Write this recap"}</button>`}
    </div>
    <div class="recap-columns">
      ${RECAP_SECTIONS.map(s => `
        <div class="recap-col">
          <div class="recap-col-label">${escapeHtml(s.label)}</div>
          ${editing
            ? `<textarea class="plain-field recap-text" data-section="${s.key}" placeholder="${escapeAttr(s.placeholder)}">${escapeHtml(entry[s.key])}</textarea>`
            : (entry[s.key].trim()
                ? `<div class="text-view">${renderMarkdown(entry[s.key])}</div>`
                : `<div class="empty-state">${escapeHtml(s.placeholder)}</div>`)}
          ${editing && (s.key === "study" || s.key === "life")
            ? `<button class="secondary-btn linked-add" data-link="${s.key}">Add from calendar…</button>`
            : ""}
        </div>`).join("")}
    </div>`;

  if (editing) {
    el.querySelectorAll(".recap-text").forEach(t => attachMarkdownPaste(t));
    el.querySelectorAll(".linked-add").forEach(b => {
      // Hold the in-progress prose so opening the picker doesn't lose it.
      b.addEventListener("click", () => {
        el.querySelectorAll(".recap-text").forEach(t => { entry[t.dataset.section] = t.value; });
        openRecapLinkPicker(b.dataset.link);
      });
    });
    document.getElementById("recap-cancel").onclick = async () => {
      state.recap.editing = false;
      await loadRecap();
    };
    document.getElementById("recap-save").onclick = saveRecap;
  } else {
    document.getElementById("recap-edit").onclick = () => {
      state.recap.editing = true;
      renderRecap();
    };
  }
}

async function saveRecap() {
  const entry = state.recap.entry;
  document.querySelectorAll(".recap-text").forEach(t => { entry[t.dataset.section] = t.value; });
  const saved = await API.put(`/api/journal/recap?key=${state.recap.selectedKey}`, {
    study: entry.study, life: entry.life, summary: entry.summary,
    dials: entry.dials, mood: entry.mood,
  });
  state.recap.entry = { ...saved, evidence: entry.evidence };
  state.recap.editing = false;
  renderRecap();
  await loadRecapWeeks();
  renderRecapStrip();
}

function setRecapView(view) {
  state.recap.view = view;
  document.querySelectorAll(".mode-btn").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  document.getElementById("recap-single").classList.toggle("hidden", view !== "single");
  document.getElementById("recap-compare").classList.toggle("hidden", view !== "compare");
  if (view === "compare") renderRecapCompare();
}

async function renderRecapCompare() {
  const el = document.getElementById("recap-compare");
  el.innerHTML = `<div class="empty-state">Loading…</div>`;
  const keys = state.recap.weeks.slice(0, 4).map(w => w.key);
  const entries = await Promise.all(keys.map(k => API.get(`/api/journal/recap?key=${k}`)));
  el.innerHTML = `
    <div class="recap-compare-grid" style="grid-template-columns: 92px repeat(${entries.length}, minmax(200px, 1fr));">
      <div class="rc-corner"></div>
      ${entries.map(e => `<div class="rc-head">
        <div class="rc-head-range">${escapeHtml(weekRangeLabel(e.key))}</div>
        <div class="rc-head-score">${e.score !== null ? e.score.toFixed(1) : "–"}</div>
      </div>`).join("")}

      <div class="rc-rowlabel">Focus</div>
      ${entries.map(e => `<div class="rc-cell rc-metric">${formatDurationHuman(e.evidence.focusSeconds)}
        <span class="hint"> · ${e.evidence.activeDays}/7 days</span></div>`).join("")}

      ${RECAP_SECTIONS.map(s => `
        <div class="rc-rowlabel">${escapeHtml(s.label)}</div>
        ${entries.map(e => `<div class="rc-cell">${e[s.key].trim()
          ? `<div class="text-view">${renderMarkdown(e[s.key])}</div>`
          : `<span class="hint">—</span>`}</div>`).join("")}
      `).join("")}
    </div>`;
}

document.querySelectorAll("#tab-journal .mode-btn").forEach(btn => {
  btn.addEventListener("click", () => setRecapView(btn.dataset.view));
});

// ---------------------------------------------------------------- tabs

document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    // Hands the section's hue to every component via the --accent tokens.
    document.body.dataset.domain = btn.dataset.tab;
    if (btn.dataset.tab === "focus") { loadFocusCurrent(); loadFocusSummary(); loadFocusCalendar(); }
    if (btn.dataset.tab === "journal") { loadRecapWeeks().then(loadRecap); }
  });
});

// ---------------------------------------------------------------- init

// Opening the app used to mean watching an empty week while iCloud was asked
// what was in it. So the first paint is now local only — four data files plus
// whatever iCloud last said, all of which the server answers off disk without
// touching the network — and the real conversation with iCloud happens behind
// the page that is already up.
async function loadAll() {
  const [todos, events, ideas, projects, icloudStatus, calendars, cachedExternal] = await Promise.all([
    API.get("/api/todos"),
    API.get("/api/events"),
    API.get("/api/ideas"),
    API.get("/api/projects"),
    API.get("/api/caldav/status?cached=1").catch(() => ({ configured: false })),
    API.get("/api/caldav/calendars?cached=1").catch(() => []),
    API.get(`/api/caldav/events?${calendarWeekQuery()}&cached=1`).catch(() => []),
  ]);
  state.todos = todos; state.events = events; state.ideas = ideas; state.projects = projects;
  state.icloudStatus = icloudStatus;
  state.calendars = calendars;
  state.externalEvents = icloudStatus.configured ? cachedExternal : [];

  updateICloudButton();
  renderTodos();
  renderCalendarGrid();
  updateCalRangeLabel();
  renderIdeas();
  renderProjects();

  refreshICloudInBackground();
  await Promise.all([
    loadFocusCurrent(),
    loadFocusSummary(),
    loadFocusCalendar(),
    // Surfaces the recap nudge on the Journal tab without having to open it.
    loadRecapWeeks(),
  ]);
}

// Everything that costs a round trip to Apple, in order, off the paint path.
async function refreshICloudInBackground() {
  await loadICloudStatus();
  await loadCalendars();
  await loadExternalEvents();
}

{
  const ideaInputEl = document.getElementById("idea-input");
  const ideaInputPreviewEl = document.getElementById("idea-input-preview");
  const updateIdeaInputPreview = () => { ideaInputPreviewEl.innerHTML = renderMarkdown(ideaInputEl.value); };
  ideaInputEl.addEventListener("input", updateIdeaInputPreview);
  attachMarkdownPaste(ideaInputEl, updateIdeaInputPreview);
}

// ---------------------------------------------------------------- liveness
// In a browser you reload to catch up; in the app there is no reflex for
// that, so the page has to keep itself current. Three cadences:
//   · every 30s  — slide the "now" line
//   · on refocus — pull fresh data (you may have just edited Apple Calendar)
//   · every 5min — pull fresh data while it sits open
// Refreshing is skipped while a dialog is open, a block is being dragged, or
// a change of ours is still on its way to iCloud — so it can never yank
// something out from under you mid-edit, or paint an old value over a new one.

const NOW_LINE_INTERVAL_MS = 30 * 1000;
const BACKGROUND_REFRESH_MS = 5 * 60 * 1000;
const REFRESH_THROTTLE_MS = 30 * 1000;

let lastRenderedDay = dateKey(new Date());
let lastDataRefresh = Date.now();

function isBusyEditing() {
  return !document.getElementById("modal-backdrop").classList.contains("hidden")
      || !!document.querySelector(".cal-event.dragging, .focus-block.dragging")
      // A change of ours that has not landed yet is newer than anything a
      // refresh could bring back, so waiting is the only way not to undo it.
      || calendarWritesPending();
}

function nowLineOffsetPx(now) {
  const hours = now.getHours() + now.getMinutes() / 60;
  if (hours < HOURS[0] || hours > HOURS[HOURS.length - 1] + 1) return null;
  return (hours - HOURS[0]) * CAL_HOUR_PX;
}

function tickNowLine() {
  const now = new Date();

  // A new day changes which column is "today", so the grids have to be
  // rebuilt rather than nudged.
  if (dateKey(now) !== lastRenderedDay) {
    lastRenderedDay = dateKey(now);
    if (!isBusyEditing()) {
      renderCalendarGrid();
      renderFocusCalendarGrid();
      loadRecapWeeks();
    }
    return;
  }

  const offset = nowLineOffsetPx(now);
  const lines = document.querySelectorAll(".cal-now-line");

  // Crossing into or out of the visible hours adds or removes the line
  // itself, which only a re-render handles.
  const shouldExist = offset !== null;
  if (shouldExist !== (lines.length > 0) && !isBusyEditing()) {
    renderCalendarGrid();
    renderFocusCalendarGrid();
    return;
  }
  lines.forEach(el => { el.style.top = offset + "px"; });
}

async function refreshLiveData({ force = false } = {}) {
  if (isBusyEditing()) return;
  const now = Date.now();
  if (!force && now - lastDataRefresh < REFRESH_THROTTLE_MS) return;
  lastDataRefresh = now;
  try {
    const [todos, events] = await Promise.all([API.get("/api/todos"), API.get("/api/events")]);
    state.todos = todos;
    state.events = events;
    renderTodos();
    renderProjectTodos();
    await loadExternalEvents();          // also pulls in Apple Calendar edits
    if (document.getElementById("tab-focus").classList.contains("active")) {
      await Promise.all([loadFocusCurrent(), loadFocusSummary(), loadFocusCalendar()]);
    }
  } catch (e) {
    /* transient; the next tick will try again */
  }
}

setInterval(tickNowLine, NOW_LINE_INTERVAL_MS);
setInterval(() => { if (!document.hidden) refreshLiveData(); }, BACKGROUND_REFRESH_MS);

// Coming back to the app is the moment you are most likely to have just
// changed something elsewhere.
window.addEventListener("focus", () => refreshLiveData());
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshLiveData(); });

document.body.dataset.domain = "calendar";
loadAll();
