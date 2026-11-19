# @mizchi/litestream

Database-independent offline synchronization and LTX support, combining a MoonBit JS core with TypeScript hosts. SQLike, SQLite WASM and Turso engines are not dependencies. ESM for Node.js 24+ and current browsers.

```sh
pnpm add @mizchi/litestream@0.2.0
```

```js
import { encodeFrame, decodeFrame } from '@mizchi/litestream/protocol';

const bytes = encodeFrame({
  kind: 1, base: 0,
  opId: crypto.randomUUID(),
  payload: new TextEncoder().encode('[]'),
});
console.log(decodeFrame(bytes).opId);
```

The root entry exports `SyncEngine`, `OfflineClient`, HTTP/peer/LTX transports, IndexedDB replica storage, Session codecs and apply-policy types. Database drivers implement the `Database` contract and preserve value types and transaction atomicity. Session capture and materialized apply are optional capabilities; support differs between drivers.

## LTX

```js
import { encodeLtx, applyLtx } from '@mizchi/litestream/ltx';

const { data: file } = encodeLtx(new Uint8Array(), sqliteImage, '1', '1');
const { data: restored } = applyLtx(new Uint8Array(), '0', file, 3);
```

Inputs must be valid SQLite images. TXIDs and timestamps use strings to preserve precision. `planLtx()` checks catalog continuity. `/ltx/core` supports engine injection. `/engine` exposes the low-level MoonBit JS ABI; `/node` provides `NodeDatabase` using Node's built-in SQLite. `/wasm/litestream.wasm` is the low-level Wasm GC core, with a base64 ABI for bytes.

The included `SyncEngine`/`OfflineClient` initialization still creates the demonstration `notes` schema. This is not a universal arbitrary-schema or driver-compatibility claim. Applications supply authentication, authorization and domain-specific conflict policies.

For durable AOT page checkpoints, the repository also demonstrates atomic IndexedDB storage of logical state and an LTX outbox, retry/ACK handling and checkpoint deferral when the outbox is full. Database/page providers remain replaceable.

[Repository](https://github.com/mizchi/sqlike) · [Synchronization and conflict handling](https://github.com/mizchi/sqlike/blob/main/docs/sync.md) · [Incremental page integration](https://github.com/mizchi/sqlike/blob/main/docs/incremental-pager.md). MIT.
