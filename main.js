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

const { ItemView, Plugin, Notice, Menu, setIcon, debounce } = require('obsidian');

const VIEW_TYPE = 'rabby-task-manager-view';
const SVG_NS    = 'http://www.w3.org/2000/svg';

const RE_TASK  = /^(\s*)-\s\[([ xX])\]\s?(.*)$/;
const RE_ID    = /\s*\^(tm[a-z0-9]+)\s*$/;
const RE_DUE   = /📅\s*(\d{4}-\d{2}-\d{2})/;
const RE_MOVES = /↻\s*(\d+)/;
const RE_FROM  = /\(from\s+(\d{4}-\d{2}-\d{2})\)/;
const RE_PRIO  = /\((High|Medium|Low)\)/i;
const RE_TAG   = /🔖\s*([^\s🔖📅(]+)/g;
const RE_DONE  = /✅\s*\d{4}-\d{2}-\d{2}/;
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

const STRIP_BACK = 1;    // days of the strip that sit before today
const STRIP_LEN  = 7;

const todayISO = () => new Date().toLocaleDateString('en-CA');
const newId    = () => 'tm' + Math.random().toString(36).slice(2, 8);

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

  const tags = [];
  let tm;
  RE_TAG.lastIndex = 0;
  while ((tm = RE_TAG.exec(rest)) !== null) tags.push(tm[1]);

  const text = rest
    .replace(RE_DUE, '')
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
    text, due,
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
    t.moves ? `↻${t.moves}` : '',
    t.moves && t.from ? `(from ${t.from})` : '',
    t.priority ? `(${t.priority})` : '',
    ...t.tags.map(x => `🔖 ${x}`),
  ].filter(Boolean);
  return `${bits.join(' ')} ^${t.id}`;
}

/* Rescheduling history: changing a due date that was already set counts
   as one move, and the very first date is kept as `from`. */
function trackMove(t, changes) {
  const next = Object.assign({}, t, changes);
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
    /* header: title, date, one-line summary, progress ring */
    const top  = this.root.createDiv({ cls: 'tm2-top' });
    const left = top.createDiv({ cls: 'tm2-top-l' });

    const d = new Date();
    left.createDiv({ cls: 'tm2-kicker', text: 'Manage tasks' });
    left.createDiv({ cls: 'tm2-date', text: d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) });
    this.subEl = left.createDiv({ cls: 'tm2-sub' });

    this.ringEl = top.createDiv({ cls: 'tm2-ring' });

    /* date strip */
    this.daysEl = this.root.createDiv({ cls: 'tm2-days' });

    /* toolbar */
    const bar = this.root.createDiv({ cls: 'tm2-bar' });
    const search = bar.createDiv({ cls: 'tm2-search' });
    setIcon(search.createSpan({ cls: 'tm2-search-icon' }), 'search');
    this.searchInput = search.createEl('input', { attr: { type: 'text', placeholder: 'Search' } });
    this.searchInput.addEventListener('input', () => {
      this.query = this.searchInput.value.toLowerCase();
      this.renderList();
    });
    this.searchInput.addEventListener('keydown', e => {
      if (e.key === 'Escape') { this.searchInput.value = ''; this.query = ''; this.renderList(); }
    });

    this.sortBtn = bar.createDiv({ cls: 'tm2-sort' });
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

    this.tabsEl = this.root.createDiv({ cls: 'tm2-tabs' });

    const sec = this.root.createDiv({ cls: 'tm2-sec' });
    this.secTitle = sec.createDiv({ cls: 'tm2-sec-t' });
    this.secCount = sec.createDiv({ cls: 'tm2-sec-n' });

    this.listEl = this.root.createDiv({ cls: 'tm2-list' });
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
    [['!high', ' · '], ['@tomorrow', ' · '], ['#tag', ' · '], ['/project', '']]
      .forEach(([code, after]) => {
        hint.createEl('code', { text: code });
        if (after) hint.createSpan({ text: after });
      });
  }

  paintSort() {
    this.sortBtn.empty();
    setIcon(this.sortBtn.createSpan(), 'arrow-up-down');
    this.sortBtn.createSpan({ text: { due: 'Due', priority: 'Priority', project: 'Project', text: 'Name' }[this.sort] });
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

      for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i];
        if (/^#{1,6}\s/.test(line)) break;           // next heading ends the section
        const t = parseTaskLine(line);
        if (!t) continue;
        t.file = file;
        t.project = file.basename;
        t.lineNo = i;
        out.push(t);
      }
    }));

    this.tasks = out;
    this.renderTop();
    this.renderDays();
    this.renderTabs();
    this.renderList();
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
    const c = this.counts();
    const total = this.tasks.length;
    this.renderRing(total ? c.done / total : 0);

    const line = !total
      ? 'Nothing tracked yet'
      : c.overdue
        ? `${c.overdue} overdue · ${c.all} open`
        : c.today
          ? `${c.today} due today · ${c.all} open`
          : c.all
            ? `Nothing due today · ${c.all} open`
            : 'All clear';
    this.subEl.setText(line);
  }

  renderDays() {
    const today = todayISO();
    this.daysEl.empty();

    for (let i = 0; i < STRIP_LEN; i++) {
      const iso = shiftISO(today, i - STRIP_BACK);
      const d = new Date(iso + 'T00:00');
      const n = this.dayCount(iso);

      const cls = 'tm2-dayc'
        + (iso === today ? ' is-today' : '')
        + (this.tab === 'day' && iso === this.day ? ' is-on' : '');
      const cell = this.daysEl.createDiv({ cls });
      cell.createDiv({ cls: 'tm2-dayc-n', text: String(d.getDate()) });
      cell.createDiv({ cls: 'tm2-dayc-w', text: d.toLocaleDateString(undefined, { weekday: 'short' }) });
      if (n) cell.createDiv({ cls: 'tm2-dayc-dot' });

      cell.onclick = () => {
        this.tab = 'day';
        this.day = iso;
        this.renderDays();
        this.renderTabs();
        this.renderList();
      };
    }
  }

  renderRing(pct) {
    const size = 58, sw = 6, r = (size - sw) / 2, circ = 2 * Math.PI * r;
    this.ringEl.empty();

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);

    const circle = (cls, dash) => {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', size / 2); c.setAttribute('cy', size / 2); c.setAttribute('r', r);
      c.setAttribute('fill', 'none');
      c.setAttribute('stroke-width', sw);
      c.setAttribute('stroke-linecap', 'round');
      c.setAttribute('class', cls);
      if (dash != null) c.setAttribute('stroke-dasharray', `${dash} ${circ}`);
      return c;
    };
    svg.appendChild(circle('tm2-ring-bg'));
    svg.appendChild(circle('tm2-ring-fg', (circ * pct).toFixed(2)));

    this.ringEl.appendChild(svg);
    this.ringEl.createDiv({ cls: 'tm2-ring-n', text: Math.round(pct * 100) + '%' });
  }

  /* ── render: tabs + list ───────────────────────────────────────── */

  renderTabs() {
    const c = this.counts();
    this.tabsEl.empty();
    TABS.forEach(t => {
      const el = this.tabsEl.createDiv({ cls: 'tm2-tab' + (this.tab === t.id ? ' is-active' : '') });
      el.createSpan({ text: t.label });
      if (c[t.id]) el.createSpan({ cls: 'tm2-tab-n', text: String(c[t.id]) });
      el.onclick = () => {
        this.tab = t.id;
        this.renderDays();          // clears the date-strip selection
        this.renderTabs();
        this.renderList();
      };
    });
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

    this.secTitle.setText(this.sectionTitle());
    this.secCount.setText(list.length ? `${list.length} task${list.length > 1 ? 's' : ''}` : '');

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

    let lastProject = null;
    list.forEach(t => {
      if (this.sort === 'project' && t.project !== lastProject) {
        lastProject = t.project;
        this.listEl.createDiv({ cls: 'tm2-group', text: t.project });
      }
      this.listEl.appendChild(this.taskRow(t));
    });
  }

  taskRow(t) {
    const today = todayISO();
    const overdue = !t.done && t.due && t.due < today;

    let cls = 'tm2-row';
    if (t.done) cls += ' is-done';
    if (t.priority) cls += ` tm2-p-${t.priority.toLowerCase()}`;
    if (overdue && !t.done) cls += ' is-overdue';
    const row = createDiv({ cls });

    const box = row.createDiv({ cls: 'tm2-check' + (t.done ? ' is-on' : '') });
    box.onclick = e => { e.stopPropagation(); this.toggle(t); };

    const body = row.createDiv({ cls: 'tm2-body' });
    const text = body.createDiv({ cls: 'tm2-text', text: t.text });
    text.onclick = () => this.inlineEdit(t, text);

    const meta = body.createDiv({ cls: 'tm2-meta' });
    meta.createSpan({ cls: 'tm2-chip tm2-project', text: t.project });
    if (t.priority) meta.createSpan({ cls: `tm2-chip tm2-prio-${t.priority.toLowerCase()}`, text: t.priority });
    if (t.due) {
      let dueCls = 'tm2-chip tm2-due';
      if (overdue) dueCls += ' is-overdue';
      else if (t.due === today) dueCls += ' is-today';
      meta.createSpan({ cls: dueCls, text: this.prettyDate(t.due) });
    }
    if (t.moves) {
      const chip = meta.createSpan({ cls: 'tm2-chip tm2-moved', text: `↻ ${t.moves}` });
      chip.setAttr('title', `Rescheduled ${t.moves}×` + (t.from ? ` · originally ${this.prettyDate(t.from)}` : ''));
    }
    t.tags.forEach(tag => meta.createSpan({ cls: 'tm2-chip tm2-tag', text: tag }));

    const acts = row.createDiv({ cls: 'tm2-acts' });
    const more = acts.createDiv({ cls: 'tm2-act' });
    setIcon(more, 'more-horizontal');
    more.onclick = ev => { ev.stopPropagation(); this.rowMenu(ev, t); };

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

  toggle(t) {
    return this.patch(t, { done: !t.done });
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

    const tags = [];
    let m;
    const tagRe = /\s#([^\s#]+)/;
    while ((m = s.match(tagRe)) !== null) { tags.push(m[1]); s = s.replace(m[0], ' '); }

    return {
      text: s.replace(/\s{2,}/g, ' ').trim(),
      priority: prio ? prio[0].toUpperCase() + prio.slice(1).toLowerCase() : '',
      due, project, tags,
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
    if (!file) file = files.find(f => f.basename === this.plugin.settings.defaultProject) || files[0];

    const task = {
      indent: '', done: false, id: newId(),
      text: q.text, due: q.due, priority: q.priority, tags: q.tags,
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
      };
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
