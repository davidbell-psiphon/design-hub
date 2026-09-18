// Shared harness for the suites that run the Worker for real.
//
// node:sqlite stands in for D1 behind the same prepare/bind/first/all/run
// shape, and Linear is a stubbed fetch — so these exercise the SQL that ships
// rather than a paraphrase of it. Extracted from session.test.mjs so that a
// schema change is one edit and not one per suite: PIECES below is the live
// database's own history, and every suite that touches SQL has to agree
// about it.
//
// Defines no tests of its own. The runner discovers every .mjs under test/,
// so it is reported as a file with nothing in it — that is expected.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// The schema as the live database got it: additive pieces, in order. The gate
// migration is last because that is the order it was applied in.
export const PIECES = ['agent-schema.sql', 'reader-schema.sql', 'track-schema.sql',
                      'piece4-schema.sql', 'piece5-schema.sql', 'piece6-schema.sql',
                      'piece7-schema.sql', 'migration-001-gates.sql',
                      'piece8-schema.sql', 'piece9-schema.sql', 'migration-002-heartbeat.sql',
                      'piece10-schema.sql'];

// Comments first, then split on statement boundaries — that order matters,
// because one piece4 comment has a semicolon in it. Safe here because none of
// the pieces put a `--` or a `;` inside a string literal.
export function statements(sql) {
  return sql.replace(/--[^\n]*/g, '')
            .split(';')
            .map(s => s.trim())
            .filter(Boolean);
}

export function applyPieces(db, pieces) {
  for (const file of pieces) {
    for (const stmt of statements(fs.readFileSync(path.join(ROOT, file), 'utf8'))) {
      db.exec(stmt);
    }
  }
}

// piece4-schema.sql sets the brand colours, so `projects` has to exist for it
// to apply verbatim — which is worth keeping, since applying every piece in
// order is half of what these suites check.
export function freshDb(pieces = PIECES) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, color TEXT,
             section_id TEXT, sort_order INTEGER)`);
  applyPieces(db, pieces);
  return db;
}

// D1's binding surface, over node:sqlite.
export function d1(db) {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      const run = (args) => {
        const r = stmt.run(...args);
        return { success: true, meta: { changes: r.changes } };
      };
      const api = (args) => ({
        bind: (...more) => api([...args, ...more]),
        first: async () => stmt.get(...args) ?? null,
        all: async () => ({ results: stmt.all(...args) }),
        run: async () => run(args),
      });
      return api([]);
    },
  };
}

// worker/index.js is ESM with a .js extension, and this repo has no
// package.json to say so — so load it as a data: URL with its relative imports
// rewritten to absolute ones. Same source the Worker ships.
export async function loadWorker() {
  // Windows paths carry separators that are not URL separators; splitting on
  // path.sep and rejoining keeps this free of escape sequences.
  const rootUrl = 'file:///' + ROOT.split(path.sep).join('/') + '/';
  const src = fs.readFileSync(path.join(ROOT, 'worker/index.js'), 'utf8')
    .replace(/from '[.][.]\/lib\/([^']+)'/g,
             (_, f) => `from '${new URL('lib/' + f, rootUrl)}'`);
  return (await import('data:text/javascript,' + encodeURIComponent(src))).default;
}

export const worker = await loadWorker();

// A Linear issue as the reader's GraphQL query returns it.
export const issue = (o) => ({
  id: o.uuid || 'uuid-' + o.identifier,
  identifier: o.identifier,
  title: o.title || o.identifier + ' title',
  description: o.description || 'A Linear description.',
  url: 'https://linear.app/x/issue/' + o.identifier,
  assignee: o.assignee === null ? null : { name: o.assignee || 'Dave Bell' },
  project: null,
  labels: { nodes: o.labels || [] },
  team: { name: o.team || 'Ryve App' },
  state: { type: o.state || 'unstarted' },
});

const gql = (data) => ({ ok: true, json: async () => ({ data }) });

// Stub Linear. Discovery gets `issues`, reconciliation gets the state and
// labels of the ids it asks for, and label mutations succeed.
//
// `mutations` is an optional recorder, so a test can assert that a route wrote
// nothing to Linear — the whole contract of the trigger button now.
//
// `opts` drives the failure paths that the dismiss route's ordering depends
// on: `noLabel` is a workspace with no such label, `mutationError` is Linear
// refusing the write, and `queries` records every operation in order.
export function stubLinear(issues, mutations, opts = {}) {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const q = body.query;
    // The whole query, not its first line: the opening line of a Linear
    // mutation is identical for add and remove, so a first-line recorder
    // cannot tell a dismissal from an undo.
    if (mutations && /^\s*mutation/.test(q)) mutations.push(q.trim());
    if (opts.queries) opts.queries.push(q.trim());

    if (/DesignReaderIssues/.test(q)) {
      // Honour the state filter the query actually declares, rather than
      // returning everything handed in. Linear applies that filter server
      // side, so a stub that ignores it cannot tell a correct discovery
      // query from one widened to drag closed issues through the
      // `first: 100` budget — which is the invariant reader.test.mjs exists
      // to hold down.
      const m = q.match(/type:\s*\{\s*in:\s*\[([^\]]*)\]/);
      const allowed = m
        ? m[1].split(',').map(s => s.trim().replace(/["']/g, '')).filter(Boolean)
        : null;
      const nodes = allowed
        ? issues.filter(i => allowed.includes(i.state && i.state.type))
        : issues;
      return gql({ issues: { nodes } });
    }
    if (/Reconcile/.test(q)) {
      const ids = body.variables.ids;
      return gql({ issues: { nodes:
        issues.filter(i => ids.includes(i.id))
              .map(i => ({ id: i.id, state: i.state, labels: i.labels })) } });
    }
    // A team's workflow states, for the complete route. Two completed states,
    // deliberately out of position order in the array, so "the earliest by
    // position wins" is a real assertion rather than a coincidence of ordering.
    if (/ReaderTeams/.test(q)) {
      return gql({ teams: { nodes: (opts.teams || ['Conduit App', 'Marketing', 'Ryve App'])
        .map((name) => ({ name })) } });
    }
    if (/IssueStates/.test(q)) {
      const found = issues.find((i) => i.id === body.variables.id);
      if (!found) return gql({ issue: null });
      return gql({ issue: {
        id: found.id,
        state: found.state,
        team: {
          id: 'team-1',
          name: (found.team && found.team.name) || 'Ryve App',
          states: { nodes: opts.states || [
            { id: 'st-backlog', name: 'Backlog',     type: 'backlog',   position: 0 },
            { id: 'st-late',    name: 'Archived',    type: 'completed', position: 3 },
            { id: 'st-done',    name: 'Design Done', type: 'completed', position: 1 },
          ] },
        },
      } });
    }
    if (/issueLabels/.test(q)) {
      return gql({ issueLabels: { nodes: opts.noLabel ? [] : [{ id: 'label-1' }] } });
    }
    if (opts.mutationError) {
      return { ok: true, json: async () => ({ errors: [{ message: 'Linear said no' }] }) };
    }
    return gql({ issueAddLabel: { success: true }, issueRemoveLabel: { success: true } });
  };
}

// ACCESS_AUD / ACCESS_TEAM are deliberately absent: unset means enforcement is
// off, which is the state every suite but access.test.mjs wants.
export const env = (db, extra = {}) =>
  ({ DB: d1(db), LINEAR_API_KEY: 'k', AGENT_SECRET: 's', ...extra });

export function call(e, method, path, body, headers = {}) {
  return worker.fetch(new Request('https://hub.test' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), e);
}

export const agentPost = (e, body) =>
  call(e, 'POST', '/api/agent/session', body, { 'X-Agent-Secret': 's' });

export const readLinear = (e) => call(e, 'POST', '/api/read-linear');

export const rows = (db) => db.prepare(`SELECT * FROM agent_sessions ORDER BY id`).all();

export const one = (db, id) =>
  db.prepare(`SELECT * FROM agent_sessions WHERE id = ?`).get(id);
