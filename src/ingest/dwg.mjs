/**
 * DWG -> DXF, via whatever converter is on the machine.
 *
 * DWG is the format real drawings actually arrive in — a design institute hands
 * you a .dwg, not a .dxf — and it is closed binary that `dxf-parser` cannot
 * touch. Rather than tell the user "unsupported" and lose the one input that
 * carries TRUE coordinates, shell out to a converter and carry on down the
 * vector path.
 *
 * No converter is bundled. DWG's format is proprietary and every tool that
 * reads it is either a large third-party install or a reverse-engineered
 * library with its own licence; vendoring one into a plugin that otherwise needs
 * nothing but `npm install` would be a bad trade. So this locates one and says
 * exactly what to install when it cannot.
 *
 * Supported, in the order they are tried:
 *
 *   B2D_DWG_CONVERTER   an explicit path, for anything unusual
 *   ODAFileConverter    Open Design Alliance, free, the reference implementation
 *   dwg2dxf             LibreDWG, open source
 *
 * The conversion is a temp file, never written next to the user's drawing: the
 * source folder is theirs, and a build should not leave artefacts in it.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, copyFile, readdir, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';

const run = promisify(execFile);

/**
 * DXF flavour to emit. `dxf-parser` reads the entities this pipeline cares
 * about (LWPOLYLINE, POLYLINE, CIRCLE, TEXT, MTEXT) from any version, so the
 * choice is about avoiding newer object types it would skip rather than about
 * capability. 2013 is old enough to be plain and new enough to be universal.
 */
const OUT_VERSION = process.env.B2D_DWG_OUTVER ?? 'ACAD2013';

const CONVERT_TIMEOUT_MS = Number(process.env.B2D_DWG_TIMEOUT_MS ?? 180000);

/** Where ODA's installer puts things on Windows; the version is in the folder name. */
function odaInstallPaths() {
  const roots = [
    process.env['ProgramFiles'] && join(process.env['ProgramFiles'], 'ODA'),
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'ODA'),
  ].filter(Boolean);

  const out = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries = [];
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const exe = join(root, e.name, 'ODAFileConverter.exe');
      if (existsSync(exe)) out.push(exe);
    }
  }
  // Newest install last in readdir order is not guaranteed, so prefer the
  // lexically greatest folder — version numbers sort correctly here in practice.
  return out.sort().reverse();
}

async function onPath(cmd) {
  try {
    await run(process.platform === 'win32' ? 'where' : 'which', [cmd]);
    return true;
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<{kind: 'oda'|'libredwg', path: string}|null>}
 */
export async function findConverter() {
  const explicit = process.env.B2D_DWG_CONVERTER;
  if (explicit && existsSync(explicit)) {
    const kind = /dwg2dxf/i.test(basename(explicit)) ? 'libredwg' : 'oda';
    return { kind, path: explicit };
  }

  if (await onPath('ODAFileConverter')) return { kind: 'oda', path: 'ODAFileConverter' };
  const [installed] = odaInstallPaths();
  if (installed) return { kind: 'oda', path: installed };

  if (await onPath('dwg2dxf')) return { kind: 'libredwg', path: 'dwg2dxf' };
  return null;
}

export const CONVERTER_HINT =
  'no DWG converter found. Install the free ODA File Converter from ' +
  'https://www.opendesign.com/guestfiles/oda_file_converter (it lands in ' +
  '"C:\\Program Files\\ODA\\ODAFileConverter <version>\\" and is picked up ' +
  'automatically), or LibreDWG\'s dwg2dxf, or point B2D_DWG_CONVERTER at one.';

/**
 * Convert a .dwg into a .dxf in a temp directory.
 *
 * The caller owns the returned `cleanup` — the DXF has to outlive this call,
 * because `extractVector` reads it afterwards.
 *
 * @param {string} dwgPath
 * @param {{verbose?: boolean}} opts
 * @returns {Promise<{dxfPath: string, cleanup: () => Promise<void>, converter: string}>}
 */
export async function dwgToDxf(dwgPath, { verbose = false } = {}) {
  if (!existsSync(dwgPath)) throw new Error(`no such file: ${dwgPath}`);

  const converter = await findConverter();
  if (!converter) throw new Error(CONVERTER_HINT);

  const work = await mkdtemp(join(tmpdir(), 'b2d-dwg-'));
  const cleanup = () => rm(work, { recursive: true, force: true }).catch(() => {});

  try {
    if (converter.kind === 'libredwg') {
      const out = join(work, `${basename(dwgPath, extname(dwgPath))}.dxf`);
      if (verbose) process.stderr.write(`  dwg: dwg2dxf ${basename(dwgPath)}\n`);
      await run(converter.path, ['-o', out, dwgPath], { timeout: CONVERT_TIMEOUT_MS });
      if (!existsSync(out)) throw new Error('dwg2dxf produced no output');
      return { dxfPath: out, cleanup, converter: 'dwg2dxf' };
    }

    // ODA File Converter works on DIRECTORIES, not files, and will happily
    // convert every drawing it finds. Give it a folder containing exactly one
    // copy of the input so a folder full of the user's other drawings is never
    // swept up by a build.
    const inDir = join(work, 'in');
    const outDir = join(work, 'out');
    await rm(inDir, { recursive: true, force: true });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(inDir, { recursive: true });
    await mkdir(outDir, { recursive: true });

    const staged = join(inDir, basename(dwgPath));
    await copyFile(dwgPath, staged);

    if (verbose) {
      process.stderr.write(`  dwg: ODAFileConverter -> ${OUT_VERSION} DXF (${basename(dwgPath)})\n`);
    }

    // <in> <out> <outVer> <outType> <recurse> <audit> [filter]
    await run(converter.path,
      [inDir, outDir, OUT_VERSION, 'DXF', '0', '1', '*.DWG'],
      { timeout: CONVERT_TIMEOUT_MS, windowsHide: true });

    const produced = (await readdir(outDir)).filter((f) => f.toLowerCase().endsWith('.dxf'));
    if (!produced.length) {
      throw new Error(
        'ODAFileConverter produced no DXF. The drawing may be password-protected, ' +
        'corrupt, or a version this converter build does not read.');
    }
    return { dxfPath: join(outDir, produced[0]), cleanup, converter: 'ODAFileConverter' };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
