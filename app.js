'use strict';

/* ── storage ──────────────────────────────────────────── */
const KEY = 'admech-fc';
const store = {
  get(name, fallback) {
    try {
      const raw = localStorage.getItem(`${KEY}:${name}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  },
  set(name, value) {
    try {
      localStorage.setItem(`${KEY}:${name}`, JSON.stringify(value));
    } catch (e) { /* private mode / quota — the app still works, just forgets */ }
  },
  drop(name) {
    try { localStorage.removeItem(`${KEY}:${name}`); } catch (e) { /* ignore */ }
  }
};

/* ── state ────────────────────────────────────────────── */
const KINDS = [
  { id: 'unit', label: 'Unit stats' },
  { id: 'ranged', label: 'Ranged weapons' },
  { id: 'melee', label: 'Melee weapons' },
  { id: 'keyword', label: 'Weapon keywords' }
];
const ROLE_ORDER = ['Epic Hero', 'Character', 'Battleline', 'Infantry', 'Mounted',
                    'Vehicle', 'Dedicated Transport'];

let DATA = null;
let selected = new Set(store.get('selection', []));
let kinds = new Set(store.get('kinds', ['unit', 'ranged', 'melee']));
let progress = store.get('progress', {});      // card id -> {seen, ok, streak}
let loadout = store.get('loadout', {});        // unit name -> weapon names taken
let listName = store.get('listname', '');
let skipped = new Set(store.get('skipped', [])); // card ids you never want to see

const session = { queue: [], card: null, total: 0, done: 0, answers: 0, right: 0, missed: [] };

const $ = (id) => document.getElementById(id);

/* ── helpers ──────────────────────────────────────────── */
function esc(text) {
  return String(text).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// BattleScribe marks game keywords with **double asterisks**.
function rich(text) {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function score(id) {
  return progress[id] ? progress[id].streak : 0;
}

/* ── cards ────────────────────────────────────────────── */
const UNIT_LABELS = ['M', 'T', 'SV', 'W', 'LD', 'OC'];
const RANGED_LABELS = ['RANGE', 'A', 'BS', 'S', 'AP', 'D'];
const MELEE_LABELS = ['RANGE', 'A', 'WS', 'S', 'AP', 'D'];

function cardsFor(unit) {
  const out = [];
  if (kinds.has('unit')) {
    for (const model of unit.models) {
      const pills = [];
      if (model.inv) pills.push({ text: `Invulnerable ${model.inv}`, kind: 'save' });
      if (unit.fnp) pills.push({ text: `Feel No Pain ${unit.fnp}`, kind: 'save' });
      out.push({
        id: `${unit.name}|unit|${model.name}`,
        kindLabel: 'Unit profile',
        title: model.name,
        sub: model.name === unit.name ? unit.role : `${unit.name} · ${unit.role}`,
        labels: UNIT_LABELS,
        values: model.stats,
        pills,
        unit
      });
    }
  }
  const taken = loadout[unit.name];
  for (const kind of ['ranged', 'melee']) {
    if (!kinds.has(kind)) continue;
    for (const weapon of unit[kind]) {
      if (taken && !taken.includes(weapon.name)) continue;
      out.push({
        id: `${unit.name}|${kind}|${weapon.name}`,
        kindLabel: kind === 'ranged' ? 'Ranged weapon' : 'Melee weapon',
        title: weapon.name,
        sub: unit.name,
        labels: kind === 'ranged' ? RANGED_LABELS : MELEE_LABELS,
        values: weapon.stats,
        pills: keywordPills(weapon.kw),
        unit
      });
    }
  }
  return out.filter((card) => !skipped.has(card.id));
}

function keywordPills(keywords) {
  if (!keywords || keywords === '-') return [];
  return keywords.split(',').map((k) => ({ text: k.trim() })).filter((p) => p.text);
}

/* A keyword carries its parameter — "Sustained Hits 1", "Anti-Vehicle 4+" —
   while the rule it points at is filed under the bare name. */
function ruleNameFor(keyword) {
  const rules = DATA.keywordRules || {};
  const tries = [
    keyword,
    keyword.replace(/\s+\d+\+?"?$/, ''),
    keyword.split(/[-‑]/)[0].trim()
  ].map((t) => t.toLowerCase());
  for (const name of Object.keys(rules)) {
    if (tries.includes(name.toLowerCase())) return name;
  }
  return '';
}

function keywordLabel(name) {
  return name === 'Anti' ? 'Anti-X Y+' : name;
}

/* Keywords are rules, not per-unit facts, so one card covers every weapon
   that has it — learning Sustained Hits twice is not learning it twice. */
function keywordCards(units) {
  const found = new Map();                       // rule name -> example keyword
  for (const unit of units) {
    const taken = loadout[unit.name];
    for (const kind of ['ranged', 'melee']) {
      for (const weapon of unit[kind]) {
        if (taken && !taken.includes(weapon.name)) continue;
        for (const pill of keywordPills(weapon.kw)) {
          const rule = ruleNameFor(pill.text);
          if (rule && !found.has(rule)) found.set(rule, pill.text);
        }
      }
    }
  }

  return [...found].map(([rule, example]) => ({
    id: `keyword|${rule.toLowerCase()}`,
    kindLabel: 'Weapon keyword',
    title: keywordLabel(rule),
    sub: example.toLowerCase() === rule.toLowerCase() ? '' : `on your weapons as “${example}”`,
    text: DATA.keywordRules[rule],
    pills: [],
    unit: null
  })).filter((card) => !skipped.has(card.id));
}

function pillsHTML(pills) {
  return pills.map((p) => {
    const rule = p.kind ? '' : ruleNameFor(p.text);
    const cls = `pill${p.kind ? ' ' + p.kind : ''}${rule ? ' tappable' : ''}`;
    return `<span class="${cls}"${rule ? ` data-rule="${esc(rule)}"` : ''}>${esc(p.text)}</span>`;
  }).join('');
}

function selectedCards() {
  const units = DATA.units.filter((u) => selected.has(u.name));
  const cards = units.flatMap(cardsFor);
  if (kinds.has('keyword')) cards.push(...keywordCards(units));
  return cards;
}

function countFor(unit) {
  return cardsFor(unit).length;
}

/* ── army lists ───────────────────────────────────────── */
// Tolerant parser for the usual army list exports: a unit name per line
// (optionally with its points), its wargear as bullets underneath, and a
// metadata header that gets ignored.
function norm(text) {
  return String(text)
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// "➤ Plasma caliver -  supercharge" and "Plasma caliver" are the same weapon.
function baseName(weaponName) {
  const clean = norm(weaponName).replace(/^[➤▶►>]\s*/, '');
  const split = clean.indexOf(' - ');
  return split > 0 ? clean.slice(0, split) : clean;
}

function parseArmyList(text) {
  const entries = [];
  let name = '';
  let current = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[+=_*~-]{3,}$/.test(line)) continue;

    const bullet = line.match(/^[•◦▪·*+-]\s*(.+)$/);
    if (bullet) {
      if (!current) continue;
      const item = bullet[1].replace(/^\d+\s*x\s*/i, '').trim();
      if (item && !/^enhancement\b/i.test(item)) current.items.push(item);
      continue;
    }

    // "List Name: ...", "Detachment(s): ...", "CHARACTERS:" and friends. A unit
    // line carries its points, so it never lands here.
    const meta = line.match(/^([^:]{1,60}):\s*(.*)$/);
    if (meta && !/\(\s*\d+\s*(pts|points)\s*\)/i.test(line)) {
      if (/^list name$/i.test(meta[1].trim())) name = meta[2].trim();
      continue;
    }

    const unitName = line
      .replace(/\(\s*\d+\s*(pts|points)\s*\)\s*$/i, '')
      .replace(/^\d+\s*x\s*/i, '')
      .replace(/^[\w ]{1,12}:\s*/, '')       // "Char1: Belisarius Cawl"
      .trim();
    if (!unitName) continue;

    current = entries.find((e) => norm(e.name) === norm(unitName));
    if (!current) {
      current = { name: unitName, items: [] };
      entries.push(current);
    }
  }
  return { name, entries };
}

function applyArmyList(text) {
  const parsed = parseArmyList(text);
  const byName = new Map(DATA.units.map((u) => [norm(u.name), u]));
  const picked = new Set();
  const nextLoadout = {};
  const unknown = [];
  let looseWeapons = 0;

  for (const entry of parsed.entries) {
    const key = norm(entry.name);
    const unit = byName.get(key)
      || DATA.units.find((u) => norm(u.name).startsWith(key) || key.startsWith(norm(u.name)));
    if (!unit) {
      unknown.push(entry.name);
      continue;
    }

    const weapons = [...unit.ranged, ...unit.melee];
    const taken = new Set(nextLoadout[unit.name] || []);
    for (const item of entry.items) {
      const wanted = norm(item);
      // Model names, Warlord and non-weapon wargear simply match nothing.
      for (const weapon of weapons) {
        if (baseName(weapon.name) === wanted || norm(weapon.name) === wanted) taken.add(weapon.name);
      }
    }
    picked.add(unit.name);
    // Nothing recognised: keep the whole datasheet rather than a bare statline.
    if (taken.size) nextLoadout[unit.name] = [...taken];
    else looseWeapons++;
  }

  if (!picked.size) return { ok: false, message: 'No Adeptus Mechanicus units found in that text.' };

  selected = picked;
  loadout = nextLoadout;
  listName = parsed.name;
  store.set('selection', [...selected]);
  store.set('loadout', loadout);
  store.set('listname', listName);

  let message = `${listName ? listName + ' · ' : ''}${picked.size} unit${picked.size === 1 ? '' : 's'}`;
  if (looseWeapons) message += ` · ${looseWeapons} without recognised wargear (all weapons kept)`;
  if (unknown.length) message += ` · not found: ${unknown.join(', ')}`;
  return { ok: true, message };
}

function clearArmyList() {
  loadout = {};
  listName = '';
  store.drop('loadout');
  store.drop('listname');
}

function renderListStatus(message) {
  const active = Object.keys(loadout).length > 0;
  $('list-status').textContent = message !== undefined ? message
    : active ? `${listName ? listName + ' · ' : ''}weapons limited to the list` : '';
  $('list-clear').hidden = !active;
  $('list-toggle').textContent = active ? 'Paste a different list' : 'Paste an army list';
}

/* ── setup view ───────────────────────────────────────── */
function renderKinds() {
  $('kinds').innerHTML = KINDS.map((k) =>
    `<button class="chip" data-kind="${k.id}" aria-pressed="${kinds.has(k.id)}">${k.label}</button>`
  ).join('');
}

function renderUnits() {
  const groups = new Map();
  for (const unit of DATA.units) {
    if (!groups.has(unit.role)) groups.set(unit.role, []);
    groups.get(unit.role).push(unit);
  }
  const roles = [...groups.keys()].sort((a, b) => {
    const ai = ROLE_ORDER.indexOf(a), bi = ROLE_ORDER.indexOf(b);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.localeCompare(b);
  });

  let html = '';
  for (const role of roles) {
    const units = groups.get(role);
    const picked = units.filter((u) => selected.has(u.name)).length;
    html += `<button class="group-head" data-role="${esc(role)}">${esc(role)}
      <span>${picked}/${units.length}</span></button>`;
    for (const unit of units) {
      html += `<div class="unit-row">
        <button class="unit-pick" data-unit="${esc(unit.name)}" aria-pressed="${selected.has(unit.name)}">
          <span class="box"></span>
          <span class="unit-name">${esc(unit.name)}</span>
          <span class="unit-meta">${countFor(unit)}</span>
        </button>
        <button class="peek" data-peek="${esc(unit.name)}" aria-label="Show datasheet">☰</button>
      </div>`;
    }
  }
  $('unit-list').innerHTML = html;
  $('skip-row').hidden = skipped.size === 0;
  $('skip-count').textContent =
    `${skipped.size} card${skipped.size === 1 ? '' : 's'} skipped`;
  renderStartBar();
}

function renderStartBar() {
  const n = selectedCards().length;
  const start = $('start');
  start.disabled = n === 0;
  start.textContent = n === 0 ? 'Pick some units' : `Start · ${n} card${n === 1 ? '' : 's'}`;
}

function datasheetHTML(unit) {
  const rows = (list, labels) => `<table class="tbl">
    <tr><th></th>${labels.map((l) => `<th>${l}</th>`).join('')}</tr>
    ${list.map((w) => `<tr><td>${esc(w.name)}</td>${w.stats.map((s) => `<td>${esc(s)}</td>`).join('')}</tr>
      ${w.kw && w.kw !== '-'
        ? `<tr><td class="kw" colspan="7"><span class="pills">${pillsHTML(keywordPills(w.kw))}</span></td></tr>`
        : ''}`).join('')}
  </table>`;

  const savePill = (text) => `<span class="pill save">${esc(text)}</span>`;

  let html = '<div class="sheet">';
  html += '<h3>Profile</h3>';
  html += `<table class="tbl"><tr><th></th>${UNIT_LABELS.map((l) => `<th>${l}</th>`).join('')}</tr>
    ${unit.models.map((m) => `<tr><td>${esc(m.name)}</td>${m.stats.map((s) => `<td>${esc(s)}</td>`).join('')}</tr>
      ${m.inv ? `<tr><td class="kw" colspan="7">${savePill('Invulnerable ' + m.inv)}</td></tr>` : ''}`).join('')}
  </table>`;
  if (unit.fnp) html += `<div class="pills">${savePill('Feel No Pain ' + unit.fnp)}</div>`;

  if (unit.ranged.length) html += '<h3>Ranged weapons</h3>' + rows(unit.ranged, RANGED_LABELS);
  if (unit.melee.length) html += '<h3>Melee weapons</h3>' + rows(unit.melee, MELEE_LABELS);
  if (unit.abilities.length) {
    html += '<h3>Abilities</h3>' + unit.abilities
      .map((a) => `<p class="ability"><b>${esc(a.name)}</b>${rich(a.text)}</p>`).join('');
  }
  if (unit.transport.length && unit.transport.some(Boolean)) {
    html += '<h3>Transport</h3>' + unit.transport
      .filter(Boolean).map((t) => `<p class="ability">${rich(t)}</p>`).join('');
  }
  html += `<h3>Keywords</h3><p class="kw-list">${esc(unit.keywords.join(' · '))}</p>`;
  return html + '</div>';
}

/* ── drill ────────────────────────────────────────────── */
function startSession(cards) {
  if (!cards.length) return;
  // Weakest cards first, jittered so the order never repeats exactly.
  session.queue = shuffle(cards.slice())
    .map((card) => ({ card, rank: score(card.id) + Math.random() * 1.5 }))
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.card);
  session.total = cards.length;
  session.done = 0;
  session.answers = 0;
  session.right = 0;
  session.missed = [];
  show('drill');
  nextCard();
}

function nextCard() {
  if (!session.queue.length) return endSession();
  session.card = session.queue.shift();
  renderCard();
}

function renderCard() {
  const card = session.card;
  const prose = Boolean(card.text);
  $('card-kind').textContent = card.kindLabel;
  $('card-title').textContent = card.title;
  $('card-sub').textContent = card.sub;
  $('statline').hidden = prose;
  $('statline').innerHTML = prose ? '' : card.labels.map((label, i) => `
    <button class="stat${card.values[i].length > 3 ? ' small' : ''}" data-i="${i}">
      <span class="lbl">${label}</span><span class="val">?</span>
    </button>`).join('');
  // One empty slot per keyword (or save): you know how many you are trying to
  // remember, and each one can be turned over on its own.
  $('card-pills').innerHTML = card.pills
    .map((_, i) => `<button class="pill ghost" data-pill="${i}">?</button>`).join('');
  $('card-text').hidden = true;
  $('card-text').innerHTML = '';
  $('hint').hidden = prose;
  $('revealbar').hidden = false;
  $('gradebar').hidden = true;
  $('card-detail').hidden = true;
  $('card-detail').open = false;
  $('detail-body').innerHTML = '';
  $('card').dataset.revealed = 'false';

  const pct = session.total ? Math.round((session.done / session.total) * 100) : 0;
  $('progress-fill').style.width = pct + '%';
  const acc = session.answers ? Math.round((session.right / session.answers) * 100) : 100;
  $('counter').textContent =
    `${session.done} / ${session.total} learned · ${session.queue.length + 1} in queue · ${acc}% correct`;
}

function revealPill(i) {
  const slot = $('card-pills').querySelector(`[data-pill="${i}"]`);
  if (slot) slot.outerHTML = pillsHTML([session.card.pills[i]]);
}

function revealStat(i) {
  const cell = $('statline').querySelector(`[data-i="${i}"]`);
  if (!cell || cell.classList.contains('shown')) return;
  cell.classList.add('shown');
  cell.querySelector('.val').textContent = session.card.values[i];
}

function revealAll() {
  if ($('card').dataset.revealed === 'true') return;
  const card = session.card;
  $('card').dataset.revealed = 'true';
  if (card.text) {
    $('card-text').innerHTML = rich(card.text);
    $('card-text').hidden = false;
  } else {
    card.values.forEach((_, i) => revealStat(i));
  }
  $('card-pills').innerHTML = pillsHTML(card.pills);
  $('hint').hidden = true;
  $('revealbar').hidden = true;
  $('gradebar').hidden = false;
  $('card-detail').hidden = !card.unit;
  $('detail-body').innerHTML = card.unit ? datasheetHTML(card.unit) : '';
}

function grade(ok) {
  const card = session.card;
  const entry = progress[card.id] || { seen: 0, ok: 0, streak: 0 };
  entry.seen++;
  if (ok) {
    entry.ok++;
    entry.streak++;
    session.done++;
    session.right++;
  } else {
    entry.streak = 0;
    if (!session.missed.some((c) => c.id === card.id)) session.missed.push(card);
    // Bring it back later in the same session.
    session.queue.splice(Math.min(session.queue.length, 4), 0, card);
  }
  session.answers++;
  progress[card.id] = entry;
  store.set('progress', progress);
  nextCard();
}

function skipCard() {
  const card = session.card;
  skipped.add(card.id);
  store.set('skipped', [...skipped]);
  // Drop every copy of it, including one requeued after an earlier miss.
  session.queue = session.queue.filter((c) => c.id !== card.id);
  session.missed = session.missed.filter((c) => c.id !== card.id);
  session.total = Math.max(session.done, session.total - 1);
  nextCard();
}

function endSession() {
  const acc = session.answers ? Math.round((session.right / session.answers) * 100) : 0;
  $('score').textContent = `${session.total} card${session.total === 1 ? '' : 's'} · ${acc}% correct`;
  $('missed-head').hidden = session.missed.length === 0;
  $('missed-list').innerHTML = session.missed.length
    ? session.missed.map((c) => `<li>${esc(c.title)}<br><span>${esc(c.sub)}</span></li>`).join('')
    : '<li>Nothing missed — everything right first time.</li>';
  $('redo').disabled = session.missed.length === 0;
  show('summary');
}

/* ── view switching ───────────────────────────────────── */
function show(view) {
  // Skipping during a session changes the counts behind the setup screen.
  if (view === 'setup' && DATA) renderUnits();
  for (const id of ['setup', 'drill', 'summary']) $(id).hidden = id !== view;
  $('startbar').hidden = view !== 'setup';
  $('summarybar').hidden = view !== 'summary';
  $('gradebar').hidden = true;
  $('revealbar').hidden = true;
  $('back').hidden = view === 'setup';
  $('reset-progress').hidden = view !== 'setup';
  $('title').textContent = view === 'setup' ? 'Adeptus Mechanicus'
    : view === 'drill' ? 'Drill' : 'Results';
  window.scrollTo(0, 0);
}

/* ── events ───────────────────────────────────────────── */
$('kinds').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-kind]');
  if (!btn) return;
  const kind = btn.dataset.kind;
  if (kinds.has(kind)) kinds.delete(kind); else kinds.add(kind);
  if (!kinds.size) kinds.add(kind);            // never leave all three off
  store.set('kinds', [...kinds]);
  renderKinds();
  renderUnits();
});

$('unit-list').addEventListener('click', (e) => {
  const pick = e.target.closest('[data-unit]');
  if (pick) {
    const name = pick.dataset.unit;
    if (selected.has(name)) selected.delete(name); else selected.add(name);
    store.set('selection', [...selected]);
    renderUnits();
    return;
  }

  const group = e.target.closest('[data-role]');
  if (group) {
    const units = DATA.units.filter((u) => u.role === group.dataset.role);
    const allOn = units.every((u) => selected.has(u.name));
    units.forEach((u) => allOn ? selected.delete(u.name) : selected.add(u.name));
    store.set('selection', [...selected]);
    renderUnits();
    return;
  }

  const peek = e.target.closest('[data-peek]');
  if (peek) {
    const open = peek.nextElementSibling;
    if (open && open.classList.contains('sheet-wrap')) { open.remove(); return; }
    const unit = DATA.units.find((u) => u.name === peek.dataset.peek);
    const wrap = document.createElement('div');
    wrap.className = 'sheet-wrap';
    wrap.innerHTML = datasheetHTML(unit);
    peek.closest('.unit-row').after(wrap);
  }
});

$('unit-bulk').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-bulk]');
  if (!btn) return;
  selected = btn.dataset.bulk === 'all' ? new Set(DATA.units.map((u) => u.name)) : new Set();
  store.set('selection', [...selected]);
  renderUnits();
});

function showListForm(open) {
  $('list-form').hidden = !open;
  $('list-toggle').parentElement.hidden = open;
  if (open) $('list-input').focus();
}

$('list-toggle').addEventListener('click', () => showListForm(true));
$('list-cancel').addEventListener('click', () => showListForm(false));

$('list-load').addEventListener('click', () => {
  const result = applyArmyList($('list-input').value);
  renderListStatus(result.message);
  if (!result.ok) return;
  $('list-input').value = '';
  showListForm(false);
  renderUnits();
});

$('list-clear').addEventListener('click', () => {
  clearArmyList();
  renderListStatus();
  renderUnits();
});

$('start').addEventListener('click', () => startSession(selectedCards()));
$('back').addEventListener('click', () => show('setup'));
$('again').addEventListener('click', () => startSession(selectedCards()));
$('redo').addEventListener('click', () => {
  const ids = new Set(session.missed.map((c) => c.id));
  startSession(selectedCards().filter((c) => ids.has(c.id)));
});

$('card').addEventListener('click', (e) => {
  // An empty slot turns over on its own, like a single stat does.
  const slot = e.target.closest('[data-pill]');
  if (slot) {
    revealPill(Number(slot.dataset.pill));
    return;
  }

  // A revealed keyword pill explains itself when you tap it.
  const pill = e.target.closest('[data-rule]');
  if (pill) {
    const name = pill.dataset.rule;
    $('card-text').innerHTML =
      `<b>${esc(keywordLabel(name))}</b>${rich(DATA.keywordRules[name])}`;
    $('card-text').hidden = false;
    return;
  }
  if (e.target.closest('#card-detail')) return;
  const cell = e.target.closest('[data-i]');
  if (cell && $('card').dataset.revealed === 'false') {
    revealStat(Number(cell.dataset.i));
    return;
  }
  revealAll();
});

$('reveal').addEventListener('click', revealAll);
$('skip').addEventListener('click', skipCard);

$('skip-restore').addEventListener('click', () => {
  skipped.clear();
  store.drop('skipped');
  renderUnits();
});
$('hit').addEventListener('click', () => grade(true));
$('miss').addEventListener('click', () => grade(false));

$('reset-progress').addEventListener('click', () => {
  if (!confirm('Forget how well you know each card?')) return;
  progress = {};
  store.drop('progress');
});

// iOS ignores user-scalable=no, so pinch has to be refused directly. Nothing
// here benefits from zooming, and a stray pinch mid-drill is only ever a
// nuisance to undo one-handed.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}

/* ── boot ─────────────────────────────────────────────── */
fetch('data/admech.json')
  .then((r) => {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  })
  .then((data) => {
    DATA = data;
    const known = new Set(DATA.units.map((u) => u.name));
    selected = new Set([...selected].filter((n) => known.has(n)));
    const src = data.source;
    $('source-note').innerHTML =
      `Data from <a href="https://github.com/${esc(src.repo)}">${esc(src.repo)}</a>
       (${esc(src.catalogue)}, rev ${esc(src.revision)}, commit
       <a href="https://github.com/${esc(src.repo)}/commit/${esc(src.commit)}">${esc(src.commit.slice(0, 7))}</a>).
       Legends and Crucible datasheets excluded. Not affiliated with Games Workshop.`;
    for (const name of Object.keys(loadout)) {
      if (!known.has(name)) delete loadout[name];
    }
    renderKinds();
    renderListStatus();
    renderUnits();
  })
  .catch(() => {
    $('unit-list').innerHTML = '<p class="empty">Could not load data/admech.json.</p>';
  });
