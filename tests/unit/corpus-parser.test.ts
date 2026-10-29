import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAX_CORPUS_BYTES,
  MAX_MESSAGE_LENGTH,
  MAX_MESSAGE_LINES,
  parseCorpusBytes,
  parseCorpusText,
  type CorpusParseResult,
} from '../../src/core/corpus-parser';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));
const utf8 = (text: string) => new TextEncoder().encode(text);

function expectOk(result: CorpusParseResult) {
  if (!result.ok) throw new Error(`Expected success, got: ${JSON.stringify(result.errors)}`);
  return result;
}

function expectErrors(result: CorpusParseResult) {
  if (result.ok) throw new Error(`Expected errors, got: ${JSON.stringify(result.messages)}`);
  return result.errors;
}

describe('parseCorpusBytes: basic format', () => {
  it('reads three English lines as three challenges', () => {
    const result = expectOk(parseCorpusBytes(fixture('three-lines.txt')));
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]).toBe('I am just checking one thing. That is what I said last time.');
  });

  it('handles a BOM, CRLF, lone CR, LF, blank lines and a trailing newline', () => {
    const result = expectOk(parseCorpusBytes(fixture('bom-mixed-newlines.txt')));
    expect(result.messages).toEqual(['First line.', 'Second line.', 'Third line.']);
  });

  it('removes only one leading BOM', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, ...utf8('Text.')]);
    const errors = expectErrors(parseCorpusBytes(bytes));
    expect(errors[0]?.message).toBe('Line 1: unsupported character U+FEFF (byte order mark) at column 1.');
  });

  it('keeps several sentences on one line as a single challenge', () => {
    const result = expectOk(parseCorpusText('One. Two. Three.\n'));
    expect(result.messages).toEqual(['One. Two. Three.']);
  });

  it('treats lines starting with # and the two characters \\n as normal text', () => {
    const result = expectOk(parseCorpusText('# not a comment\nA literal \\n stays.\nQuotes "a,b" and \\ stay.'));
    expect(result.messages).toEqual(['# not a comment', 'A literal \\n stays.', 'Quotes "a,b" and \\ stay.']);
  });

  it('accepts short messages without a minimum word count', () => {
    expect(expectOk(parseCorpusText('No.')).messages).toEqual(['No.']);
  });
});

describe('parseCorpusText: whitespace', () => {
  it('trims and collapses spaces and tabs, ignoring blank lines', () => {
    const result = expectOk(parseCorpusText('  Too   many \t spaces.  \n\n\t\n   \nTab\tinside.'));
    expect(result.messages).toEqual(['Too many spaces.', 'Tab inside.']);
  });

  it('turns no-break and ideographic spaces into regular spaces', () => {
    const result = expectOk(parseCorpusText('A B　　C '));
    expect(result.messages).toEqual(['A B C']);
  });

  it('drops lines that become empty after conversion', () => {
    const result = expectOk(parseCorpusText(' 　\nReal line.'));
    expect(result.messages).toEqual(['Real line.']);
  });
});

describe('parseCorpusText: typographic characters', () => {
  it('converts curly quotes, dashes and the ellipsis', () => {
    const result = expectOk(
      parseCorpusText('‘It’s’ “fine”… a–b—c\nPlain line.'),
    );
    expect(result.messages).toEqual([`'It's' "fine"... a-b-c`, 'Plain line.']);
    expect(result.stats.convertedLines).toBe(1);
  });

  it('does not apply wider Unicode compatibility mappings', () => {
    const errors = expectErrors(parseCorpusText('Full！width'));
    expect(errors[0]?.message).toBe('Line 1: unsupported character "！" (U+FF01) at column 5.');
  });
});

describe('parseCorpusText: duplicates', () => {
  it('removes duplicates after normalization and keeps the first occurrence order', () => {
    const result = expectOk(parseCorpusText('B line.\nA line.\nB  line.\n“Q”\n"Q"'));
    expect(result.messages).toEqual(['B line.', 'A line.', '"Q"']);
    expect(result.stats.duplicatesRemoved).toBe(2);
    expect(result.stats.lineCount).toBe(5);
  });

  it('keeps messages that differ only by letter case', () => {
    const result = expectOk(parseCorpusText('Hello there.\nhello there.'));
    expect(result.messages).toHaveLength(2);
    expect(result.stats.duplicatesRemoved).toBe(0);
  });
});

describe('parseCorpusText: unsupported characters', () => {
  it('rejects zero-width spaces with the original line number', () => {
    const errors = expectErrors(parseCorpusBytes(fixture('zero-width-space.txt')));
    expect(errors).toEqual([
      { line: 3, message: 'Line 3: unsupported character U+200B (zero-width space) at column 6.' },
    ]);
  });

  it('rejects emoji, Japanese and accented letters', () => {
    const errors = expectErrors(parseCorpusText('Fine.\nSmile \u{1F600}\nあい\nCafé'));
    expect(errors.map((e) => e.message)).toEqual([
      'Line 2: unsupported character "\u{1F600}" (U+1F600) at column 7.',
      'Line 3: unsupported character "あ" (U+3042) at column 1.',
      'Line 4: unsupported character "é" (U+00E9) at column 4.',
    ]);
  });

  it('reports line numbers counted before blank lines are removed', () => {
    const errors = expectErrors(parseCorpusText('\n\nOK.\r\n\r\n\rBadé'));
    expect(errors[0]?.line).toBe(6);
  });

  it('rejects control characters and a BOM in the middle of the file', () => {
    const errors = expectErrors(parseCorpusText('Bell\u0007.\nMid﻿file.'));
    expect(errors.map((e) => e.message)).toEqual([
      'Line 1: unsupported character U+0007 (control character) at column 5.',
      'Line 2: unsupported character U+FEFF (byte order mark) at column 4.',
    ]);
  });

  it('does not import the valid lines of a file that has invalid ones', () => {
    const result = parseCorpusText('Good one.\nBad​one.\nGood two.');
    expect(result.ok).toBe(false);
    expect('messages' in result).toBe(false);
  });

  it('caps the number of reported problems', () => {
    const text = Array.from({ length: 80 }, (_, i) => `Bad ${i} é`).join('\n');
    const errors = expectErrors(parseCorpusText(text));
    expect(errors).toHaveLength(51);
    expect(errors.at(-1)?.message).toBe('…and 30 more problem lines.');
  });
});

describe('parseCorpusBytes: invalid UTF-8', () => {
  it('rejects invalid bytes instead of replacing them, with the line number', () => {
    const errors = expectErrors(parseCorpusBytes(fixture('invalid-utf8.txt')));
    expect(errors).toEqual([
      {
        line: 3,
        message: 'Line 3: invalid UTF-8 byte 0xFF at byte 28. Save the file as UTF-8 and try again.',
      },
    ]);
  });

  it('rejects truncated sequences, overlong forms and encoded surrogates', () => {
    for (const bad of [[0xe3, 0x81], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80]]) {
      const errors = expectErrors(parseCorpusBytes(new Uint8Array([...utf8('Hi\r\n'), ...bad])));
      expect(errors[0]?.line).toBe(2);
    }
  });

  it('counts CRLF as a single line break when locating invalid bytes', () => {
    const errors = expectErrors(parseCorpusBytes(new Uint8Array([...utf8('a\r\nb\rc\nd '), 0x80])));
    expect(errors[0]?.line).toBe(4);
  });
});

describe('limits', () => {
  it('accepts a file of exactly 1 MiB and rejects one byte more', () => {
    const line = 'x'.repeat(1023) + '\n';
    const exact = line.repeat(MAX_CORPUS_BYTES / 1024);
    expect(utf8(exact).length).toBe(MAX_CORPUS_BYTES);
    // Every line is identical, so de-duplication keeps a single message.
    expect(expectOk(parseCorpusText(exact)).messages).toHaveLength(1);

    const errors = expectErrors(parseCorpusBytes(utf8(exact + 'y')));
    expect(errors[0]?.message).toBe('The file is 1,048,577 bytes; the limit is 1 MiB (1,048,576 bytes).');
    expect(expectErrors(parseCorpusText(exact + 'y'))[0]?.line).toBeNull();
  });

  it('accepts 2,000 characters per line and rejects 2,001 after normalization', () => {
    expect(expectOk(parseCorpusText('a'.repeat(MAX_MESSAGE_LENGTH))).messages[0]).toHaveLength(2000);
    // Surrounding whitespace is trimmed before measuring.
    expect(expectOk(parseCorpusText(`   ${'a'.repeat(MAX_MESSAGE_LENGTH)}  `)).messages).toHaveLength(1);
    // The ellipsis expands to three characters before measuring.
    const errors = expectErrors(parseCorpusText('a'.repeat(MAX_MESSAGE_LENGTH - 2) + '…'));
    expect(errors[0]?.message).toBe(
      'Line 1: the sentence is too long (2,001 characters after normalization; the limit is 2,000).',
    );
  });

  it('allows 5,000 non-empty lines (counting duplicates) and rejects 5,001', () => {
    const lines = (count: number) => Array.from({ length: count }, (_, i) => `Line ${i % 10}.`).join('\n\n');
    const ok = expectOk(parseCorpusText(lines(MAX_MESSAGE_LINES)));
    expect(ok.messages).toHaveLength(10);
    expect(ok.stats.duplicatesRemoved).toBe(MAX_MESSAGE_LINES - 10);

    const errors = expectErrors(parseCorpusText(lines(MAX_MESSAGE_LINES + 1)));
    expect(errors[0]).toEqual({ line: null, message: 'The file has 5,001 non-empty lines; the limit is 5,000.' });
  });

  it('rejects a file without any sentences', () => {
    for (const text of ['', '\n\n', ' \t \r\n ', '﻿']) {
      const errors = expectErrors(parseCorpusText(text));
      expect(errors[0]?.message).toBe('The file has no sentences. Add at least one non-empty line.');
    }
  });
});
