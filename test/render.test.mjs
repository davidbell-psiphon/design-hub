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
  triggered_at: o.triggered_at || null, dismissed_at: o.dismissed_at || null,
  linear_uuid: 'uuid-' + o.linear_id, url: 'https://linear.app/x',
});

const sessions = [
  row({ linear_id: 'CON-116' }),
  row({ linear_id: 'CON-118' }),
  row({ linear_id: 'CON-120', triggered_at: '2026-09-05 01:00:00' }),
  row({ linear_id: 'CON-124', dismissed_at: '2026-09-05 02:00:00' }),
  row({ linear_id: 'CON-125', dismissed_at: '2026-09-05 02:00:00', triggered_at: '2026-09-05 01:00:00' }),
  row({ linear_id: 'WEB-271', linear_state: 'completed' }),
  row({ linear_id: 'WEB-272', linear_state: 'canceled', dismissed_at: '2026-09-05 02:00:00' }),
  row({ linear_id: 'RYV-187', project: 'ryve' }),
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

let board, sidebar, topbar, drawers;

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

  const run = new Function(logic + '\n' + inline + '\n;return { loadBoard };');
  await run().loadBoard();

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
    assert.equal(topbar, '1 waiting on you · 4 open');
  });

  test('the brand header counts open rows only', () => {
    // Conduit holds 5 rows, 2 of them dismissed.
    assert.match(drawers.above, /brand-name">Conduit<[\s\S]{0,400}?<span>3 open<\/span>/);
  });

  test('a dismissed waiting row does not leave an amber badge behind', () => {
    // CON-120 is the only genuine decision; CON-125 is waiting but dismissed.
    assert.equal((sidebar.match(/class="sb-badge waiting/g) || []).length, 2); // All brands + Conduit
    assert.match(sidebar, /sb-badge waiting">1</);
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

  test('untriggered board cards offer the No design control', () => {
    assert.ok(drawers.above.includes('dismissSession'));
  });
});
