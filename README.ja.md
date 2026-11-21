# twitter-archive-viewer

[English](README.md) | 日本語

Twitter/X の公式データアーカイブ(設定 → アーカイブをダウンロード で入手できる ZIP)を閲覧・検索するための、セルフホスト型ビューアです。自分のサーバー上で、ツイート・いいね・DM をスマホや PC から見られます。

- 実行時の npm 依存はゼロ。Node.js 22.18 以上(Docker イメージは `node:24-bookworm-slim`)。TypeScript は Node の type stripping でそのまま実行します。
- `node:sqlite` による SQLite と、FTS5 trigram の全文検索。日本語(CJK)の部分一致に対応し、1〜2 文字の検索は `LIKE` にフォールバックします。
- Vanilla TypeScript の SPA(ハッシュルーティング)。モバイル対応、ライト/ダークテーマ。

アーカイブ(特に DM)は機微な情報です。データはすべて自分のホスト上に置かれますが、アプリ自体には**認証機能がありません**。[安全に公開する](#安全に公開する)を必ず読んでください。

## 機能

- 無限スクロールのタイムライン
- ハイライト付きの全文検索
- 絞り込み: 種別(オリジナル / リプライ / RT)、メディアのみ、期間、月ジャンプ、並び順、消失したツイート
- ツイート詳細(リプライの文脈)、画像ライトボックス、動画再生(HTTP Range)
- いいね、DM(1 対 1・グループ)
- 管理画面(`#/admin`): アーカイブフォルダに置いた ZIP を選んで進捗付きでインポート、インポート履歴、DB リセット
- 履歴を保持するマージ方式のインポート([アーカイブの取り込みと更新](#アーカイブの取り込みと更新)を参照)

## クイックスタート(Docker)

必要なもの: Docker(Compose 付き)と、X からダウンロードしたアーカイブ ZIP。

```sh
git clone https://github.com/yykuso/twitter-archive-viewer.git
cd twitter-archive-viewer
cp .env.example .env            # 必要に応じて編集
mkdir -p data/archive data/db data/media
cp /path/to/twitter-archive-*.zip data/archive/
docker compose up -d --build
```

その後 `http://<ホスト>:8080/#/admin` を開き、ZIP を選んでインポートを開始します。完了すると `http://<ホスト>:8080/` でタイムラインが見られます。

`DATA_DIR` 配下の `archive/`・`db/`・`media/` は起動前に自分で作成してください。Synology NAS(Container Manager)など、バインドマウント先のフォルダが自動作成されない環境があります。

Cloudflare Tunnel のコネクタも起動する場合は `tunnel` プロファイルを使います(後述)。

```sh
docker compose --profile tunnel up -d --build
```

## 設定

`.env`(`.env.example` を参照)または環境変数で設定します。

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `DATA_DIR` | `./data` | `archive/`(ZIP、読み取り専用でマウント)、`db/`(SQLite)、`media/`(展開した画像・動画)を置くホスト側フォルダ |
| `VIEWER_PORT` | `8080` | ビューアを公開するホスト側ポート。認証がないため LAN 内限定で使うこと |
| `TIMEZONE` | `UTC` | 日付表示・期間絞り込み・月別カレンダーに使う IANA タイムゾーン |
| `TUNNEL_TOKEN` | - | Cloudflare Tunnel のトークン。`--profile tunnel` のときのみ必要 |

コンテナ内ではさらに `DB_PATH`・`MEDIA_ROOT`・`ARCHIVE_DIR`・`PORT`・`WEB_ROOT` が使われます。既定値は `/data` と `/app` 配下を指しているため、通常は変更不要です。

## アーカイブの取り込みと更新

X のアーカイブは、ダウンロード時点のアカウントのスナップショットです。インポートは複数のスナップショットを 1 つの DB に**マージ**します。

- 各行は、最初と最後に現れたアーカイブを記録します。
- 最新のアーカイブから消えたツイート・いいね・DM は**削除されず**、消失した日付つきで「消失」と表示されます。
- 新しいアーカイブの値(カウントや本文)で上書きされます。
- どの順番で取り込んでもよく、同じ ZIP の再取り込みも冪等です。
- インポートは DB の一時コピーに対して行い、アトミックに差し替えるため、取り込み中も閲覧できます。
- メディアは `unzip -n` で展開するため、既存ファイルは上書きされません。

目安として、約 16 万ツイートの取り込みは約 10 秒、ピークメモリは約 1 GB です。約 15 GB のメディア展開はそれより時間がかかります。

更新するには、新しい ZIP を `DATA_DIR/archive/` に置き、`#/admin` から取り込みます。

CLI でも実行できます(サーバーが取り込み中でないときに実行してください)。

```sh
docker compose run --rm viewer import [zip] [--skip-media]
```

## 安全に公開する

ビューアにはログイン機能がありません。インターネットへ直接公開しないでください。参照構成は Cloudflare Tunnel と Cloudflare Access の組み合わせで、ルーターの受信ポート開放が不要です。ダッシュボードの画面は変わるため、以下は概要です。

1. ドメインの DNS を Cloudflare に置く。
2. Zero Trust で remotely-managed の Tunnel を作成し、トークンを `.env` の `TUNNEL_TOKEN` に設定する。
3. `viewer.example.com` のような Public Hostname を追加し、`http://viewer:8080` へ転送する。
4. `viewer.example.com` の self-hosted Access アプリケーション(チームドメイン `<your-team>.cloudflareaccess.com`)を作り、自分のメールアドレスだけを許可するポリシーを設定する。
5. `docker compose --profile tunnel up -d --build` で起動する。
   `--profile` を指定できない環境 (Synology Container Manager など) では、`.env` に `COMPOSE_PROFILES=tunnel` を書く。

Cloudflare 無料プランはリクエストボディが 100 MB までのため、ZIP はブラウザからアップロードせず、`DATA_DIR/archive/` に置いて管理画面で選択する方式にしています。

直接公開している `VIEWER_PORT` は Access を経由しません。LAN 内に限定し(localhost にバインドしてもよい)、ルーターからポートフォワードしないでください。

## 開発

Node.js 22.18 以上と `unzip` が必要です。

```sh
npm install                      # devDependencies のみ(typescript, @types/node)
npm run build:web
DB_PATH=./data/db/tweets.sqlite MEDIA_ROOT=./data/media ARCHIVE_DIR=./data/archive npm start
npm run typecheck
```

構成:

- `src/import/` - ZIP の解析とマージ
- `src/server/` - HTTP、API、メディア配信、管理画面のジョブ実行
- `src/db/` - スキーマ、オープン、アトミックな差し替え
- `src/shared/types.ts` - Web アプリと共有する API の型
- `web/` - SPA
- `docs/architecture/` - アーキテクチャドキュメント

## アーキテクチャ

[docs/architecture/twitter-archive-viewer/spec.md](docs/architecture/twitter-archive-viewer/spec.md) と、対になる `diagram.drawio` を参照してください。

## ライセンス

[MIT](LICENSE)

## 免責

非公式のツールであり、X Corp. とは無関係で、承認・後援も受けていません。「Twitter」「X」はそれぞれの権利者の商標です。
