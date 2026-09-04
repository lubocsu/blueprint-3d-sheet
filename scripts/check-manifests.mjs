#!/usr/bin/env node
/**
 * The plugin manifest, the marketplace entry and package.json each carry a copy
 * of the same facts. They drift, and the failure is silent: a stale version in
 * one of them installs fine and simply reports the wrong thing forever.
 *
 *   node scripts/check-manifests.mjs
 */

import { readFileSync, existsSync } from 'node:fs';

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

let failures = 0;
const fail = (msg) => { failures++; console.error(`  x ${msg}`); };
const pass = (msg) => console.log(`  - ${msg}`);

const plugin = read('.claude-plugin/plugin.json');
const market = read('.claude-plugin/marketplace.json');
const pkg = read('package.json');

for (const field of ['name', 'description', 'version', 'author']) {
  if (!plugin[field]) fail(`plugin.json is missing "${field}"`);
}

const entry = market.plugins?.find((p) => p.name === plugin.name);
if (!entry) fail(`marketplace.json has no entry named "${plugin.name}"`);
else pass(`marketplace lists "${plugin.name}"`);

if (pkg.version !== plugin.version) {
  fail(`version drift: package.json ${pkg.version} vs plugin.json ${plugin.version}`);
} else {
  pass(`version agrees across manifests: v${plugin.version}`);
}

// A placeholder that reaches a published manifest is worse than a missing
// field: it installs, and then points every user at a repository nobody owns.
const placeholders = JSON.stringify({ plugin, market }).match(/YOUR-[A-Z-]+/g);
if (placeholders) fail(`unfilled placeholder(s): ${[...new Set(placeholders)].join(', ')}`);
else pass('no unfilled placeholders');

// The loader looks here and nowhere else.
const skill = `skills/${plugin.name}/SKILL.md`;
if (!existsSync(skill)) fail(`the skill is not where the loader expects it: ${skill}`);
else pass(`skill present at ${skill}`);

if (failures) {
  console.error(`\nmanifest check failed with ${failures} problem(s)`);
  process.exit(1);
}
console.log('\nmanifests agree');
