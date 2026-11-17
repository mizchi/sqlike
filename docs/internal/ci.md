# PRの回帰ゲート

`.github/workflows/ci.yml`はPR・mainへのpush・手動起動で実行する。3 jobを独立したUbuntu 24.04 runnerで並行実行し、ローカルでは同じjust recipeを使う。

| job | recipe | 検証範囲 |
| --- | --- | --- |
| typecheck | `just ci-typecheck` | JSを生成してから通常 / Workersの型チェック |
| core | `just ci-node` | MoonBit JS / Wasm、Node全回帰、任意機能の除去、独立npm consumer、本家Litestream復元 |
| browser | `just ci-browser` | Chromium E2E、IndexedDB・再起動・同期 / ACK消失・実DO、対応済みSQL差分、成功出力とatomic拒否 |

型チェックには生成された`.d.ts`が必要なため、fresh checkoutでも先に`pnpm build:core`を実行する。core / browserは実行可能な`LITESTREAM_BIN`を必須とし、復元テストを欠かした成功扱いを防ぐ。

## 実行環境

共通のcomposite actionは`.github/actions/setup-ci/action.yml`。

- Node 24.22.2、pnpmは`package.json`の10.28.2、just 1.50.0、MoonBit compiler 0.10.20+65efd5b93を使用する。
- `pnpm install --frozen-lockfile`とpnpm store cacheを使用し、MoonBitは公式installerの後に`moon update`する。
- integration jobはGo 1.26.2、Litestream 0.5.18、lockfileに対応するPlaywright Chromiumを用意する。LitestreamのLinux x86_64 archiveは固定SHA-256を検証してから展開する。
- Actionsはcommit SHAへ固定する。Node actionはNode 24、justのcomposite action内の固定依存もNode 24であることを確認した。

workflowは`contents: read`で実行し、各jobは新しいcheckoutからbuildする。PRの更新では同じPRの古いrunを中止する。ログと失敗時のPlaywright traceは、失敗したstepの後にも7日間のartifactとして保存する。

```sh
moon update
pnpm install --frozen-lockfile
just ci-typecheck
LITESTREAM_BIN=/path/to/litestream just ci-node
LITESTREAM_BIN=/path/to/litestream just ci-browser
```

coreのNodeテストにはChromiumを使う独立consumer検証もあるため、core jobにもChromiumを入れる。browser jobの差分checkerはそのrunで生成したNode / Chromiumの記録を照合する。

性能・容量・heapの全量再計測は`just p0-measure`へ残す。PRでは決定的な互換性と機能の除去を検査し、runnerの速度を基準マシンの閾値と比較しない。npmの公開は既存のtag専用workflowで扱う。
