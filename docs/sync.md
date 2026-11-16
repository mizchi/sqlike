# 同期とLTX

`@mizchi/litestream`はDBドライバーを介して動く同期ライブラリです。利用側のDBは`all`・`run`・`transaction`を持つ`Database`契約に従います。データとoutboxを同じtransactionで保存できることが必要です。

## ローカル編集から正本へ送る

次の例は、インメモリ接続でローカル編集と同期の流れを確認します。

```ts
import { openDatabase } from '@mizchi/sqlike';
import { SyncEngine, OfflineClient, statement } from '@mizchi/litestream';

const authority = openDatabase();
const engine = new SyncEngine(authority);
const local = openDatabase();
const client = new OfflineClient(local, {
  push: async bytes => engine.push(bytes),
  snapshot: async () => engine.snapshot(),
});

await client.sync();
client.execute([
  statement('INSERT INTO notes(id,title,score) VALUES(?,?,?)', ['one', 'hello', 1n]),
], 'sql');
await client.sync();

const rows = authority.all('SELECT id,title FROM notes');
local.close();
authority.close();
```

`SyncEngine` / `OfflineClient`の初期化には、現在デモ用の`notes` schemaも含まれます。同期処理の例を基に組み込む場合は、この初期化範囲も確認してください。

上の接続はインメモリです。ページを開き直してもoutboxを残すには、データとoutboxを永続化するdriverを使います。`DefinedDatabase`の非同期named statement APIと、`OfflineClient`が受け取る同期SQL driverは別の契約です。

## Transportを差し替える

HTTPでは`new HttpTransport(endpoint)`を使い、サーバーへ次の処理を実装します。

| リクエスト | 正本側の処理 |
| --- | --- |
| `GET <endpoint>/snapshot` | `engine.snapshot()`をJSONで返す |
| `POST <endpoint>/push` | bodyを`Uint8Array`で受け取り、`engine.push(bytes)`のreceiptを返す |

失敗時には`SyncFailure`の構造化したエラーを返す必要があります。認証・認可とendpointの公開はアプリ側で用意します。

リポジトリには[Node relay](../adapters/relay.ts)、[Cloudflare Durable Object](../adapters/durable-object.ts)、[P2P relay](../src/transport.ts)の構成例があります。例の起動・開発手順は[開発ガイド](internal/development.md)を参照してください。

## 同期方式とdriver

| 方式 | 用途と条件 |
| --- | --- |
| SQL | SQLを正本で再実行。古いrevisionや実行結果の不一致を保留し、利用側が判断 |
| Session差分 | SQLite Session形式の変更。driverにcapture / 適用の能力が必要 |
| LTX | SQLite画像の物理履歴を受け渡す。TXID・base・checksumが連続する必要がある |

driverに存在しない機能を要求した場合は拒否します。trigger / FKの副作用を含むSession適用では、materialized applyを扱うdriverとwrapperが必要です。SQLike・SQLite・Tursoの全SQLや全同期方式を同じように使えるという契約ではありません。

## 適用と競合を判断する

`ApplyPolicy`を正本側の`SyncEngine`へ登録します。クライアントはpolicy名とJSONのintentを渡します。

| フック | 判断するタイミング |
| --- | --- |
| `before` | 正本へ適用する前。適用・保留・拒否を選ぶ |
| `onAmbiguous` | stale SQL、schema不一致、旧値の競合等をrollbackした後。保留・拒否・置換SQLを選ぶ |
| `after` | 結果を確認し、commit前に適用・保留・拒否を選ぶ |

フックは同期関数です。対象を一意に決めるSELECTと期待件数を記述し、置換する場合も対象の条件と適用後の結果を検査します。DB identityの不一致や破損をpolicyで無効化することはできません。

画面で利用者へ判断を求める場合は`ClientOptions.onIssue`や`resolvePending()`を使えます。ACK消失やタイムアウトで正本のcommit有無が不明な間は、同じ操作IDでreceiptを確認します。

## LTXを生成・適用する

```ts
import { encodeLtx, applyLtx } from '@mizchi/litestream/ltx';

const { data: file } = encodeLtx(new Uint8Array(), sqliteImage, '1', '1');
const { data: restored } = applyLtx(new Uint8Array(), '0', file, 3);
```

`sqliteImage`には有効なSQLite画像を渡します。SQLikeから作る場合は[SQLite出力](prepared.md#sqliteファイルへ書き出す)を使います。TXIDは精度を保つため文字列で指定します。別履歴の画像を合成せず、適用に必要なbaseと連続したファイルを用意します。
