# schemaの名前と列挙

2026-11-18、未リリース。通常SQLのJS / Wasm、JSON / binary catalog、保存と同期の境界をそろえる。

`table`・`view`・`index`は名前空間を共有し、`trigger`は独立した名前空間を持つ。大文字小文字の扱いは既存のSQLite identifier規則を使う。同名のtableとtriggerもJSON復元、binary snapshot、SQLite画像の出力・読込で維持する。

`IF NOT EXISTS`は任意の同名オブジェクトを無視する指定ではない。table / view同士、index同士、trigger同士は既存定義を保ってskipする。table / viewとindexの衝突はエラーにし、schema cookie・既存データを変更しない。`DROP TABLE / VIEW IF EXISTS`でも、相手がもう一方の種類なら拒否する。ユーザーDDLによる`sqlite_`予約名の作成は拒否する。SQLite画像の内部オブジェクトの読込とは処理を分ける。

`sqlite_schema` / `sqlite_master`の`type`・`name`・`tbl_name`・`sql`にはTEXT affinityを付ける。`name=3`やIN SELECT、derived columnでも、数値の表名`"3"`をTEXTとして比較する。物理page割当とschemaレコードのrowidは行ストアへ保存していないため、`rootpage`と`rowid`の読取・条件・ORDER BY、これらを含む`SELECT *`は明示拒否する。仮の0や再採番した連番をSQLiteのmetadataとして返さない。空入力・未実行CASEもprepare時の検査対象にする。

## 同期adapterの契約

`Database.schemaEntries?(): SchemaEntry[]`は`{name,type,tbl_name,sql}`を返す。依存先のtableはそのオブジェクトより前に置き、trigger同士の作成順を維持する。SQLikeのadapterは現在の論理schemaから列挙し、SQLite driverの既定経路は永続schema rowid順を使う。物理metadataをSQLikeへ追加するための公開APIではない。

snapshotはこの契約でDDLを取得し、tableと他のオブジェクトへ分けて復元する。materialized replicationのtrigger退避・再作成も同じ列挙を使う。SQLikeの新hookを使わない既存のSQLite / DO driverは従来のSQL経路を利用できる。triggerの相対順をalphabetical sortへ変えない。

## 検証

- [名前衝突の行列と保存](../../tests/sqlike-schema-names.test.ts): 4種類の既存オブジェクト×5作成文をJS / Wasmで照合。拒否後の非変更、予約名、JSON / binary / SQLite画像、実際のtrigger dispatchを検査。
- [schema affinityと明示拒否](../../tests/sqlike-schema-affinity.test.ts): TEXT列の比較を6経路で照合し、物理metadataのread / star / empty queryとcatalogでの拒否を確認。
- [列挙と同期](../../tests/schema-entries.test.ts): logical / physical両driverのsnapshotとmaterialized applyで、triggerの作成順と実行順を維持。既存のACK消失・trigger / FK同期の回帰も実行。

物理metadata、暗黙indexを含む完全なschemaレコード、旧形式の宣言順の復元、DDLの全てのSQL正規化はS09の残りとして管理する。この修正だけで全schema metadata互換とはしない。
