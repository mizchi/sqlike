# @mizchi/litestream

DBエンジンに依存しないオフライン同期とLTXの実装。MoonBitのJSコアとTypeScriptのhostを同梱する。SQLike・SQLite・Tursoの本体は依存に含めない。ESM、Node.js 24以上と現行ブラウザ向け。

```sh
pnpm add https://github.com/mizchi/sqlike/releases/download/v0.1.0/mizchi-litestream-0.1.0.tgz
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

root entryは`SyncEngine`、`OfflineClient`、HTTP / peer / LTX transport、IndexedDBのreplica store、Session codecと適用policyの型を公開する。利用側のDBは`Database`契約に従い、値の型とtransactionの原子性を維持する必要がある。Sessionのcaptureやmaterialized applyはoptionalな能力で、各DBの能力を同じと仮定しない。

## LTX

```js
import { encodeLtx, applyLtx } from '@mizchi/litestream/ltx';
const { data: file } = encodeLtx(new Uint8Array(), sqliteImage, '1', '1');
const { data: restored } = applyLtx(new Uint8Array(), '0', file, 3);
```

入力は有効なSQLite画像。TXIDとtimestampは精度を保持する文字列で渡す。`planLtx()`はcatalogの連続性を検査する。`/engine`は低水準のMoonBit JS ABI、`/node`はNode組み込みSQLiteの`NodeDatabase`。`wasm/litestream.wasm`は低水準のWasm GCコアで、Bytesの受け渡しにはbase64 ABIを使う。

既存のデモ用`notes` schemaは`SyncEngine` / `OfflineClient`の初期化にも含まれる。任意schema・任意driverの全機能互換を宣言するものではない。利用側policy、driver capability、Node / DO / P2Pの構成例と対応範囲は[リポジトリ](https://github.com/mizchi/sqlike)・[共通契約](https://github.com/mizchi/sqlike/blob/main/docs/sync.md)を参照。MIT。
