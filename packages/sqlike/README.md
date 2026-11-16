# mizchi/sqlike

MoonBitから使えるSQLiteサブセットです。動的SQLと事前コンパイルした問い合わせを実行でき、SQLite画像の読取・書き出しも扱います。Litestreamへの依存はありません。JS / Wasm GCに対応します。

```sh
moon add mizchi/sqlike@0.1.1
```

`moon.pkg`から`"mizchi/sqlike"`をimportします。

```moonbit
let db = @sqlike.Connection::open(":memory:")
let statement = db.prepare("SELECT ?")
statement.bind(index=1, 9007199254740993L)
if statement.step() {
  let value : Int64 = statement.column(index=0)
  assert_eq(value, 9007199254740993L)
}
statement.finalize()
db.close()
```

bindは1始まり、columnは0始まりです。`Connection` / `Statement` / `Bind` / `Column` / `Value`を公開します。

| パッケージ | 用途 |
| --- | --- |
| `mizchi/sqlike` | SQL実行、型付き値、事前コンパイルしたProgram、DB画像・SQLiteページ |
| `mizchi/sqlike/compiler` | schemaとSQLの事前コンパイル |
| `mizchi/sqlike/fts` | 任意の全文検索。通常のSQL runtimeから独立 |

CRUD、RETURNING、JOIN、index、制約、基本trigger、transaction等を扱います。SQLite全機能互換ではありません。[SQLの対応範囲](https://github.com/mizchi/sqlike/blob/main/docs/sql.md)を参照してください。

JavaScript / TypeScriptからは`@mizchi/sqlike`を使えます。[導入と利用例](https://github.com/mizchi/sqlike) / [固定schema・IndexedDB](https://github.com/mizchi/sqlike/blob/main/docs/prepared.md)。MIT。
