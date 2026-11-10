/* ─────────────────────────────────────────────────────────────────────────
   Task Manager (Rabby) — v3.0.0

   Single-file plugin. This file IS the source; there is no build step and
   no TypeScript to keep in sync. Edit it, reload Obsidian, done.

   Data model — tasks live as markdown checkboxes under a "## Tasks"
   heading in any note whose frontmatter has `type: Project`:

     - [ ] Buy milk 📅 2026-09-25 (High) 🔖 errands ^tm7k2p

   The trailing ^tm… is an Obsidian block ID. It is how a task is
   identified. Previously tasks were matched by substring on their own
   text, which meant two tasks with the same wording were indistinguishable
   — edits and deletes hit whichever came first. IDs fix that permanently.
   They are written in lazily, the first time a task is touched.
   ───────────────────────────────────────────────────────────────────── */

'use strict';

const { ItemView, Plugin, Notice, Menu, Platform, setIcon, debounce } = require('obsidian');

const VIEW_TYPE = 'rabby-task-manager-view';
const SVG_NS    = 'http://www.w3.org/2000/svg';

const RE_TASK  = /^(\s*)-\s\[([ xX])\]\s?(.*)$/;
const RE_ID    = /\s*\^(tm[a-z0-9]+)\s*$/;
const RE_DUE   = /📅\s*(\d{4}-\d{2}-\d{2})/;
const RE_MOVES = /↻\s*(\d+)/;
const RE_FROM  = /\(from\s+(\d{4}-\d{2}-\d{2})\)/;
const RE_PRIO  = /\((High|Medium|Low)\)/i;
const RE_TAG   = /🔖\s*([^\s🔖📅⏰🔁(]+)/g;
const RE_TIME  = /⏰\s*(\d{1,2}:\d{2})(?:\s*[-–]\s*(\d{1,2}:\d{2}))?/;
const RE_REPEAT = /🔁\s*every\s+(day|weekday|week|month)\b/i;
const RE_DONE  = /✅\s*(\d{4}-\d{2}-\d{2})/;
const RE_H_TASKS   = /^#+\s*Tasks\s*$/i;

const PRIORITIES = ['High', 'Medium', 'Low'];

/* "Today" is no longer a tab — the date strip owns date selection. */
const TABS = [
  { id: 'overdue',   label: 'Overdue'   },
  { id: 'upcoming',  label: 'Upcoming'  },
  { id: 'unplanned', label: 'Unplanned' },
  { id: 'all',       label: 'All'       },
  { id: 'done',      label: 'Done'      },
];

const REPEATS = [['', 'Never'], ['day', 'Daily'], ['weekday', 'Weekdays'], ['week', 'Weekly'], ['month', 'Monthly']];
const REPEAT_LABEL = Object.fromEntries(REPEATS);

/* day view groups, by start time; tasks without a time go to Anytime */
const DAY_GROUPS = [
  { id: 'any',       label: 'Anytime',   icon: 'circle-dashed' },
  { id: 'morning',   label: 'Morning',   icon: 'sunrise',   until: 12 * 60 },
  { id: 'midday',    label: 'Midday',    icon: 'sun',       until: 14 * 60 },
  { id: 'afternoon', label: 'Afternoon', icon: 'cloud-sun', until: 18 * 60 },
  { id: 'evening',   label: 'Evening',   icon: 'moon',      until: 24 * 60 },
];

/** "9:5" / "09:05" → "09:05"; anything else → "" */
const normTime = v => {
  const m = /^(\d{1,2}):(\d{2})$/.exec((v || '').trim());
  if (!m) return '';
  const h = +m[1], mi = +m[2];
  return h < 24 && mi < 60 ? `${String(h).padStart(2, '0')}:${m[2]}` : '';
};
const toMin = hm => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };

/** length of a time slot, e.g. "6h", "1h 30m", "45m" (an end before the start runs past midnight) */
const slotLength = (a, b) => {
  let d = toMin(b) - toMin(a);
  if (d <= 0) d += 24 * 60;
  const h = Math.floor(d / 60), m = d % 60;
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
};

function groupOf(t) {
  if (!t.time) return DAY_GROUPS[0];
  const m = toMin(t.time);
  return DAY_GROUPS.find(g => g.until && m < g.until) || DAY_GROUPS[DAY_GROUPS.length - 1];
}

/** one step of a repeat rule */
function stepISO(iso, rep) {
  const d = new Date(iso + 'T00:00');
  if (rep === 'day') d.setDate(d.getDate() + 1);
  else if (rep === 'week') d.setDate(d.getDate() + 7);
  else if (rep === 'weekday') { do d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6); }
  else if (rep === 'month') {
    const day = d.getDate();
    d.setDate(1); d.setMonth(d.getMonth() + 1);
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  }
  return d.toLocaleDateString('en-CA');
}

/** next date for a repeating task: after its due date, and never in the past */
function nextOccurrence(base, rep) {
  const today = new Date().toLocaleDateString('en-CA');
  let n = stepISO(base, rep);
  for (let guard = 0; n <= today && guard < 1000; guard++) n = stepISO(n, rep);
  return n;
}

const STRIP_BACK = 1;    // days of the strip that sit before today
const STRIP_LEN  = 7;

const todayISO = () => new Date().toLocaleDateString('en-CA');
const newId    = () => 'tm' + Math.random().toString(36).slice(2, 8);

/** Monday of the week an ISO date falls in */
const mondayOf = iso => {
  const d = new Date(iso + 'T00:00');
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toLocaleDateString('en-CA');
};

const shiftISO = (iso, n) => {
  const d = new Date(iso + 'T00:00');
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('en-CA');
};

/* ── parse / serialise ──────────────────────────────────────────────── */

function parseTaskLine(raw) {
  const m = raw.match(RE_TASK);
  if (!m) return null;
  const [, indent, check, rest0] = m;

  let rest = rest0;
  let id = null;
  const idm = rest.match(RE_ID);
  if (idm) { id = idm[1]; rest = rest.slice(0, idm.index); }

  const due  = (rest.match(RE_DUE)  || [])[1] || '';
  const prio = (rest.match(RE_PRIO) || [])[1] || '';
  const moves = parseInt((rest.match(RE_MOVES) || [])[1] || '0', 10);
  const from  = (rest.match(RE_FROM) || [])[1] || '';

  const doneOn = (rest.match(RE_DONE) || [])[1] || '';
  const tmM = rest.match(RE_TIME);
  const time = tmM ? normTime(tmM[1]) : '';
  const end  = tmM && tmM[2] && time ? normTime(tmM[2]) : '';
  const repeat = ((rest.match(RE_REPEAT) || [])[1] || '').toLowerCase();

  const tags = [];
  let tm;
  RE_TAG.lastIndex = 0;
  while ((tm = RE_TAG.exec(rest)) !== null) tags.push(tm[1]);

  const text = rest
    .replace(RE_DUE, '')
    .replace(RE_TIME, '')
    .replace(RE_REPEAT, '')
    .replace(RE_MOVES, '')
    .replace(RE_FROM, '')
    .replace(RE_PRIO, '')
    .replace(RE_TAG, '')
    .replace(RE_DONE, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return {
    id, indent,
    done: check.toLowerCase() === 'x',
    text, due, time, end, repeat, doneOn,
    priority: prio ? prio[0].toUpperCase() + prio.slice(1).toLowerCase() : '',
    moves, from,
    tags, raw,
  };
}

function serialiseTask(t) {
  const bits = [
    `${t.indent || ''}- [${t.done ? 'x' : ' '}]`,
    t.text.trim(),
    t.due ? `📅 ${t.due}` : '',
    t.time ? `⏰ ${t.time}${t.end ? '-' + t.end : ''}` : '',
    t.repeat ? `🔁 every ${t.repeat}` : '',
    t.moves ? `↻${t.moves}` : '',
    t.moves && t.from ? `(from ${t.from})` : '',
    t.priority ? `(${t.priority})` : '',
    ...t.tags.map(x => `🔖 ${x}`),
    t.done && t.doneOn ? `✅ ${t.doneOn}` : '',
  ].filter(Boolean);
  return `${bits.join(' ')} ^${t.id}`;
}

/* Rescheduling history: changing a due date that was already set counts
   as one move, and the very first date is kept as `from`. */
function trackMove(t, changes) {
  const next = Object.assign({}, t, changes);
  if (changes && 'done' in changes) next.doneOn = changes.done ? todayISO() : '';
  if (changes && 'due' in changes && t.due && changes.due && changes.due !== t.due) {
    next.moves = (t.moves || 0) + 1;
    next.from = t.from || t.due;
  }
  return next;
}

/* ── atomic file mutation ───────────────────────────────────────────── */

async function mutate(app, file, fn) {
  if (typeof app.vault.process === 'function') {
    // atomic: Obsidian serialises this against other writers
    return app.vault.process(file, data => fn(data.split('\n')).join('\n'));
  }
  const data = await app.vault.read(file);          // fallback, older API
  await app.vault.modify(file, fn(data.split('\n')).join('\n'));
}

/* ── the view ───────────────────────────────────────────────────────── */

class TaskView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.tasks = [];
    this.tab = 'day';
    this.day = todayISO();
    this.query = '';
    this.sort = 'due';
    this.lastDeleted = null;
    this.project = null;        // path of the project whose page is open
    this.allProjects = false;   // "See all" in the projects grid
    this.allDone = false;       // earlier completed tasks on a project page
    this.weekStart = mondayOf(todayISO());
    this.refresh = debounce(this._refresh.bind(this), 120, true);
  }

  getViewType()    { return VIEW_TYPE; }
  getDisplayText() { return 'Tasks'; }
  getIcon()        { return 'checkmark'; }

  async onOpen() {
    this.root = this.contentEl.createDiv({ cls: 'tm-container tm2' });
    this.buildChrome();
    this.registerEvent(this.app.metadataCache.on('changed', () => this.refresh()));
    this.registerEvent(this.app.vault.on('modify', () => this.refresh()));
    await this._refresh();
  }

  async onClose() { this.contentEl.empty(); }

  /* ── static chrome, built once ─────────────────────────────────── */

  buildChrome() {
    /* two panes: the overview, and one project's page */
    this.homeEl = this.root.createDiv({ cls: 'tm3-home' });
    this.pageEl = this.root.createDiv({ cls: 'tm3-page' });
    this.pageEl.hide();
    const H = this.homeEl;

    /* header: title · search · sort · month */
    const hd = H.createDiv({ cls: 'tm3-hd' });
    const title = hd.createDiv({ cls: 'tm3-hd-t' });
    setIcon(title.createSpan({ cls: 'tm3-i' }), 'list-checks');
    title.createSpan({ text: 'Tasks' });
    const tools = hd.createDiv({ cls: 'tm3-hd-r' });

    const searchBtn = tools.createDiv({ cls: 'tm3-ibtn', attr: { 'aria-label': 'Search' } });
    setIcon(searchBtn, 'search');
    this.sortBtn = tools.createDiv({ cls: 'tm3-ibtn', attr: { 'aria-label': 'Sort' } });
    this.paintSort();
    this.sortBtn.onclick = ev => {
      const m = new Menu();
      [['due', 'Due date'], ['priority', 'Priority'], ['project', 'Project'], ['text', 'Name']]
        .forEach(([k, label]) => m.addItem(i => i
          .setTitle(label)
          .setChecked(this.sort === k)
          .onClick(() => { this.sort = k; this.paintSort(); this.renderList(); })));
      m.showAtMouseEvent(ev);
    };
    this.monthBtn = tools.createDiv({ cls: 'tm3-pill' });
    this.monthBtn.onclick = ev => this.monthMenu(ev);

    /* search: hidden until asked for */
    const search = H.createDiv({ cls: 'tm2-search tm3-search' });
    search.hide();
    setIcon(search.createSpan({ cls: 'tm2-search-icon' }), 'search');
    this.searchInput = search.createEl('input', { attr: { type: 'text', placeholder: 'Search tasks' } });
    this.searchInput.addEventListener('input', () => {
      this.query = this.searchInput.value.toLowerCase();
      this.renderList();
    });
    const closeSearch = () => { this.searchInput.value = ''; this.query = ''; search.hide(); this.renderList(); };
    this.searchInput.addEventListener('keydown', e => { if (e.key === 'Escape') closeSearch(); });
    searchBtn.onclick = () => {
      if (search.isShown()) closeSearch();
      else { search.show(); this.searchInput.focus(); }
    };

    /* week strip */
    this.daysEl = H.createDiv({ cls: 'tm3-wk' });

    /* projects */
    const pl = H.createDiv({ cls: 'tm3-lab' });
    const pll = pl.createDiv({ cls: 'tm3-lab-l' });
    setIcon(pll.createSpan({ cls: 'tm3-i' }), 'folder');
    pll.createSpan({ text: 'Projects' });
    this.seeAllEl = pl.createDiv({ cls: 'tm3-lab-r' });
    this.seeAllEl.onclick = () => { this.allProjects = !this.allProjects; this.renderProjects(); };
    this.projEl = H.createDiv({ cls: 'tm3-grid' });

    /* tasks: heading, count, filter */
    const tl = H.createDiv({ cls: 'tm3-lab tm3-lab-tasks' });
    const tll = tl.createDiv({ cls: 'tm3-lab-l' });
    this.secTitle = tll.createSpan({ text: 'Tasks' });
    this.secCount = tll.createSpan({ cls: 'tm3-n' });
    this.tabsEl = tl.createDiv({ cls: 'tm3-pill' });
    this.tabsEl.onclick = ev => this.filterMenu(ev);

    this.listEl = H.createDiv({ cls: 'tm2-list' });

    this.undoEl = this.root.createDiv({ cls: 'tm2-undo' });
    this.undoEl.style.display = 'none';

    /* docked composer — stays reachable with a thumb */
    const dock = this.root.createDiv({ cls: 'tm2-dock' });
    this.addInput = dock.createEl('input', {
      cls: 'tm2-dock-input',
      attr: { type: 'text', placeholder: 'Add a task…' },
    });
    const addBtn = dock.createDiv({ cls: 'tm2-dock-btn' });
    setIcon(addBtn, 'plus');
    addBtn.onclick = () => this.quickAdd();
    this.addInput.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); this.quickAdd(); }
      if (e.key === 'Escape') { this.addInput.value = ''; this.addInput.blur(); }
    });

    const hint = this.root.createDiv({ cls: 'tm2-hint' });
    [['!high', ' · '], ['@tomorrow', ' · '], ['9:30', ' · '], ['#tag', ' · '], ['/project', '']]
      .forEach(([code, after]) => {
        hint.createEl('code', { text: code });
        if (after) hint.createSpan({ text: after });
      });
  }

  monthMenu(ev) {
    const m = new Menu();
    const now = new Date(todayISO() + 'T00:00');
    m.addItem(i => i.setTitle('Today').setIcon('calendar-check').onClick(() => this.gotoDay(todayISO())));
    m.addSeparator();
    for (let k = -2; k <= 6; k++) {
      const d = new Date(now.getFullYear(), now.getMonth() + k, 1);
      const iso = k === 0 ? todayISO() : d.toLocaleDateString('en-CA');
      m.addItem(i => i
        .setTitle(d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))
        .onClick(() => this.gotoDay(iso)));
    }
    m.showAtMouseEvent(ev);
  }

  gotoDay(iso) {
    this.tab = 'day';
    this.day = iso;
    this.weekStart = mondayOf(iso);
    this.renderTop(); this.renderDays(); this.renderTabs(); this.renderList();
  }

  filterMenu(ev) {
    const c = this.counts();
    const m = new Menu();
    const pick = fn => () => { fn(); this.renderDays(); this.renderTabs(); this.renderList(); };
    m.addItem(i => i.setTitle('Today' + (c.today ? `  ·  ${c.today}` : '')).setIcon('sun')
      .setChecked(this.tab === 'day' && this.day === todayISO())
      .onClick(() => this.gotoDay(todayISO())));
    m.addSeparator();
    TABS.forEach(t => m.addItem(i => i
      .setTitle(t.label + (c[t.id] ? `  ·  ${c[t.id]}` : ''))
      .setChecked(this.tab === t.id)
      .onClick(pick(() => { this.tab = t.id; }))));
    m.showAtMouseEvent(ev);
  }

  paintSort() {
    this.sortBtn.empty();
    setIcon(this.sortBtn, 'arrow-up-down');
    this.sortBtn.setAttr('aria-label', 'Sort: ' + { due: 'Due date', priority: 'Priority', project: 'Project', text: 'Name' }[this.sort]);
  }

  /* ── data ──────────────────────────────────────────────────────── */

  projectFiles() {
    return this.app.vault.getMarkdownFiles()
      .filter(f => this.app.metadataCache.getFileCache(f)?.frontmatter?.type === 'Project');
  }

  async _refresh() {
    const files = this.projectFiles();
    const out = [];

    await Promise.all(files.map(async file => {
      let data;
      try { data = await this.app.vault.cachedRead(file); } catch { return; }
      const lines = data.split('\n');
      const start = lines.findIndex(l => RE_H_TASKS.test(l.trim()));
      if (start === -1) return;

      const seen = new Set();
      for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i];
        if (/^#{1,6}\s/.test(line)) break;           // next heading ends the section
        const t = parseTaskLine(line);
        if (!t) continue;

        /* a copied line carries someone else's ^id: treat it as new, so a
           tick or edit hits this line (and it gets its own id then) */
        if (t.id && seen.has(t.id)) t.id = null;
        if (t.id) seen.add(t.id);

        /* typed straight into the note (no id yet): read the same shortcuts
           as the Add box — @today, !high, #tag, 9:30, 9:00-15:00, every day.
           Nothing is rewritten while you type; the first tick or edit saves
           the line in the normal format. */
        if (!t.id && /(^|\s)(@\S|!(high|medium|low)\b|#\S|\d{1,2}:\d{2}|\d{1,2}\s?(am|pm)\b|every |daily|weekly|monthly|weekdays)/i.test(t.text)) {
          const q = this.parseQuick(t.text);
          if (q.text) {
            t.text = q.text;
            if (q.due && !t.due) t.due = q.due;
            if (q.priority && !t.priority) t.priority = q.priority;
            if (q.time && !t.time) { t.time = q.time; t.end = q.end; }
            if (q.repeat && !t.repeat) t.repeat = q.repeat;
            q.tags.forEach(x => { if (!t.tags.includes(x)) t.tags.push(x); });
          }
        }
        t.file = file;
        t.project = file.basename;
        t.lineNo = i;
        out.push(t);
      }
    }));

    this.tasks = out;
    this.renderTop();
    this.renderDays();
    this.renderProjects();
    this.renderTabs();
    this.renderList();
    this.renderPage();
  }

  filtered() {
    const today = todayISO();
    let list = this.tasks.filter(t => {
      switch (this.tab) {
        case 'day':       return !t.done && t.due === this.day;
        case 'overdue':   return !t.done && t.due && t.due < today;
        case 'upcoming':  return !t.done && t.due && t.due > today;
        case 'unplanned': return !t.done && !t.due;
        case 'done':      return t.done;
        default:          return !t.done;
      }
    });

    if (this.query) {
      list = list.filter(t =>
        t.text.toLowerCase().includes(this.query) ||
        t.project.toLowerCase().includes(this.query) ||
        t.tags.some(x => x.toLowerCase().includes(this.query)));
    }

    const rank = p => ({ High: 0, Medium: 1, Low: 2 }[p] ?? 3);
    const cmp = {
      due:      (a, b) => (a.due || '9999').localeCompare(b.due || '9999') || rank(a.priority) - rank(b.priority),
      priority: (a, b) => rank(a.priority) - rank(b.priority) || (a.due || '9999').localeCompare(b.due || '9999'),
      project:  (a, b) => a.project.localeCompare(b.project) || (a.due || '9999').localeCompare(b.due || '9999'),
      text:     (a, b) => a.text.localeCompare(b.text),
    }[this.sort];

    return list.sort(cmp);
  }

  /** open tasks due on a given ISO date */
  dayCount(iso) {
    return this.tasks.filter(t => !t.done && t.due === iso).length;
  }

  counts() {
    const today = todayISO();
    const open = this.tasks.filter(t => !t.done);
    return {
      day:       open.filter(t => t.due === this.day).length,
      today:     open.filter(t => t.due === today).length,
      overdue:   open.filter(t => t.due && t.due < today).length,
      upcoming:  open.filter(t => t.due && t.due > today).length,
      unplanned: open.filter(t => !t.due).length,
      all:       open.length,
      done:      this.tasks.length - open.length,
    };
  }

  /* ── render: hero ──────────────────────────────────────────────── */

  renderTop() {
    /* month shown = the month most of the visible week is in */
    const mid = new Date(shiftISO(this.weekStart, 3) + 'T00:00');
    this.monthBtn.empty();
    this.monthBtn.createSpan({ text: mid.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) });
    setIcon(this.monthBtn.createSpan({ cls: 'tm3-i' }), 'chevron-down');
  }

  renderDays() {
    const today = todayISO();
    this.daysEl.empty();

    const nav = (icon, step, label) => {
      const b = this.daysEl.createDiv({ cls: 'tm3-wk-nav', attr: { 'aria-label': label } });
      setIcon(b, icon);
      b.onclick = () => { this.weekStart = shiftISO(this.weekStart, step); this.renderTop(); this.renderDays(); };
    };
    nav('chevron-left', -7, 'Previous week');

    for (let i = 0; i < 7; i++) {
      const iso = shiftISO(this.weekStart, i);
      const d = new Date(iso + 'T00:00');
      const cls = 'tm3-day'
        + (iso === today ? ' is-today' : '')
        + (this.tab === 'day' && iso === this.day ? ' is-on' : '')
        + (this.dayCount(iso) ? ' has-tasks' : '');
      const cell = this.daysEl.createDiv({ cls });
      cell.createDiv({ cls: 'tm3-day-w', text: d.toLocaleDateString(undefined, { weekday: 'short' }) });
      cell.createDiv({ cls: 'tm3-day-n', text: String(d.getDate()) });
      cell.createDiv({ cls: 'tm3-day-dot' });
      cell.onclick = () => {
        this.tab = 'day';
        this.day = iso;
        this.renderDays();
        this.renderTabs();
        this.renderList();
      };
    }
    nav('chevron-right', 7, 'Next week');
  }

  /* ── render: projects grid ─────────────────────────────────────── */

  projectStats() {
    const by = new Map();
    this.projectFiles().forEach(f => by.set(f.path, { file: f, total: 0, done: 0, open: 0 }));
    this.tasks.forEach(t => {
      const p = by.get(t.file.path);
      if (!p) return;
      p.total++; t.done ? p.done++ : p.open++;
    });
    /* busiest first; empty projects last */
    return [...by.values()].sort((a, b) => b.open - a.open || b.total - a.total || a.file.basename.localeCompare(b.file.basename));
  }

  progressEl(host, p) {
    const el = host.createDiv({ cls: 'tm3-prog' });
    const tone = !p.total ? 'none' : p.open === 0 ? 'ok' : 'a';
    setIcon(el.createSpan({ cls: 'tm3-i tm3-tone-' + tone }), p.total && p.open === 0 ? 'circle-check' : 'loader');
    if (!p.total) { el.createSpan({ text: 'No tasks yet' }); return el; }
    const s = el.createSpan();
    s.createEl('b', { cls: 'tm3-tone-' + tone, text: `${p.done}/${p.total}` });
    s.appendText(' completed');
    return el;
  }

  renderProjects() {
    const all = this.projectStats();
    const LIMIT = 4;
    this.projEl.empty();
    this.seeAllEl.empty();
    if (all.length > LIMIT) {
      this.seeAllEl.createSpan({ text: this.allProjects ? 'Show less' : `See all (${all.length})` });
      setIcon(this.seeAllEl.createSpan({ cls: 'tm3-i' }), this.allProjects ? 'chevron-up' : 'chevron-right');
    }
    if (!all.length) {
      this.projEl.createDiv({ cls: 'tm3-grid-empty', text: 'No projects yet. Add type: Project to a note’s properties.' });
      return;
    }
    (this.allProjects ? all : all.slice(0, LIMIT)).forEach(p => {
      const card = this.projEl.createDiv({ cls: 'tm3-pc' });
      const top = card.createDiv({ cls: 'tm3-pc-top' });
      setIcon(top.createDiv({ cls: 'tm3-pc-ic' }), 'folder');
      const more = top.createDiv({ cls: 'tm3-pc-more', attr: { 'aria-label': 'More' } });
      setIcon(more, 'more-horizontal');
      more.onclick = ev => {
        ev.stopPropagation();
        const m = new Menu();
        m.addItem(i => i.setTitle('Open note').setIcon('file-text')
          .onClick(() => this.app.workspace.openLinkText(p.file.path, '', false)));
        m.addItem(i => i.setTitle('New tasks go here by default').setIcon('inbox')
          .setChecked(this.plugin.settings.defaultProject === p.file.basename)
          .onClick(async () => { this.plugin.settings.defaultProject = p.file.basename; await this.plugin.saveSettings(); }));
        m.showAtMouseEvent(ev);
      };
      card.createDiv({ cls: 'tm3-pc-n', text: p.file.basename });
      this.progressEl(card, p);
      card.onclick = () => this.openProject(p.file.path);
    });
  }

  /* ── one project's page ────────────────────────────────────────── */

  openProject(path) {
    this.project = path;
    this.allDone = false;
    this.homeEl.hide();
    this.pageEl.show();
    this.renderPage();
    this.contentEl.scrollTop = 0;
  }

  closeProject() {
    this.project = null;
    this.pageEl.hide();
    this.homeEl.show();
    this.addInput.setAttr('placeholder', 'Add a task…');
  }

  renderPage() {
    if (!this.project) return;
    const file = this.app.vault.getAbstractFileByPath(this.project);
    if (!file) { this.closeProject(); return; }
    const E = this.pageEl;
    E.empty();
    this.addInput.setAttr('placeholder', `Add a task to ${file.basename}…`);

    const mine = this.tasks.filter(t => t.file.path === file.path);
    const done = mine.filter(t => t.done)
      .sort((a, b) => (a.doneOn || '').localeCompare(b.doneOn || '') || b.lineNo - a.lineNo);
    const open = mine.filter(t => !t.done)
      .sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999')
        || (a.time || '99').localeCompare(b.time || '99') || a.lineNo - b.lineNo);

    /* header */
    const hd = E.createDiv({ cls: 'tm3-hd' });
    const title = hd.createDiv({ cls: 'tm3-hd-t' });
    const back = title.createDiv({ cls: 'tm3-ibtn tm3-back', attr: { 'aria-label': 'Back' } });
    setIcon(back, 'arrow-left');
    back.onclick = () => this.closeProject();
    setIcon(title.createSpan({ cls: 'tm3-i' }), 'folder');
    title.createSpan({ cls: 'tm3-hd-name', text: file.basename });
    const edit = hd.createDiv({ cls: 'tm3-ibtn', attr: { 'aria-label': 'Open note' } });
    setIcon(edit, 'square-pen');
    edit.onclick = () => this.app.workspace.openLinkText(file.path, '', false);

    /* summary */
    const sum = E.createDiv({ cls: 'tm3-sum' });
    const cell = (label, value, cls = '') => {
      const c = sum.createDiv({ cls: 'tm3-sum-c' });
      c.createDiv({ cls: 'tm3-sum-l', text: label });
      c.createDiv({ cls: 'tm3-sum-v ' + cls, text: value });
    };
    const nextDue = open.find(t => t.due);
    const today = todayISO();
    cell('Next due', nextDue ? this.prettyDate(nextDue.due) : '—',
      nextDue ? (nextDue.due < today ? 'is-overdue' : nextDue.due === today ? 'is-today' : '') : '');
    sum.createDiv({ cls: 'tm3-sum-sep' });
    const lastDone = done.filter(t => t.doneOn).pop();
    cell('Last done', lastDone ? this.prettyDate(lastDone.doneOn) : '—');

    const stat = { total: mine.length, done: done.length, open: open.length };
    this.progressEl(E, stat).addClass('tm3-prog-lg');
    const bar = E.createDiv({ cls: 'tm3-bar' });
    bar.createDiv({ cls: 'tm3-bar-f' }).style.width = (stat.total ? Math.round(stat.done / stat.total * 100) : 0) + '%';

    if (!mine.length) {
      const e = E.createDiv({ cls: 'tm2-empty' });
      setIcon(e.createDiv({ cls: 'tm2-empty-icon' }), 'check-circle');
      e.createDiv({ text: 'No tasks in this project yet' });
      e.createDiv({ cls: 'tm2-empty-sub', text: 'Add one below' });
      return;
    }

    /* numbered list: done first, then what is next */
    const th = E.createDiv({ cls: 'tm3-th' });
    th.createSpan({ text: 'Task' }); th.createSpan({ text: 'Description' }); th.createSpan({ text: 'Status' });

    const KEEP = 3;
    const hidden = this.allDone ? 0 : Math.max(0, done.length - KEEP);
    if (done.length > KEEP) {
      const more = E.createDiv({ cls: 'tm3-earlier' });
      more.setText(this.allDone ? 'Hide earlier completed' : `Show ${hidden} earlier completed`);
      more.onclick = () => { this.allDone = !this.allDone; this.renderPage(); };
    }

    [...done, ...open].forEach((t, i) => {
      if (i < hidden) return;
      const row = E.createDiv({ cls: 'tm3-tr' + (t.done ? ' is-done' : '') });
      const isNext = !t.done && t === open[0];
      row.createDiv({ cls: 'tm3-num' + (isNext ? ' is-next' : ''), text: String(i + 1) });

      const body = row.createDiv({ cls: 'tm3-tr-b' });
      const name = body.createDiv({ cls: 'tm3-tr-t', text: t.text });
      name.onclick = () => this.openEditor(t);
      this.metaLine(t, body, { hideProject: true });

      const st = row.createDiv({ cls: 'tm3-st' });
      const box = st.createDiv({ cls: 'tm2-check' + (t.done ? ' is-on' : '') + (t.priority ? ` tm3-p-${t.priority.toLowerCase()}` : '') });
      box.onclick = e => { e.stopPropagation(); this.toggle(t); };
      if (t.done && t.doneOn) st.createDiv({ cls: 'tm3-st-d', text: this.prettyDate(t.doneOn) });

      row.oncontextmenu = ev => { ev.preventDefault(); this.rowMenu(ev, t); };
    });
  }

  /* ── render: filter + list ─────────────────────────────────────── */

  renderTabs() {
    const label = this.tab === 'day'
      ? this.sectionTitle()
      : (TABS.find(t => t.id === this.tab) || {}).label || 'All';
    this.tabsEl.empty();
    this.tabsEl.createSpan({ text: label });
    setIcon(this.tabsEl.createSpan({ cls: 'tm3-i' }), 'chevron-down');
  }

  /** what the list below is currently showing */
  sectionTitle() {
    if (this.tab !== 'day') {
      return (TABS.find(t => t.id === this.tab) || {}).label || 'Tasks';
    }
    const today = todayISO();
    if (this.day === today) return 'Today';
    if (this.day === shiftISO(today, 1))  return 'Tomorrow';
    if (this.day === shiftISO(today, -1)) return 'Yesterday';
    return new Date(this.day + 'T00:00')
      .toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
  }

  renderList() {
    this.listEl.empty();
    const list = this.filtered();

    this.secCount.setText(String(list.length));
    this.secCount.toggle(!!list.length);

    if (!list.length) {
      const e = this.listEl.createDiv({ cls: 'tm2-empty' });
      setIcon(e.createDiv({ cls: 'tm2-empty-icon' }), this.query ? 'search-x' : 'check-circle');
      if (this.query) {
        e.createDiv({ text: 'Nothing matches that search' });
        e.createDiv({ cls: 'tm2-empty-sub', text: `in ${this.tab}` });
      } else {
        const msg = {
          day:       [`Nothing due ${this.sectionTitle().toLowerCase()}`, 'Add one below, or pick another day'],
          overdue:   ['Nothing overdue',       'You are on top of it'],
          upcoming:  ['Nothing scheduled',     'Add a date with @tomorrow'],
          unplanned: ['Everything has a date', 'Nice'],
          all:       ['No open tasks',         'Add one below'],
          done:      ['Nothing finished yet',  'Tick something off'],
        }[this.tab] || ['Nothing here', ''];
        e.createDiv({ text: msg[0] });
        if (msg[1]) e.createDiv({ cls: 'tm2-empty-sub', text: msg[1] });
      }
      return;
    }

    /* a single day: Anytime, Morning, Midday, Afternoon, Evening */
    if (this.tab === 'day' && this.sort !== 'project') {
      const order = new Map(list.map((t, i) => [t, i]));
      const buckets = DAY_GROUPS.map(g => ({ g, items: [] }));
      list.forEach(t => buckets[DAY_GROUPS.indexOf(groupOf(t))].items.push(t));
      buckets.forEach(({ g, items }) => {
        if (!items.length) return;
        /* by time within a group; untimed keep the chosen sort */
        items.sort((a, b) => (a.time && b.time ? toMin(a.time) - toMin(b.time) : 0) || order.get(a) - order.get(b));
        const hd = this.listEl.createDiv({ cls: 'tm2-group tm2-tgroup' });
        setIcon(hd.createSpan({ cls: 'tm2-tgroup-i' }), g.icon);
        hd.createSpan({ cls: 'tm2-tgroup-t', text: g.label });
        hd.createSpan({ cls: 'tm2-tgroup-n', text: String(items.length) });
        items.forEach(t => this.listEl.appendChild(this.taskRow(t)));
      });
      return;
    }

    let lastProject = null;
    list.forEach(t => {
      if (this.sort === 'project' && t.project !== lastProject) {
        lastProject = t.project;
        this.listEl.createDiv({ cls: 'tm2-group', text: t.project });
      }
      this.listEl.appendChild(this.taskRow(t));
    });
  }

  /** the details line: small Lucide icons and plain text */
  metaLine(t, host, opts = {}) {
    const today = todayISO();
    const overdue = !t.done && t.due && t.due < today;
    const meta = host.createDiv({ cls: 'tm2-meta' });
    const item = (icon, label, cls = '', title = '') => {
      const el = meta.createSpan({ cls: 'tm2-mi' + (cls ? ' ' + cls : '') });
      setIcon(el.createSpan({ cls: 'tm2-i' }), icon);
      el.createSpan({ text: label });
      if (title) el.setAttr('title', title);
      return el;
    };
    if (t.time) {
      item('clock', t.end ? `${t.time}–${t.end} · ${slotLength(t.time, t.end)}` : t.time, 'tm2-mi-time');
    }
    if (t.due && !opts.hideDue) {
      let c = 'tm2-mi-due';
      if (overdue) c += ' is-overdue';
      else if (t.due === today) c += ' is-today';
      item(overdue ? 'alarm-clock' : 'calendar', this.prettyDate(t.due), c);
    }
    if (t.project && !opts.hideProject) item('folder', t.project, 'tm2-mi-project');
    if (t.priority) item('flag', t.priority, `tm2-mi-prio tm2-mi-${t.priority.toLowerCase()}`);
    if (t.repeat) item('repeat', REPEAT_LABEL[t.repeat] || t.repeat, 'tm2-mi-repeat');
    if (t.moves) item('history', String(t.moves), 'tm2-mi-moved',
      `Rescheduled ${t.moves}×` + (t.from ? ` · originally ${this.prettyDate(t.from)}` : ''));
    t.tags.forEach(tag => item('hash', tag, 'tm2-mi-tag'));
    if (!meta.childElementCount) meta.remove();
    return meta;
  }

  taskRow(t) {
    const today = todayISO();
    const overdue = !t.done && t.due && t.due < today;

    let cls = 'tm2-row tm3-card';
    if (t.done) cls += ' is-done';
    if (t.priority) cls += ` tm2-p-${t.priority.toLowerCase()}`;
    if (overdue && !t.done) cls += ' is-overdue';
    const row = createDiv({ cls });

    /* project on top, title, details; checkbox on the right */
    const body = row.createDiv({ cls: 'tm2-body' });
    const proj = body.createDiv({ cls: 'tm3-card-p', text: t.project });
    proj.onclick = e => { e.stopPropagation(); this.openProject(t.file.path); };
    const text = body.createDiv({ cls: 'tm2-text', text: t.text });
    text.onclick = () => (Platform.isMobile ? this.openEditor(t) : this.inlineEdit(t, text));
    this.metaLine(t, body, { hideProject: true, hideDue: this.tab === 'day' && t.due === this.day });

    const side = row.createDiv({ cls: 'tm3-card-r' });
    const box = side.createDiv({ cls: 'tm2-check' + (t.done ? ' is-on' : '') });
    box.onclick = e => { e.stopPropagation(); this.toggle(t); };
    const more = side.createDiv({ cls: 'tm2-act tm3-card-more', attr: { 'aria-label': 'More' } });
    setIcon(more, 'more-horizontal');
    more.onclick = ev => { ev.stopPropagation(); this.rowMenu(ev, t); };
    row.oncontextmenu = ev => { ev.preventDefault(); this.rowMenu(ev, t); };

    return row;
  }

  prettyDate(iso) {
    const today = todayISO();
    if (iso === today) return 'Today';
    const d = new Date(iso + 'T00:00'), n = new Date(today + 'T00:00');
    const diff = Math.round((d - n) / 86400000);
    if (diff === 1)  return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    if (diff > 1 && diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  rowMenu(ev, t) {
    const m = new Menu();
    m.addItem(i => i.setTitle('Edit…').setIcon('pencil').onClick(() => this.openEditor(t)));

    m.addItem(i => i.setTitle('Due today').setIcon('calendar').onClick(() => this.patch(t, { due: todayISO() })));
    m.addItem(i => i.setTitle('Due tomorrow').setIcon('calendar-clock').onClick(() => {
      const d = new Date(); d.setDate(d.getDate() + 1);
      this.patch(t, { due: d.toLocaleDateString('en-CA') });
    }));
    if (t.due) m.addItem(i => i.setTitle('Clear due date').setIcon('calendar-x').onClick(() => this.patch(t, { due: '' })));

    m.addSeparator();
    PRIORITIES.forEach(p => m.addItem(i => i
      .setTitle(p).setChecked(t.priority === p)
      .onClick(() => this.patch(t, { priority: t.priority === p ? '' : p }))));

    m.addSeparator();
    m.addItem(i => i.setTitle('Open note').setIcon('file-text')
      .onClick(() => this.app.workspace.openLinkText(t.file.path, '', false)));
    m.addItem(i => i.setTitle('Delete').setIcon('trash').onClick(() => this.remove(t)));
    m.showAtMouseEvent(ev);
  }

  /* ── inline edit ───────────────────────────────────────────────── */

  inlineEdit(t, el) {
    const input = createEl('input', { cls: 'tm2-inline', attr: { type: 'text', value: t.text } });
    el.replaceWith(input);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    let settled = false;
    const done = commit => {
      if (settled) return;
      settled = true;
      const v = input.value.trim();
      if (commit && v && v !== t.text) this.patch(t, { text: v });
      else this.renderList();
    };
    input.addEventListener('blur', () => done(true));
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); done(true); }
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
    });
  }

  /* ── mutations ─────────────────────────────────────────────────── */

  /** Locate a task's line. Prefers the block ID; falls back to the cached
   *  line number, and only then to exact-line match. Never substring. */
  findLine(lines, t) {
    if (t.id) {
      const i = lines.findIndex(l => l.includes(`^${t.id}`));
      if (i !== -1) return i;
    }
    if (lines[t.lineNo] === t.raw) return t.lineNo;
    return lines.findIndex(l => l === t.raw);
  }

  async patch(t, changes) {
    const next = trackMove(t, changes);
    if (!next.id) next.id = newId();
    try {
      await mutate(this.app, t.file, lines => {
        const i = this.findLine(lines, t);
        if (i === -1) throw new Error('not found');
        lines[i] = serialiseTask(next);
        return lines;
      });
      await this._refresh();
    } catch (e) {
      console.error('[task-manager] patch failed', e, t);
      new Notice('Could not find that task line — nothing changed');
    }
  }

  async toggle(t) {
    if (t.done || !t.repeat) return this.patch(t, { done: !t.done });

    /* repeating: tick this one off and add the next one right below it */
    const nextDue = nextOccurrence(t.due || todayISO(), t.repeat);
    const doneT = Object.assign({}, t, { done: true, doneOn: todayISO() });
    if (!doneT.id) doneT.id = newId();
    const fresh = {
      indent: t.indent || '', done: false, id: newId(),
      text: t.text, due: nextDue, time: t.time, end: t.end, repeat: t.repeat,
      priority: t.priority, tags: [...t.tags], moves: 0, from: '',
    };
    try {
      await mutate(this.app, t.file, lines => {
        const i = this.findLine(lines, t);
        if (i === -1) throw new Error('not found');
        lines[i] = serialiseTask(doneT);
        /* never twice: if an open copy for that date already exists
           (ticked, unticked, ticked again), don't add another one */
        const twin = lines.some(l => {
          const x = parseTaskLine(l);
          return x && !x.done && x.text === fresh.text && x.repeat === fresh.repeat && x.due === fresh.due;
        });
        if (!twin) lines.splice(i + 1, 0, serialiseTask(fresh));
        return lines;
      });
      new Notice(`Done \u00b7 next on ${this.prettyDate(nextDue)}`);
      await this._refresh();
    } catch (e) {
      console.error('[task-manager] repeat failed', e, t);
      new Notice('Could not find that task line — nothing changed');
    }
  }

  async remove(t) {
    try {
      let removed = null, atIndex = -1;
      await mutate(this.app, t.file, lines => {
        const i = this.findLine(lines, t);
        if (i === -1) throw new Error('not found');
        removed = lines[i]; atIndex = i;
        lines.splice(i, 1);
        return lines;
      });
      this.lastDeleted = { file: t.file, line: removed, at: atIndex };
      this.showUndo(t.text);
      await this._refresh();
    } catch (e) {
      console.error('[task-manager] delete failed', e, t);
      new Notice('Could not find that task line — nothing deleted');
    }
  }

  showUndo(label) {
    this.undoEl.empty();
    this.undoEl.style.display = '';
    this.undoEl.createSpan({ text: `Deleted “${label.slice(0, 36)}”` });
    const btn = this.undoEl.createSpan({ cls: 'tm2-undo-btn', text: 'Undo' });
    btn.onclick = () => this.undo();
    clearTimeout(this._undoTimer);
    this._undoTimer = setTimeout(() => { this.undoEl.style.display = 'none'; this.lastDeleted = null; }, 8000);
  }

  async undo() {
    const d = this.lastDeleted;
    if (!d) return;
    this.lastDeleted = null;
    this.undoEl.style.display = 'none';
    await mutate(this.app, d.file, lines => {
      lines.splice(Math.min(d.at, lines.length), 0, d.line);
      return lines;
    });
    await this._refresh();
  }

  /* ── quick add ─────────────────────────────────────────────────── */

  parseQuick(raw) {
    let s = ' ' + raw + ' ';
    const take = re => { const m = s.match(re); if (m) { s = s.replace(m[0], ' '); return m[1]; } return ''; };

    const prio = take(/\s!(high|medium|low)\b/i);
    let due    = take(/\s@(\d{4}-\d{2}-\d{2})\b/);
    const word = take(/\s@(today|tomorrow)\b/i);
    if (!due && word) {
      const d = new Date();
      if (word.toLowerCase() === 'tomorrow') d.setDate(d.getDate() + 1);
      due = d.toLocaleDateString('en-CA');
    }
    const project = take(/\s\/([^\s]+)/);

    /* time: needs a colon or am/pm, so "read 10-20 pages" stays text */
    const ampm = (h, ap) => { h = +h % 12; if (/p/i.test(ap)) h += 12; return `${h}:00`; };
    let time = '', end = '';
    const slot = s.match(/\s(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})(?=\s)/);
    if (slot) { time = normTime(slot[1]); end = normTime(slot[2]); s = s.replace(slot[0], ' '); }
    else {
      const one = s.match(/\s(\d{1,2}:\d{2})(?=\s)/) || s.match(/\s(\d{1,2})\s?(am|pm)(?=\s)/i);
      if (one) { time = normTime(one[2] ? ampm(one[1], one[2]) : one[1]); s = s.replace(one[0], ' '); }
    }
    const repWord = take(/\s(every day|daily|every weekday|weekdays|every week|weekly|every month|monthly)(?=\s)/i).toLowerCase();
    const repeat = { 'every day': 'day', daily: 'day', 'every weekday': 'weekday', weekdays: 'weekday',
      'every week': 'week', weekly: 'week', 'every month': 'month', monthly: 'month' }[repWord] || '';
    if (repeat && !due) due = todayISO();

    const tags = [];
    let m;
    const tagRe = /\s#([^\s#]+)/;
    while ((m = s.match(tagRe)) !== null) { tags.push(m[1]); s = s.replace(m[0], ' '); }

    return {
      text: s.replace(/\s{2,}/g, ' ').trim(),
      priority: prio ? prio[0].toUpperCase() + prio.slice(1).toLowerCase() : '',
      due, project, tags, time, end, repeat,
    };
  }

  async quickAdd() {
    const raw = this.addInput.value.trim();
    if (!raw) return;
    const q = this.parseQuick(raw);
    if (!q.text) { new Notice('Task needs some text'); return; }

    const files = this.projectFiles();
    if (!files.length) {
      new Notice('No project notes found — add `type: Project` to a note’s frontmatter');
      return;
    }

    let file = q.project
      ? files.find(f => f.basename.toLowerCase().startsWith(q.project.toLowerCase()))
      : null;
    if (q.project && !file) { new Notice(`No project matching “${q.project}”`); return; }
    if (!file && this.project) file = files.find(f => f.path === this.project);
    if (!file) file = files.find(f => f.basename === this.plugin.settings.defaultProject) || files[0];

    const task = {
      indent: '', done: false, id: newId(),
      text: q.text, due: q.due, priority: q.priority, tags: q.tags,
      time: q.time, end: q.end, repeat: q.repeat,
    };

    await mutate(this.app, file, lines => {
      let i = lines.findIndex(l => RE_H_TASKS.test(l.trim()));
      if (i === -1) { lines.push('', '## Tasks'); i = lines.length - 1; }
      lines.splice(i + 1, 0, serialiseTask(task));
      return lines;
    });

    this.addInput.value = '';
    new Notice(`Added to ${file.basename}`);
    await this._refresh();
  }

  /* ── full editor ───────────────────────────────────────────────── */

  openEditor(t) {
    const overlay = document.body.createDiv({ cls: 'tm2-overlay' });
    const sheet = overlay.createDiv({ cls: 'tm2-sheet' });
    sheet.onclick = e => e.stopPropagation();
    overlay.onclick = () => close();

    sheet.createDiv({ cls: 'tm2-sheet-handle' });
    const h = sheet.createDiv({ cls: 'tm2-sheet-head' });
    h.createDiv({ cls: 'tm2-sheet-title', text: 'Edit task' });
    const x = h.createDiv({ cls: 'tm2-sheet-close' });
    setIcon(x, 'x');
    x.onclick = () => close();

    const field = label => {
      const w = sheet.createDiv({ cls: 'tm2-field' });
      w.createDiv({ cls: 'tm2-label', text: label });
      return w;
    };

    const textIn = field('Task').createEl('input', { attr: { type: 'text', value: t.text } });

    const projSel = field('Project').createEl('select');
    this.projectFiles().forEach(f => {
      const o = projSel.createEl('option', { text: f.basename, value: f.path });
      if (f.path === t.file.path) o.selected = true;
    });

    /* priority: tappable segments, not a dropdown */
    let priority = t.priority;
    const seg = field('Priority').createDiv({ cls: 'tm2-seg' });
    const segBtns = [];
    [['', 'None'], ...PRIORITIES.map(p => [p, p])].forEach(([val, label]) => {
      const b = seg.createDiv({ cls: 'tm2-seg-b' + (priority === val ? ' is-on' : ''), text: label });
      b.dataset.p = val;
      b.onclick = () => {
        priority = val;
        segBtns.forEach(x2 => x2.toggleClass('is-on', x2.dataset.p === val));
      };
      segBtns.push(b);
    });

    const dueIn = field('Due date').createEl('input', { attr: { type: 'date', value: t.due || '' } });

    /* time: Anytime / At a time / Time slot */
    let tmode = t.time ? (t.end ? 'slot' : 'at') : 'any';
    const tf = field('Time');
    const tseg = tf.createDiv({ cls: 'tm2-seg' });
    const trow = tf.createDiv({ cls: 'tm2-time-row' });
    const startIn = trow.createEl('input', { attr: { type: 'time', value: t.time || '09:00' } });
    const dash = trow.createSpan({ cls: 'tm2-time-dash', text: '\u2013' });
    const endIn = trow.createEl('input', { attr: { type: 'time', value: t.end || '' } });
    const lenEl = trow.createSpan({ cls: 'tm2-time-len' });
    const paintLen = () => {
      const a = normTime(startIn.value), b = normTime(endIn.value);
      lenEl.setText(tmode === 'slot' && a && b ? slotLength(a, b) : '');
    };
    const tBtns = [];
    const paintTime = () => {
      tBtns.forEach(b => b.toggleClass('is-on', b.dataset.m === tmode));
      trow.toggle(tmode !== 'any');
      dash.toggle(tmode === 'slot'); endIn.toggle(tmode === 'slot');
      if (tmode === 'slot' && !endIn.value && startIn.value) {
        const m = (toMin(normTime(startIn.value) || '09:00') + 60) % 1440;
        endIn.value = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      }
      paintLen();
    };
    [['any', 'Anytime'], ['at', 'At a time'], ['slot', 'Time slot']].forEach(([m, label]) => {
      const b = tseg.createDiv({ cls: 'tm2-seg-b', text: label });
      b.dataset.m = m;
      b.onclick = () => { tmode = m; paintTime(); };
      tBtns.push(b);
    });
    startIn.oninput = paintLen; endIn.oninput = paintLen;
    paintTime();

    const repSel = field('Repeat').createEl('select');
    REPEATS.forEach(([v, label]) => {
      const o = repSel.createEl('option', { text: label, value: v });
      if ((t.repeat || '') === v) o.selected = true;
    });
    const tagIn = field('Tags').createEl('input', { attr: { type: 'text', value: t.tags.join(', '), placeholder: 'comma separated' } });

    const foot = sheet.createDiv({ cls: 'tm2-sheet-foot' });
    const cancel = foot.createDiv({ cls: 'tm2-btn tm2-btn-ghost', text: 'Cancel' });
    const save   = foot.createDiv({ cls: 'tm2-btn tm2-btn-primary', text: 'Save' });
    cancel.onclick = () => close();

    save.onclick = async () => {
      const changes = {
        text: textIn.value.trim() || t.text,
        priority,
        due: dueIn.value,
        tags: tagIn.value.split(',').map(s => s.trim()).filter(Boolean),
        time: tmode === 'any' ? '' : normTime(startIn.value),
        end:  tmode === 'slot' ? normTime(endIn.value) : '',
        repeat: repSel.value,
      };
      if (!changes.time) changes.end = '';
      /* a repeating task needs a date to repeat from */
      if (changes.repeat && !changes.due) changes.due = todayISO();
      const target = this.app.vault.getAbstractFileByPath(projSel.value);
      close();
      if (target && target.path !== t.file.path) await this.move(t, target, changes);
      else await this.patch(t, changes);
    };

    const onKey = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    function close() { document.removeEventListener('keydown', onKey); overlay.remove(); }

    // Mobile: don't auto-open the keyboard; it appears when a field is tapped.
    if (!require('obsidian').Platform.isMobile) setTimeout(() => textIn.focus(), 40);
  }

  async move(t, target, changes) {
    const next = trackMove(t, changes);
    if (!next.id) next.id = newId();
    try {
      await mutate(this.app, t.file, lines => {
        const i = this.findLine(lines, t);
        if (i === -1) throw new Error('not found');
        lines.splice(i, 1);
        return lines;
      });
      await mutate(this.app, target, lines => {
        let i = lines.findIndex(l => RE_H_TASKS.test(l.trim()));
        if (i === -1) { lines.push('', '## Tasks'); i = lines.length - 1; }
        lines.splice(i + 1, 0, serialiseTask(next));
        return lines;
      });
      new Notice(`Moved to ${target.basename}`);
      await this._refresh();
    } catch (e) {
      console.error('[task-manager] move failed', e, t);
      new Notice('Could not move that task — nothing changed');
    }
  }
}

/* ── plugin ─────────────────────────────────────────────────────────── */

const DEFAULTS = { defaultProject: '' };

module.exports = class TaskManagerPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());

    this.registerView(VIEW_TYPE, leaf => new TaskView(leaf, this));

    this.addRibbonIcon('checkmark', 'Tasks', () => this.activate());

    this.addCommand({
      id: 'open-tasks',
      name: 'Open task manager',
      callback: () => this.activate(),
    });

    this.addCommand({
      id: 'focus-quick-add',
      name: 'Quick add task',
      callback: async () => {
        const view = await this.activate();
        view?.addInput?.focus();
      },
    });
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async activate() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
    return leaf.view;
  }
};
