/**
 * Headless screenshot helper.
 *
 *   node dev/shot.mjs <url> <out.png> [--w 1600] [--h 950] [--wait 900]
 *                     [--click "#sel"] [--eval "js"] [--dpr 2]
 *
 * WebGL under headless Chrome runs on SwiftShader, so the flags matter: without
 * them the canvas comes back blank and you spend an hour blaming the shader.
 */

import puppeteer from 'puppeteer';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

export const CHROME_FLAGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--enable-webgl',
  '--ignore-gpu-blocklist',
  '--disable-gpu-sandbox',
  '--no-sandbox',
  '--allow-file-access-from-files',
  '--font-render-hinting=none',
];

export async function shoot({ url, out, w = 1600, h = 950, wait = 900, click, evalJs, dpr = 2, browser: shared }) {
  const browser = shared ?? await puppeteer.launch({ headless: true, args: CHROME_FLAGS });
  const page = await browser.newPage();
  const errors = [];
  const noise = /favicon|net::ERR_FILE_NOT_FOUND.*favicon/i;
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // a missing favicon is not a rendering failure
    if (noise.test(text) || (text.includes('404') && !text.includes('.js'))) return;
    errors.push(text);
  });

  await page.setViewport({ width: Number(w), height: Number(h), deviceScaleFactor: Number(dpr) });
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
  if (click) { await page.waitForSelector(click, { timeout: 10000 }); await page.click(click); }
  if (evalJs) await page.evaluate(evalJs);
  await new Promise((r) => setTimeout(r, Number(wait)));
  await page.screenshot({ path: out });
  await page.close();
  if (!shared) await browser.close();
  return errors;
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedDirectly) {
  const url = args[0];
  const out = args[1];
  if (!url || !out) {
    console.error('usage: node dev/shot.mjs <url> <out.png> [--w N] [--h N] [--wait ms] [--click sel] [--eval js] [--dpr N]');
    process.exit(1);
  }
  const errors = await shoot({
    url, out,
    w: flag('w', 1600), h: flag('h', 950), wait: flag('wait', 900),
    click: flag('click'), evalJs: flag('eval'), dpr: flag('dpr', 2),
  });
  if (errors.length) {
    console.error('page errors:');
    for (const e of errors) console.error('  ', e);
    process.exit(2);
  }
  console.log('wrote', out);
}
