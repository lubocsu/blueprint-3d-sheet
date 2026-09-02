/**
 * Model call + repair loop.
 *
 * The spec comes back through a forced tool call, so the transport is already
 * JSON — no fence-stripping, no "here is your spec:" preamble to chew off. If
 * validation or the density gate rejects it, the exact failure list is fed back
 * and the model tries again. That loop is the reason the pipeline can be pointed
 * at an arbitrary subject and still produce something that renders.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateSpec } from '../spec/validate.mjs';
import { checkRichness } from '../spec/richness.mjs';
import { buildSystemPrompt, buildRepairPrompt } from './prompt.mjs';
import { makeClient, hasCredentials, CREDENTIAL_HINT } from './anthropic.mjs';

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL('../spec/schema.json', import.meta.url)), 'utf8'),
);

const MODEL = process.env.B2D_MODEL ?? 'claude-opus-5';
const MAX_ATTEMPTS = 3;

/**
 * The tool the model must call. Handing it the real JSON Schema means the
 * structure is enforced at the API boundary, before our validator ever runs.
 */
function specTool() {
  const { $schema, $id, ...rest } = schema;
  return {
    name: 'emit_assembly_spec',
    description: 'Emit the complete AssemblySpec for the subject. Call exactly once.',
    input_schema: { ...rest, type: 'object' },
  };
}

function extractSpec(message) {
  const block = message.content.find(
    (b) => b.type === 'tool_use' && b.name === 'emit_assembly_spec');
  if (!block) {
    const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    throw new Error(`model did not call emit_assembly_spec${text ? `: ${text.slice(0, 400)}` : ''}`);
  }
  return block.input;
}

/**
 * Shortfalls that mean the model was missing FACTS rather than making a
 * malformed spec. Telling it to try harder on these just invites it to invent
 * more; the useful response is to go and find out.
 */
const KNOWLEDGE_GAPS = {
  thinParts: ['decomposition'],
  thinNotes: ['decomposition', 'materials'],
  noInternals: ['internals'],
  lowGrounding: ['scale', 'materials'],
};

function knowledgeAxes(gaps) {
  const axes = new Set();
  for (const [flag, list] of Object.entries(KNOWLEDGE_GAPS)) {
    if (gaps?.[flag]) for (const a of list) axes.add(a);
  }
  return [...axes];
}

/**
 * @param {object} opts
 * @param {string} opts.archetype
 * @param {Array} opts.userContent - Anthropic content blocks (text and/or image)
 * @param {boolean} opts.verbose
 * @param {(axes: string[]) => Promise<{dossier, userContent}|null>} [opts.onKnowledgeGap]
 *        Called at most once, when a rejected spec looks under-informed rather
 *        than malformed. Returning fresh content restarts generation with it.
 * @returns {Promise<object>} a spec that passed both gates
 */
export async function generateSpec({
  archetype, userContent, verbose = false, onKnowledgeGap = null, client = null,
}) {
  if (!client && !hasCredentials()) {
    throw new Error(
      `${CREDENTIAL_HINT}. Or skip ingest and pass an existing spec.json ` +
      'straight to `b2d build`.');
  }

  // `client` is a seam, not a feature: it lets the retry-and-escalate loop be
  // exercised offline with a stub. Nothing in the pipeline passes one.
  client ??= makeClient();
  const tool = specTool();
  const system = buildSystemPrompt(archetype);

  let messages = [{ role: 'user', content: userContent }];
  let lastSpec = null;
  let lastReport = null;
  // One escalation per run. Any more and a subject the web simply cannot answer
  // would multiply the research cost by the retry count.
  let escalated = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (verbose) process.stderr.write(`  attempt ${attempt}/${MAX_ATTEMPTS} … `);

    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 32000,
      system,
      tools: [tool],
      tool_choice: { type: 'tool', name: 'emit_assembly_spec' },
      messages,
    });

    let spec;
    try {
      spec = extractSpec(message);
    } catch (err) {
      if (verbose) process.stderr.write('no tool call\n');
      if (attempt === MAX_ATTEMPTS) throw err;
      messages.push({ role: 'assistant', content: message.content });
      messages.push({ role: 'user', content: 'You must call emit_assembly_spec. Do it now.' });
      continue;
    }

    lastSpec = spec;
    const structural = validateSpec(spec);
    const rich = structural.ok ? checkRichness(spec) : { ok: false, errors: [], warnings: [], gaps: {} };
    const errors = [...structural.errors, ...rich.errors];
    lastReport = { errors, warnings: [...(structural.warnings ?? []), ...(rich.warnings ?? [])] };

    if (errors.length === 0) {
      if (verbose) {
        const s = rich.stats;
        process.stderr.write(
          `ok — ${s.authoredParts} parts (${s.effectiveParts} with instances), ` +
          `${s.callouts} callouts, ${s.details} details\n`);
      }
      return spec;
    }

    if (verbose) process.stderr.write(`${errors.length} problem(s)\n`);
    if (attempt === MAX_ATTEMPTS) break;

    // Under-informed rather than malformed? Fetch facts and start over, instead
    // of spending another round asking for more of what it does not know.
    const axes = knowledgeAxes(rich.gaps);
    if (!escalated && axes.length && onKnowledgeGap) {
      escalated = true;
      const better = await onKnowledgeGap(axes);
      if (better?.userContent) {
        messages = [{ role: 'user', content: better.userContent }];
        continue;
      }
    }

    const toolUse = message.content.find((b) => b.type === 'tool_use');
    messages.push({ role: 'assistant', content: message.content });
    messages.push({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUse.id, content: 'rejected' },
        { type: 'text', text: buildRepairPrompt(errors, lastReport.warnings) },
      ],
    });
  }

  const err = new Error(
    `spec still failing after ${MAX_ATTEMPTS} attempts:\n` +
    lastReport.errors.map((e) => `  - ${e}`).join('\n'));
  err.spec = lastSpec;
  err.report = lastReport;
  throw err;
}

export { MODEL, specTool, knowledgeAxes, KNOWLEDGE_GAPS };
