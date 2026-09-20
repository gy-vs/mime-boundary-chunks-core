// Streaming multipart/MIME parser.
//
// Boundary scanning is done with a KMP automaton (prefix-function fallback).
// A boundary is committed only when ALL of the following hold:
//   1. the full delimiter body "--" + boundary has matched,
//   2. the match starts at a legal line beginning (stream start for the very
//      first delimiter, otherwise immediately after CRLF),
//   3. the terminator is valid: CRLF, or "--" followed by optional WSP and
//      CRLF (at EOF a closing delimiter is accepted without the final CRLF).
//
// Across chunks only a bounded suffix is retained physically; the KMP state
// itself carries every partial prefix, so history is never rescanned. When
// several multipart levels are active, outer automata are frozen while an
// inner level is on top of the stack, so the innermost legal boundary always
// wins (important when nested boundaries share a prefix).

export interface Header {
  name: string;
  value: string;
}

export type MimeEvent =
  | { type: 'partStart'; headers: Header[]; container: boolean }
  | { type: 'data'; data: string }
  | { type: 'partEnd' }
  | { type: 'done' };

export function parseHeaders(input: string): Header[] {
  const out: Record<string, string> = {};
  for (const line of input.split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at > 0) out[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
  }
  return Object.entries(out).map(([name, value]) => ({ name, value }));
}

/** Extract the boundary parameter from a multipart Content-Type value. */
export function boundaryFromContentType(contentType: string): string | null {
  if (!/multipart\//i.test(contentType)) return null;
  const m = /;\s*boundary\s*=\s*("(?:[^"\\]|\\.)*"|[^;]+)/i.exec(contentType);
  if (!m) return null;
  let v = m[1].trim();
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  return v.length ? v : null;
}

function prefixFunction(p: string): number[] {
  const pi = new Array<number>(p.length).fill(0);
  for (let i = 1; i < p.length; i++) {
    let k = pi[i - 1];
    while (k > 0 && p[k] !== p[i]) k = pi[k - 1];
    if (p[k] === p[i]) k++;
    pi[i] = k;
  }
  return pi;
}

// Terminator sub-state after the delimiter body has fully matched.
type TermState = 'open' | 'dash1' | 'close' | 'pad' | 'lf';

interface Candidate {
  start: number; // absolute index of the first byte of "--"
  close: boolean;
  state: TermState;
  pad: number; // trailing WSP bytes consumed
}

type Phase = 'preamble' | 'headers' | 'body' | 'epilogue';

interface Frame {
  pat: string; // "--" + boundary
  pi: number[];
  kmp: number; // current KMP match length
  cand: Candidate | null;
  started: boolean; // first (opening) delimiter already seen
  phase: Phase;
  leaf: boolean; // current part is a leaf (its body is emitted as data)
  root: boolean;
}

// Routing run: every input byte belongs to exactly one run.
//   h -> header bytes (accumulated while the top part reads its header block)
//   d -> body bytes of a leaf part (emitted as data)
//   x -> framing / preamble / epilogue / container body (discarded)
type Kind = 'h' | 'd' | 'x';
interface Run {
  from: number;
  to: number;
  kind: Kind;
  leaf: boolean;
}

const INF = Number.POSITIVE_INFINITY;
const MAX_PAD = 256; // cap transport-padding so a candidate cannot grow unbounded

/**
 * Streaming parser for one multipart document. Nested multipart parts are
 * followed automatically when their Content-Type carries a boundary.
 *
 * `feed()` returns the events produced by the chunk; `end()` flushes the
 * stream and returns the final events (including `done`).
 */
export class MultipartParser {
  #frames: Frame[] = [];
  #events: MimeEvent[] = [];

  // Physical storage: a rope of chunk strings, never compacted by copying.
  // Whole nodes are dropped once both routing and scanning are done with them.
  #rope: { s: string; start: number }[] = [];
  #frontier = 0; // absolute index one past the last buffered byte
  #routed = 0; // absolute index one past the last routed byte
  #hint = 0; // rope node hint for #charAt (queried positions are monotonic)
  #rhint = 0; // rope node hint for #slice (routing positions are monotonic)

  #runs: Run[] = [{ from: 0, to: INF, kind: 'x', leaf: false }];
  #headerAcc = '';

  // Header-block FSM: detects CRLF CRLF strictly (bare LF does not count).
  #hcr = false;
  #hcrlf = 0; // 1 after one completed CRLF, else 0

  #comparisons = 0; // KMP pattern comparisons (linearity observability)

  constructor(boundary: string) {
    if (!boundary) throw new Error('boundary required');
    this.#frames.push(this.#frame(boundary, true));
  }

  #frame(boundary: string, root: boolean): Frame {
    const pat = '--' + boundary;
    return {
      pat,
      pi: prefixFunction(pat),
      kmp: 0,
      cand: null,
      started: false,
      phase: 'preamble',
      leaf: false,
      root,
    };
  }

  /** Number of pattern comparisons performed; grows linearly with input. */
  get comparisons(): number {
    return this.#comparisons;
  }

  /** Bytes physically retained (bounded suffix, independent of total input). */
  get retainedBytes(): number {
    let n = 0;
    for (const c of this.#rope) n += c.s.length;
    return n;
  }

  feed(chunk: string): MimeEvent[] {
    this.#events = [];
    if (chunk.length) {
      const start = this.#frontier;
      this.#rope.push({ s: chunk, start });
      const end = start + chunk.length;

      // Walker over the newly appended bytes. The frontier advances as bytes
      // are consumed so in-scan releases (header end, boundary commits) see
      // the bytes just scanned.
      let ni = this.#rope.length - 1;
      let node = this.#rope[ni];
      let off = 0;
      for (let i = start; i < end; i++) {
        const c = node.s[off++];
        this.#frontier = i + 1;
        this.#step(c, i);
        if (off === node.s.length && i + 1 < end) {
          ni++;
          off = 0;
          node = this.#rope[ni];
        }
      }
      this.#frontier = end;
      this.#release(this.#floor(end));
    }
    return this.#events;
  }

  end(): MimeEvent[] {
    this.#events = [];
    const f = this.#top();
    // Lenient EOF: a fully formed closing delimiter without the trailing CRLF.
    if (f && f.cand && f.started && f.cand.state === 'close') {
      this.#commit(f, this.#frontier - 1);
    }
    for (const fr of this.#frames) fr.cand = null;
    this.#release(this.#frontier);
    this.#events.push({ type: 'done' });
    return this.#events;
  }

  #top(): Frame | undefined {
    return this.#frames[this.#frames.length - 1];
  }

  #ret(): number {
    // KMP needs at most m-1 past bytes, line-start validation 2 more, and a
    // live candidate may additionally carry up to MAX_PAD padding bytes.
    return this.#top()!.pat.length + MAX_PAD + 4;
  }

  // Process one byte at absolute index i.
  #step(c: string, i: number): void {
    const f = this.#top()!;

    // Header FSM runs first; the terminating LF is header data and is never
    // fed to the boundary automaton.
    if (f.phase === 'headers') {
      if (this.#headerByte(f, c, i)) return;
    }

    if (f.phase === 'epilogue') return;

    // Boundary automaton and terminator validation run in PARALLEL on the
    // same byte: KMP is advanced for every input byte regardless of whether a
    // candidate is live, so a failed candidate never needs replay and a
    // boundary starting inside a rejected terminator is still found.
    const terminating = f.cand ? this.#termByte(f, c) : null;
    this.#kmpByte(f, c, i);
    if (terminating === 'commit') {
      this.#commit(f, i); // clears candidate/KMP and switches phase/frame
    }
  }

  // Returns true when this byte completed (and was consumed by) the header block.
  #headerByte(f: Frame, c: string, i: number): boolean {
    if (this.#hcr) {
      this.#hcr = false;
      if (c === '\n') {
        if (this.#hcrlf === 1) {
          this.#endHeaders(f, i);
          return true;
        }
        this.#hcrlf = 1;
      } else {
        this.#hcrlf = 0;
      }
    } else if (c === '\r') {
      this.#hcr = true;
    } else {
      this.#hcrlf = 0;
    }
    return false;
  }

  #endHeaders(f: Frame, i: number): void {
    // Flush all header bytes (routing is otherwise batched at feed end).
    this.#release(i + 1);
    const raw = this.#headerAcc.slice(0, -4);
    this.#headerAcc = '';
    const headers = parseHeaders(raw);
    const childBoundary = findMultipartBoundary(headers);
    const leaf = childBoundary === null;
    f.leaf = leaf;
    // Emit partStart BEFORE any body byte is routed, so data events can never
    // overtake their own partStart even in a single big feed() call.
    this.#events.push({ type: 'partStart', headers, container: !leaf });

    // A new part begins at a line beginning; stale match state cannot apply.
    f.kmp = 0;
    f.cand = null;
    if (childBoundary !== null) {
      // Container: the child's own preamble routing covers the boundary.
      const child = this.#frame(childBoundary, false);
      this.#frames.push(child);
      this.#switchRun(i + 1, 'x', false); // child preamble starts here
    } else {
      f.phase = 'body';
      this.#switchRun(i + 1, 'd', leaf);
    }
  }

  #kmpByte(f: Frame, c: string, i: number): void {
    const pat = f.pat;
    const m = pat.length;
    let k = f.kmp;
    while (k > 0 && pat[k] !== c) {
      this.#comparisons++;
      k = f.pi[k - 1];
    }
    this.#comparisons++;
    if (pat[k] === c) k++;

    if (k === m) {
      const start = i - m + 1;
      // Allow overlap matches (self-overlapping boundaries): keep scanning.
      k = f.pi[m - 1];
      const legalStart =
        !f.started ||
        (start >= 2 &&
          this.#charAt(start - 2) === '\r' &&
          this.#charAt(start - 1) === '\n');
      if (legalStart) {
        // Latest legal full match wins. An earlier candidate that could still
        // commit would have committed already; a candidate alive at this point
        // overlaps the new match and cannot produce a valid terminator.
        f.cand = {
          start,
          close: false,
          state: 'open',
          pad: 0,
        };
      }
    }
    f.kmp = k;
  }

  // Validates the terminator byte after a live candidate's pattern body.
  // Returns 'commit' when the candidate is fully confirmed, 'alive' while the
  // terminator is still pending, or 'dead' when the candidate is rejected.
  #termByte(f: Frame, c: string): 'commit' | 'alive' | 'dead' {
    const cand = f.cand!;
    const wsp = c === ' ' || c === '\t';
    const fail = (): 'dead' => {
      f.cand = null;
      return 'dead';
    };
    switch (cand.state) {
      case 'open':
        if (c === '-') cand.state = 'dash1';
        else if (wsp) cand.state = 'pad';
        else if (c === '\r') cand.state = 'lf';
        else return fail();
        return 'alive';
      case 'dash1':
        if (c !== '-') return fail();
        cand.state = 'close';
        cand.close = true;
        return 'alive';
      case 'close':
        if (wsp) {
          if (++cand.pad > MAX_PAD) return fail();
        } else if (c === '\r') cand.state = 'lf';
        else return fail();
        return 'alive';
      case 'pad':
        if (wsp) {
          if (++cand.pad > MAX_PAD) return fail();
        } else if (c === '\r') cand.state = 'lf';
        else return fail();
        return 'alive';
      case 'lf':
        if (c === '\n') return 'commit';
        return fail();
    }
  }

  // Commit the live candidate whose terminator ends at index i.
  #commit(f: Frame, i: number): void {
    const cand = f.cand!;
    const s = cand.start;
    const bodyEnd = f.started ? s - 2 : s; // strip the CRLF before a body boundary
    this.#release(bodyEnd);

    // Framing bytes (preceding CRLF, delimiter body, dashes/padding, CRLF).
    this.#switchRun(bodyEnd, 'x', false);
    f.cand = null;

    if (!f.started) {
      // Opening delimiter after the preamble: first part starts.
      f.started = true;
      this.#startHeaders(f, i + 1); // header run begins right after the CRLF
      return;
    }

    // Any boundary terminates the current part.
    this.#events.push({ type: 'partEnd' });

    if (cand.close) {
      if (f.root) {
        f.phase = 'epilogue';
      } else {
        // Inner multipart finished: pop to the parent part, which resumes its
        // body at the line beginning right after the closing CRLF. The parent
        // automaton was frozen throughout the child's lifetime; restart it.
        this.#frames.pop();
        const parent = this.#top()!;
        parent.phase = 'body';
        parent.kmp = 0;
        parent.cand = null;
      }
    }
    // After the framing run, resume headers (sibling) or the parent body.
    this.#switchRun(i + 1, 'x', false);
    if (!cand.close) this.#startHeaders(f, i + 1);
  }

  #startHeaders(f: Frame, at: number): void {
    f.phase = 'headers';
    this.#hcr = false;
    // The delimiter line already supplied one CRLF; the header block ends on
    // the next blank line (another CRLF). With hcrlf=1, an empty header block
    // "\r\n" terminates immediately, while a real header line resets it.
    this.#hcrlf = 1;
    this.#switchRun(at, 'h', false);
  }

  // Routing: release every byte with absolute index < to, in run order.
  #release(to: number): void {
    to = Math.min(to, this.#frontier);
    while (this.#runs.length && this.#runs[0].from < to) {
      const r = this.#runs[0];
      const e = Math.min(to, r.to);
      if (e > r.from) {
        const piece = this.#slice(r.from, e);
        if (r.kind === 'h') {
          this.#headerAcc += piece;
        } else if (r.kind === 'd' && r.leaf && piece.length) {
          this.#events.push({ type: 'data', data: piece });
        }
      }
      r.from = e;
      if (r.from === r.to) this.#runs.shift();
      else break;
    }
    this.#routed = Math.max(this.#routed, to);

    // Physical retention: drop whole chunk nodes that routing and scanning
    // are both done with. No suffix copying, so total work stays linear.
    const keep = Math.min(this.#routed, this.#frontier - this.#ret());
    while (this.#rope.length) {
      const n0 = this.#rope[0];
      if (n0.start + n0.s.length > keep) break;
      this.#rope.shift();
      if (this.#hint > 0) this.#hint--;
      if (this.#rhint > 0) this.#rhint--;
    }
  }

  #floor(end: number): number {
    let lim = end - this.#ret();
    const f = this.#top()!;
    if (f.cand) lim = Math.min(lim, f.started ? f.cand.start - 2 : f.cand.start);
    return Math.max(0, lim);
  }

  #switchRun(at: number, kind: Kind, leaf: boolean): void {
    const last = this.#runs[this.#runs.length - 1];
    if (last.from >= at) {
      // The previous run never materialized (zero length); replace it in
      // place instead of stacking an empty run that would swallow bytes.
      last.kind = kind;
      last.leaf = leaf;
      last.to = INF;
      return;
    }
    last.to = at;
    this.#runs.push({ from: at, to: INF, kind, leaf });
  }

  #charAt(abs: number): string {
    let idx = this.#hint;
    while (idx < this.#rope.length - 1 && this.#rope[idx].start + this.#rope[idx].s.length <= abs) idx++;
    while (idx > 0 && abs < this.#rope[idx].start) idx--;
    this.#hint = idx;
    return this.#rope[idx].s[abs - this.#rope[idx].start];
  }

  #slice(from: number, to: number): string {
    if (from >= to) return '';
    let idx = this.#rhint;
    while (idx < this.#rope.length && this.#rope[idx].start + this.#rope[idx].s.length <= from) idx++;
    this.#rhint = idx;
    const parts: string[] = [];
    let pos = from;
    while (pos < to) {
      const n = this.#rope[idx];
      const lo = Math.max(0, pos - n.start);
      const hi = Math.min(n.s.length, to - n.start);
      parts.push(lo === 0 && hi === n.s.length ? n.s : n.s.slice(lo, hi));
      pos = n.start + hi;
      idx++;
    }
    this.#rhint = idx - 1;
    return parts.length === 1 ? parts[0] : parts.join('');
  }
}

function findMultipartBoundary(headers: Header[]): string | null {
  for (const h of headers) {
    if (h.name === 'content-type') {
      const b = boundaryFromContentType(h.value);
      if (b !== null) return b;
    }
  }
  return null;
}
