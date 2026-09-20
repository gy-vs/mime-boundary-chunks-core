# MIME stream core

Streaming `multipart/*` parser with a KMP boundary scanner.

- A boundary is committed **only** when the full `--boundary` marker matches at
  a legal line beginning **and** its terminator is valid (`CRLF`, or `--` plus
  optional whitespace then `CRLF`). Pseudo-prefixes and bad terminators inside
  the body never truncate it.
- Across chunks only a bounded suffix (`len(boundary)` plus a small constant) is
  retained; the KMP prefix function carries partial matches, so history is never
  concatenated or rescanned. Total work is linear in the number of input bytes.
- Nested multipart parts (via a `multipart/...; boundary=...` Content-Type) are
  followed automatically. While a child part is active, only the innermost
  boundary can commit, so nested boundaries that share a prefix are handled
  correctly.

## Usage

```ts
import {MultipartParser} from './src/index.js';

const parser = new MultipartParser('FRAME');
for (const chunk of stream) {
  for (const ev of parser.feed(chunk)) {
    // partStart {headers, container}
    // data      {data}
    // partEnd
  }
}
for (const ev of parser.end()) /* ... includes 'done' */;
```

Run `npm install`, then `npm test` and `npm run build`.
