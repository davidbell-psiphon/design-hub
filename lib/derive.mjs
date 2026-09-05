// Brand and track derivation for the Linear Reader.
//
// Extracted from worker/index.js so it can be tested directly. .mjs because
// this repo has no package.json: Node reads .mjs as ESM regardless, and
// esbuild resolves the import when wrangler bundles the Worker.

// Teams that map to exactly one brand. 'Websites' is deliberately absent —
// it covers every brand, so its issues fall through to keyword detection.
export const TEAM_BRAND = {
  'Conduit App': 'conduit',
  'Ryve App': 'ryve',
  'Psiphon App': 'psiphon',
  'Forge': 'forge',
};

export const TEAM_TRACK = {
  'Conduit App': 'app',
  'Ryve App': 'app',
  'Psiphon App': 'app',
  'Forge': 'website',
  'Websites': 'website',
};

export const BRAND_KEYWORDS = ['conduit', 'ryve', 'psiphon', 'forge'];

// Keyword fallback: scans the issue's project name, labels and title for a
// brand word. This is what rescues 'Websites' issues, which have no team
// mapping — WEB-248 is only filed under psiphon because of this.
export function detectBrand(issue) {
  const haystacks = [
    issue.project && issue.project.name,
    ...((issue.labels && issue.labels.nodes) || []).map(l => l.name),
    issue.title,
  ].filter(Boolean).map(s => s.toLowerCase());
  for (const text of haystacks) {
    const hit = BRAND_KEYWORDS.find(brand => text.includes(brand));
    if (hit) return hit;
  }
  return null;
}

// The full brand decision: team mapping first, keyword fallback second.
// Null means the reader could not place it, and the card lands in Unassigned.
export function deriveBrand(issue) {
  const team = issue.team && issue.team.name;
  return TEAM_BRAND[team] || detectBrand(issue);
}

// app | website | null. Track comes from the team alone — there is no
// keyword fallback, because a title never reliably says which it is.
export function deriveTrack(teamName) {
  return TEAM_TRACK[teamName] || null;
}
