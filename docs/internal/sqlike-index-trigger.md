# 複合 index・部分 / 式 index・基本 trigger

このページの速度・サイズはindex / triggerを追加した段階の記録。現在の機能・計測の有効範囲と今後の着手順は[対応範囲と改善台帳](status-and-improvement-plan.md)を参照。

0.0.1 に、複合・降順 index → 部分 / 式 index → 基本 trigger → 永続化・同期の順で追加した。[0.1.0 の一般的な利用シナリオ](roadmap-0.1.0.md)全体はまだ未完了。LSM は引き続き実験専用で、既定の保存方式と配信バンドルには含めない。

## 使用例

次の schema を動的 SQL で作成するか、AOT compiler の schema に渡せる。AOT runtime は SQL parser を持たず、事前に作った AST を実行する。

```sql
CREATE TABLE items(
  id INTEGER PRIMARY KEY,
  tenant TEXT NOT NULL,
  title TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX feed ON items(tenant ASC, updated_at DESC, id ASC)
  WHERE deleted = 0;
CREATE UNIQUE INDEX live_title ON items(tenant, lower(title))
  WHERE deleted = 0;
CREATE TABLE audit(id INTEGER PRIMARY KEY, item_id INTEGER, title TEXT);
CREATE TRIGGER item_insert AFTER INSERT ON items BEGIN
  INSERT INTO audit(item_id, title) VALUES(new.id, new.title);
END;
```

```sql
SELECT id, title FROM items
WHERE tenant = ? AND deleted = 0 AND updated_at < ?
ORDER BY updated_at DESC, id ASC LIMIT 10;
```

この一覧は `feed` の等値 prefix と範囲を探索する。`live_title` は、論理削除していない行だけに正規化した名前の一意性を課す。

## index の範囲

- 列ごとの ASC / DESC / COLLATE、複合 UNIQUE、部分 index、式 index の定義と保存に対応する。UNIQUE の NULL、collation、変更時の衝突を native SQLite と比較する。
- 実行用の列 index は、等値 prefix・次列の比較範囲・順方向 / 逆方向の走査、残余 WHERE、ORDER BY alias、LIMIT に対応する。書込時には対象行の出入りと位置を増分更新する。
- 部分 index は、query の AND 条件が index の WHERE 条件を含むと確認できる場合に使う。含意の判定は同じ AST の照合に限定する。証明できない式は通常の走査へ戻す。
- 式 index は決定的な式の許可リストに限定する。parameter、subquery、aggregate、window、乱数・時刻などは拒否する。部分 index の対象外の行ではキーの式を評価しない。

**式 index を使った検索高速化は未対応**。宣言・一意性・SQLite ファイルへの保存には使えるが、検索時は既存の評価経路に戻す。複雑な OR なども同様。UPSERT は列の競合対象と部分 index の WHERE を扱い、式そのものを競合対象にする構文は未対応。

実行用 index は最大4個の行参照配列を保持する。別に[主キー専用hash / rowid→slot](sqlike-feature-profiles.md)も実装済みで、最大4テーブル分を保持する。全行をディスクから必要な分だけ読む pager ではなく、データ本体もメモリに保持する。変更表のコピーとDELETEのO(N)、保持メモリの定量比較は課題として残る。

## trigger の範囲

| 機能 | 対応 |
| --- | --- |
| AFTER INSERT / UPDATE / DELETE | 通常テーブル、行ごとの実行 |
| BEFORE INSERT / UPDATE / DELETE | SELECT による入力検証のみ |
| OLD / NEW、WHEN、UPDATE OF、FOR EACH ROW | 対応 |
| CREATE / DROP TRIGGER | 動的 SQL と AOT schema |
| RAISE(ABORT, message) / RAISE(IGNORE) | 文全体の rollback / 対象処理の中止を区別 |
| recursive_triggers | 既定 OFF、ON 時の深さ上限32、超過時 rollback |
| TEMP / ATTACH / INSTEAD OF、BEFORE の書込 | 未対応 |
| RAISE(FAIL / ROLLBACK)、trigger 本体の RETURNING | 未対応 |

本体は SELECT / INSERT / UPDATE / DELETE の AST を実行する。DDL・PRAGMA・INSERT DEFAULT VALUES は本体では拒否する。複数 trigger の実行順序には依存しない。

親文と副作用は同じ候補状態に適用し、失敗時には両方を戻す。`changes()`、`last_insert_rowid()`、RETURNING、UPSERT / REPLACE、親の OR IGNORE / OR REPLACE、後続の対象行を別 trigger が変更する場合を native と比較した。RAISE(ABORT) は adapter でも `SQLITE_CONSTRAINT_TRIGGER` を保持する。

OLD / NEW、再帰 stack、直前の変更件数は接続ごとの実行状態とし、保存画像に混ぜない。既存 schema / program の新しい optional metadata がない場合は、従来と同じ JSON バイト列を生成する。

## 保存・復旧・同期

| 経路 | trigger の扱いと検証 |
| --- | --- |
| IndexedDB 行ジャーナル | 副作用を含めた after-image を保存し、replay では trigger を発火しない。ACK 消失・put 中断・再起動・checkpoint を検証 |
| SQLite 書出し・読込 | 部分 / 式 index のキーと順序、trigger DDL と更新済みデータを保存。native `integrity_check` と強制 index 読取、SQLike 再読込を検証 |
| SQL 同期 | 元の SQL に対して trigger を実行し、receipt で再送を除外。snapshot はデータ復元後に trigger 定義を戻し、二重発火を防ぐ |
| binary Session changeset | 任意の[materialized適用wrapper](sqlike-feature-profiles.md)でtrigger / FKの副作用を重ねず適用する。wrapperなしの経路は拒否 |
| SQLite 画像 / LTX | 行 DML として再実行しない。複合・降順・部分・式 index と trigger 副作用を含む LTX chain を本家 Litestream で復元し、index 読取・監査ログ・native integrity を検証 |

SQL 同期の追加テストは Node SQLite / SQLike の正本と SQLike ローカルを対象にする。DO / Turso の trigger 対応全体を検証したものではない。一般的な U01〜U09 の組合せ、保持メモリの比較も今後のリリース条件として残る。

trigger の導入は AOT schema またはアプリ所有の trusted `SyncEngine.migrate()` から行う。ネットワークから受け取る SQL の単文 lexer は引き続き `BEGIN ...; ...; END` を拒否し、内部名前空間の検査も維持する。

## 検証

`LITESTREAM_BIN=/path/to/litestream just check` で MoonBit **40件 × JS / Wasm GC**、Node **167件**、Playwright **42件**と型チェックを通過した。動的 / AOT と JS / Wasm GC の4経路で native SQLite と照合する。全 SQLite 機能の互換性監査の未対応項目を合格に変更していない。

- [index の差分テスト](../../tests/sqlike-index.test.ts)
- [trigger の差分テスト](../../tests/sqlike-trigger.test.ts)
- [SQLite ファイル互換](../../tests/aot-storage.test.ts)
- [本家 Litestream での LTX chain 復元](../../tests/aot-ltx.test.ts)
- [SQL 同期・ACK 消失](../../tests/trigger-sync.test.ts)
- [durable journal・checkpoint](../../tests/aot-persistence.test.ts)
- [実ブラウザでの中断・再読込](../../e2e/sqlike-trigger.spec.ts)

サイズ・既存処理の速度は、[変更前](../../measurements/wasm-build-size-before-composite-index.json)と追加後を同じ条件で比較した。既存 AOT アプリの初回転送は Brotli **79.75 → 85.51 KiB**、全公開 API の AOT JS 単体は **80.18 → 87.20 KiB**。notes program のバイト列は同一で、LSM は含まない。1,000行の既存範囲検索には JS 約8% / Wasm 約9%、更新には約4% / 約11%の時間増加が観測された。[サイズ](runtime-size.md)と[速度・改善計画](sqlike-optimization-plan.md)に全条件とサンプルを記録した。
