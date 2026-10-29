/**
 * Fails if anything that is (or would be) pushed contains local machine
 * details: home directory paths, temporary directory paths, or e-mail
 * addresses other than no-reply and documentation placeholders.
 *
 *   npm run check:privacy
 *
 * Checks the contents and names of tracked and staged files, plus the
 * author, committer and message of every commit on the current branch.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const RULES: { name: string; pattern: RegExp }[] = [
  { name: 'home directory path', pattern: /(?:\/Users|\/home)\/(?!<)[A-Za-z0-9._-]+/g },
  { name: 'Windows profile path', pattern: /[A-Za-z]:\\+Users\\+(?!<)[A-Za-z0-9._-]+/gi },
  { name: 'temporary directory path', pattern: /\/(?:private\/)?(?:var\/folders|tmp\/claude)[^\s'"`)]*/g },
  { name: 'e-mail address', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
];

/** Addresses that are fine to publish. */
const ALLOWED_EMAIL = /(?:@users\.noreply\.github\.com|^noreply@anthropic\.com|@(?:[a-z0-9-]+\.)*example\.(?:com|org|net))$/i;

const BINARY = /\.(?:png|jpe?g|gif|ico|webp|woff2?|ttf|zip)$/i;

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function findings(text: string): string[] {
  const found: string[] = [];
  for (const { name, pattern } of RULES) {
    for (const match of text.matchAll(pattern)) {
      if (name === 'e-mail address' && ALLOWED_EMAIL.test(match[0])) continue;
      found.push(`${name}: ${match[0]}`);
    }
  }
  return found;
}

const problems: string[] = [];
const files = new Set([...git('ls-files', '-z').split('\0'), ...git('diff', '--cached', '--name-only', '-z').split('\0')]);
for (const file of files) {
  if (!file) continue;
  for (const finding of findings(file)) problems.push(`${file} (file name): ${finding}`);
  if (BINARY.test(file)) continue;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // deleted in the working tree
  }
  text.split('\n').forEach((line, index) => {
    for (const finding of findings(line)) problems.push(`${file}:${index + 1}: ${finding}`);
  });
}

const hasCommits = (() => {
  try {
    git('rev-parse', '--verify', 'HEAD');
    return true;
  } catch {
    return false;
  }
})();
if (hasCommits) {
  const log = git('log', '--format=%h%x00%an <%ae>%x00%cn <%ce>%x00%B%x1e');
  for (const entry of log.split('\x1e')) {
    const [hash, author, committer, message] = entry.trim().split('\0');
    if (!hash) continue;
    for (const finding of findings([author, committer, message].join('\n'))) problems.push(`commit ${hash}: ${finding}`);
  }
}

if (problems.length > 0) {
  console.error('Possible personal or machine-specific data found:');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`No personal paths or e-mail addresses found in ${files.size} files${hasCommits ? ' and commit metadata' : ''}.`);
