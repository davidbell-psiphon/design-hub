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
  project: o.project || 'conduit', track: 'app', phase: 'research',
  status: o.status || 'waiting', title: o.title || o.linear_id,
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
  row({ linear_id: 'WEB-271', linear_state: 'completed' }),
  row({ linear_id: 'WEB-272', linear_state: 'canceled', dismissed_at: '2026-09-05 02:00:00' }),
  row({ linear_id: 'RYV-187', project: 'ryve', labels: ['AI-research done'] }),
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

let board, sidebar, topbar, drawers, sessionCard;

before(async () => {
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
    json: async () => (url.endsWith('/brands') ? brandRows : sessions),
  });

  const run = new Function(logic + '\n' + inline + '\n;return { loadBoard, sessionCard };');
  const api = run();
  sessionCard = api.sessionCard;
  await api.loadBoard();

  board = nodes['board'].innerHTML;
  sidebar = nodes['sidebar'].innerHTML;
  topbar = nodes['topbar-sub'].textContent;
  drawers = {
    nodesign: (board.match(/id="drawer-nodesign"[\s\S]*?<\/details>/) || [''])[0],
    completed: (board.match(/id="drawer-completed"[\s\S]*?<\/details>/) || [''])[0],
    above: board.slice(0, board.indexOf('<details')),
  };
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
    assert.equal(/<details class="drawer"[^>]*\bopen\b/.test(board), false);
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
    // CON-120 is the only run in flight; CON-125 is queued but dismissed.
    assert.equal((sidebar.match(/class="sb-badge waiting/g) || []).length, 2); // All brands + Conduit
    assert.match(sidebar, /sb-badge waiting">1</);
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

describe('the four stage columns', () => {
  const heading = (name) => new RegExp('bucket-label">' + name + '<');

  test('all four render, in order', () => {
    const order = ['Backlog', 'Researched', 'AI-designed', 'QA&#39;d'];
    const labels = [...drawers.above.matchAll(/bucket-label">([^<]+)</g)].map(m => m[1]);
    // One set per brand section; every set is the same four in the same order.
    assert.ok(labels.length >= 4, 'no buckets rendered');
    assert.deepEqual(labels.slice(0, 4), ['Backlog', 'Researched', 'AI-designed', "QA'd"]);
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

  test('a card with a run in flight shows a disabled Working button', () => {
    const html = sessionCard(row({ linear_id: 'CON-120', requested_stage: 'research' }));
    assert.match(html, /btn btn-primary" disabled>Working/);
    assert.equal(html.includes("triggerSession('linear/CON-120'"), false,
                 'a running card must not be clickable');
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
  });

  test('every option is its own button, carrying its label and summary', () => {
    const html = gate();
    assert.equal((html.match(/class="gate-option"/g) || []).length, 3);
    assert.ok(html.includes('Icon-only corner button'));
    assert.ok(html.includes('Collection-level add row'));
    assert.ok(html.includes('Costs card width.'));
    assert.match(html, /answerGate\('[^']+', 'd2'/);
  });

  test('the question is shown, and nothing is typed to answer it', () => {
    const html = gate();
    assert.ok(html.includes('Which direction proceeds?'), 'the question is missing');
    assert.equal(html.includes('<textarea'), false, 'a free-text answer box came back');
    // The one input is the note, and it says what it is for.
    assert.equal((html.match(/<input/g) || []).length, 1);
    assert.match(html, /class="gate-note"[\s\S]*?not instead of it/);
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
