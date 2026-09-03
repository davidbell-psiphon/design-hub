-- Design Hub — full schema v2
-- Run with: npx wrangler d1 execute design-hub --file=./schema.sql --remote

-- Drop and recreate for clean slate
DROP TABLE IF EXISTS chats;
DROP TABLE IF EXISTS resources;
DROP TABLE IF EXISTS capabilities;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS sections;

-- sections: top-level sidebar groups
CREATE TABLE sections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0
);

-- projects: items inside a section (a brand, a design project, a goal group)
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  section_id TEXT NOT NULL REFERENCES sections(id),
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#888780',
  description TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- capabilities: the "what this does" bullet notes on each project card
CREATE TABLE capabilities (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  label TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0
);

-- resources: links attached to a project (github, cloudflare, figma, linear, chat url, etc)
CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('github','cloudflare','figma','linear','claude','chatgpt','gemini','other')),
  sort_order INTEGER DEFAULT 0
);

-- chats: individual AI chat sessions under a project
CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  notes TEXT,
  type TEXT NOT NULL CHECK(type IN ('design','research','writing','agent')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','waiting','done')),
  url TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────
-- SEED DATA
-- ─────────────────────────────────────────

INSERT INTO sections (id, name, sort_order) VALUES
  ('design-projects', 'Design projects', 1),
  ('brands',          'Brands',          2),
  ('cross-brand',     'Cross-brand',     3);

-- ── Design projects ──
INSERT INTO projects (id, section_id, name, color, description, sort_order) VALUES
  ('design-ai',      'design-projects', 'Design AI',       '#7F77DD', 'AI infrastructure and session management for all design work', 1),
  ('design-hub',     'design-projects', 'Design Hub',      '#378ADD', 'Central dashboard for organizing projects, chats, and resources', 2),
  ('design-portal',  'design-projects', 'Design Portal',   '#1D9E75', 'Research and resource site for design best practices', 3),
  ('design-magazine','design-projects', 'Design Magazine', '#D4537E', 'Publication and content platform for design insights', 4);

-- ── Brands ──
INSERT INTO projects (id, section_id, name, color, description, sort_order) VALUES
  ('conduit',  'brands', 'Conduit',     '#378ADD', 'VPN and network connectivity product', 1),
  ('ryve',     'brands', 'Ryve',        '#D4537E', 'Fitness and wellness mobile app', 2),
  ('psiphon',  'brands', 'Psiphon VPN', '#1D9E75', 'Open source censorship circumvention tool', 3),
  ('forge',    'brands', 'Forge',       '#BA7517', 'Developer tooling and infrastructure', 4);

-- ── Cross-brand ──
INSERT INTO projects (id, section_id, name, color, description, sort_order) VALUES
  ('q3-goals', 'cross-brand', 'Q3 Goals', '#7F77DD', 'Quarterly goals spanning all brands', 1);

-- ─────────────────────────────────────────
-- CAPABILITIES
-- ─────────────────────────────────────────

INSERT INTO capabilities (id, project_id, label, sort_order) VALUES
  ('cap-ai-1', 'design-ai', 'Organizes all AI sessions by brand and project', 1),
  ('cap-ai-2', 'design-ai', 'Generates weekly schedule from Linear tasks', 2),
  ('cap-ai-3', 'design-ai', 'Monitors always-on background agents', 3);

INSERT INTO capabilities (id, project_id, label, sort_order) VALUES
  ('cap-hub-1', 'design-hub', 'Central command dashboard for second screen', 1),
  ('cap-hub-2', 'design-hub', 'Links every AI chat to its project and brand', 2),
  ('cap-hub-3', 'design-hub', 'Tracks status of all active work sessions', 3);

INSERT INTO capabilities (id, project_id, label, sort_order) VALUES
  ('cap-portal-1', 'design-portal', 'Researches and gathers design news automatically', 1),
  ('cap-portal-2', 'design-portal', 'Maintains a library of design resources and best practices', 2),
  ('cap-portal-3', 'design-portal', 'Self-improving site — agent codes and deploys updates', 3);

INSERT INTO capabilities (id, project_id, label, sort_order) VALUES
  ('cap-mag-1', 'design-magazine', 'Publishes design articles and case studies', 1),
  ('cap-mag-2', 'design-magazine', 'Curates industry trends and insights', 2);

INSERT INTO capabilities (id, project_id, label, sort_order) VALUES
  ('cap-conduit-1', 'conduit', 'Creates website content and landing pages', 1),
  ('cap-conduit-2', 'conduit', 'Designs UI for download and hosted product pages', 2),
  ('cap-conduit-3', 'conduit', 'Researches platform-specific UX patterns', 3);

INSERT INTO capabilities (id, project_id, label, sort_order) VALUES
  ('cap-ryve-1', 'ryve', 'Creates UX designs for mobile app flows', 1),
  ('cap-ryve-2', 'ryve', 'Produces App Store assets and launch materials', 2),
  ('cap-ryve-3', 'ryve', 'Reviews and documents SDK and release changes', 3);

INSERT INTO capabilities (id, project_id, label, sort_order) VALUES
  ('cap-psi-1', 'psiphon', 'Designs brand system and identity materials', 1),
  ('cap-psi-2', 'psiphon', 'Researches regional messaging and ICP strategy', 2),
  ('cap-psi-3', 'psiphon', 'Builds and redesigns the public-facing website', 3);

INSERT INTO capabilities (id, project_id, label, sort_order) VALUES
  ('cap-forge-1', 'forge', 'Redesigns homepage and core marketing pages', 1),
  ('cap-forge-2', 'forge', 'Creates competitive research and design briefs', 2);

INSERT INTO capabilities (id, project_id, label, sort_order) VALUES
  ('cap-q3-1', 'q3-goals', 'Tracks quarterly goals across all brands', 1),
  ('cap-q3-2', 'q3-goals', 'Balances goal progress against sprint tasks', 2),
  ('cap-q3-3', 'q3-goals', 'Surfaces at-risk goals in daily brief', 3);

-- ─────────────────────────────────────────
-- RESOURCES
-- ─────────────────────────────────────────

INSERT INTO resources (id, project_id, label, url, type, sort_order) VALUES
  ('res-hub-1', 'design-hub', 'design-hub', 'https://design-hub-7y2.pages.dev', 'cloudflare', 1),
  ('res-hub-2', 'design-hub', 'This chat', 'https://claude.ai', 'claude', 2);

INSERT INTO resources (id, project_id, label, url, type, sort_order) VALUES
  ('res-portal-1', 'design-portal', 'Design Portal', 'https://design-portal-2t2.pages.dev/', 'cloudflare', 1);

-- ─────────────────────────────────────────
-- STARTER CHATS
-- ─────────────────────────────────────────

INSERT INTO chats (id, project_id, title, notes, type, status) VALUES
  ('c-hub-1', 'design-hub',    'Session board UI',       'Brand → project → chat hierarchy, status toggles, resource links', 'design',   'active'),
  ('c-hub-2', 'design-hub',    'Architecture planning',  'Cloudflare D1 schema, Worker API endpoints, data model design',    'agent',    'done'),
  ('c-ai-1',  'design-ai',     'DAD system design',      'Multiplexer concept, three-layer architecture, UX flows',          'design',   'active'),
  ('c-ai-2',  'design-ai',     'Schedule intelligence',  'Linear API connection, weekly plan generation, daily brief',       'research', 'waiting'),
  ('c1', 'conduit',  'Download page — platform detection', 'Layout and device frame designs for 4 platform states',  'design',   'active'),
  ('c2', 'conduit',  'Hosted Conduit graphic',            'Concept brief — flagged waiting since Aug 4',              'design',   'waiting'),
  ('c6', 'ryve',     'App Store launch video',            'Storyboard MAR-760, scene direction MAR-761',              'design',   'active'),
  ('c8', 'ryve',     'Expo SDK upgrade review',           'SDK changelog audit, Linear issues MAR-764',               'research', 'active'),
  ('c11','psiphon',  'Brand booklet wireframe',           '20-spread layout structure, 12 chapter outline',           'design',   'waiting'),
  ('c12','psiphon',  'Website redesign',                  'ICP definitions WEB-13, UVP options WEB-16',               'research', 'done'),
  ('c14','forge',    'Homepage redesign',                 'Full redesign brief and Figma AI prompt complete',         'writing',  'done'),
  ('c15','q3-goals', 'Social AI pipeline',                '108-template Figma system, agent architecture',            'agent',    'active');

-- Auth and session tables (add to existing schema)
CREATE TABLE IF NOT EXISTS auth (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  attempts INTEGER DEFAULT 0,
  locked_until TEXT
);
