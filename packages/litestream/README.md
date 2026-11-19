# mizchi/litestream

Database-independent SQLite synchronization and LTX support for MoonBit. Supports JS and Wasm GC without depending on SQLike, SQLite or Turso engines.

```sh
moon add mizchi/litestream@0.2.0
```

Import `"mizchi/litestream"` from `moon.pkg` and use the `@litestream` APIs:

- Generate/apply LTX v3 files and validate TXIDs and checksums.
- Decode SQLite Session changesets and plan their SQL application.
- Encode/decode transport frames and evaluate revision/apply decisions.
- Use LZ4 and CRC64 helpers.

LTX APIs accept SQLite images independently of the driver producing them. Applications supply the driver capabilities needed for Session or LTX synchronization.

The `@mizchi/litestream` npm package provides JavaScript/TypeScript hosts for HTTP/P2P transports, offline edits, retries and application-defined conflict policies.

[Synchronization, conflicts and LTX](https://github.com/mizchi/sqlike/blob/main/docs/sync.md) · [Getting started](https://github.com/mizchi/sqlike). MIT.
