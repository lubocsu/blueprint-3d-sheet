#!/usr/bin/env node
/**
 * Print the canonical spec-authoring guide for a subject class.
 *
 * This is generated from the pipeline's own source rather than copied into
 * prose, so it cannot drift: the shape vocabulary, the detail decorators, the
 * animation channels and the density bar printed here are literally the ones
 * `b2d validate` will hold the spec to.
 *
 *   node scripts/spec-guide.mjs                 # list the subject classes
 *   node scripts/spec-guide.mjs vehicle         # the full guide for one class
 */

import { buildSystemPrompt } from '../../../src/ingest/prompt.mjs';
import { ARCHETYPES, guessArchetype } from '../../../src/ingest/archetypes.mjs';

const arg = process.argv[2];

if (!arg) {
  console.log('Subject classes:\n');
  for (const name of Object.keys(ARCHETYPES)) {
    const first = ARCHETYPES[name].guidance.trim().split('\n')[0].replace('SUBJECT CLASS: ', '');
    console.log(`  ${name.padEnd(18)} ${first}`);
  }
  console.log('\nUsage: node scripts/spec-guide.mjs <class>');
  console.log('If unsure which class fits, pass the subject text instead and it will be routed:');
  console.log('  node scripts/spec-guide.mjs "a nine-cylinder radial aero engine"');
  process.exit(0);
}

const archetype = ARCHETYPES[arg] ? arg : guessArchetype(arg);
if (!ARCHETYPES[arg]) {
  console.error(`# "${arg}" routed to subject class: ${archetype}\n`);
}
console.log(buildSystemPrompt(archetype));
