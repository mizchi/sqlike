# 索引・UPDATE・JS結果ABI・大量書込の試行

2026-11-17。基準は`2f1d702`の未リリースソース。4項目を順に試し、SQLiteとの出力・失敗後状態を確認した。初回は`fe98120`、以下は後続の[DELETE改善](delete-cache.md)も含めた再計測。公開パッケージのversionは0.1.2のまま。

<!-- optimization-results:start -->
| 試行 | 基準 → 最終実装 | 判断 |
| --- | --- | --- |
| 10万行・索引の両端移動＋範囲読取 | JS 198.02→10.65 µs / WASM 38.40→8.73 µs | ブロック化を採用 |
| 10万行・同値UPDATE | JS 3.96→2.57 µs / WASM 2.26→1.51 µs | 格納時の固定費削減を採用 |
| JS・10万行のnative結果取得 | JSON経路 84.20→typed 21.10 ms | SELECT専用の実験entry |
| JS・native結果の主キー検索 | 1.43→0.70 µs | 同上 |
| Node・1万行INSERT・明示主キー | JS 588.50→57.53 ms / WASM 317.28→21.19 ms | 最大rowid探索の削減を採用 |
| Node・1万行INSERT・自動採番 | JS 505.61→26.20 ms / WASM 280.58→14.85 ms | 最大rowid探索の削減を採用 |

Brotli、単体engine、同じ公開exportを保持した容量比較:

| engine | 前 | 後 | 増分 |
| --- | ---: | ---: | ---: |
| AOT + SQLite writer + LTX | 112,370 B | 113,321 B | +951 B |
| SQLike dynamic SQL | 119,634 B | 120,768 B | +1,134 B |
| Litestream | 38,291 B | 38,291 B | +0 B |

実験typed runtime単体はminified 593,050 B / Brotli 111,992 B。通常engineとはexportが異なるため、差分容量の比較には使わない。通常SQL / AOTからbridgeが除去されることを別に検査した。

10万行INSERT、各3回。基準は3秒の予算内で未完走のため、完走時間の比は計算しない。

| mode | 改善後JS | 改善後Wasm | SQLite prepared | 基準の完走 |
| --- | ---: | ---: | ---: | --- |
| explicit | 295.19 ms | 186.38 ms | 11.87 ms | JS / Wasmとも0 / 3 |
| automatic | 270.32 ms | 192.59 ms | 7.14 ms | JS / Wasmとも0 / 3 |

warmなrowid順cacheがある1万行DBからのpoint DELETE（µs/削除、前回の採番改善と後続のcache改善を含む）:

| mode | JS 前→後 | Wasm 前→後 | SQLite |
| --- | ---: | ---: | ---: |
| explicit | 25.57→12.30 | 10.12→4.40 | 0.57 |
| automatic | 23.57→7.94 | 5.43→3.22 | 0.53 |
<!-- optimization-results:end -->

## 1. 大きい二次索引のブロック化：採用

`CachedIndex.rows`を、順序付きの`IndexRows`へ分離した。8,192行以下では従来と同じflatな配列を使い、大きい二次索引は128行で初期化したleafへ分ける。leafは256行を超えたら分割し、削除で小さくなれば隣接leafと結合する。

キーの探索はleafの末尾とleaf内の二段階の二分探索。変更位置を確認できるときは同じslotを置き換え、大きく移動するときだけleaf内の行参照を動かす。prefix位置の更新はleaf数に比例するため、完全なO(log N)の木ではない。1回の更新で全10万行の参照をずらす費用を減らした。

比較規則・collation・NULL・rowidによるtie break・partial indexの条件は既存処理と共有する。clone / rollbackへ可変の索引配列を共有せず、従来通り派生cacheを破棄する。保存画像・Program・LTXの形式は変えない。空になったleaf・削除したleafの参照もJS / Wasmで解放する。

初回はrowid順の全件走査用cacheをflatに維持した。ブロック化の試行で見えた集約の反復費用は、leaf内配列を直接走査して抑えた。後続の[DELETE改善](delete-cache.md)では大きいrowid順cacheもブロック化し、一般queryのrange走査もleaf内を順次進む形へ変更した。

## 2. UPDATEの固定費：採用

制約・trigger・FK・RETURNING・`changes()`・serialの処理は実行する。最後に格納する値が現在の行と同一なら、行ページ・索引・永続差分への実書込を省く。BEFORE triggerが行を書き換える場合を考慮し、比較するのは呼出し元が保存したOLD値ではなく、格納先の現在値。

INTEGER / REALを区別し、REALの正負のゼロもbit単位で比較する。CHECKがないときの評価用Environment生成と、該当tableにtriggerがないときの空のtrigger探索も省いた。全UPDATEを同値と仮定した最適化ではなく、実変更と同値反復は別に測る。

## 3. JS向け型付き結果ABI：任意の実験package

`mizchi/sqlike/experimental-typed`を独立packageにした。通常のnpm entry、AOT / defined、デフォルトのSQL runtimeのexportには追加しない。既定runtimeからbridgeの実装が消えることもテストする。npmの公開entryとしては提供していない。

現時点ではSELECTの位置付き結果だけを扱う。bindは既存のCell JSONのまま、結果を`bigint / number / string / null / Uint8Array`の配列として返し、結果JSONの生成と`JSON.parse`を省く。列名が重複しても位置を維持し、BLOBはJS境界でコピーして可変の返却配列がDBへ漏れないようにする。MoonBitのenum / growable Arrayの内部表現をJSへ公開せず、primitiveとFixedArrayで渡す。

呼出し例はビルド後の実験runtimeを直接使う。

```ts
import * as native from "../../_build/js/release/build/mizchi/sqlike/experimental-typed/experimental-typed.js";

const db = native.open();
// exec / restore / set_clockは既存JSON応答。利用側でerrorを検査する。
const setup = JSON.parse(native.exec(db, "CREATE TABLE t(id INTEGER PRIMARY KEY)", "[]"));
if (setup.error) throw Error(setup.error);
const query = native.prepare(db, "SELECT ? AS id");
const rows = native.values(query, '[{"t":"integer","v":"1"}]'); // [[1n]]
```

handleはこのruntimeと接続に属し、別runtimeへ渡さない。保持数・寿命は実験APIの利用側が管理する。既存の`openDatabase`の上限付きLRUとは別の低レベルAPIである。

比較では両経路がnativeの`Value[][]`を返す条件に揃えた。既存経路はJSON.parse後のCell→BigInt等の変換も含む。そのため、Cell配列を返す通常の8経路benchmarkと数値を混ぜない。3サンプル、20ms目標、10万行scanは最大2反復。型付きnative SQLite期待値で前後を照合する。

対応済み差分コーパス566ケースのSELECTを型付き結果経路でも照合し、DDL / DML等は既存のexec経路で実行した。元の1,000クエリ、int64の両端、REALと負のゼロ、NUL / 日本語、NULL、重複列、BLOBの返却後変更、bind件数・書込の拒否も検査した。日時等のclock更新は`set_clock`で明示する。AOT版・typed bind・streaming / chunk返却は後続の実験とする。

## 4. 大量INSERTとDELETE：採番・rowid順cacheを改善

INSERTが各行の最大rowidを毎回全走査していた。明示rowidでは最大値の探索を行わず、自動採番には既存の派生PrimaryIndexへ最大値cacheを追加した。最大rowidを削除・変更したら無効化し、次の採番で一度だけ再計算する。AUTOINCREMENTでは現在の最大rowidとsequenceの両方を考慮する。

cacheは保存しない。clone時はwrapperを複製し、restoreでは再構築する。負のrowidだけの表、空表、最大値の削除、主キー変更、trigger内の挿入、rollback・失敗文とAUTOINCREMENTの本家差分を検査した。主キー索引を外した構成は走査へ戻る。

書込benchmarkはNodeのJS / Wasm GCと`node:sqlite`によるmemory DBで、ブラウザやdisk commitの計測ではない。明示rowid / 自動採番を各100行のprepared INSERTで投入する。各caseはbatch間で3秒の予算を検査し、未完走は実際に投入できたprefixを記録する。部分的な投入時間を10万行全体の速度として扱わない。件数・SUM・min/max rowid・変更件数・last_insert_rowidを別に投入したnative SQLiteと照合する。

完走したcaseでは、rowid順の読取cacheをwarmにしてから最大1,000行のpoint DELETEも測る。初回には改善を確認できず、[cacheなし・あり・交互読取の比較](delete-cache.md)でflatなrowid順cacheの更新を切り分けた。後続ではその大きいcacheもブロック化した。cacheなしでも残る制約・trigger / FK探索、prepared DELETEの固定費は後続の候補。

## 検証と再計測

```sh
LITESTREAM_BIN=/path/to/litestream just check
just differential-audit
just sqlite-large-bench
just typed-result-bench
just bulk-write-bench
# before-dirは同じMoonBit版で基準commitをbuildしたsqlike.js / sqlike.wasmを置く
just bulk-write-bench --before-dir=generated/optimization-trials/before
just delete-bench --before-dir=generated/delete-before --profile
just p0-measure
just bundle-size
pnpm exec tsx scripts/report-optimization-trials.ts
pnpm exec tsx scripts/check-p0.ts --record
```

[集計と採否](../../measurements/optimization-trials-current.json)、[索引だけの段階](../../measurements/optimization-index-large.json)、[UPDATEまでの段階](../../measurements/optimization-update-large.json)、[JS結果ABI](../../measurements/optimization-typed-results.json)、[大量書込](../../measurements/optimization-bulk-write.json)。基準の計測は[before](../../measurements/optimization-trials-before)へ固定した。段階ごとのraw runtimeは`generated/optimization-trials`へ保管し、レポートにSHA-256を残す。

異なる日時の段階比較と、同一ページのABI比較・同一process内の書込比較を区別する。少ないサンプルの小差を改善と断定しない。全SQLite互換や、全てのクエリでの速度向上を主張するものではない。
