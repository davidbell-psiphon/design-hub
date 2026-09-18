// The schema pieces, against the database they actually run on.
//
//   node --test test/sql.test.mjs
//
// This exists because of a real failure on a real deploy, and the shape of it
// is worth keeping in mind before adding any table.
//
// `piece11-schema.sql` created its session table as `CREATE TABLE IF NOT
// EXISTS sessions`. The live database already has a `sessions` table — the
// password-auth one the retired chat organiser left behind, dead since Access
// took over, still present because §13 step 4 has not been run. So the
// statement did nothing, silently, and the next one failed with `no such
// column: requested_at`.
//
// The suite was green throughout. `freshDb` built a database with the four
// live tables and nothing else, so the name was free — the test database was
// not the shape of the real one, and the difference was invisible until
// deploy. `freshDb` creates the legacy tables now, which is the actual fix;
// these are what say so out loud.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, PIECES, freshDb, statements } from './helpers.mjs';

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// Every table name the retired product left in the database. Parsed from
// schema.sql rather than listed, so a name cannot be forgotten here.
function legacyTableNames() {
  const out = new Set();
  for (const m of read('schema.sql').matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/gi)) {
    out.add(m[1].toLowerCase());
  }
  return out;
}

// Every table each piece creates. Comments are stripped first — piece11 talks
// about the collision in prose, and a scanner that reads the explanation as a
// statement reports the bug the file exists to document.
function tablesCreatedBy(file) {
  const out = [];
  for (const stmt of statements(read(file))) {
    const m = stmt.match(/^\s*CREATE TABLE (?:IF NOT EXISTS )?(\w+)/i);
    if (m) out.push(m[1].toLowerCase());
  }
  return out;
}

describe('a new table cannot take a name the old product already used', () => {
  // The whole bug in one assertion. `IF NOT EXISTS` turns a name collision
  // from a loud error into a silent no-op, which is the worst possible
  // combination — and every piece here uses it, correctly, for re-runnability.
  const legacy = legacyTableNames();

  for (const piece of PIECES) {
    const creates = tablesCreatedBy(piece);
    if (!creates.length) continue;

    test(`${piece} creates ${creates.join(', ')}`, () => {
      for (const name of creates) {
        assert.ok(!legacy.has(name),
          `${piece} creates a table called "${name}", and schema.sql already ` +
          `has one. With IF NOT EXISTS that is a silent no-op against the live ` +
          `database, and the next statement fails on a column that was never ` +
          `created. Pick another name — piece11 had to become stage_sessions ` +
          `for exactly this reason.`);
      }
    });
  }

  test('the legacy names are what we think they are', () => {
    // If schema.sql stops being parseable, the check above quietly passes
    // everything. This is what catches that.
    assert.ok(legacy.has('sessions'), 'schema.sql no longer parses as expected');
    assert.ok(legacy.has('projects'));
    assert.ok(legacy.size >= 8, `only found ${legacy.size} legacy tables`);
  });
});

describe('every piece applies to a database shaped like production', () => {
  test('the whole history, in order, over the legacy tables', () => {
    // freshDb creates the legacy tables first, so this is the real path. It
    // throws on any failure, which is the assertion.
    const db = freshDb();

    const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

    assert.ok(cols('cards').includes('issue_key'), 'cards lost its key');
    assert.ok(cols('cards').includes('linear_read_at'), 'cards lost a column');
    for (const c of ['issue_key', 'stage', 'status', 'requested_at', 'options',
                     'gate_round', 'last_error', 'agent_posted_at', 'handoff_at']) {
      assert.ok(cols('stage_sessions').includes(c),
        `stage_sessions lost ${c} — the exact shape of the production failure`);
    }
    assert.ok(cols('gate_decisions').includes('stage'), 'gate_decisions lost stage');
    assert.ok(cols('brands').includes('sort_order'), 'brands lost a column');

    // And the legacy table is still there, untouched. Nothing in the pieces
    // drops anything, by instruction.
    assert.deepEqual(cols('sessions').sort(), ['created_at', 'expires_at', 'token'],
      'something wrote to the legacy sessions table, or dropped it');
  });

  test('applying every piece twice is survivable', () => {
    // Not silently idempotent — an ALTER TABLE is supposed to fail on a
    // duplicate column, per CLAUDE.md, because that is better than destroying
    // data. What must not happen is a piece half-applying.
    const db = freshDb();
    for (const piece of PIECES) {
      for (const stmt of statements(read(piece))) {
        try { db.exec(stmt); } catch (e) {
          assert.match(e.message, /duplicate column|already exists|UNIQUE/i,
            `re-running ${piece} failed for an unexpected reason: ${e.message}`);
        }
      }
    }
    // Nothing lost on the way through.
    assert.ok(db.prepare(`PRAGMA table_info(stage_sessions)`).all().length > 10);
  });
});
