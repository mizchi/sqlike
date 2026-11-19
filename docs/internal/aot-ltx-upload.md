# R02: AOT LTXをNode relay / DOへ送る

2026-11-16。AOTデモから、ローカルに永続化したLTXをNode relayとDurable Objectの保存gatewayへ送信できる。オフライン生成、再起動、受信後のACK消失、同じファイルの再送、本家Litestreamでの復元を両経路で検証した。0.1.0に含める。

以下の計測と回帰件数はR02完了時点へ固定した。その後のDO adapterの拡張と現行の検証は[C02](do-consumer-sql.md)を参照。

## 試す

`just build`後、別々のターミナルで`just relay`、`just do`、`pnpm exec vite preview`を起動する。ブラウザで`http://127.0.0.1:14173/lite/?client=my-notes`を開き、メモを追加して「LTXを送信」を押す。

| 保存先 | デモのURL | 役割 |
| --- | --- | --- |
| Node relay | `/aot-ltx/my-notes` | `DATA_DIR/aot-ltx/my-notes.sqlite`へファイル・受理記録・復元画像を保存 |
| DO | `/do-aot-ltx/my-notes` | ViteがWorkerの`/aot-ltx/my-notes`へproxy。専用`AotLtxRoom`へ保存 |

DOを選ぶ場合は初回送信前に保存先を変更する。`?upload=/do-aot-ltx/my-notes`でも初期値を指定できる。一度送信先を固定したローカルDBは、別の送信先へ自動で付け替えない。再起動時は保存済みの送信先を入力欄へ復元して編集不可にし、同じ保存先へ再送できる。

```ts
// デモのWorkerを通し、未確認ファイルを回収して最新checkpointを送る。
await window.liteDemo.sync("/do-aot-ltx/my-notes");
// => { uploaded: 2 }
```

ライブラリでは[syncAotLtx](../../src/aot-upload.ts)へ[AotDatabase](../../adapters/aot-database.ts)・絶対URL・任意のfetch実装を渡す。未確認ファイルの送信・ACK回収→最新SQLのcheckpoint→もう一巡の送信を行い、`{ uploaded, checkpoint }`を返す。Workerは既存の`{ uploaded }`を維持し、保留時だけ`deferred`を追加する。`uploadAotLtx()`単体は取得時点のpendingだけを送る。通信処理はMoonBitの同期評価や保存adapterから分離した。同期は明示呼出しであり、常駐する背景同期・定期retryはまだ設けていない。失敗後は同じ送信先で再呼出しする。

未リリースの追加として、永続AOTは既定128件のpendingでcheckpointを保留し、SQLの論理保存を継続する。`outboxLimit`は1〜128。保留は`created: false`と`deferred: { reason: 'outbox-full', pending, limit }`で返し、既存のbytesやTXIDは変更しない。再接続は先にACKを回収するため、満杯からでも最新SQLへ追いつける。各同期はupload最大2巡とcheckpoint1回で終了し、その後の書込は次回へ残す。[契約と回帰検証](aot-outbox-backpressure.md)

## 一つの物理履歴の所有

[契約](../../src/aot-upload-contract.ts)は`aot-ltx-upload@1`と`aot-ltx-ack@1`。最初の通信前に送信先URL・履歴UUID・256-bit所有トークン・Program全体のSHA-256をIDBへ原子的に保存する。ACK未確定の間も同じ識別情報とLTX bytesを使い、再起動時に作り直さない。

受信側は、TXID 1の正しいsnapshotを最初に受理したpublisherがroomを所有する。所有トークンのSHA-256、履歴ID、Program SHA-256を固定し、別publisher・別Programへの交代を拒否する。トークンはAuthorization headerで渡し、catalogやACKへ出力しない。初期roomの事前予約や読取認証はこのデモにはなく、catalogとLTXのGETは公開する。外部公開する配置では、gatewayの手前に必要な認証を置く。

ProgramのSHA-256は履歴の識別用であり、受信先がそのProgramをロード・実行・証明するものではない。受信側が検査するのはファイルhash、TXID、LTX / SQLite画像headerとページchecksumの連鎖で、任意schemaのSQL意味論を検証する機構ではない。

ローカルで手動ACKを済ませ、送信先の記録がない旧DBは新しい送信先へbindできない。既に受理された履歴の行き先を推測して、outboxを空にしたりTXIDを巻き戻したりしない。

## 受理と再送

1. 各ファイルは`baseTXID + 1 = minTXID = maxTXID`。canonicalなuint64十進TXID、ファイル名の16桁hex、size、SHA-256を照合する。
2. 新しいファイルはgatewayのheadをbaseとし、[MoonBitのLTX適用](../../src/ltx.ts)で候補画像を作る。gap、違うbase、壊れたchecksum、headerとのTXID不一致を拒否する。保存済みbaseもSHA-256を確認する。
3. [保存契約](../../src/aot-upload-contract.ts)のCAS commitで、元LTX bytes・復元画像・head・受理記録を同じtransactionへ保存する。durable完了後にのみACKを返す。
4. 同じTXID・同じdescriptor・同じbytesの再送は、保存済みファイルのhashとdurabilityを確認して**同一のACK**を返す。後続のTXIDが進んだ後も、古いファイルのACKは変わらない。異なるbytesを同じTXIDへ上書きしない。
5. 送信側はACKの形式・履歴ID・Program SHA-256・TXID・ファイルSHA-256を照合し、ローカルの`acknowledge()`をdurableに保存してから次へ進む。誤ったACK、応答喪失、timeout、ローカル保存の不確定時は未確認ファイルを残す。

ACKは4 KiBまで、LTX / 復元画像は64 MiBまで、履歴は50,000ファイルまで。これらは形式・受付の上限で、全上限入力がDOのメモリ内で処理できる保証ではない。LTXと全base画像をメモリへ読み、画像全体を再構成・hashする費用が残る。

## HTTPと保存adapter

`GET /aot-ltx/:room`はcatalog、`GET /aot-ltx/:room/:file`は元のLTX bytes、`PUT`は新規受理または再送。PUTは`application/octet-stream`のbodyと、`X-Aot-Ltx`のJSON descriptor、`Authorization: Bearer ...`を使う。ファイルをJSON / Base64へ変換して送らない。過大なbodyをstream読取中にも制限する。

[共通gateway](../../src/aot-ltx-gateway.ts)はプラットフォームの保存APIに依存しない。[SQL保存adapter](../../adapters/aot-ltx-store.ts)は64 KiBのBLOB chunk、metadata、receiptをtransactionで確定する。Nodeは専用SQLiteと`PRAGMA synchronous=FULL`、DOは専用namespaceのSQL storageと`transactionSync()`・`sync()`を使う。[DOの公式保存API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transactionsync)に従い、SQL cursorをawaitの前に読み切る。

DO自身のSQLiteへ受信した生ページをimportせず、ファイルをBLOBとして扱う。通常のSQL同期の`SyncRoom`、P2Pの`PeerRelay`、Litestreamが生成したLTXの受信経路は独立して維持する。このgatewayは、ブラウザが所有する履歴の保存と再配布を担当し、複数writerの物理ページmergeや、DO正本へのSQL反映は行わない。通常デモのSQL / Session同期を選べばサーバー正本へ論理変更を送れる。

`moon-aot-store@1`に任意のupload bindingを追加し、`aot-journal@1`でも保存する。旧snapshot / ログを引き続き読み、列patchやLTXのバイト形式、AOT Programは変更しない。Service WorkerはgatewayのGETをcacheしない。

## 検証

- [Nodeテスト](../../tests/aot-upload.test.ts): 競合する二つのgateway、SQL transaction中断と再開、durability応答喪失、別owner・Program・base・gap・fork・header・hash拒否、保存済みファイル／baseの破損、誤ACK・過大ACK・送信先変更・binding保存失敗を検査する。
- [ブラウザE2E](../../e2e/aot-upload.spec.ts): 実IDBでオフライン生成→再読込→送信、受信直後にACKを破棄→再起動→同じbytesを再送、ローカルACKの再開、別publisherの拒否をNode / 実workerdのDOそれぞれで通す。20万文字超のTEXTとint64を含む。
- サーバーからGETしたファイルを上流Go decoderで検査し、本物のLitestreamで復元。ローカルのSQLite出力と全bytesを一致させ、native `integrity_check`・型付き結果も照合する。送信前の手元ファイルだけの復元で代用しない。

```sh
just aot-upload-check /absolute/path/to/litestream
LITESTREAM_BIN=/absolute/path/to/litestream just check
just differential-audit
```

MoonBit 49件×JS / Wasm、Node 268件、Chromium E2E 51件と型チェック・実Litestream復元を通過した。厳密差分566ケース×8経路で不一致0、出力監査は各環境432一致・270 atomic拒否・誤出力0。全機能監査の未対応・未検証は維持する。[R02時点の完了証拠](../../measurements/c02-before/p0-completion.json)は、gateway実装・テストに加えてDO binding、Vite proxy、Service Workerのソースhashも検査する。

## 配信量と再計測

Apple M5 / Node 24.22.2 / Chromium 158 / Moon 0.1.20261104。前値は[P02完了時点](../../measurements/r02-before)、現行は[アプリ配信](../../measurements/c02-before/aot-current.json)・[単体](../../measurements/c02-before/wasm-build-size-current.json)へ保存した。

| Brotli転送量 | R02前 → 後 |
| --- | ---: |
| AOTアプリ全体 | 114,168 → 116,300 B（111.49 → 113.57 KiB、+2,132 B） |
| 動的SQLikeアプリ | 172,884 → 172,856 B |
| SQLiteアプリ | 486,444 → 486,416 B |
| 全公開AOT API単体 JS / Wasm | 119.20 / 148.69 KiB、同一bytes |

AOTのページ・Worker・保存adapter・送信処理を含む実リクエストを測った。MoonBit AOT JS / Wasm、動的SQL JS、notes Programのartifact hashは前値と一致する。Programは20,049 B、SHA-256 `a6af7a52769d67773842aae483fcb856b46f628e31180d44afa14d2201bc2de2`を維持。FTS / LSMと別DB SDKをAOTへ混ぜない。

既存の[SQL CPU](../../measurements/c02-before/sqlite-speed-current.json)・[行ストア](../../measurements/c02-before/row-store-current.json)・[TEXT IDB](../../measurements/c02-before/indexeddb-speed-current.json)・[BLOB IDB](../../measurements/c02-before/indexeddb-blob-current.json)・[DO型復元](../../measurements/c02-before/do-speed-current.json)・[共通アプリ](../../measurements/c02-before/release-app-current.json)も逐次再採取した。1,000行のPK検索はJS 2.51 / Wasm 1.93 / SQLite 1.65µs、64 B TEXTのIDB更新はcheckpoint込み平均0.212ms。前回の2.16 / 1.67 / 1.47µs・0.196msとは変動しており、同一coreの再測定を送信追加の速度改善とは解釈しない。送信スループットやgateway固有の保持 / peakメモリはまだ計測していない。

履歴の削除／所有権移譲、read replicaのlive追従、保存容量のGC、背景同期、複数writerのmergeは残る。SQLite writerの増分化と上限付きcacheはS02として別に扱う。LSMは引き続き実験で、通常バンドルに含めない。
