import { describe, expect, it } from 'vitest';
import {
  MultipartParser,
  boundaryFromContentType,
  parseHeaders,
} from '../src/index.js';
import type { MimeEvent } from '../src/index.js';

it('parses header fields', () =>
  expect(parseHeaders('A: one\r\nB: two')).toHaveLength(2));

describe('boundaryFromContentType', () => {
  it('extracts a quoted boundary', () => {
    expect(
      boundaryFromContentType('multipart/mixed; boundary="abc 123"'),
    ).toBe('abc 123');
  });
  it('rejects non-multipart types', () => {
    expect(boundaryFromContentType('text/plain; boundary=x')).toBeNull();
  });
});

// ---- helpers -------------------------------------------------------------

function collect(parser: MultipartParser, chunks: string[]): MimeEvent[] {
  const out: MimeEvent[] = [];
  for (const c of chunks) out.push(...parser.feed(c));
  out.push(...parser.end());
  return out;
}

function bytesOf(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

const oneByte = (s: string): string[] => bytesOf(s, 1);
const twoByte = (s: string): string[] => bytesOf(s, 2);

// Every chunking of the message must produce exactly the same events.
function allChunkings(s: string): string[][] {
  const out: string[][] = [[s]];
  out.push(oneByte(s));
  out.push(twoByte(s));
  // fixed 3/5/7 and a pseudo-random irregular split
  for (const n of [3, 5, 7]) out.push(bytesOf(s, n));
  const irr: string[] = [];
  let i = 0;
  let seed = 7;
  while (i < s.length) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const n = 1 + (seed % 6);
    irr.push(s.slice(i, i + n));
    i += n;
  }
  out.push(irr);
  return out;
}

function leafData(events: MimeEvent[]): string[] {
  return events.filter((e) => e.type === 'data').map((e) => (e as any).data);
}

// Build a simple two-part multipart document.
function simpleDoc(b = 'BOUNDARY'): string {
  return (
    `preamble line\r\n--${b}\r\n` +
    'A: 1\r\n\r\n' +
    'hello\r\nworld' +
    `\r\n--${b}\r\n` +
    'B: 2\r\n\r\n' +
    'second part' +
    `\r\n--${b}--\r\nepilogue`
  );
}

// ---- invariant: chunking-independent output ------------------------------

describe('chunking independence', () => {
  it('byte-at-a-time and every split yield identical events', () => {
    const doc = simpleDoc();
    const ref = collect(new MultipartParser('BOUNDARY'), [doc]);
    for (const chunks of allChunkings(doc)) {
      const got = collect(new MultipartParser('BOUNDARY'), chunks);
      expect(got).toEqual(ref);
    }
    const events = ref;
    expect(leafData(events).join('')).toBe('hello\r\nworldsecond part');
    expect(events.filter((e) => e.type === 'partEnd')).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('boundary marker split across chunks at every possible offset', () => {
    const b = 'XYZ';
    const head = `--${b}\r\nA:1\r\n\r\n`;
    const tail = `\r\n--${b}--\r\n`;
    const body = 'payload'.repeat(3);
    const doc = head + body + tail;
    // split at each position inside the closing marker
    const markerStart = head.length + body.length;
    for (let cut = markerStart; cut < doc.length; cut++) {
      const parser = new MultipartParser(b);
      const ev = collect(parser, [doc.slice(0, cut), doc.slice(cut)]);
      expect(leafData(ev).join(''), `cut=${cut}`).toBe(body);
    }
  });

  it('keeps only a bounded suffix regardless of feed history', () => {
    const parser = new MultipartParser('B');
    const events = collect(parser, oneByte('x'.repeat(5000) + simpleDoc('B')));
    expect(leafData(events).join('')).toContain('hello\r\nworld');
    // KMP retention window: pattern("--B" = 3) + pad cap + small constant
    expect(parser.retainedBytes).toBeLessThan(300);
  });
});

// ---- self-overlapping boundary prefix ------------------------------------

describe('self-overlapping boundary prefix', () => {
  it('falls back via prefix function and never emits prefix bytes', () => {
    const b = 'b--b--b';
    const doc =
      `--${b}\r\n\r\n` +
      // prefix "--b--b" then a byte that must not complete the marker
      `--b--bX more body` +
      `\r\n--${b}--\r\n`;
    const events = collect(new MultipartParser(b), oneByte(doc));
    const body = leafData(events).join('');
    expect(body).toBe('--b--bX more body');
    expect(events.filter((e) => e.type === 'partEnd')).toHaveLength(1);
  });

  it('handles an overlapping boundary that resolves late', () => {
    const b = 'aaa';
    // "--aaa" occurrences overlapping in body text without line start
    const doc =
      `--${b}\r\n\r\n` +
      `\r--aaa--aaa--` + // leading "\r" only (no \n) => not a line start
      `\r\n--${b}--\r\n`;
    for (const chunks of allChunkings(doc)) {
      const events = collect(new MultipartParser(b), chunks);
      expect(leafData(events).join('')).toBe('\r--aaa--aaa--');
    }
  });
});

// ---- body pseudo-prefix must not truncate --------------------------------

describe('pseudo prefix inside body', () => {
  it('keeps bytes when only a boundary prefix appears', () => {
    const b = 'FRONTIER';
    const doc =
      `--${b}\r\n\r\n` +
      `\r\n--FRON\r\n` +
      `--FRONTIERY extra\r\n` +
      `\n--FRONTIER\r\n` + // bare LF: not a legal line start
      `\r--FRONTIER-X` + // lone CR before marker and bad terminator X
      `\r\n--${b}--\r\n`;
    const ref = collect(new MultipartParser(b), [doc]);
    for (const chunks of allChunkings(doc)) {
      expect(collect(new MultipartParser(b), chunks)).toEqual(ref);
    }
    const body = leafData(ref).join('');
    expect(body).toBe(
      '\r\n--FRON\r\n--FRONTIERY extra\r\n\n--FRONTIER\r\n\r--FRONTIER-X',
    );
  });

  it('requires CRLF line start even across chunk boundaries', () => {
    const b = 'B';
    const doc = `--${b}\r\n\r\nxx\r--${b}--\r\n`; // \r-- not CRLF--
    for (const chunks of allChunkings(doc)) {
      const events = collect(new MultipartParser(b), chunks);
      // No valid closing boundary: whole remainder is body until EOF.
      expect(events.filter((e) => e.type === 'partEnd')).toHaveLength(0);
      expect(leafData(events).join('')).toBe('xx\r--B--\r\n');
    }
  });
});

// ---- closing boundary -----------------------------------------------------

describe('closing boundary', () => {
  it('closes on -- with CRLF and ignores the epilogue', () => {
    const b = 'END';
    const doc =
      `--${b}\r\n\r\nbody1\r\n--${b}\r\n\r\nbody2` +
      `\r\n--${b}--\r\nepilogue ignored\r\n--${b}\r\njunk`;
    const events = collect(new MultipartParser(b), oneByte(doc));
    expect(leafData(events).join('')).toBe('body1body2');
    expect(events.filter((e) => e.type === 'partEnd')).toHaveLength(2);
  });

  it('accepts close delimiter at EOF without trailing CRLF', () => {
    const b = 'END';
    const doc = `--${b}\r\n\r\nbody\r\n--${b}--`;
    for (const chunks of allChunkings(doc)) {
      const events = collect(new MultipartParser(b), chunks);
      expect(leafData(events).join('')).toBe('body');
      expect(events.some((e) => e.type === 'partEnd')).toBe(true);
    }
  });

  it('rejects a close marker missing dashes', () => {
    const b = 'END';
    const doc = `--${b}\r\n\r\nbody\r\n--${b}-\r\nmore\r\n--${b}--\r\n`;
    for (const chunks of allChunkings(doc)) {
      const events = collect(new MultipartParser(b), chunks);
      expect(leafData(events).join('')).toBe('body\r\n--END-\r\nmore');
    }
  });
});

// ---- trailing whitespace / transport padding -----------------------------

describe('trailing whitespace after delimiter', () => {
  it('accepts spaces and tabs before CRLF on open and close', () => {
    const b = 'P';
    const doc =
      `--${b} \t \r\nA:1\r\n\r\none` +
      `\r\n--${b}--  \t \r\nafter`;
    for (const chunks of allChunkings(doc)) {
      const events = collect(new MultipartParser(b), chunks);
      expect(leafData(events).join('')).toBe('one');
      expect(events.filter((e) => e.type === 'partEnd')).toHaveLength(1);
    }
  });

  it('does not treat whitespace without CRLF as a delimiter', () => {
    const b = 'P';
    const doc = `--${b}\r\n\r\nx\r\n--${b}--  z\r\nend\r\n--${b}--\r\n`;
    const events = collect(new MultipartParser(b), oneByte(doc));
    expect(leafData(events).join('')).toBe('x\r\n--P--  z\r\nend');
  });
});

// ---- missing CRLF ---------------------------------------------------------

describe('missing CRLF', () => {
  it('bare LF before the marker is not a legal boundary', () => {
    const b = 'M';
    const doc = `--${b}\r\n\r\nbody\n--${b}\r\n\r\nnext\r\n--${b}--\r\n`;
    for (const chunks of allChunkings(doc)) {
      const events = collect(new MultipartParser(b), chunks);
      // The "\n--M" pseudo-boundary is never legal, so the second opening
      // delimiter is swallowed as body; only the close delimiter commits.
      expect(leafData(events).join('')).toBe('body\n--M\r\n\r\nnext');
      expect(events.filter((e) => e.type === 'partEnd')).toHaveLength(1);
      // No bytes lost: the stream still terminates cleanly.
      expect(events.at(-1)).toEqual({ type: 'done' });
    }
  });

  it('open marker lacking CRLF terminator stays body', () => {
    const b = 'M';
    const doc = `--${b}\r\n\r\nkeep\r\n--${b}Xtail\r\n--${b}--\r\n`;
    const events = collect(new MultipartParser(b), oneByte(doc));
    expect(leafData(events).join('')).toBe('keep\r\n--MXtail');
  });
});

// ---- nested boundaries sharing a prefix -----------------------------------

describe('nested multipart with shared boundary prefix', () => {
  const outer = 'frame-001';
  const inner = 'frame-001-child';
  const doc =
    `--${outer}\r\n` +
    'Content-Type: multipart/mixed; boundary="' + inner + '"\r\n\r\n' +
    `--${inner}\r\n\r\ninner-one` +
    `\r\n--${inner}\r\n\r\ninner-two` +
    `\r\n--${inner}--\r\n` +
    `\r\n--${outer}\r\n\r\nouter-second` +
    `\r\n--${outer}--\r\n`;

  it('innermost boundary wins, outer prefix is inert', () => {
    const ref = collect(new MultipartParser(outer), [doc]);
    for (const chunks of allChunkings(doc)) {
      expect(collect(new MultipartParser(outer), chunks)).toEqual(ref);
    }
    const data = leafData(ref).join('');
    expect(data).toBe('inner-oneinner-twoouter-second');
  });

  it('emits events in correct open/close nesting order', () => {
    const ev = collect(new MultipartParser(outer), oneByte(doc));
    const types = ev.map((e) =>
      e.type === 'partStart' ? (e.container ? 'openC' : 'openL') : e.type,
    );
    expect(types).toEqual([
      'openC',
      'openL',
      'data',
      'partEnd',
      'openL',
      'data',
      'partEnd',
      'partEnd',
      'openL',
      'data',
      'partEnd',
      'done',
    ]);
  });

  it('an outer-looking marker inside the inner body is not a boundary', () => {
    // "--frame-001" alone (not followed by "-child") is ordinary body while
    // the inner part is active.
    const d =
      `--${outer}\r\n` +
      'Content-Type: multipart/mixed; boundary="' + inner + '"\r\n\r\n' +
      `--${inner}\r\n\r\n` +
      `\r\n--${outer}\r\ntail` +
      `\r\n--${inner}--\r\n` +
      `\r\n--${outer}--\r\n`;
    for (const chunks of allChunkings(d)) {
      const events = collect(new MultipartParser(outer), chunks);
      expect(leafData(events).join('')).toBe(
        `\r\n--${outer}\r\ntail`,
      );
    }
  });
});

// ---- linearity ------------------------------------------------------------

describe('scanning work', () => {
  it('pattern comparisons grow linearly, not quadratically', () => {
    const b = 'aaaaaaaaaa';
    const adversarial = ('a'.repeat(9) + 'b').repeat(2000);
    const doc =
      `--${b}\r\n\r\n` + adversarial + `\r\n--${b}--\r\n`;
    const p1 = new MultipartParser(b);
    collect(p1, [doc]);
    const c1 = p1.comparisons;

    const doc2 =
      `--${b}\r\n\r\n` +
      ('a'.repeat(9) + 'b').repeat(8000) +
      `\r\n--${b}--\r\n`;
    const p2 = new MultipartParser(b);
    collect(p2, [doc2]);
    const c2 = p2.comparisons;

    const ratio = c2 / c1;
    expect(ratio).toBeGreaterThan(2);
    expect(ratio).toBeLessThan(6); // 4x input, linear work -> ~4x compares
  });

  it('byte-at-a-time feeds do not accumulate historical chunks', () => {
    const b = 'KEEP';
    const parser = new MultipartParser(b);
    let maxRetained = 0;
    const ev: MimeEvent[] = [];
    for (const c of oneByte('junk '.repeat(300) + simpleDoc(b))) {
      ev.push(...parser.feed(c));
      maxRetained = Math.max(maxRetained, parser.retainedBytes);
    }
    ev.push(...parser.end());
    expect(leafData(ev).join('')).toContain('hello\r\nworld');
    expect(maxRetained).toBeLessThan(350);
  });
});
