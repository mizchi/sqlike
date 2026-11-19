# AOT outboxの上限と再開

2026-11-19、未リリース。永続`AotDatabase`は、未ACKのLTXが上限に達するとcheckpointを保留する。SQLの論理保存を継続でき、ACK回収後に最新状態から次のLTXを生成できる。[利用方法](../incremental-pager.md#existing-durable-checkpoint-adapter)

## 契約

`AotDatabaseOptions.outboxLimit`は整数1〜128、既定128。`open()` / `withStore()`の最初のawait前に設定をコピーし、`withStore()`で値を検査する。page providerのファイル上限は共有定数`SQLITE_PAGE_FILE_LIMIT`で128に固定する。inline経路にも同じcheckpoint保留を適用し、128件を超える旧履歴の読込とACK回収は許可する。

変更があり上限に達している場合、`checkpoint()`は以下を返す。

```ts
{ created: false, head: '128',
  deferred: { reason: 'outbox-full', pending: 128, limit: 128 } }
```

page準備・SQLite出力・LTX生成・provider保存の前に返す。TXID、page generation、logical generation、checkpoint serial、未確認bytesを変更しない。SQLの`execute()`は従来どおり論理journalと必要なcompactionをdurableに保存する。既に最新のcheckpointなら上限に関係なく`{ created: false, head }`を返す。active transactionとTXID overflowの拒否は維持する。

保留自体はDBを失敗状態にしない。実際の保存abortや保存ACK消失は従来どおり再読込を要求し、保存されなかった値と保存済みの値を推測して進めない。特別な保留フラグは保存せず、pending件数とSQL / checkpointのserialから再開後も判定する。`inspect()`に`checkpointSerial`を追加した。デモは未checkpointの更新とローカル保存済みの保留を表示する。

## 再接続

`syncAotLtx(db, endpoint, fetch?)`は既存`uploadAotLtx()`を使い、次の順で処理する。

1. 開始時に取得したpendingを順に送信し、検証済みACKを原子的に保存・回収する。
2. 最新のdurable SQLをcheckpointする。
3. もう一度取得したpendingを送信・ACK回収する。

返却値は`{ uploaded, checkpoint }`。Workerの`sync`は既存の`{ uploaded }`を保ち、保留時だけ`deferred`を追加する。各呼出しはuploadを最大2巡・checkpointを1回に限定し、書込が続いても無制限に追いかけない。checkpoint後のSQLは次回の同期対象となる。並行操作で再び上限に達すれば保留結果を返す。通信失敗の自動retryや背景同期は実装しない。

送信先binding、履歴ID、ファイルbytes、TXIDとACKの検証契約は維持する。受信後にACKだけが失われても未確認ファイルを残し、再読込後に同じbytesを再送する。誤ったhashのACKは空き枠を作らない。`uploadAotLtx()`単体は現在のpendingだけを送る従来の動作を維持する。

## 検証と残り

`LITESTREAM_BIN=/path/to/litestream just check`を通過。MoonBitはJS / Wasm各93件、Node 565件、Chromium 73件、型チェックと独立npm consumerを確認した。SQLite出力監査はJS / Wasm / Chromiumそれぞれ508 probe一致・230 atomic拒否・値の不一致0。未対応・未検証の全機能inventoryは残す。

現行sourceで`pnpm exec tsx scripts/bench-idb-pager.ts --smoke --output=/tmp/outbox-idb-smoke.json`も通過。200行・5構成の通常更新 / logical compaction、LTX連続適用・SQLite byte一致・native integrity・再読込・ACK回収を確認した。小規模なsmokeのため、既存の5,000 / 100,000行の速度表は置き換えない。

- [Node / page](../../tests/aot-pager-checkpoint.test.ts): 上限・複数回保留・journal compaction・再読込・誤ACK・ACK後のcatch-up、保存前abort / 保存ACK消失、option検査と外部変更の分離。
- [Node / inline・通信](../../tests/aot-upload.test.ts): 満杯からの再接続、remote受理後のACK消失と再送、同期中の書込・2巡での終了・次回のcatch-up。
- [Chromium / 実IndexedDB](../../e2e/aot-outbox.spec.ts): 既定128件からの保留、以後のSQL保存、再読込、ACK後の129番目のLTX、全履歴の本家Litestream復元・SQLite byte一致・native integrity。page経路のACK消失と再送、Worker UIの保存表示も検査。
- [Node / DOデモ](../../e2e/aot-upload.spec.ts): 両gatewayへの既存送信・ACK消失・再送・本家復元を維持。

この変更はhost adapterと送信制御のみで、MoonBit engine・LTX形式・公開APIのbuild graphは変更していない。engineサイズの既存計測は維持する。既存IDB速度表は各reportのsource hashに対応する保留追加前の計測で、満杯時やネットワークの所要時間は計測していない。

上限が制限するのは未ACKファイル数だけで、論理SQLサイズ・初回snapshot・全体メモリ・IndexedDB quotaの上限を保証しない。既存LTXの集約・サーバー履歴GC・所有権移譲・背景同期は後続。ACK前のファイルは削除・上書きしない。
