/**
 * Parser for the plain-text message file: one line = one challenge.
 *
 * The same pure functions are used for the bundled messages.en.txt (at build
 * time and at runtime) and for files imported from the options page.
 */

export const MAX_CORPUS_BYTES = 1_048_576;
export const MAX_MESSAGE_LENGTH = 2_000;
export const MAX_MESSAGE_LINES = 5_000;
const MAX_REPORTED_ERRORS = 50;

export interface CorpusError {
  /** 1-based line number in the original file, or null for file-level errors. */
  line: number | null;
  message: string;
}

export interface CorpusParseStats {
  /** Non-empty lines after normalization, before de-duplication. */
  lineCount: number;
  duplicatesRemoved: number;
  /** Kept lines in which typographic characters were converted to ASCII. */
  convertedLines: number;
}

export type CorpusParseResult =
  | { ok: true; messages: string[]; stats: CorpusParseStats }
  | { ok: false; errors: CorpusError[] };

/** The only characters that are rewritten automatically. */
const TYPOGRAPHY: Readonly<Record<string, string>> = {
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '…': '...',
  '–': '-',
  '—': '-',
  ' ': ' ',
  '　': ' ',
};
const TYPOGRAPHY_PATTERN = /[‘’“”…–— 　]/g;

const CHARACTER_NAMES: Readonly<Record<number, string>> = {
  0x00: 'null character',
  0x0b: 'vertical tab',
  0x0c: 'form feed',
  0x7f: 'delete control character',
  0x85: 'next line control character',
  0xad: 'soft hyphen',
  0x2002: 'en space',
  0x2003: 'em space',
  0x2009: 'thin space',
  0x200a: 'hair space',
  0x200b: 'zero-width space',
  0x200c: 'zero-width non-joiner',
  0x200d: 'zero-width joiner',
  0x200e: 'left-to-right mark',
  0x200f: 'right-to-left mark',
  0x2028: 'line separator',
  0x2029: 'paragraph separator',
  0x202f: 'narrow no-break space',
  0x2060: 'word joiner',
  0xfeff: 'byte order mark',
  0xfffd: 'replacement character',
};

/** Validates and normalizes raw file bytes. */
export function parseCorpusBytes(bytes: Uint8Array): CorpusParseResult {
  if (bytes.length > MAX_CORPUS_BYTES) {
    return { ok: false, errors: [sizeError(bytes.length)] };
  }
  const decoded = decodeUtf8Strict(bytes);
  if (!decoded.ok) {
    return { ok: false, errors: [decoded.error] };
  }
  return parseDecoded(decoded.text);
}

/**
 * Validates and normalizes text that was already decoded strictly as UTF-8
 * (for example by the options page before it hands the file to the
 * background worker). A leading BOM, if still present, is removed here.
 */
export function parseCorpusText(text: string): CorpusParseResult {
  const byteLength = new TextEncoder().encode(text).length;
  if (byteLength > MAX_CORPUS_BYTES) {
    return { ok: false, errors: [sizeError(byteLength)] };
  }
  return parseDecoded(text);
}

/**
 * Decodes UTF-8 without hiding invalid bytes behind U+FFFD. The BOM is kept
 * so that callers see exactly what the file contains.
 */
export function decodeUtf8Strict(
  bytes: Uint8Array,
): { ok: true; text: string } | { ok: false; error: CorpusError } {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return { ok: true, text };
  } catch {
    const offset = findInvalidUtf8Offset(bytes);
    if (offset < 0) {
      return { ok: false, error: { line: null, message: 'The file is not valid UTF-8.' } };
    }
    const line = lineNumberAtByte(bytes, offset);
    const byte = bytes[offset] ?? 0;
    return {
      ok: false,
      error: {
        line,
        message:
          `Line ${line}: invalid UTF-8 byte 0x${byte.toString(16).toUpperCase().padStart(2, '0')} ` +
          `at byte ${formatNumber(offset + 1)}. Save the file as UTF-8 and try again.`,
      },
    };
  }
}

function parseDecoded(text: string): CorpusParseResult {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rawLines = body.split(/\r\n|\r|\n/);

  const errors: CorpusError[] = [];
  let problemCount = 0;
  const report = (line: number, message: string) => {
    problemCount += 1;
    if (errors.length < MAX_REPORTED_ERRORS) errors.push({ line, message });
  };

  const kept: string[] = [];
  let nonEmptyLines = 0;
  let convertedLines = 0;

  rawLines.forEach((raw, index) => {
    const lineNumber = index + 1;
    const converted = raw.replace(TYPOGRAPHY_PATTERN, (ch) => TYPOGRAPHY[ch] ?? ch);
    const normalized = converted.replace(/[ \t]+/g, ' ').replace(/^ /, '').replace(/ $/, '');
    if (normalized === '') return;
    nonEmptyLines += 1;

    const unsupported = findUnsupportedCharacter(raw);
    if (unsupported) {
      report(
        lineNumber,
        `Line ${lineNumber}: unsupported character ${describeCharacter(unsupported.codePoint)} ` +
          `at column ${unsupported.column}.`,
      );
      return;
    }
    if (normalized.length > MAX_MESSAGE_LENGTH) {
      report(
        lineNumber,
        `Line ${lineNumber}: the sentence is too long (${formatNumber(normalized.length)} characters ` +
          `after normalization; the limit is ${formatNumber(MAX_MESSAGE_LENGTH)}).`,
      );
      return;
    }
    if (converted !== raw) convertedLines += 1;
    kept.push(normalized);
  });

  if (problemCount > errors.length) {
    errors.push({
      line: null,
      message: `…and ${formatNumber(problemCount - errors.length)} more problem lines.`,
    });
  }
  if (nonEmptyLines > MAX_MESSAGE_LINES) {
    errors.unshift({
      line: null,
      message:
        `The file has ${formatNumber(nonEmptyLines)} non-empty lines; ` +
        `the limit is ${formatNumber(MAX_MESSAGE_LINES)}.`,
    });
  }
  if (errors.length > 0) return { ok: false, errors };

  const messages = [...new Set(kept)];
  if (messages.length === 0) {
    return {
      ok: false,
      errors: [{ line: null, message: 'The file has no sentences. Add at least one non-empty line.' }],
    };
  }

  return {
    ok: true,
    messages,
    stats: {
      lineCount: kept.length,
      duplicatesRemoved: kept.length - messages.length,
      convertedLines,
    },
  };
}

/**
 * Finds the first character that would remain outside U+0020..U+007E after
 * normalization. Normalization only rewrites tabs and the TYPOGRAPHY table,
 * so checking the raw line gives the same verdict plus the original column.
 */
function findUnsupportedCharacter(raw: string): { codePoint: number; column: number } | null {
  let column = 0;
  for (const ch of raw) {
    column += 1;
    const codePoint = ch.codePointAt(0) ?? 0;
    if (codePoint >= 0x20 && codePoint <= 0x7e) continue;
    if (codePoint === 0x09 || ch in TYPOGRAPHY) continue;
    return { codePoint, column };
  }
  return null;
}

/** "U+200B (zero-width space)" for invisible characters, '"é" (U+00E9)' otherwise. */
export function describeCharacter(codePoint: number): string {
  const label = `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
  const name = CHARACTER_NAMES[codePoint];
  if (name) return `${label} (${name})`;
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) {
    return `${label} (control character)`;
  }
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
    return `${label} (unpaired surrogate)`;
  }
  return `"${String.fromCodePoint(codePoint)}" (${label})`;
}

/** Returns the offset of the first byte of an invalid UTF-8 sequence, or -1. */
export function findInvalidUtf8Offset(bytes: Uint8Array): number {
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i]!;
    if (b0 <= 0x7f) {
      i += 1;
      continue;
    }
    let length: number;
    let min2 = 0x80;
    let max2 = 0xbf;
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      length = 2;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      length = 3;
      if (b0 === 0xe0) min2 = 0xa0;
      if (b0 === 0xed) max2 = 0x9f;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      length = 4;
      if (b0 === 0xf0) min2 = 0x90;
      if (b0 === 0xf4) max2 = 0x8f;
    } else {
      return i;
    }
    if (i + length > bytes.length) return i;
    const b1 = bytes[i + 1]!;
    if (b1 < min2 || b1 > max2) return i;
    for (let k = 2; k < length; k += 1) {
      const b = bytes[i + k]!;
      if (b < 0x80 || b > 0xbf) return i;
    }
    i += length;
  }
  return -1;
}

/** 1-based line number containing the byte at `offset` (CRLF, CR and LF are line breaks). */
function lineNumberAtByte(bytes: Uint8Array, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i += 1) {
    const b = bytes[i];
    if (b === 0x0a) {
      line += 1;
    } else if (b === 0x0d) {
      line += 1;
      if (bytes[i + 1] === 0x0a && i + 1 < offset) i += 1;
    }
  }
  return line;
}

function sizeError(byteLength: number): CorpusError {
  return {
    line: null,
    message:
      `The file is ${formatNumber(byteLength)} bytes; ` +
      `the limit is 1 MiB (${formatNumber(MAX_CORPUS_BYTES)} bytes).`,
  };
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}
