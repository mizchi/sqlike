# AOT のサイズと速度

現行の再計測は[R02](aot-ltx-upload.md)を参照。以下は以前の実装・計測の記録である。

2026-11-15、SQLike の一般アプリ向けSQL・JSON / 日時・window・移行の追加後に再測定。Apple M5 / macOS arm64 / Node 24.22.2 / Chromium 158.0.8127.18。`just measure-aot` で再現し、[生データ](../measurements/p0-before/aot-current.json)に artifact hash と実リクエストを残す。

SQL parser を除いた AOT デモは、スキーマ・事前コンパイル済み6クエリ・SQLite writer・LTX の必要部分・保存アダプター込みで **100,723 bytes（98.36 KiB）**。SQL 文字列版 SQLike の154.71 KiBに対して約36%、SQLite WASM の474.27 KiBに対して約79%小さい。[一般アプリ向けSQL追加前](../measurements/aot-before-app-features.json)の85.51 KiBから+12.85 KiB。notes program のバイト列は同一で、追加の定義を使わないアプリでの runtime 増加を測った。任意の全文検索とLSMは含まない。[速度の測定](sqlike-optimization-plan.md)も参照する。

| 指標 | AOT JS | SQL 文字列版 SQLike JS | SQLite WASM |
| --- | ---: | ---: | ---: |
| Brotli 初回転送 | 98.36 KiB | 154.71 KiB | 474.27 KiB |
| 初期化中央値 | 99.3 ms | 94.2 ms | 129.4 ms |
| オフライン再読込中央値 | 49.6 ms | 38.2 ms | 55.6 ms |

新しい Chromium プロセス・空の保存領域で各3回、localhost、CPU / 回線制限なし。ページ・Service Worker と precache・DB Worker・artifact・空 DB 初期化までのレスポンスを合計する。HTTP ヘッダーは含まない。AOT は Service Worker の制御を確認してから DB Worker を起動する。

この計測時点のAOTはローカル保存・LTX生成と送信候補の保持まで。その後の[R02](aot-ltx-upload.md)でNode / DOへの送信を追加した。通常デモはSQL / Sessionの同期UI・プロトコルを持つ。転送削減をparserの容量だけと解釈しない。3回の結果から起動時間の改善・p95・モバイル性能は主張しない。

反復実行の退行検査は [SQLike の測定記録](sqlike-development.md)、Web 標準 API による削減の試作は [Web 標準とサイズ](web-platform-size.md)に記録する。SQLite 全機能互換は[未達](sqlite-feature-audit.md)。実装範囲は [AOT と LTX](aot-ltx-plan.md)を参照。

保存方式別の比較は[IndexedDB差分保存](indexeddb-persistence.md)に分離した。実デモの100回逐次書込の合計中央値は30.90 ms、100回のWorker読取は5.69 ms、SQLite / LTX checkpointは9.86 ms。空DBへ100行追加する計3回の測定で、大規模DBの保存速度や単独のIDB I/O時間とは扱わない。
