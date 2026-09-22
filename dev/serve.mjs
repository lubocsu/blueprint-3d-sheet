/**
 * Minimal static server for the dev harness and built pages.
 * Serves the repo root; `?dir=` is not supported on purpose — one root, no surprises.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT ?? 5178);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/dev/hatch-lab.html';
    const path = join(ROOT, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!path.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }

    const s = await stat(path).catch(() => null);
    if (!s || s.isDirectory()) { res.writeHead(404).end('not found'); return; }

    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    }).end(body);
  } catch (err) {
    res.writeHead(500).end(String(err));
  }
});

/*
   Several sessions work on this repository at once, each in its own worktree,
   and they all reach for the same default port. Whoever gets there second used
   to die on an unhandled `EADDRINUSE` stack trace — and the confusing part is
   what happens next: the URL still WORKS, because the first server is still
   answering it, from a different worktree. You then spend a while wondering why
   your new file 404s and your changes are not in the page.
*/
server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error([
    `port ${PORT} is already in use.`,
    '',
    'Another session is probably serving a different worktree on it. That server will',
    'answer your requests with ITS files, so pages load, your new files 404, and your',
    'changes are simply missing from the page.',
    '',
    `  node bin/b2d.mjs serve --port ${PORT + 1}`,
    '',
  ].join('\n'));
  process.exit(1);
});

server.listen(PORT, () => console.log(`serving ${ROOT} on http://localhost:${PORT}`));
