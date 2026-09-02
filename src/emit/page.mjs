/**
 * Emit a single self-contained HTML page.
 *
 * Everything is inlined — three, the runtime, the stylesheet and the spec — so
 * the result opens from a file:// path, survives a strict CSP, and has zero
 * external requests. The spec goes in as readable JSON rather than baked vertex
 * data: it is a fraction of the size and stays hand-editable after the fact.
 */

import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

/** JSON that is safe to drop inside a <script> element. */
function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

let cachedBundle = null;

export async function bundleRuntime({ minify = true, force = false } = {}) {
  if (cachedBundle && !force) return cachedBundle;
  const result = await build({
    entryPoints: [join(ROOT, 'src/render/app.mjs')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome100', 'firefox100', 'safari15'],
    minify,
    legalComments: 'none',
    write: false,
    logLevel: 'warning',
  });
  cachedBundle = result.outputFiles[0].text;
  return cachedBundle;
}

/**
 * @param {object} spec - the *authored* spec (normalization happens in-page)
 * @param {object} opts
 * @returns {Promise<{ html: string, bytes: number }>}
 */
export async function renderPage(spec, { minify = true, embedFont = null } = {}) {
  const [template, styles, bundle] = await Promise.all([
    readFile(join(ROOT, 'templates/page.html'), 'utf8'),
    readFile(join(ROOT, 'templates/styles.css'), 'utf8'),
    bundleRuntime({ minify }),
  ]);

  let fontTag = '';
  if (embedFont) {
    const buf = await readFile(embedFont);
    const b64 = buf.toString('base64');
    fontTag = `<style>@font-face{font-family:"B2D Mono";src:url(data:font/woff2;base64,${b64}) format("woff2");font-display:block}` +
              `:root{--mono:"B2D Mono",ui-monospace,monospace}</style>`;
  }

  const html = template
    .replace('{{TITLE}}', String(spec.meta?.title ?? 'Assembly').replace(/[<>&]/g, ''))
    .replace('{{STYLES}}', () => styles)
    .replace('{{FONT}}', () => fontTag)
    .replace('{{SPEC}}', () => safeJson(spec))
    .replace('{{BUNDLE}}', () => bundle);

  return { html, bytes: Buffer.byteLength(html, 'utf8') };
}

export async function writePage(spec, outDir, opts = {}) {
  const { html, bytes } = await renderPage(spec, opts);
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, 'index.html');
  await writeFile(file, html, 'utf8');
  return { file, bytes };
}
