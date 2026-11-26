import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
const { buildRadar, checksum } = createRequire(import.meta.url)('./dashboard/model.js');

function option(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const joined = args.find(arg => arg.startsWith(`${name}=`));
  if (joined) return joined.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  return value;
}

function publishFiles(source: string, output: string, matches: RegExp): number {
  const target = join(output, source);
  mkdirSync(target, { recursive: true });
  const files = readdirSync(join(root, source), { withFileTypes: true })
    .filter(file => file.isFile() && matches.test(file.name));
  for (const { name } of files) copyFileSync(join(root, source, name), join(target, name));
  return files.length;
}

function run() {
  const input = option('--input', '/input/snapshot.json');
  const snapshotPath = input.endsWith('.json') ? input : join(input, 'snapshot.json');
  const output = resolve(option('--output', process.env.MAKEFUN_OUTPUT_DIR || '/output'));
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  if (!Array.isArray(snapshot.protocols) || !Array.isArray(snapshot.watchlist) || !Number.isFinite(snapshot.floor_usd)) {
    throw new Error('Expected the sealed token radar snapshot');
  }
  const { board } = buildRadar(snapshot);
  const slugs = new Set(board.rows.map((row: { slug: string }) => row.slug));
  if (slugs.size !== board.rows.length || snapshot.watchlist.some((slug: string) => !slugs.has(slug))) {
    throw new Error('Ranked rows must be unique and cover the watchlist');
  }
  const source = join(root, 'dashboard');
  const sourceBytes = readdirSync(source).reduce((total, name) => total + statSync(join(source, name)).size, 0);
  if (sourceBytes >= 60_000) throw new Error(`Dashboard source is ${sourceBytes} bytes, expected fewer than 60000`);
  const fingerprint = checksum(board);
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'board.json'), `${JSON.stringify(board)}\n`);
  writeFileSync(join(output, 'data.js'), `globalThis.RADAR_DATA = ${JSON.stringify({ snapshot, board, fingerprint })};\n`);
  publishFiles('dashboard', output, /^[A-Za-z0-9_][\w.-]*\.(?:html|css|js)$/);
  const images = publishFiles('screenshots', output, /^[A-Za-z0-9_][\w.-]*\.(?:jpe?g|png)$/i);
  if (images !== 3) throw new Error(`Expected three captures, found ${images}`);
  const dossier = buildDossier(output, {
    text_max_bytes: 65_536, screenshots: { max: 3, max_bytes: 524_288 }, dashboard: { max_files: 400, max_bytes: 4_194_304 }
  });
  writeFileSync(join(output, 'dossier.json'), dossier);
  console.log(`Forward Window v4 | ${board.rows.length} ranked · ${fingerprint} · ${sourceBytes} source bytes · ${dossier.length} dossier bytes`);
}

try {
  run();
} catch (error) {
  console.error(`Forward Window v4: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
