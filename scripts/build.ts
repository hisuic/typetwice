/**
 * Builds the unpacked extension into dist/.
 *
 *   npm run build
 *
 * The bundled message file is validated with the same parser the extension
 * uses, and the build fails instead of shipping an invalid file.
 */
import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseCorpusBytes } from '../src/core/corpus-parser';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const DIST = 'dist';
const MESSAGES = 'public/messages.en.txt';
const STATIC_FILES: Record<string, string> = {
  'src/gate/gate.html': 'gate.html',
  'src/gate/gate.css': 'gate.css',
  'src/popup/popup.html': 'popup.html',
  'src/popup/popup.css': 'popup.css',
  'src/options/options.html': 'options.html',
  'src/options/options.css': 'options.css',
  [MESSAGES]: 'messages.en.txt',
  'public/icons': 'icons',
};

async function main(): Promise<void> {
  const parsed = parseCorpusBytes(new Uint8Array(await readFile(MESSAGES)));
  if (!parsed.ok) {
    console.error(`${MESSAGES} is not valid:`);
    for (const error of parsed.errors) console.error(`  ${error.message}`);
    process.exit(1);
  }

  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  await build({
    entryPoints: {
      background: 'src/background/index.ts',
      content: 'src/content/index.ts',
      gate: 'src/gate/index.ts',
      popup: 'src/popup/index.ts',
      options: 'src/options/index.ts',
    },
    outdir: DIST,
    bundle: true,
    // Content scripts and the classic service worker cannot be ES modules here.
    format: 'iife',
    platform: 'browser',
    target: 'chrome116',
    charset: 'utf8',
    legalComments: 'none',
    sourcemap: false,
    minify: false,
    logLevel: 'warning',
  });

  const pkg = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };
  const manifest = JSON.parse(await readFile('manifest.json', 'utf8')) as Record<string, unknown>;
  manifest.version = pkg.version;
  await writeFile(`${DIST}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);

  for (const [from, to] of Object.entries(STATIC_FILES)) {
    await cp(from, `${DIST}/${to}`, { recursive: true });
  }

  const { duplicatesRemoved } = parsed.stats;
  console.log(
    `Built TypeTwice ${pkg.version} into ${DIST}/ with ${parsed.messages.length} bundled sentences` +
      (duplicatesRemoved > 0 ? ` (${duplicatesRemoved} duplicates removed).` : '.'),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
