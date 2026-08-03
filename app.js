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
  { id: 'melee', label: 'Melee weapons' }
];
const ROLE_ORDER = ['Epic Hero', 'Character', 'Battleline', 'Infantry', 'Mounted',
                    'Vehicle', 'Dedicated Transport'];

let DATA = null;
let selected = new Set(store.get('selection', []));
let kinds = new Set(store.get('kinds', ['unit', 'ranged', 'melee']));
let progress = store.get('progress', {});      // card id -> {seen, ok, streak}

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
      out.push({
        id: `${unit.name}|unit|${model.name}`,
        kindLabel: 'Unit profile',
        title: model.name,
        sub: model.name === unit.name ? unit.role : `${unit.name} · ${unit.role}`,
        labels: UNIT_LABELS,
        values: model.stats,
        extra: model.inv ? `Invulnerable save ${model.inv}` : '',
        unit
      });
    }
  }
  for (const kind of ['ranged', 'melee']) {
    if (!kinds.has(kind)) continue;
    for (const weapon of unit[kind]) {
      out.push({
        id: `${unit.name}|${kind}|${weapon.name}`,
        kindLabel: kind === 'ranged' ? 'Ranged weapon' : 'Melee weapon',
        title: weapon.name,
        sub: unit.name,
        labels: kind === 'ranged' ? RANGED_LABELS : MELEE_LABELS,
        values: weapon.stats,
        extra: weapon.kw && weapon.kw !== '-' ? weapon.kw : '',
        unit
      });
    }
  }
  return out;
}

function selectedCards() {
  return DATA.units.filter((u) => selected.has(u.name)).flatMap(cardsFor);
}

function countFor(unit) {
  return cardsFor(unit).length;
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
      ${w.kw && w.kw !== '-' ? `<tr><td class="kw" colspan="7">${esc(w.kw)}</td></tr>` : ''}`).join('')}
  </table>`;

  let html = '<div class="sheet">';
  html += '<h3>Profile</h3>';
  html += `<table class="tbl"><tr><th></th>${UNIT_LABELS.map((l) => `<th>${l}</th>`).join('')}</tr>
    ${unit.models.map((m) => `<tr><td>${esc(m.name)}</td>${m.stats.map((s) => `<td>${esc(s)}</td>`).join('')}</tr>
      ${m.inv ? `<tr><td class="kw" colspan="7">Invulnerable save ${esc(m.inv)}</td></tr>` : ''}`).join('')}
  </table>`;

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
  $('card-kind').textContent = card.kindLabel;
  $('card-title').textContent = card.title;
  $('card-sub').textContent = card.sub;
  $('statline').innerHTML = card.labels.map((label, i) => `
    <button class="stat${card.values[i].length > 3 ? ' small' : ''}" data-i="${i}">
      <span class="lbl">${label}</span><span class="val">?</span>
    </button>`).join('');
  $('card-extra').textContent = '';
  $('hint').hidden = false;
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

function revealStat(i) {
  const cell = $('statline').querySelector(`[data-i="${i}"]`);
  if (!cell || cell.classList.contains('shown')) return;
  cell.classList.add('shown');
  cell.querySelector('.val').textContent = session.card.values[i];
}

function revealAll() {
  if ($('card').dataset.revealed === 'true') return;
  $('card').dataset.revealed = 'true';
  session.card.values.forEach((_, i) => revealStat(i));
  $('card-extra').textContent = session.card.extra;
  $('hint').hidden = true;
  $('gradebar').hidden = false;
  $('card-detail').hidden = false;
  $('detail-body').innerHTML = datasheetHTML(session.card.unit);
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
  for (const id of ['setup', 'drill', 'summary']) $(id).hidden = id !== view;
  $('startbar').hidden = view !== 'setup';
  $('summarybar').hidden = view !== 'summary';
  $('gradebar').hidden = true;
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

document.querySelector('.bulk').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-bulk]');
  if (!btn) return;
  selected = btn.dataset.bulk === 'all' ? new Set(DATA.units.map((u) => u.name)) : new Set();
  store.set('selection', [...selected]);
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
  if (e.target.closest('#card-detail')) return;
  const cell = e.target.closest('[data-i]');
  if (cell && $('card').dataset.revealed === 'false') {
    revealStat(Number(cell.dataset.i));
    return;
  }
  revealAll();
});

$('hit').addEventListener('click', () => grade(true));
$('miss').addEventListener('click', () => grade(false));

$('reset-progress').addEventListener('click', () => {
  if (!confirm('Forget how well you know each card?')) return;
  progress = {};
  store.drop('progress');
});

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
    renderKinds();
    renderUnits();
  })
  .catch(() => {
    $('unit-list').innerHTML = '<p class="empty">Could not load data/admech.json.</p>';
  });
