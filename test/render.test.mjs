// Render tests: the board's own JS, run against a stub DOM and fabricated
// rows. These cover what pure-function tests cannot — that a dismissed or
// closed card actually leaves the brand buckets and every count, which is the
// half of "collapse it away" that is easy to get wrong.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const brandRows = [
  { id: 'conduit', name: 'Conduit', color: '#7E67A4' },
  { id: 'ryve', name: 'Ryve', color: '#206CCC' },
];

const row = (o) => ({
  id: 'linear/' + o.linear_id, linear_id: o.linear_id, system: 'design-ai',
  project: o.project || 'conduit', track: 'app', phase: o.phase || 'research',
  status: o.status || 'waiting', title: o.title || o.linear_id,
  updated_at: o.updated_at || null, requested_at: o.requested_at || null,
  prompt: o.prompt || null,
  team: o.team === null ? null : (o.team || 'Conduit App'),
  linear_project: o.linear_project || null,
  set_aside_at: o.set_aside_at || null,
  options: o.options ? JSON.stringify(o.options) : null,
  linear_state: o.linear_state === undefined ? 'backlog' : o.linear_state,
  labels: JSON.stringify(o.labels || []),
  requested_stage: o.requested_stage || null,
  dismissed_at: o.dismissed_at || null,
  linear_uuid: 'uuid-' + o.linear_id, url: 'https://linear.app/x',
});

const sessions = [
  row({ linear_id: 'CON-116' }),
  row({ linear_id: 'CON-118' }),
  row({ linear_id: 'CON-120', requested_stage: 'research' }),
  row({ linear_id: 'CON-124', dismissed_at: '2026-09-05 02:00:00' }),
  row({ linear_id: 'CON-125', dismissed_at: '2026-09-05 02:00:00', requested_stage: 'research' }),
  row({ linear_id: 'WEB-271', linear_state: 'completed', team: 'Websites' }),
  row({ linear_id: 'WEB-272', linear_state: 'canceled', dismissed_at: '2026-09-05 02:00:00',
        team: 'Websites' }),
  row({ linear_id: 'RYV-187', project: 'ryve', labels: ['AI-research done'], team: 'Ryve App' }),
];

function stubEl() {
  return {
    innerHTML: '', textContent: '', title: '', disabled: false, style: {}, scrollTop: 0,
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, f) { const on = f === undefined ? !this._s.has(c) : f;
                     on ? this._s.add(c) : this._s.delete(c); return on; },
      contains(c) { return this._s.has(c); },
    },
  };
}

// What GET /api/reader/teams answers with, unless a suite says otherwise.
// Empty `selected` is the unconfigured reader: every team is read.
const ALL_TEAMS = { selected: [], available: ['Conduit App', 'Marketing', 'Ryve App'],
                    source: 'linear', all: true };

// Mount the board against a stub DOM and one set of rows, and hand back what
// it rendered. Extracted so that a suite can render a fixture of its own — the
// run-state suites need errored and stalled rows, and putting those in the
// shared fixture would move every count the suites above assert on.
async function mount(rows, readerCfg = ALL_TEAMS) {
  const html = fs.readFileSync(path.join(ROOT, 'frontend/index.html'), 'utf8');
  const logic = fs.readFileSync(path.join(ROOT, 'frontend/board-logic.js'), 'utf8');
  const inline = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));

  const nodes = {};
  globalThis.document = { getElementById: id => (nodes[id] = nodes[id] || stubEl()) };
  globalThis.window = {
    matchMedia: () => ({ matches: false }), addEventListener: () => {}, scrollTo: () => {},
  };
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => {
      if (url.endsWith('/brands')) return brandRows;
      if (url.endsWith('/reader/teams')) return readerCfg;
      if (url.endsWith('/runner')) return { repo: 'x/design-ai', workflow: 'design-ai.yml',
        url: 'https://github.com/x/design-ai/actions/workflows/design-ai.yml' };
      return rows;
    },
  });

  const run = new Function(logic + '\n' + inline + '\n;return { loadBoard, sessionCard };');
  const api = run();
  await api.loadBoard();

  const board = nodes['board'].innerHTML;
  return {
    sessionCard: api.sessionCard,
    board,
    sidebar: nodes['sidebar'].innerHTML,
    topbar: nodes['topbar-sub'].textContent,
    panel: nodes['side-panel'].innerHTML,
    drawers: {
      nodesign: (board.match(/id="drawer-nodesign"[\s\S]*?<\/details>/) || [''])[0],
      completed: (board.match(/id="drawer-completed"[\s\S]*?<\/details>/) || [''])[0],
      above: board.slice(0, board.indexOf('<details')),
    },
  };
}

let board, sidebar, topbar, drawers, sessionCard, mounted;

before(async () => {
  mounted = await mount(sessions);
  ({ board, sidebar, topbar, drawers, sessionCard } = mounted);
});

const cards = html => (html.match(/class="session-card/g) || []).length;

describe('collapsed sections', () => {
  test('both drawers render with their counts', () => {
    assert.ok(drawers.nodesign, 'No design drawer missing');
    assert.ok(drawers.completed, 'Completed drawer missing');
    assert.equal(cards(drawers.nodesign), 2);
    assert.equal(cards(drawers.completed), 2);
  });

  test('collapsed by default', () => {
    // Matched as an attribute — \bopen\b also finds `this.open` in the
    // ontoggle handler that remembers which drawers are open across a
    // re-render, which every drawer now carries whether or not it is open.
    assert.equal(/<details class="drawer"[^>]*\sopen[\s>]/.test(board), false);
  });

  test('but an open drawer survives the thirty-second re-render', () => {
    // The board re-renders itself on a timer now, and innerHTML replacement
    // loses <details> state — so a drawer opened would close under you inside
    // half a minute without the handler that records it.
    assert.match(board, /<details class="drawer"[^>]*ontoggle="rememberSection\(/);
  });

  test('a canceled row that was also dismissed files under Completed', () => {
    assert.ok(drawers.completed.includes('WEB-272'));
    assert.equal(drawers.nodesign.includes('WEB-272'), false);
  });
});

describe('drawer rows leave the board proper', () => {
  test('only the open rows appear in brand buckets', () => {
    assert.equal(cards(drawers.above), 4);
    for (const id of ['CON-124', 'CON-125', 'WEB-271', 'WEB-272']) {
      assert.equal(drawers.above.includes('>' + id + '<'), false, `${id} still on the board`);
    }
  });

  test('the topbar counts open rows only', () => {
    assert.equal(topbar, '1 running · 4 open');
  });

  test('the brand header counts open rows only', () => {
    // Conduit holds 5 rows, 2 of them dismissed.
    assert.match(drawers.above, /brand-name">Conduit<[\s\S]{0,400}?<span>3 open<\/span>/);
  });

  test('a dismissed running row does not leave a badge behind', () => {
    // CON-120 is the only run in flight; CON-125 is queued but dismissed, so
    // Conduit App is the one team that goes amber and the drawer rows are out
    // of every count.
    assert.equal((sidebar.match(/sb-badge waiting/g) || []).length, 1);
    assert.match(sidebar, /Conduit App<\/span>[\s\S]*?sb-badge waiting">3</);
  });
});

describe('the sidebar lists teams, not brands', () => {
  // The reader stopped filtering by team, so every issue assigned to Dave
  // reaches the board — 57 open cards across seven teams on the real one. The
  // team is the context an issue arrives with; brand stays what the board is
  // built from.
  test('All teams first, then the teams that have open work, alphabetically', () => {
    const names = [...sidebar.matchAll(/sb-name">([^<]+)</g)].map(m => m[1]);
    assert.deepEqual(names, ['All teams', 'Conduit App', 'Ryve App']);
    // Websites has two rows and both are closed, so it is not a team with open
    // work and does not appear.
    assert.equal(sidebar.includes('Websites'), false, 'a team with nothing open is listed');
  });

  test('the heading says what it filters on', () => {
    assert.match(sidebar, /sb-label">Teams</);
    assert.equal(sidebar.includes('All brands'), false, 'the brand filter is still there');
  });

  test('every open row is counted under exactly one team', () => {
    const counts = [...sidebar.matchAll(/sb-badge[^"]*">(\d+)</g)].map(m => Number(m[1]));
    const [all, ...teams] = counts;
    assert.equal(all, 4, 'All teams should count every open row');
    assert.equal(teams.reduce((a, b) => a + b, 0), all,
                 'the teams do not add up to the board');
  });
});

describe('filtering by team', () => {
  let filtered;
  before(async () => {
    const m = await mount(sessions);
    // setFilter is a global on the mounted board; re-render through it.
    filtered = m;
  });

  test('a team with no open rows is not offered as a filter', () => {
    assert.equal(filtered.sidebar.includes('>Websites<'), false);
  });

  test('brand is still what the board is built from', () => {
    // Brand sections, not team sections — the filter narrows what is inside
    // them rather than replacing them.
    assert.match(filtered.drawers.above, /brand-name">Conduit</);
    assert.match(filtered.drawers.above, /brand-name">Ryve</);
  });
});

describe('Dismissed — design work, but not for the agents', () => {
  const aside = [
    row({ linear_id: 'MAR-978', project: null, team: 'Marketing',
          linear_project: 'BCC', set_aside_at: '2026-09-16 22:00:00' }),
    row({ linear_id: 'CON-116' }),
    row({ linear_id: 'CON-124', dismissed_at: '2026-09-05 02:00:00' }),
  ];
  let m;
  before(async () => { m = await mount(aside); });

  test('it gets its own drawer, separate from No design', () => {
    const dismissed = (m.board.match(/id="drawer-dismissed"[\s\S]*?<\/details>/) || [''])[0];
    assert.ok(dismissed, 'no Dismissed drawer');
    assert.ok(dismissed.includes('>MAR-978<'), 'the set-aside row is not in it');
    assert.equal(dismissed.includes('>CON-124<'), false, 'a no-design row landed in Dismissed');
    assert.ok(m.drawers.nodesign.includes('>CON-124<'), 'No design lost its row');
  });

  test('it leaves the board proper, like the other two drawers', () => {
    assert.equal(m.drawers.above.includes('>MAR-978<'), false, 'still on the board');
    assert.match(m.topbar, /^1 open$/);
  });

  test('a board card offers Dismiss beside No design', () => {
    const card = m.sessionCard(aside[1]);
    assert.match(card, /setAside\('linear\/CON-116'/);
    assert.match(card, /dismissSession\('linear\/CON-116'/);
  });

  test('a dismissed card offers only the way back', () => {
    const dismissed = (m.board.match(/id="drawer-dismissed"[\s\S]*?<\/details>/) || [''])[0];
    assert.match(dismissed, /unsetAside\(/);
    assert.equal(dismissed.includes('triggerSession'), false, 'a dismissed card can be triggered');
    // Matched at the attribute boundary: unsetAside( contains setAside( .
    assert.equal(dismissed.includes(String.fromCharCode(34) + 'setAside('), false,
                 'offered to dismiss what is already dismissed');
  });

  test('the Linear project labels a card whose brand is not obvious', () => {
    // Marketing does not imply a brand, so the project is what says what the
    // work is — and the cue for whether Move to… is worth reaching for.
    assert.match(m.sessionCard(aside[0]), /session-project">BCC</);
    // Conduit App does imply one, so the project would repeat the heading.
    assert.equal(
      m.sessionCard(row({ linear_id: 'CON-116', linear_project: 'Wallet' }))
        .includes('session-project'), false);
  });
});

describe('the card shows no agent prose', () => {
  // What the board used to drown in: an agent session carrying a paragraph of
  // prompt and a paragraph of detail on every card. Dave reads the research as
  // a comment on the Linear issue; the Hub shows none of it.
  const PROMPT = 'Two directions for the wallet header.\n\n' + 'A keeps the balance card. '.repeat(12);
  const DETAIL = 'Research notes.\n\n' + 'The current header stacks three rows. '.repeat(14);
  const wordy = () => sessionCard({
    ...row({ linear_id: 'RYV-84', project: 'ryve', title: 'Wallet header',
             labels: ['AI-research done'] }),
    phase: 'research', status: 'waiting', prompt: PROMPT, detail: DETAIL,
    response: 'Direction B', responded_at: '2026-09-09 10:00:00',
  });

  test('none of the prompt, detail or answer reaches the card', () => {
    const html = wordy();
    assert.equal(html.includes('Research notes.'), false, 'detail is on the card');
    assert.equal(html.includes('A keeps the balance card.'), false, 'the prompt is on the card');
    assert.equal(html.includes('Direction B'), false, 'the answer is on the card');
  });

  test('no disclosure and no reply box are rendered at all', () => {
    const html = wordy();
    assert.equal(html.includes('<details'), false, 'the prose disclosure came back');
    assert.equal(html.includes('agent-reply'), false, 'the reply box came back');
    assert.equal(html.includes('respondAgent'), false, 'the reply handler came back');
  });

  test('the card shows the issue, the stage and the one action', () => {
    const html = wordy();
    assert.ok(html.includes('>RYV-84<'), 'no issue id');
    assert.ok(html.includes('>Wallet header<'), 'no issue title');
    assert.match(html, /class="stage-pill">Researched</);
    assert.match(html, /triggerSession\('[^']+', 'design'/);
    assert.ok(html.includes('Run Design'), 'no stage button');
  });
});

describe('the three stage columns', () => {
  test('all three render, in order, and QA is not among them', () => {
    const labels = [...drawers.above.matchAll(/bucket-label">([^<]+)</g)].map(m => m[1]);
    // One set per brand section; every set is the same three in the same order.
    assert.ok(labels.length >= 3, 'no buckets rendered');
    assert.deepEqual(labels.slice(0, 3), ['Backlog', 'Researched', 'AI-designed']);
    assert.equal(drawers.above.includes("QA&#39;d"), false, "the QA'd column came back");
    assert.equal(board.includes('Run QA'), false, 'the Run QA button came back');
  });

  test('a card sits in the column its labels say', () => {
    // RYV-187 carries AI-research done, so it belongs under Researched.
    const ryve = drawers.above.slice(drawers.above.indexOf('brand-name">Ryve<'));
    const researched = ryve.slice(ryve.indexOf('bucket-label">Researched<'));
    assert.ok(researched.includes('>RYV-187<'), 'RYV-187 is not under Researched');
  });

  test('every open card offers exactly one stage button', () => {
    const open = drawers.above;
    const buttons = (open.match(/btn btn-primary/g) || []).length;
    assert.equal(buttons, 4, 'expected one primary button per open card');
  });

  test('a card with a run queued shows a disabled button saying so', () => {
    // It says Queued rather than Working: the runner works one issue at a
    // time, so of everything with a queue entry at most one is being worked.
    const html = sessionCard(row({ linear_id: 'CON-120', requested_stage: 'research' }));
    assert.match(html, /btn btn-primary" disabled>Queued</);
    assert.equal(html.includes("triggerSession('linear/CON-120'"), false,
                 'a queued card must not be clickable');
  });
});

// ── WHAT THE CARD SAYS IT IS DOING ────────────────────────────────────
// The bug these pin: statusPill checked isWorking before status, and
// requested_stage is cleared only by /api/agent/stage-done, which a run that
// failed never reaches. So an errored session kept its queue entry and the
// board kept painting it "Working…" — for days, in RYV-84's case.

const MIN = 60000;
const stamp = (msAgo) =>
  new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ');

const GATE = [{ id: 'd1', label: 'Icon-only corner button' }];

// One row per run state, and one for each of the two quiet ones.
const stateRows = [
  row({ linear_id: 'RYV-84', project: 'ryve', status: 'error', requested_stage: 'design',
        labels: ['AI-research done'], phase: 'design', updated_at: stamp(200 * MIN),
        requested_at: stamp(200 * MIN),
        prompt: 'The qa stage is not implemented yet' }),
  row({ linear_id: 'CON-120', requested_stage: 'research', updated_at: stamp(95 * MIN),
        requested_at: stamp(95 * MIN) }),
  // Queued and not started — nothing in this fixture is running, which is what
  // lets CON-120 above be stalled rather than merely waiting its turn.
  row({ linear_id: 'CON-118', requested_stage: 'research',
        requested_at: stamp(2 * MIN), updated_at: stamp(2 * MIN) }),
  row({ linear_id: 'RYV-187', project: 'ryve', options: GATE, updated_at: stamp(30 * MIN) }),
  row({ linear_id: 'CON-116', status: 'done', labels: ['AI-design done'], updated_at: stamp(MIN) }),
  row({ linear_id: 'CON-117', updated_at: stamp(MIN) }),
];

describe('a card reports the state it is actually in', () => {
  let card;
  before(async () => { card = (await mount(stateRows)).sessionCard; });

  const of = (id) => card(stateRows.find(r => r.linear_id === id));
  const pill = (html) => (html.match(/status-pill status-(\w+)">([^<]+)</) || []).slice(1);

  test('an errored card says Error, not Working, while still holding its queue entry', () => {
    const html = of('RYV-84');
    assert.deepEqual(pill(html), ['error', 'Error']);
    assert.ok(html.includes('session-card state-error'), 'the card is not outlined as errored');
    // Still queued, so still not clickable — but the button no longer lies
    // about what the row is doing.
    assert.match(html, /btn btn-primary" disabled>Error</);
    assert.equal(html.includes('>Working'), false, 'the card still claims to be working');
  });

  test('an errored card says why it stopped, in the words the agent used', () => {
    assert.match(of('RYV-84'),
      /card-note note-error">The qa stage is not implemented yet</);
  });

  test('a queued run with no activity for half an hour reads Stalled', () => {
    const html = of('CON-120');
    assert.deepEqual(pill(html), ['stalled', 'Stalled']);
    assert.match(html, /card-note note-stalled[\s\S]*?never came back/);
    assert.match(html, /btn btn-primary" disabled>Stalled</);
  });

  test('a running card carries a clock that ticks', () => {
    // The assurance the board could not give: "Working…" with a frozen
    // timestamp is identical whether the run started ten seconds or nine
    // minutes ago, and the runner says nothing at all in between.
    assert.match(of('CON-118'), /session-elapsed" data-since="[^"]+">\d+m\d\ds</);
  });

  test('a stalled card keeps its clock — that is how you see how long', () => {
    assert.match(of('CON-120'), /session-elapsed" data-since=/);
  });

  test('a card with no run behind it has no clock to show', () => {
    for (const id of ['RYV-187', 'CON-116', 'CON-117']) {
      assert.equal(of(id).includes('session-elapsed'), false, id + ' shows a run clock');
    }
  });

  test('a recently queued run says its place, not that it is working', () => {
    // Nothing in this fixture is running, so none of the three queued rows may
    // claim to be. CON-118 was asked for last, so it is third of the three.
    const html = of('CON-118');
    assert.deepEqual(pill(html), ['working', '3rd of 3']);
    assert.equal(html.includes('note-stalled'), false, 'a fresh request was flagged as stalled');
  });

  test('an open gate reads Needs you', () => {
    assert.deepEqual(pill(of('RYV-187')), ['waiting', 'Needs you']);
  });

  test('a finished stage reads Done, and a quiet row gets no pill', () => {
    assert.deepEqual(pill(of('CON-116')), ['done', 'Done']);
    assert.deepEqual(pill(of('CON-117')), []);
  });

  test('a card that has stopped offers Reset', () => {
    // The gap this closes: the stage button is disabled while a request is
    // queued, and only stage-done clears the queue — which a failed run never
    // reaches. Reset is the other way out.
    for (const id of ['RYV-84', 'CON-120']) {
      assert.match(of(id), /btn-reset[\s\S]*?resetSession[\s\S]*?>Reset</, id + ' offers no reset');
    }
  });

  test('a run that is going offers Stop instead — the same call, said honestly', () => {
    assert.match(of('CON-118'), /btn-reset[\s\S]*?resetSession[\s\S]*?>Stop</);
    assert.equal(of('CON-118').includes('>Reset<'), false,
                 'a live run offered Reset, which is not what it does');
  });

  test('a card with no run behind it gets neither', () => {
    for (const id of ['RYV-187', 'CON-116', 'CON-117']) {
      assert.equal(of(id).includes('resetSession'), false, id + ' offers a control it should not');
    }
  });

  test('no agent prose reaches a card that has not errored', () => {
    // failureReason is the second exception to the rule, after a gate's
    // options — and it is only that one exception.
    const quiet = card(row({ linear_id: 'CON-119', prompt: 'Run design research on CON-119?' }));
    assert.equal(quiet.includes('Run design research'), false, 'the prompt is on a quiet card');
    assert.equal(quiet.includes('card-note'), false);
  });

  test('a card in a drawer reports no live run at all', () => {
    const put_aside = card(row({ linear_id: 'RYV-84', status: 'error', requested_stage: 'design',
                                 prompt: 'The qa stage is not implemented yet',
                                 dismissed_at: '2026-09-05 02:00:00' }));
    assert.equal(put_aside.includes('card-note'), false, 'a put-aside card reported a failure');
  });
});

describe('where Linear issues are read from', () => {
  // It was a constant in the Worker that only a deploy could change, and it
  // has been both "design teams only" and "every team" inside a fortnight —
  // so the board could not answer "why is that not on my board".
  test('the console says where it is scraping from, in a line', () => {
    return mount(sessions, { selected: ['Conduit App', 'Ryve App'],
                             available: ALL_TEAMS.available, all: false }).then(m => {
      assert.match(m.panel, /cn-from/);
      assert.match(m.panel, /Conduit App \u00b7 Ryve App/);
    });
  });

  test('an empty set means every team, and says so rather than rendering blank', () => {
    assert.match(mounted.panel, /cn-from[\s\S]*?every team/);
  });

  test('it is a statement and not a control', () => {
    // The set changes rarely and on purpose. A console you can misclick into
    // reading the wrong half of Linear is worse than one you change elsewhere.
    for (const gone of ['toggleSource', 'cn-src-box', 'cn-sources']) {
      assert.equal(mounted.panel.includes(gone), false, gone + ' is still in the console');
    }
  });

  test('a board that could not read the config says nothing at all', () => {
    // Rather than an empty line, which would read as "nothing is being read" —
    // the exact opposite of what an empty selection means.
    return mount(sessions, null).then(m => {
      assert.equal(m.panel.includes('cn-from'), false);
    });
  });
});

describe('the reader can be run from the board', () => {
  // The route has always existed; without a control the only way to pull a
  // newly-assigned issue in was to wait for Wednesday or Friday.
  const html = fs.readFileSync(path.join(ROOT, 'frontend/index.html'), 'utf8');

  test('the control is in the topbar and calls the reader route', () => {
    assert.match(html, /id="btn-read"[^>]*onclick="runReader\(this\)"/);
    assert.match(html, /api\('\/read-linear', \{ method: 'POST' \}\)/);
  });

  test('it starts nothing — gathering is not triggering', () => {
    // The whole rule in one assertion: the reader control must not reach the
    // trigger route, and must not dispatch a run by any other name.
    const fn = html.slice(html.indexOf('async function runReader'),
                          html.indexOf('async function dismissSession'));
    assert.equal(fn.includes('/trigger'), false, 'the reader control triggers a stage');
    assert.equal(fn.includes('stage'), false, 'the reader control names a stage');
  });
});

describe('the queue says where each card is in it', () => {
  // Runs are serialised — GitHub's concurrency group lets exactly one happen
  // at a time — so most cards with a queue entry have not started. They all
  // said "Working…", which was true of at most one of them.
  const queued = [
    // Running: asked for at 6m, reported in at 5m.
    row({ linear_id: 'QUE-1', status: 'active', requested_stage: 'research',
          requested_at: stamp(6 * MIN), updated_at: stamp(5 * MIN) }),
    row({ linear_id: 'QUE-2', requested_stage: 'research',
          requested_at: stamp(4 * MIN), updated_at: stamp(4 * MIN) }),
    row({ linear_id: 'QUE-3', requested_stage: 'design',
          requested_at: stamp(2 * MIN), updated_at: stamp(2 * MIN) }),
    row({ linear_id: 'QUE-4' }),
  ];
  let m;
  before(async () => { m = await mount(queued); });
  const of = (id) => m.sessionCard(queued.find(r => r.linear_id === id));

  test('the one being worked says Working, and it is the only one that does', () => {
    assert.match(of('QUE-1'), /status-pill status-working">Working/);
    assert.equal(of('QUE-2').includes('>Working'), false, 'a waiting card claims to be working');
  });

  test('the rest say their place, oldest request first', () => {
    assert.match(of('QUE-2'), /status-pill status-working">2nd of 3</);
    assert.match(of('QUE-3'), /status-pill status-working">3rd of 3</);
  });

  test('the disabled button says the same thing as the pill', () => {
    assert.match(of('QUE-2'), /btn btn-primary" disabled>2nd of 3</);
  });

  test('the console says it in its own column', () => {
    assert.match(m.panel, /cn-st state-working">WORKING</);
    assert.match(m.panel, /cn-st state-working">QUEUED 2\/3</);
    assert.match(m.panel, /cn-st state-working">QUEUED 3\/3</);
  });

  test('a card with no run behind it is in no queue', () => {
    assert.equal(of('QUE-4').includes('status-pill'), false);
  });

  test('alone in the queue, a card does not say "1st of 1"', () => {
    const solo = row({ linear_id: 'ONE', requested_stage: 'research',
                       requested_at: stamp(MIN), updated_at: stamp(MIN) });
    return mount([solo]).then(one => {
      assert.match(one.sessionCard(solo), /status-pill status-working">Queued</);
    });
  });
});

describe('waiting your turn is not stalling', () => {
  // A queue of four ten-minute runs leaves the last one waiting forty minutes
  // entirely correctly. Flagging that as a dead process is the board crying
  // wolf about its own design — the flag is for the case where nothing is
  // coming at all.
  test('an old queued card is not stalled while something is running', () => {
    const moving = [
      row({ linear_id: 'MOV-1', status: 'active', requested_stage: 'research',
            requested_at: stamp(90 * MIN), updated_at: stamp(MIN) }),
      row({ linear_id: 'MOV-2', requested_stage: 'research',
            requested_at: stamp(80 * MIN), updated_at: stamp(80 * MIN) }),
    ];
    return mount(moving).then(m => {
      const card = m.sessionCard(moving[1]);
      assert.equal(card.includes('Stalled'), false, 'a card waiting its turn was flagged stalled');
      assert.match(card, /status-pill status-working">2nd of 2</);
    });
  });

  test('with nothing running, the same card is stalled', () => {
    const stuck = [
      row({ linear_id: 'STK-1', requested_stage: 'research',
            requested_at: stamp(90 * MIN), updated_at: stamp(90 * MIN) }),
      row({ linear_id: 'STK-2', requested_stage: 'research',
            requested_at: stamp(80 * MIN), updated_at: stamp(80 * MIN) }),
    ];
    return mount(stuck).then(m => {
      assert.match(m.sessionCard(stuck[1]), /status-pill status-stalled">Stalled</);
    });
  });
});

describe('the console watches the whole pipeline', () => {
  let panel;
  before(async () => { panel = (await mount(stateRows)).panel; });

  const at = (id) => panel.indexOf('>' + id + '<');

  test('it is a console, not the in-flight list it replaced', () => {
    assert.match(panel, /cn-title">Activity</);
    assert.equal(panel.includes('In flight'), false, 'the old title is still there');
    // Column-aligned lines, not cards.
    assert.match(panel, /class="cn-line"/);
    assert.match(panel, /cn-t">\d\d:\d\d</, 'no timestamp column');
  });

  test('everything that is doing something is listed, most urgent first', () => {
    for (const id of ['RYV-84', 'CON-120', 'RYV-187', 'CON-118']) {
      assert.ok(at(id) > -1, id + ' is missing from the console');
    }
    assert.ok(at('RYV-84') < at('CON-120'), 'errored should sort above stalled');
    assert.ok(at('CON-120') < at('RYV-187'), 'stalled should sort above needs-you');
    assert.ok(at('RYV-187') < at('CON-118'), 'needs-you should sort above running');
  });

  test('the console carries the same clocks, on the same rows', () => {
    // One derivation, so the console and the card cannot disagree about how
    // long something has been going.
    assert.match(panel, /cn-el" data-since="[^"]+">\d+m\d\ds</);
  });

  test('it links out to the runner log, which is the only live view', () => {
    // The Hub sees a run start and sees it finish and nothing in between,
    // because the Claude call blocks for minutes. So it links rather than
    // pretending to know more than it does.
    assert.match(panel, /class="cn-log"/);
    assert.ok(panel.includes('/actions/workflows/'),
              'the log link does not point at the runner workflow');
  });

  test('the state column reads as a level, and matches the card', () => {
    // The console and the card read the same derivation, so they cannot
    // disagree about a row the way the button and the column once did.
    assert.match(panel, /cn-st state-error">ERROR</);
    assert.match(panel, /cn-st state-stalled">STALLED</);
    assert.match(panel, /cn-st state-waiting">NEEDS YOU</);
    // Queued rather than WORKING: nothing in this fixture has been started.
    assert.match(panel, /cn-st state-working">QUEUED 3\/3</);
  });

  test('a line that stopped says why, under itself', () => {
    assert.match(panel, /cn-msg">The qa stage is not implemented yet</);
    assert.match(panel, /cn-msg">queued \d+[mhd] ago, never came back</);
  });

  test('a run that finished recently is still news; an idle row is not', () => {
    assert.ok(at('CON-116') > -1, 'a run that finished a minute ago should be on the console');
    assert.match(panel, /cn-st state-done">DONE</);
    assert.equal(at('CON-117'), -1, 'an idle row is cluttering the console');
  });

  test('live and quiet together account for every open card', () => {
    // Four live, one recently done, one idle — six open rows, all of them
    // either counted in the head or counted in the foot.
    assert.match(panel, /cn-counts">4 live \/ 6 open</);
    assert.match(panel, />2 quiet</);
  });

  test('an all-quiet board says so rather than rendering an empty list', () => {
    return mount([row({ linear_id: 'CON-117' })]).then(m => {
      assert.match(m.panel, /cn-empty">— nothing is running —</);
      assert.match(m.panel, /cn-counts">0 live \/ 1 open</);
    });
  });
});

describe('a gate renders as options, not as a box to type in', () => {
  // The bug in the UI half: a three-option question with a free-text field
  // under it invites "Yes". One click per option is the whole interaction.
  const OPTIONS = [
    { id: 'd1', label: 'Icon-only corner button', summary: '48x48 circular + at the corner.' },
    { id: 'd2', label: 'Labelled corner control', summary: 'Costs card width.' },
    { id: 'd3', label: 'Collection-level add row', summary: 'Leaves the corner empty.' },
  ];
  const gate = (o = {}) => sessionCard({
    ...row({ linear_id: 'RYV-84', project: 'ryve', title: 'Wallet header',
             linear_state: o.linear_state, dismissed_at: o.dismissed_at }),
    status: o.status || 'waiting',
    prompt: 'Which direction proceeds?',
    options: JSON.stringify(OPTIONS),
    response_option_id: o.response_option_id || null,
    response_note: o.response_note || null,
    responded_at: o.responded_at || (o.response_option_id ? '2026-09-13 10:00:00' : null),
  });

  test('every option is its own button, carrying its label and summary', () => {
    const html = gate();
    assert.equal((html.match(/class="gate-option"/g) || []).length, 3);
    assert.ok(html.includes('Icon-only corner button'));
    assert.ok(html.includes('Collection-level add row'));
    assert.ok(html.includes('Costs card width.'));
    assert.match(html, /answerGate\('[^']+', 'd2'/);
  });

  test('the question is shown, and no prose answers it', () => {
    const html = gate();
    assert.ok(html.includes('Which direction proceeds?'), 'the question is missing');
    assert.equal(html.includes('<textarea'), false, 'a free-text answer box came back');
    // Two fields, and neither takes an answer in words: one names a Figma
    // section, the other gives a reason for rejecting every option.
    const ids = [...html.matchAll(/<input[^>]*\sid="([a-z-]+)-[^"]*"/g)].map(m => m[1]);
    assert.deepEqual(ids, ['own', 'reject-note']);
  });

  test('rejecting all three is offered, and is not one of the options', () => {
    const html = gate();
    assert.match(html, /askRejectAll\('[^']+'\)/);
    assert.match(html, /rejectAll\('[^']+', this\)/);
    assert.ok(html.includes('None of these'));
    // It must not be reachable as a choice: every answerGate call names an id
    // the agent offered, and there are exactly three of those.
    const answers = [...html.matchAll(/answerGate\('[^']+', '([^']+)'/g)].map(m => m[1]);
    assert.deepEqual(answers, ['d1', 'd2', 'd3']);
    assert.equal(/answerGate\([^)]*none/i.test(html), false);
  });

  test('the rejection asks for its own reason, separate from the section', () => {
    const html = gate();
    assert.match(html, /id="reject-note-[^"]+"[\s\S]*?Why none of these\? \(required\)/);
    assert.match(html, /id="own-[^"]+"[\s\S]*?Wallet header v3/);
  });

  test('a design you already made is answered by naming its section', () => {
    const html = gate();
    assert.ok(html.includes('name its Figma section'), 'the field does not say what it takes');
    // An Enter button beside the input, and the Enter key doing the same thing.
    assert.match(html, /id="own-go-[^"]+"[\s\S]*?onclick="chooseOwn\('[^']+'\)">Enter</);
    assert.match(html, /onkeydown="if \(event\.key === 'Enter'\)[\s\S]*?chooseOwn/);
  });

  test('naming a section is a decision, and the card shows it as yours', () => {
    const html = gate({ status: 'active', responded_at: '2026-09-13 10:00:00',
                        response_note: 'Wallet header v3' });
    assert.ok(html.includes('Your design'), 'it does not read as your own direction');
    assert.ok(html.includes('Wallet header v3'), 'the section is missing');
    // Not shown twice: the section is the decision, not a note beside one.
    assert.equal((html.match(/Wallet header v3/g) || []).length, 1);
    assert.match(html, /askReopen\('[^']+'\)/, 'it cannot be taken back');
  });

  test('an answered gate shows the label and never the id', () => {
    const html = gate({ status: 'active', response_option_id: 'd2',
                        response_note: 'but tighten the label copy' });
    assert.ok(html.includes('Labelled corner control'), 'the chosen label is missing');
    assert.ok(html.includes('but tighten the label copy'), 'the note is missing');
    assert.equal(/>d2</.test(html), false, 'the bare option id reached the card');
    assert.equal(html.includes('gate-option"'), false, 'the options are still clickable');
  });

  test('an answered gate can be sent back', () => {
    const html = gate({ status: 'active', response_option_id: 'd2' });
    assert.match(html, /askReopen\('[^']+'\)/);
    assert.match(html, /reopenGate\('[^']+', this\)/);
  });

  test('the stage button is still there — a gate does not replace the card', () => {
    assert.match(gate(), /btn btn-primary/);
    assert.ok(gate().includes('dismissSession'));
  });

  test('a card in a drawer carries no live decision', () => {
    // Put aside or closed in Linear: there is nothing to answer from there.
    assert.equal(gate({ dismissed_at: '2026-09-05 02:00:00' }).includes('answerGate'), false);
    assert.equal(gate({ linear_state: 'completed' }).includes('answerGate'), false);
    assert.equal(gate({ linear_state: 'completed', status: 'active',
                        response_option_id: 'd2' }).includes('askReopen'), false);
  });

  test('a session with no options renders the quiet card, unchanged', () => {
    const html = sessionCard({
      ...row({ linear_id: 'RYV-84', project: 'ryve', title: 'Wallet header' }),
      status: 'waiting', prompt: 'Which direction proceeds?',
    });
    assert.equal(html.includes('class="gate"'), false);
    assert.equal(html.includes('Which direction proceeds?'), false);
  });
});

describe('a skipped stage looks different from a completed one', () => {
  const pill = (html) => (html.match(/class="stage-pill[^"]*">([^<]+)</) || [])[1];

  test('the pill says which stage was skipped, and is marked as such', () => {
    const skipped = sessionCard(row({ linear_id: 'RYV-90', labels: ['no-research'] }));
    assert.equal(pill(skipped), 'Research skipped');
    assert.match(skipped, /class="stage-pill is-skipped"/);
  });

  test('a completed stage keeps the plain pill it always had', () => {
    const done = sessionCard(row({ linear_id: 'RYV-91', labels: ['AI-research done'] }));
    assert.equal(pill(done), 'Researched');
    assert.equal(done.includes('is-skipped'), false);
  });

  test('an untouched card is still Backlog, not skipped', () => {
    const fresh = sessionCard(row({ linear_id: 'RYV-92' }));
    assert.equal(pill(fresh), 'Backlog');
    assert.equal(fresh.includes('is-skipped'), false);
  });

  test('skipping advances the card, so the button offers the next stage', () => {
    // The failure this closes: the card sat in Backlog offering Run Design,
    // with the column and the button disagreeing about where it was.
    const skipped = sessionCard(row({ linear_id: 'RYV-90', labels: ['no-research'] }));
    assert.match(skipped, /triggerSession\('[^']+', 'design'/);
    assert.ok(skipped.includes('Run Design'));
  });

  test('a no-design card in the drawer says why it is at that level', () => {
    const aside = sessionCard(row({ linear_id: 'RYV-93', labels: ['no-design'],
                                    dismissed_at: '2026-09-05 02:00:00' }));
    assert.equal(pill(aside), 'Design skipped');
    // Still put aside, and still offering only Undo — sectioning is untouched.
    assert.ok(aside.includes('undismissSession'));
    assert.equal(aside.includes('triggerSession'), false);
  });
});

describe('controls per section', () => {
  test('No design cards offer Undo and cannot be triggered', () => {
    assert.ok(drawers.nodesign.includes('undismissSession'));
    assert.equal(drawers.nodesign.includes('triggerSession'), false);
  });

  test('Completed cards carry no controls at all', () => {
    assert.equal(drawers.completed.includes('undismissSession'), false);
    assert.equal(drawers.completed.includes('triggerSession'), false);
    assert.equal(drawers.completed.includes('dismissSession'), false);
  });

  test('board cards offer the No design control', () => {
    assert.ok(drawers.above.includes('dismissSession'));
  });
});
