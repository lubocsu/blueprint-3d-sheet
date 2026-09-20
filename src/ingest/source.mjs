/**
 * What kind of input is this, and is it safe to read as text?
 *
 * The dispatcher used to treat anything outside its two extension whitelists as
 * a written brief and slurp it with `readFile(path, 'utf8')`. Hand it a 29 MB
 * DWG and nothing fails — the evidence scorer happily scores the mojibake. Byte
 * noise matches the model-designation pattern, the unit regexes fire hundreds of
 * times against random digits, and the one component whose entire job is to say
 * "this material is too thin to draw from" reports:
 *
 *     source: brief · subject class: vehicle
 *       identity   1.00  a model designation is given
 *       scale      1.00  132 length figure(s), 129 mass figure(s)
 *       geometry   0.00  no drawing supplied
 *       coverage 0.65 — the material supports a detailed drawing
 *
 * A green light derived from binary noise is worse than any error: it is the
 * exact failure — a confident sheet built on figures that came from nowhere —
 * that the evidence stage exists to prevent, reached through the most ordinary
 * input a real user has (a DWG, the format drawings actually arrive in).
 *
 * So classification and the text guard live here, in one place the CLI and the
 * skill's own evidence script both read from, rather than as two drifting copies
 * of the same extension set.
 */

import { extname } from 'node:path';

/** Raster drawings: the model reads proportions, estimates every dimension. */
export const RASTER = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff']);

/** Vector drawings: true coordinates, parsed directly into extrude profiles. */
export const VECTOR = new Set(['.dxf', '.svg']);

/**
 * Closed formats a converter can turn into something in VECTOR. Listed
 * separately from "unsupported" because the answer is "convert it", not "no".
 */
export const CONVERTIBLE = new Set(['.dwg']);

/** Plain-text extensions a brief legitimately arrives as. */
export const TEXTUAL = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.yml', '.yaml', '']);

/**
 * Binary formats worth naming explicitly, so the refusal can say what to do
 * instead of "that isn't text". Everything not listed still gets caught by the
 * NUL-byte sniff below — this table only buys a better sentence.
 */
const BINARY_ADVICE = {
  '.dwg': 'DWG is closed binary. Convert it to DXF first — see src/ingest/dwg.mjs, ' +
          'which will do it automatically once a converter is installed.',
  '.pdf': 'PDF is not read directly. Export the sheet you want as DXF (best) or PNG.',
  '.zip': 'Unpack it and pass the drawing inside.',
  '.rar': 'Unpack it and pass the drawing inside.',
  '.7z':  'Unpack it and pass the drawing inside.',
  '.docx': 'Export or copy the text out and pass that as the brief.',
  '.xlsx': 'Export or copy the figures out and pass them as the brief.',
  '.step': 'STEP is not supported. Export a DXF of the views you need.',
  '.stp':  'STEP is not supported. Export a DXF of the views you need.',
  '.iges': 'IGES is not supported. Export a DXF of the views you need.',
  '.igs':  'IGES is not supported. Export a DXF of the views you need.',
  '.sldprt': 'Export a DXF of the views you need.',
  '.ipt':  'Export a DXF of the views you need.',
  '.rvt':  'Export a DXF of the views you need.',
};

/**
 * How much of a file to sniff. A text file that is genuinely text is text in its
 * first few KB; a binary container gives itself away almost immediately.
 */
const SNIFF_BYTES = 8192;

/**
 * @param {string} path
 * @param {boolean} exists
 * @returns {{kind: 'brief'|'raster'|'vector'|'convertible', ext: string}}
 */
export function classifyPath(path, exists = true) {
  if (!exists || typeof path !== 'string') return { kind: 'brief', ext: '' };
  const ext = extname(path).toLowerCase();
  if (RASTER.has(ext)) return { kind: 'raster', ext };
  if (VECTOR.has(ext)) return { kind: 'vector', ext };
  if (CONVERTIBLE.has(ext)) return { kind: 'convertible', ext };
  return { kind: 'brief', ext };
}

/**
 * True when a buffer is plainly not text.
 *
 * A NUL byte is the giveaway: no encoding a brief could legitimately arrive in
 * puts one in running prose, and every binary container is riddled with them.
 * The replacement-character ratio catches the rarer case of compressed bytes
 * that happen to avoid NUL — a fully compressed DWG section, for instance.
 */
export function looksBinary(buffer) {
  if (!buffer?.length) return false;
  const head = buffer.subarray(0, Math.min(buffer.length, SNIFF_BYTES));
  if (head.includes(0)) return true;

  const text = head.toString('utf8');
  let replacements = 0;
  for (const ch of text) if (ch === '�') replacements++;
  return replacements / Math.max(text.length, 1) > 0.1;
}

/**
 * Refuse a file that cannot honestly be read as a brief.
 *
 * Deliberately an error rather than a warning. The alternative — score it and
 * mention the doubt — is what produced `coverage 0.65` for a binary blob, and a
 * caller that trusted the number would carry on and build on it.
 *
 * @param {string} path
 * @param {Buffer} buffer  the bytes already read for this file
 * @throws {Error} when the content is not text
 */
export function assertReadableBrief(path, buffer) {
  const ext = extname(path).toLowerCase();
  const advice = BINARY_ADVICE[ext];

  if (advice) {
    throw new Error(
      `${path} is a ${ext.slice(1).toUpperCase()} file, not a brief or a supported drawing. ${advice}`);
  }
  if (looksBinary(buffer)) {
    throw new Error(
      `${path} is binary, not text — refusing to read it as a written brief. ` +
      'Supported drawings are ' + [...VECTOR, ...CONVERTIBLE, ...RASTER].join(' ') + '; ' +
      'anything else has to be a plain-text brief.');
  }
}

/** Every extension the pipeline will accept as a drawing, for help text. */
export function supportedDrawingExtensions() {
  return [...VECTOR, ...CONVERTIBLE, ...RASTER];
}
