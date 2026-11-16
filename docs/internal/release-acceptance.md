# 0.1.0の受入プロファイルとP0チェックリスト

対象は0.1.0のSQLiteサブセット。一般アプリで使う機能を共通schemaに組み合わせ、次の必須プロファイルで受入する。全SQLite機能・全driverの全組合せを合格とするものではない。実行結果と測定の鮮度は`just p0-check`で検査する。

2026-11-15、下記P0チェックを通過した。[完了証拠](../../measurements/p0-completion.json)・[結果と計測](p0-results.md)を保存した。0.1.0での再検証・公開手順は[リリースノート](../releases/v0.1.0.md)と[公開手順](releasing.md)を参照。

## 共通のアプリと固定入力

[release-scenarios.ts](../../tests/compatibility/release-scenarios.ts)にSQLと型付きbindを固定した。tenant、STRICTなtask、複合PKのtag、監査表を使う。降順・部分・式UNIQUE index、FKのCASCADE、BEFORE検証、AFTER監査とカウンタを同時に有効にする。時刻は固定した入力で比較する。

| ID | 必須入力・拒否入力 | 変更後・失敗後の確認 |
| --- | --- | --- |
| U01 | INTEGER / REAL / NULL / TEXT / BLOBのbind、UPSERT、RETURNING、空titleのCHECK違反 | 格納クラス・列位置・行、失敗前のデータ・監査・カウンタ |
| U02 | tenantの降順feed、同値の境界、NULL、keysetの次ページ、索引列の更新 | 更新前後の並びとページ境界、他tenantの非混入 |
| U03 | tagとのJOIN / GROUP BY / HAVING、親キー変更・削除、存在しない親への挿入 | 複合PK・FK・CASCADE、監査・カウンタ、foreign_key_check |
| U04 | 論理削除→同名復活→衝突→削除→再復活、lower式UNIQUE、NOCASE検索 | 部分indexの出入り、衝突した文の非変更 |
| U05 | 複数行の後半でRAISE(ABORT)、UPDATE OF / WHEN、RETURNING、削除 | 親変更とtrigger副作用の同時rollback、発火回数 |
| U06 | JSON抽出・編集、NULL、UTC offset・閏日・floor modifier、壊れたJSON | nativeと同じ型付き結果、拒否後の値 |
| U07 | ADD / RENAME / DROP COLUMN、index / trigger / FK依存、参照される列のDROP拒否 | 動的SQLでの移行と再読込。AOTは固定schemaを再コンパイルし、別Programの画像を拒否 |
| U08 | BEGIN / SAVEPOINT / ROLLBACK TO / COMMIT、offline変更、IDB abort、古いwriter、commit後ACK消失 | 保存前の変更を公開しない。reopen後の値・型・副作用、offlineでの再編集、同期の重複排除 |
| U09 | int64、REAL、overflow BLOB、PK変更、削除、SQLite / LTXへの書出し | JS / Wasm同一bytes、native integrity / FK、監査表、本家Litestreamの復元bytes |

観測は対象行だけでなく、全task・tenantカウンタ・tag・監査表に対して各step後に行う。AOTでの任意DDLを実行一致へ数えず、U07は動的2経路と固定Programの移行契約を分ける。

## 必須の組合せと対象外

| プロファイル | 必須の組合せ | 実行する検査 |
| --- | --- | --- |
| ローカルの共通アプリ | JS SQL / Wasm SQL / JS AOT / Wasm AOT、native SQLite参照 | [シナリオ差分](../../tests/release-scenarios.test.ts)。34実行一致とU07のAOT対象外2件を別集計 |
| 共通アプリのSQL / binary同期 | SQLikeローカル、Node SQLite / SQLike正本、SQL / Sessionの4組。binaryはmaterialized wrapper付き | [組合せ同期](../../tests/release-sync.test.ts)。型・trigger / FK・失敗の非変更・ACK消失・復旧・再送 |
| 共通アプリのブラウザ保存 | Chromium、AOT JS、実IndexedDB・Service Worker | [U08 E2E](../../e2e/release-scenarios.spec.ts)。queued putの実abort、世代CAS、ACK消失、offline cached reload、再編集 |
| 共通アプリのファイル受渡し | AOT JS / WasmのSQLite writer、native SQLite、上流Go decoder、実Litestream | [round-trip](../../tests/release-roundtrip.test.ts)。全非DDLシナリオの画像と、LTX復元 |
| 持ち運べる同期の共通部分 | SQLite WASM / SQLike / Tursoの実SDK、Node / DO / peer / peer-doの対応経路 | [混在engine](../../e2e/backends.spec.ts)、[同期と利用側policy](../../e2e/sync.spec.ts)、[副作用抑制](../../e2e/materialized-sync.spec.ts)の既存E2Eを維持 |

[C02のDO向け固定consumer](do-consumer-sql.md)に続き、[Drizzle](drizzle.md)で決定的なRETURNING式・bindと、ownerの排他migration scopeでのtrigger導入を検証した。非決定的なRETURNING式・subquery、TursoのSession生成・直接LTX・整数値REAL bind等の拒否は維持する。trigger / FK付きbinaryの抑制をDO / Tursoへ仮定しない。最後の行は共通部分のプロファイルであり、上の共通アプリ全schemaを全SDKで受理するという宣言ではない。

[R02のAOT LTX送信](aot-ltx-upload.md)を追加し、Node relay / 実DOへのオフライン生成・再起動・ACK消失・再送・本家復元を`just check`に含めた。DO自身のSQL正本へ生ページをimportする契約ではない。Firefox / WebKit・モバイルはV02として別に扱う。LTX生成 / 復元と、通常デモのSQL / Session / 直接LTX受信も引き続き必須検査に含む。

## P0の完了条件

- [x] V01: 現行artifactと計測ソースのhashを記録し、SQL・IDB・配信・機能別サイズを再採取。
- [x] V01: GC後の保持heap、backing storage、別workloadでサンプリングした最大値を区別。厳密な一時ピーク / RSSとは表示しない。
- [x] V01: index / triggerあり・なしの同条件アプリで配信・検索・durable更新・メモリを比較し、実workerdのDO追加SQL回数も記録。
- [x] C01: 3 seed・9 family・324生成ケースを追加。数値・NUL / collation・集約scope・JSON・bind・宣言・成功 / 失敗後状態を検査。
- [x] C01: 必須成功ケース・必須拒否ケースを固定し、全件拒否や内部例外で通さない。動的 / AOT × JS / Wasmの4経路で検査し、Chromiumの出力台帳にも追加。
- [x] R01: 上記U01〜U09と必須プロファイルを実行し、失敗の除外を足さずに通す。
- [x] R01: ON UPDATEを含むDDLと、uppercase BEGINを持つtriggerの列名変更の不具合を最小回帰へ固定。
- [x] `just check`、`just differential-audit`、現行measurement / sourceのhash検査を通す。全機能監査は未達判定を維持。

計測用アプリは[scripts/release-app-workload.ts](../../scripts/release-app-workload.ts)。同じ100行・64-byte BLOB・STRICT / FKと固定queryを使い、二次index / 部分UNIQUE / triggerだけを切り替える。PK索引は双方で使う。triggerありでは監査表が増える費用も含める。実ブラウザmain thread＋IDBの測定で、Worker RPCやネットワーク同期時間は含まない。通常デモの初回配信量は別の実アプリ計測で扱う。

```sh
# 重い計測を同時実行せず、順に採取する
just p0-measure

# native復元と既存全回帰、差分、計測の鮮度を確認して完了証拠を保存する
LITESTREAM_BIN=/path/to/litestream just p0-check

# 保存した完了証拠に対して、code / reportの変更を検出する
pnpm exec tsx scripts/check-p0.ts
```

旧基準は[measurements/p0-before](../../measurements/p0-before)へ固定した。P0完了証拠は`measurements/p0-completion.json`へ記録する。チェックの更新はこれらの実行後に行い、バージョン変更・公開とは分ける。
