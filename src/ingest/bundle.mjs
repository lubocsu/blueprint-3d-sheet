/**
 * URL-first reference bundles.
 *
 * Search is not the core dependency here: a user or the hosting agent can find
 * URLs. The skill owns the durable part after that point: download, archive,
 * score, select, and hand local evidence to ingest.
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { mkdir, readFile, writeFile, copyFile, rm, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extractVector } from './vector.mjs';

const run = promisify(execFile);

export const BUNDLE_ROOT = fileURLToPath(new URL('../../.cache/bundles/', import.meta.url));
export const BUNDLE_VERSION = 1;
export const BUNDLE_ROLES = new Set(['manual', 'drawing', 'photo', 'spec', 'cad']);
export const MAX_DOWNLOAD_BYTES = Number(process.env.B2D_BUNDLE_MAX_BYTES ?? 50 * 1024 * 1024);
export const MAX_SELECTED = Number(process.env.B2D_BUNDLE_MAX_SELECTED ?? 3);
export const MAX_REDIRECTS = Number(process.env.B2D_BUNDLE_MAX_REDIRECTS ?? 5);

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff']);
const VECTOR_EXT = new Set(['.svg', '.dxf']);
const TEXT_EXT = new Set(['.txt', '.md', '.csv']);
const DRAWING_WORDS = [
  'blueprint', 'drawing', 'general arrangement', 'ga drawing', 'orthographic',
  'plan view', 'side view', 'front view', 'section', 'cutaway', 'exploded',
  'dimension', 'manual', 'datasheet', 'schematic', 'parts catalog',
  '图纸', '总装', '剖面', '剖视', '爆炸图', '尺寸', '手册', '样本',
];
const INTERNAL_WORDS = [
  'internal', 'interior', 'cutaway', 'section', 'cross-section', 'powerpack',
  'gearbox', 'transmission', 'bearing', 'shaft', 'impeller', 'stator', 'rotor',
  '内部', '剖视', '剖面', '内构', '总成', '轴承', '叶轮', '转子',
];
const UNIT_RE = /\b\d+(?:[.,]\d+)?\s*(mm|cm|m|in|ft|kg|t|lb|rpm|hp|kw|bar|psi|mpa|kpa|v|a|hz|km\/h|mph)\b|(?:\d+(?:[.,]\d+)?\s*(毫米|厘米|米|公斤|千克|吨|马力|千瓦|升|伏|安|转))/gi;
const INJECTION_RE = /\b(ignore|disregard|forget|override)\b.{0,80}\b(previous|above|system|developer|instruction|prompt|message|rules?)\b|\b(system|developer)\s+prompt\b|\bact\s+as\b|\bdo\s+not\s+(follow|obey)\b|\b(jailbreak|prompt\s+injection)\b|忽略.{0,40}(之前|以上|系统|开发者|指令|规则)|系统提示词|开发者消息|不要遵守/iu;

const now = () => new Date().toISOString();
const hashText = (s) => createHash('sha1').update(String(s)).digest('hex');
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

export function bundleSlug(subject) {
  const norm = String(subject).trim().toLowerCase().replace(/\s+/g, ' ');
  const stem = norm
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56);
  return `${stem || 'subject'}-${hashText(norm).slice(0, 8)}`;
}

export function defaultBundlePath(subject) {
  return join(BUNDLE_ROOT, bundleSlug(subject));
}

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8');
}

export function manifestPath(bundleDir) {
  return join(resolve(bundleDir), 'manifest.json');
}

export async function readManifest(bundleDir) {
  const path = manifestPath(bundleDir);
  const manifest = await readJson(path);
  if (!manifest) throw new Error(`bundle manifest not found: ${path}`);
  manifest.sources ??= [];
  return manifest;
}

async function saveManifest(bundleDir, manifest) {
  manifest.updatedAt = now();
  await writeJson(manifestPath(bundleDir), manifest);
}

function addWarning(entry, message) {
  entry.warnings ??= [];
  entry.warnings.push(message);
}

async function ensureBundleDirs(bundleDir) {
  await mkdir(bundleDir, { recursive: true });
  await mkdir(join(bundleDir, 'downloads'), { recursive: true });
  await mkdir(join(bundleDir, 'screenshots'), { recursive: true });
  await mkdir(join(bundleDir, 'selected'), { recursive: true });
}

function searchTerms(subject, archetype = null) {
  const base = [`"${subject}" dimensions`, `"${subject}" manual`, `"${subject}" cutaway`];
  if (archetype === 'vehicle') base.push(`"${subject}" blueprint`, `"${subject}" interior`);
  if (archetype === 'rotating-machine') base.push(`"${subject}" section drawing`, `"${subject}" parts diagram`);
  base.push(`"${subject}" pdf`, `"${subject}" exploded view`);
  return [...new Set(base)];
}

async function writeUrlRequest(bundleDir, manifest) {
  const body = `# Reference URLs needed - ${manifest.subject}

The material is not detailed enough for a fine 3D engineering sheet.

Add URLs with:

\`\`\`bash
b2d bundle add-url "${bundleDir}" "<url>" --role spec
b2d bundle add-url "${bundleDir}" "<url>" --role drawing
b2d bundle fetch "${bundleDir}"
\`\`\`

Useful roles: manual, drawing, photo, spec, cad.

Suggested searches:

${searchTerms(manifest.subject, manifest.archetype).map((s) => `- ${s}`).join('\n')}

Prefer manufacturer pages, manuals, datasheets, museum/archive pages, vector/CAD
drawings, and clear section or exploded views. Avoid using a photo unless it is
clearly the exact model or it only informs broad proportions.
`;
  await writeFile(join(bundleDir, 'request.md'), body, 'utf8');
}

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return parts.reduce((n, p) => ((n << 8) + p) >>> 0, 0);
}

function ipv4InRange(ip, base, bits) {
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(base);
  if (a == null || b == null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

function isBlockedIp(address) {
  const kind = isIP(address);
  if (kind === 4) {
    return [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.168.0.0', 16],
      ['224.0.0.0', 4],
    ].some(([base, bits]) => ipv4InRange(address, base, bits));
  }
  if (kind === 6) {
    const ip = address.toLowerCase();
    return ip === '::1' || ip === '::' || ip.startsWith('fc') || ip.startsWith('fd') ||
      ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb');
  }
  return false;
}

async function validateReferenceUrl(url, { allowUnsafeLocal = false } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid URL: ${url}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`unsupported URL protocol: ${parsed.protocol || '(none)'}`);
  }
  if (allowUnsafeLocal) return parsed;

  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error(`blocked local hostname: ${parsed.hostname}`);
  }
  if (isIP(host) && isBlockedIp(host)) {
    throw new Error(`blocked private or local IP: ${parsed.hostname}`);
  }

  let addresses;
  try {
    addresses = await lookup(parsed.hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new Error(`could not resolve URL host ${parsed.hostname}: ${err.message}`);
  }
  const blocked = addresses.find((a) => isBlockedIp(a.address));
  if (blocked) {
    throw new Error(`blocked private or local resolved IP for ${parsed.hostname}: ${blocked.address}`);
  }
  return parsed;
}

export async function initBundle(subject, { outDir = null, archetype = null } = {}) {
  if (!subject || !String(subject).trim()) throw new Error('bundle subject is empty');
  const bundleDir = resolve(outDir ?? defaultBundlePath(subject));
  await ensureBundleDirs(bundleDir);
  const path = manifestPath(bundleDir);
  const existing = await readJson(path);
  if (existing) return { bundleDir, manifest: existing, created: false };
  const manifest = {
    version: BUNDLE_VERSION,
    subject: String(subject),
    archetype: archetype ?? null,
    createdAt: now(),
    updatedAt: now(),
    evidencePolicy: 'Downloaded files are temporary authoring evidence only; final index.html must not link to these URLs or files.',
    sources: [],
    selected: [],
  };
  await saveManifest(bundleDir, manifest);
  await writeUrlRequest(bundleDir, manifest);
  return { bundleDir, manifest, created: true };
}

export async function addBundleUrl(bundleDir, url, { role = 'manual', title = null, allowUnsafeLocal = false } = {}) {
  if (!BUNDLE_ROLES.has(role)) throw new Error(`unknown role "${role}"`);
  const manifest = await readManifest(bundleDir);
  const parsed = await validateReferenceUrl(url, { allowUnsafeLocal });
  const href = parsed.href;
  const found = manifest.sources.find((s) => s.url === href);
  if (found) {
    found.role = role;
    if (title) found.title = title;
    found.updatedAt = now();
    await saveManifest(bundleDir, manifest);
    return { entry: found, added: false };
  }
  const entry = {
    id: hashText(href).slice(0, 12),
    url: href,
    role,
    title: title ?? '',
    status: 'pending',
    addedAt: now(),
    evidenceOnly: true,
    errors: [],
    warnings: [],
  };
  manifest.sources.push(entry);
  await saveManifest(bundleDir, manifest);
  return { entry, added: true };
}

function extFromUrl(url) {
  try {
    return extname(new URL(url).pathname).toLowerCase();
  } catch {
    return '';
  }
}

function classify(url, contentType = '') {
  const ct = String(contentType).toLowerCase();
  const ext = extFromUrl(url);
  if (ct.includes('pdf') || ext === '.pdf') return { kind: 'pdf', ext: '.pdf' };
  if (ct.includes('svg') || ext === '.svg') return { kind: 'vector', ext: '.svg' };
  if (ext === '.dxf') return { kind: 'vector', ext: '.dxf' };
  if (ct.startsWith('image/') || IMAGE_EXT.has(ext)) return { kind: 'image', ext: ext || imageExtFromType(ct) };
  if (ct.includes('html') || !ext) return { kind: 'html', ext: '.html' };
  if (TEXT_EXT.has(ext) || ct.startsWith('text/')) return { kind: 'text', ext: ext || '.txt' };
  return { kind: 'binary', ext: ext || '.bin' };
}

function imageExtFromType(ct) {
  if (ct.includes('png')) return '.png';
  if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg';
  if (ct.includes('webp')) return '.webp';
  if (ct.includes('gif')) return '.gif';
  return '.img';
}

async function fetchBuffer(url, {
  maxBytes = MAX_DOWNLOAD_BYTES,
  timeoutMs = 45000,
  allowUnsafeLocal = false,
  allowUnsafeRedirectLocal = allowUnsafeLocal,
} = {}) {
  let current = (await validateReferenceUrl(url, { allowUnsafeLocal })).href;
  const redirects = [];

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': 'b2d-reference-bundle/1.0 (+offline engineering sheet evidence)',
          accept: 'text/html,application/pdf,image/*,*/*;q=0.8',
        },
      });

      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        const next = new URL(res.headers.get('location'), current).href;
        redirects.push(next);
        current = (await validateReferenceUrl(next, { allowUnsafeLocal: allowUnsafeRedirectLocal })).href;
        continue;
      }

      const chunks = [];
      let total = 0;
      if (!res.body) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > maxBytes) throw new Error(`download exceeds ${maxBytes} bytes`);
        return { res, buffer: buf, finalUrl: current, redirects };
      }
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        total += buf.length;
        if (total > maxBytes) throw new Error(`download exceeds ${maxBytes} bytes`);
        chunks.push(buf);
      }
      return { res, buffer: Buffer.concat(chunks), finalUrl: current, redirects };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`too many redirects (${MAX_REDIRECTS})`);
}

function htmlTitle(html) {
  const m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim().slice(0, 160) : '';
}

function decodeEntities(text) {
  return String(text)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

function htmlToText(html) {
  return decodeEntities(String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function charsetFromContentType(contentType = '') {
  const m = String(contentType).match(/charset\s*=\s*["']?([^;"'\s]+)/i);
  return m ? m[1].trim().toLowerCase() : null;
}

function charsetFromMeta(buffer) {
  const head = buffer.slice(0, Math.min(buffer.length, 8192)).toString('latin1');
  const direct = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([^"'\s/>]+)/i);
  if (direct) return direct[1].trim().toLowerCase();
  const equiv = head.match(/<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]+content\s*=\s*["'][^"']*charset=([^"'\s;]+)/i);
  return equiv ? equiv[1].trim().toLowerCase() : null;
}

function normaliseEncoding(label) {
  const enc = String(label || '').toLowerCase().replace(/^x-/, '');
  if (enc === 'gb2312' || enc === 'gbk' || enc === 'cp936') return 'gb18030';
  if (enc === 'utf8') return 'utf-8';
  return enc || 'utf-8';
}

function decodeTextBuffer(buffer, { contentType = '', html = false } = {}, entry = null) {
  const candidates = [
    charsetFromContentType(contentType),
    html ? charsetFromMeta(buffer) : null,
    'utf-8',
  ].filter(Boolean).map(normaliseEncoding);
  const tried = new Set();
  for (const enc of candidates) {
    if (tried.has(enc)) continue;
    tried.add(enc);
    try {
      const text = new TextDecoder(enc, { fatal: false }).decode(buffer);
      if (entry && enc !== 'utf-8') addWarning(entry, `decoded text as ${enc}`);
      return text;
    } catch (err) {
      if (entry) addWarning(entry, `could not decode as ${enc}: ${err.message}`);
    }
  }
  if (entry) addWarning(entry, 'falling back to utf-8 replacement decoding');
  return buffer.toString('utf8');
}

function removeInstructionLikeText(text, entry = null) {
  const chunks = String(text)
    .split(/\n{2,}|(?<=[.!?。！？])\s+/u)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!chunks.length) return String(text);
  const kept = [];
  let dropped = 0;
  for (const chunk of chunks) {
    if (INJECTION_RE.test(chunk)) {
      dropped++;
      continue;
    }
    kept.push(chunk);
  }
  if (dropped && entry) addWarning(entry, `discarded ${dropped} instruction-like source excerpt(s)`);
  return kept.join('\n\n').trim();
}

async function tryPdfText(file) {
  try {
    const { stdout } = await run('pdftotext', ['-layout', file, '-'], { maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return '';
  }
}

async function browserExtractHtml(url, outFile, { allowUnsafeLocal = false } = {}) {
  const puppeteer = (await import('puppeteer')).default;
  const { CHROME_FLAGS } = await import('../../dev/shot.mjs');
  const browser = await puppeteer.launch({ headless: true, args: CHROME_FLAGS });
  const blocked = [];
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', async (req) => {
      const reqUrl = req.url();
      if (/^(data|blob|about):/i.test(reqUrl)) {
        req.continue();
        return;
      }
      try {
        await validateReferenceUrl(reqUrl, { allowUnsafeLocal });
        req.continue();
      } catch (err) {
        blocked.push(`${reqUrl}: ${err.message}`);
        req.abort();
      }
    });
    await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    const title = await page.title();
    const text = await page.evaluate(() => document.body?.innerText || '');
    if (outFile) await page.screenshot({ path: outFile, fullPage: true });
    return { title, text, blocked };
  } finally {
    await browser.close();
  }
}

async function processDownloaded(bundleDir, entry, file, buffer, kind, {
  contentType = '',
  sourceUrl = entry.url,
  screenshots = false,
  allowUnsafeLocal = false,
} = {}) {
  entry.bytes = buffer.length;
  entry.hash = createHash('sha256').update(buffer).digest('hex');
  entry.file = file;
  entry.evidenceOnly = true;

  if (kind === 'html') {
    const html = decodeTextBuffer(buffer, { contentType, html: true }, entry);
    entry.title ||= htmlTitle(html);
    let text = htmlToText(html);
    if (entry.role === 'manual' || entry.role === 'spec') {
      try {
        const shot = screenshots ? join(bundleDir, 'screenshots', `${entry.id}.png`) : null;
        const extracted = await browserExtractHtml(sourceUrl, shot, { allowUnsafeLocal });
        if (extracted.title) entry.title ||= extracted.title.slice(0, 160);
        if (extracted.text?.trim()) text = extracted.text.trim();
        if (shot) entry.screenshotFile = shot;
        if (extracted.blocked?.length) {
          addWarning(entry, `browser blocked ${extracted.blocked.length} unsafe request(s)`);
        }
      } catch (err) {
        addWarning(entry, `browser text extraction failed, used static html: ${err.message}`);
      }
    } else if (screenshots) {
      try {
        const shot = join(bundleDir, 'screenshots', `${entry.id}.png`);
        const extracted = await browserExtractHtml(sourceUrl, shot, { allowUnsafeLocal });
        if (extracted.title) entry.title ||= extracted.title.slice(0, 160);
        if (shot) entry.screenshotFile = shot;
        if (extracted.blocked?.length) {
          addWarning(entry, `browser blocked ${extracted.blocked.length} unsafe request(s)`);
        }
      } catch (err) {
        addWarning(entry, `screenshot failed: ${err.message}`);
      }
    }
    text = removeInstructionLikeText(text, entry).slice(0, 250000);
    if (text) {
      const textFile = join(bundleDir, 'downloads', `${entry.id}.txt`);
      await writeFile(textFile, text, 'utf8');
      entry.textFile = textFile;
    }
  } else if (kind === 'pdf') {
    const text = removeInstructionLikeText(await tryPdfText(file), entry);
    if (text) {
      const textFile = join(bundleDir, 'downloads', `${entry.id}.txt`);
      await writeFile(textFile, text.slice(0, 250000), 'utf8');
      entry.textFile = textFile;
    }
  } else if (kind === 'vector' && extname(file).toLowerCase() === '.svg') {
    const text = decodeTextBuffer(buffer, { contentType, html: true }, entry);
    entry.title ||= htmlTitle(text);
    try {
      const extracted = await extractVector(file);
      const vectorFile = join(bundleDir, 'downloads', `${entry.id}.vector.json`);
      await writeJson(vectorFile, extracted);
      entry.vectorFile = vectorFile;
      entry.vectorOutlines = extracted.outlines?.length ?? 0;
      entry.vectorTexts = extracted.texts?.length ?? 0;
    } catch (err) {
      entry.errors.push(`vector extraction failed: ${err.message}`);
    }
  } else if (kind === 'vector' && extname(file).toLowerCase() === '.dxf') {
    try {
      const extracted = await extractVector(file);
      const vectorFile = join(bundleDir, 'downloads', `${entry.id}.vector.json`);
      await writeJson(vectorFile, extracted);
      entry.vectorFile = vectorFile;
      entry.vectorOutlines = extracted.outlines?.length ?? 0;
      entry.vectorTexts = extracted.texts?.length ?? 0;
    } catch (err) {
      entry.errors.push(`vector extraction failed: ${err.message}`);
    }
  }
}

export async function fetchBundle(bundleDir, { screenshots = false, allowUnsafeLocal = false } = {}) {
  const manifest = await readManifest(bundleDir);
  await ensureBundleDirs(bundleDir);
  manifest.evidencePolicy ??= 'Downloaded files are temporary authoring evidence only; final index.html must not link to these URLs or files.';
  for (const entry of manifest.sources) {
    entry.errors ??= [];
    entry.warnings ??= [];
    try {
      const { res, buffer, finalUrl, redirects } = await fetchBuffer(entry.url, { allowUnsafeLocal });
      if (redirects?.length) entry.redirects = redirects;
      entry.finalUrl = finalUrl;
      entry.httpStatus = res.status;
      entry.contentType = res.headers.get('content-type') ?? '';
      if (!res.ok) {
        entry.status = 'failed';
        entry.errors.push(`HTTP ${res.status}`);
        continue;
      }
      const { kind, ext } = classify(finalUrl ?? entry.url, entry.contentType);
      entry.kind = kind;
      if (entry.role === 'photo' && kind !== 'image') addWarning(entry, `role photo fetched ${kind}, not an image`);
      if (entry.role === 'cad' && kind !== 'vector') addWarning(entry, `role cad fetched ${kind}, not a vector/CAD file`);
      if (entry.role === 'drawing' && !['image', 'vector', 'pdf'].includes(kind)) {
        addWarning(entry, `role drawing fetched ${kind}, not a drawing-like file`);
      }
      const file = join(bundleDir, 'downloads', `${entry.id}${ext}`);
      await writeFile(file, buffer);
      await processDownloaded(bundleDir, entry, file, buffer, kind, {
        contentType: entry.contentType,
        sourceUrl: finalUrl ?? entry.url,
        screenshots,
        allowUnsafeLocal,
      });
      entry.status = 'fetched';
      entry.fetchedAt = now();
    } catch (err) {
      entry.status = 'failed';
      entry.errors.push(err.message);
    }
  }
  await saveManifest(bundleDir, manifest);
  return manifest;
}

async function entryText(entry) {
  const parts = [entry.title, entry.url, entry.role, entry.kind];
  if (entry.textFile && existsSync(entry.textFile)) {
    parts.push((await readFile(entry.textFile, 'utf8')).slice(0, 80000));
  }
  return parts.filter(Boolean).join('\n').toLowerCase();
}

async function entrySnippetText(entry) {
  const parts = [entry.title, entry.url];
  if (entry.textFile && existsSync(entry.textFile)) {
    parts.push((await readFile(entry.textFile, 'utf8')).slice(0, 80000));
  }
  return parts.filter(Boolean).join('\n');
}

function sourceQuality(url) {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { points: 0, reason: 'bad-url' };
  }
  if (/\.(gov|mil|edu)$/.test(host)) return { points: 18, reason: 'institutional-domain' };
  if (/museum|archive|manual|datasheet|manufacturer|company|official/.test(host)) {
    return { points: 14, reason: 'strong-source-host' };
  }
  if (/wikipedia|wikimedia/.test(host)) return { points: 8, reason: 'reference-host' };
  if (/forum|reddit|pinterest|facebook|x\.com|twitter|blogspot/.test(host)) {
    return { points: -8, reason: 'low-control-source' };
  }
  return { points: 4, reason: 'ordinary-source' };
}

function countHits(text, words) {
  return words.filter((w) => text.includes(w.toLowerCase())).length;
}

function subjectHit(text, subject) {
  const s = String(subject ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!s) return 0;
  if (text.includes(s)) return 20;
  const tokens = s.split(/[^a-z0-9\p{L}\p{N}]+/u).filter((t) => t.length >= 3);
  if (!tokens.length) return 0;
  const hits = tokens.filter((t) => text.includes(t)).length;
  return Math.round(12 * hits / tokens.length);
}

export async function scoreBundle(bundleDir) {
  const manifest = await readManifest(bundleDir);
  for (const entry of manifest.sources) {
    const reasons = [];
    let score = 0;
    const text = await entryText(entry);

    const exact = subjectHit(text, manifest.subject);
    if (exact) { score += exact; reasons.push(`subject-match +${exact}`); }

    const roleScore = { cad: 22, drawing: 20, spec: 16, manual: 14, photo: 8 }[entry.role] ?? 5;
    score += roleScore;
    reasons.push(`${entry.role} +${roleScore}`);

    const kindScore = { vector: 24, pdf: 20, image: 14, html: 8, text: 8, binary: 0 }[entry.kind] ?? 0;
    score += kindScore;
    if (kindScore) reasons.push(`${entry.kind} +${kindScore}`);

    const drawingHits = countHits(text, DRAWING_WORDS);
    if (drawingHits) {
      const pts = clamp(drawingHits * 6, 0, 24);
      score += pts;
      reasons.push(`drawing-terms +${pts}`);
    }

    const internalHits = countHits(text, INTERNAL_WORDS);
    if (internalHits) {
      const pts = clamp(internalHits * 5, 0, 20);
      score += pts;
      reasons.push(`interior-terms +${pts}`);
    }

    const unitHits = [...text.matchAll(UNIT_RE)].length;
    if (unitHits) {
      const pts = clamp(unitHits * 2, 0, 20);
      score += pts;
      reasons.push(`figures +${pts}`);
    }

    if (entry.vectorOutlines) {
      const pts = clamp(entry.vectorOutlines, 0, 20);
      score += pts;
      reasons.push(`vector-outlines +${pts}`);
    }

    if (entry.bytes && entry.kind === 'image') {
      const pts = entry.bytes > 200000 ? 3 : entry.bytes > 50000 ? 1 : 0;
      score += pts;
      if (pts) reasons.push(`image-size +${pts}`);
    }

    const q = sourceQuality(entry.url);
    score += q.points;
    reasons.push(`${q.reason} ${q.points >= 0 ? '+' : ''}${q.points}`);

    if (entry.status !== 'fetched') {
      score = Math.min(score, 0);
      reasons.push('not-fetched');
    }

    entry.score = score;
    entry.scoreReasons = reasons;
  }
  await saveManifest(bundleDir, manifest);
  return manifest;
}

function selectedSourceFile(entry) {
  if (entry.kind === 'image' && entry.file) return entry.file;
  if (entry.kind === 'vector' && entry.file && extname(entry.file).toLowerCase() === '.svg') return entry.file;
  if (entry.screenshotFile) return entry.screenshotFile;
  if (entry.kind === 'pdf' && entry.file) return entry.file;
  return null;
}

function safeName(name) {
  return String(name || 'reference')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'reference';
}

function snippetsFromText(text, limit = 12) {
  const out = [];
  const clean = String(text).replace(/\s+/g, ' ').trim();
  for (const m of clean.matchAll(UNIT_RE)) {
    const i = Math.max(0, m.index - 120);
    const j = Math.min(clean.length, m.index + m[0].length + 160);
    const snippet = clean.slice(i, j).trim();
    if (INJECTION_RE.test(snippet)) continue;
    if (!out.includes(snippet)) out.push(snippet);
    if (out.length >= limit) break;
  }
  return out;
}

async function buildDossier(manifest, bundleDir) {
  const sources = manifest.sources
    .filter((s) => s.status === 'fetched')
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 12)
    .map((s) => ({ title: s.title || s.url, url: s.url }));

  const snippets = [];
  const snippetEntries = manifest.sources
    .filter((s) => s.status === 'fetched' && s.textFile)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 12);
  for (const entry of snippetEntries) {
    const text = await entrySnippetText(entry);
    snippets.push(...snippetsFromText(text, 4).map((snippet) => ({
      source: entry.title || entry.url,
      url: entry.url,
      text: snippet,
      trust: 'untrusted',
    })));
  }

  const selected = manifest.selected ?? [];
  return {
    trust: 'template',
    bundleSubject: manifest.subject,
    designation: '',
    summary: '',
    dimensions: null,
    subsystems: [],
    components: [],
    motions: [],
    specs: [],
    _fill: {
      designation: 'Read downloads/*.txt and selected/ to identify the exact subject/model, then fill this field.',
      dimensions: 'Fill only dimensions traceable to the downloaded evidence; leave unknown values absent.',
      subsystems: 'Fill engineering subsystem names after reviewing the selected evidence.',
      components: 'Fill external and internal component names with notes; mark internal parts with internal:true.',
      motions: 'Fill real motion channels/ranges only when supported by the evidence.',
      specs: 'Fill curated specification bullets; do not paste raw snippets here.',
    },
    sources,
    referenceImages: manifest.sources
      .filter((s) => s.kind === 'image' && s.status === 'fetched')
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 3)
      .map((s) => ({ url: s.url, caption: s.title || s.role })),
    localReferences: selected.map((s) => s.file),
    snippets: snippets.slice(0, 24),
    bundleDir,
  };
}

export async function selectBundle(bundleDir, { max = MAX_SELECTED } = {}) {
  let manifest = await readManifest(bundleDir);
  if (manifest.sources.some((s) => s.score == null)) manifest = await scoreBundle(bundleDir);
  const selectedDir = join(resolve(bundleDir), 'selected');
  await rm(selectedDir, { recursive: true, force: true });
  await mkdir(selectedDir, { recursive: true });

  const candidates = manifest.sources
    .filter((s) => s.status === 'fetched')
    .map((s) => ({ entry: s, file: selectedSourceFile(s) }))
    .filter((x) => x.file && existsSync(x.file))
    .sort((a, b) => (b.entry.score ?? 0) - (a.entry.score ?? 0));

  manifest.selected = [];
  for (const { entry, file } of candidates.slice(0, max)) {
    const ext = extname(file) || '.bin';
    const out = join(selectedDir, `${String(manifest.selected.length + 1).padStart(2, '0')}-${safeName(entry.title || entry.role)}${ext}`);
    await copyFile(file, out);
    manifest.selected.push({
      id: entry.id,
      url: entry.url,
      role: entry.role,
      kind: entry.kind,
      score: entry.score ?? 0,
      file: out,
    });
  }

  const dossier = await buildDossier(manifest, resolve(bundleDir));
  await writeJson(join(resolve(bundleDir), 'dossier.json'), dossier);
  await saveManifest(bundleDir, manifest);
  return { manifest, dossier };
}

export async function loadBundleForIngest(bundleDir) {
  const dir = resolve(bundleDir);
  const manifest = await readManifest(dir);
  let dossier = await readJson(join(dir, 'dossier.json'));
  if (!dossier) dossier = (await buildDossier(manifest, dir));

  const selected = manifest.selected?.length
    ? manifest.selected.map((s) => s.file)
    : [];
  const referenceFiles = selected
    .filter(Boolean)
    .filter((p) => existsSync(p))
    .filter((p) => IMAGE_EXT.has(extname(p).toLowerCase()) || extname(p).toLowerCase() === '.svg')
    .slice(0, MAX_SELECTED);

  return { manifest, dossier, referenceFiles, bundleDir: dir };
}

export async function bundleStatus(bundleDir) {
  const manifest = await readManifest(bundleDir);
  const fetched = manifest.sources.filter((s) => s.status === 'fetched').length;
  const failed = manifest.sources.filter((s) => s.status === 'failed').length;
  const selected = manifest.selected?.length ?? 0;
  let bytes = 0;
  for (const s of manifest.sources) {
    if (s.file && existsSync(s.file)) bytes += (await stat(s.file)).size;
  }
  return { subject: manifest.subject, sources: manifest.sources.length, fetched, failed, selected, bytes };
}

export async function pruneBundles({ root = BUNDLE_ROOT, olderThanDays = 30, dryRun = false } = {}) {
  const cutoff = Date.now() - Number(olderThanDays) * 24 * 60 * 60 * 1000;
  const removed = [];
  const kept = [];
  if (!existsSync(root)) return { root, olderThanDays: Number(olderThanDays), dryRun, removed, kept };
  for (const ent of await readdir(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const dir = join(root, ent.name);
    const manifest = await readJson(join(dir, 'manifest.json'));
    const stamp = Date.parse(manifest?.updatedAt ?? manifest?.createdAt ?? '');
    const ageHit = Number.isFinite(stamp) && stamp < cutoff;
    if (!ageHit) {
      kept.push(dir);
      continue;
    }
    removed.push(dir);
    if (!dryRun) await rm(dir, { recursive: true, force: true });
  }
  return { root, olderThanDays: Number(olderThanDays), dryRun, removed, kept };
}

export { createServer, validateReferenceUrl, fetchBuffer };
