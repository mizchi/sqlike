# PRの回帰ゲート

`.github/workflows/ci.yml`はPR・mainへのpush・手動起動で実行する。現行ソースでは4 jobを独立したUbuntu 24.04 runnerで並行実行し、ローカルでは同じjust recipeを使う。新しいbuild-graph jobを含む現行差分のLinux実行確認は[TODOのR03](../../TODO.md)に残す。

| job | recipe | 検証範囲 |
| --- | --- | --- |
| build-graph | `just build-graph-check` | Z3の依存閉包検証、生成drift、staging、外部MoonBit consumer、JS / Wasm AOT、API選択、optimizer全無効の差分 |
| typecheck | `just ci-typecheck` | JSを生成してから通常 / Workersの型チェック |
| core | `just ci-node` | MoonBit JS / Wasm、Node全回帰、任意機能の除去、独立npm consumer、本家Litestream復元 |
| browser | `just ci-browser` | Chromium E2E、IndexedDB・再起動・同期 / ACK消失・実DO、対応済みSQL差分、成功出力とatomic拒否 |

型チェックには生成された`.d.ts`が必要なため、fresh checkoutでも先に`pnpm build:core`を実行する。core / browserは実行可能な`LITESTREAM_BIN`を必須とし、復元テストを欠かした成功扱いを防ぐ。

## 実行環境

共通のcomposite actionは`.github/actions/setup-ci/action.yml`。

- Node 24.22.2、pnpmは`package.json`の10.28.2、just 1.50.0、MoonBit compiler 0.10.20+65efd5b93を使用する。
- `pnpm install --frozen-lockfile`とpnpm store cacheを使用し、MoonBitは公式installerの後に`moon update`する。
- integration jobはGo 1.26.2、Litestream 0.5.18、lockfileに対応するPlaywright Chromiumを用意する。LitestreamのLinux x86_64 archiveは固定SHA-256を検証してから展開する。
- build-graph jobはZ3を追加し、検証条件・結果JSON・ログをartifactへ残す。検証範囲は[ビルド契約](sqlike-build-contract.md)を参照。
- Actionsはcommit SHAへ固定する。Node actionはNode 24、justのcomposite action内の固定依存もNode 24であることを確認した。

workflowは`contents: read`で実行し、各jobは新しいcheckoutからbuildする。PRの更新では同じPRの古いrunを中止する。ログ・失敗時のPlaywright trace・差分と全機能監査のJSONは、失敗したstepの後にも7日間のartifactとして保存する。監査JSONは検査前にrunner上の既存記録を除去し、そのrunが生成した記録だけを保存する。

```sh
moon update
pnpm install --frozen-lockfile
just ci-typecheck
LITESTREAM_BIN=/path/to/litestream just ci-node
LITESTREAM_BIN=/path/to/litestream just ci-browser
```

coreのNodeテストにはChromiumを使う独立consumer検証もあるため、core jobにもChromiumを入れる。browser jobの差分checkerはそのrunで生成したNode / Chromiumの記録を照合する。

性能・容量・heapの全量再計測は`just p0-measure`へ残す。PRでは決定的な互換性と機能の除去を検査し、runnerの速度を基準マシンの閾値と比較しない。npmの公開は既存のtag専用workflowで扱う。

## Linuxでの実行記録

2026-11-17、[PR #5](https://github.com/mizchi/sqlike/pull/5)の実装HEAD `976c50e`で[初回run](https://github.com/mizchi/sqlike/actions/runs/44086898693)が3 jobとも成功した。

| job | setupを含む所要時間 | 結果 |
| --- | ---: | --- |
| typecheck | 48秒 | fresh build後の型チェック成功 |
| core | 172秒 | MoonBit 68件×JS / Wasm、Node 398件、skip 0 |
| browser | 264秒 | Chromium 59件、差分566ケース×12経路の不一致0、成功出力458 probe一致 |

Linuxでのatomic拒否は各target 243件だった。参照SQLiteの能力を含む実行環境ごとの記録で、ローカルmacOSの244件を固定の期待件数として流用しない。型・行・失敗後状態の不一致は両環境とも0。初回の所要時間は観測値であり、PRの速度閾値にはしない。
