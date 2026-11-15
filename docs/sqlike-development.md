# SQLike の互換性と速度

現在のバージョンは0.1.0。一般的なアプリの固定シナリオ、インデックスと基本 trigger、永続化・同期を必須プロファイルで検証した。[対応計画・完了条件](roadmap-0.1.0.md)で、実装済みの部分と今後の必須範囲を管理する。[複合・部分・式 index と基本 trigger](sqlike-index-trigger.md)は実装済みで、差分テストと保存・同期の対応範囲を記録した。

SQLike は SQLite を参照実装として、既存 SQL の振る舞いと速度を維持しながら互換範囲を広げる。ランタイムの SQL parser を除ける AOT 経路を維持し、未対応 SQL を別 DB に転送しない。Litestream の通信・ポリシー・SDK とは独立して実装する。[一般アプリ向けの追加SQLと任意の全文検索](sqlike-app-features.md)も同じ実行器とnative差分テストで管理する。

追加する SQL ごとに native SQLite の結果・storage class・列位置・順序を oracle とし、失敗、評価タイミング、文の rollback も検査する。既存コーパスを削除せず、両者がエラーになっただけで一致とは数えない。変更は探索 → 差分テストの Red → 実装 → Green → Refactoring の順で行う。

```sh
just test-sqlike       # MoonBit の公開 API、JS / Wasm GC
just sqlike-check     # SQLite との直接差分、動的 SQL と AOT
just conformance      # Chromium を含む直接差分
just sqlike-bench     # 現在の速度を記録
just wasm-bench       # JS / Wasm GC を Node / Chromium で比較
just sqlite-bench     # SQLite WASM と比較し、CPU profile を保存
just sqlike-bench --compare=measurements/sqlike-before-backend-decoupling.json
```

今回 `substr` / `substring`、`instr`、`replace`、`trim` / `ltrim` / `rtrim`、`concat` / `concat_ws`、`octet_length`、`nullif`、`iif` / `if` と `PRAGMA encoding` を追加した。[3,970件の固定生成コーパス](../tests/compatibility/scalar-corpus.ts)を JS / Wasm GC / AOT / Chromium で native SQLite と照合する。Unicode scalar と BLOB bytes の区別、NUL、NULL、整数境界、負の範囲、照合順序、遅延評価を含む。整数 column 変換の decimal prefix と int64 の clamp も修正した。

一般アプリ向けSQLの追加後、全機能の固定プローブ一致は90から162へ増えた。[全機能監査](sqlite-feature-audit.md)では未対応と未検証を引き続き記録し、完全互換の gate は成功扱いにしない。SQLite の全 API・構文・拡張が実装済みという意味ではない。照合先は Node 24 の SQLite 3.53.4 であり、別バージョンや compile option の差は明示して検証する。

速度は [bench-sqlike.ts](../scripts/bench-sqlike.ts) が保存・RPC を除いた同じ SQL を計測する。native の型付き結果を先に検査し、定数式10,000回、100行からの検索2,000回を、各1,000回 warm-up 後に7回測定する。AOT と動的 SQL を交互に測り、中央値と成果物 hash を記録する。

`--compare` は Node・MoonBit・CPU・OS と workload hash が同じ baseline だけを受理し、いずれかが30%を超えて遅ければ失敗する。30% はこの計測器の初期しきい値で、ユーザー指定の KPI ではない。別の機械では比較用 baseline を明示的に作成する。数値のばらつきと、個別 SQL の結果を全 workload の速度保証へ広げない。

今回の変更前後の中央値は次の通り。最大約1.4%の差で、30%の退行 gate は通過した。この差を高速化の証拠とは扱わない。

| workload | 変更前 | 変更後 | 比率 |
| --- | ---: | ---: | ---: |
| 定数式 / AOT | 33.80 ms | 34.07 ms | 1.008x |
| 定数式 / 動的 SQL | 94.80 ms | 96.07 ms | 1.013x |
| 100行検索 / AOT | 208.00 ms | 210.70 ms | 1.013x |
| 100行検索 / 動的 SQL | 237.11 ms | 236.50 ms | 0.997x |

記録は [変更前](../measurements/sqlike-before-backend-decoupling.json)、[現在](../measurements/sqlike-current.json)。ブラウザ全体の配信量・起動・durable 保存は [AOT 計測](aot-performance.md)の別指標として扱う。今後の実装でも速度の比較条件と既存の互換性コーパスを維持する。

[JS / Wasm GC の比較](wasm-performance.md)では、同じ文字列 API で動的 SQL・AOT・SQLite 書き出し・LTX 生成と適用を測る。Chromium では LTX 生成が約1.8倍、適用が約1.3倍速い一方、AOT の検索・更新は JS と同程度かやや遅い。結果の検証と速度の検証を分けて保存する。

[SQLite WASM との比較と最適化候補](sqlite-performance.md)では、1,000行の主キー検索で AOT でも約600倍の差を確認した。全行走査を避ける実行計画、事前ビルドでの列位置・メタデータの解決、LIMIT の早期停止、書き込み退避コピーの削減を優先する。SQLike 本体への最適化はこの計測では行っていない。

その後の [改善計画と実施結果](sqlike-optimization-plan.md)では、コストの小さい名前解決・行メタデータ・単純 SELECT / DML の候補限定・退避コピーから改善した。1,000行の JS AOT は主キー検索948 → 5.89 μs、更新993 → 8.28 μs、全行取得4.84 → 1.16 msになった。最終の native 差分・同期・LTX・ブラウザテストも通過した。この後の単一列二次索引の範囲検索は次の段落に記録する。

[単一列二次索引の範囲検索](sqlike-secondary-index.md)は、保存形式に含めない実行用索引を最大4個保持し、スキーマ変更・rollback・restore で無効化する。続く[索引の増分更新](sqlike-incremental-index.md)では、構築済み索引に行差分を適用し、書き込み後の再ソートを省いた。1,000行の「更新→10行検索」は JS 42.75 → 23.61 μs / Wasm 27.69 → 15.62 μs。その後、[行参照配列の全体 map の除去](sqlike-optimization-plan.md)も実装し、1,000行の表の1行更新は JS 8.20 → 5.94 μs / Wasm 4.31 → 3.55 μsになった。その後[IndexedDBの行差分保存](indexeddb-persistence.md)も実装した。1,000行のdurableな1行更新は全量保存1.708 ms / 行差分0.195 ms / SQLiteページ差分5.939 ms。保存契約とfactoryを分離しており、別実装へ差し替えられる。退避処理のcopy-on-write、変更列だけの差分、上限付きpagerは次の候補に残す。
