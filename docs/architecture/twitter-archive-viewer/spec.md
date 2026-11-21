---
system: twitter-archive-viewer
updated_at: 2026-11-21
project: twitter-archive
accounts:
  - Cloudflare account
  - Docker host
regions:
  - Cloudflare global edge
  - home/LAN
---

# twitter-archive-viewer アーキテクチャ仕様

構成図: [diagram.drawio](./diagram.drawio)

## 概要

自分のTwitter(X)公式アーカイブ(ツイート・いいね・DM)を閲覧・検索するための、セルフホスト型Webアプリの参照構成。
自宅などのDockerホスト(NAS等)上でNode.js製ビューアを動かし、Cloudflare Tunnel経由で `viewer.example.com`(任意のホスト名)として公開する。外部からのリクエストはすべてCloudflare Accessで認証する。
アプリ自体に認証機能はないため、インターネットへ公開する場合は本構成のように認証プロキシを前段に置くこと。
環境は1つのみで全環境共通の構成のため、`${env}` は展開せず変数表記のままとする(本システムの命名は `${env}` を含まない)。`${project}` は `twitter-archive` に展開済み。

## 構成要素

| id | サービス | リソース名 | 役割・備考 | 依存先id |
|----|---------|-----------|-----------|----------|
| user | Browser | - | オーナーがPC/スマホから利用するブラウザ | dns |
| pc | Owner PC | - | アーカイブZIPのダウンロード先。ZIPをSMBなど任意の方法でDockerホストの `DATA_DIR/archive/` へコピーする | archive |
| github | GitHub | `twitter-archive-viewer` | ソースコードを公開しているOSSリポジトリ。Dockerホストへcloneしてビルド元とする | viewer |
| dns | Cloudflare DNS | `viewer.example.com` | Cloudflare管理ゾーン内のホスト名。名前解決を担う | access |
| access | Cloudflare Access | - | Zero Trust。`viewer.example.com` のself-hostedアプリケーション(チームドメイン `<your-team>.cloudflareaccess.com`)。ポリシーはオーナーのemailのみ許可、認証はメールのワンタイムPIN | tunnel |
| tunnel | Cloudflare Tunnel | `<your-tunnel>` | remotely-managed(トークン方式)。Public Hostname `viewer.example.com` を `http://viewer:8080` へ転送する | cloudflared |
| cloudflared | cloudflared | - | Tunnelのコネクタ。composeのprofile `tunnel` で起動し、`TUNNEL_TOKEN` は `.env` から読み込む(gitには含めない)。ホスト側からアウトバウンド接続するため、ルーターの受信ポートは開放しない | viewer |
| viewer | Node.js | `twitter-archive-viewer` | 静的SPA(Vanilla TypeScript・ハッシュルーティング: timeline/search/detail/likes/DM/admin)、JSON API(`/api/*`)、メディア配信(`/media/*`、HTTP Range対応)、インポート開始用の管理APIを提供するHTTPサーバー。イメージ `node:24-bookworm-slim`、npmの実行時依存なし。コンテナ内ポート8080(ホスト側は `VIEWER_PORT` で公開、認証なしのためLAN内限定) | sqlite, media, import |
| import | Node.js | - | viewerが起動する子プロセス(`node src/import/cli.ts`)。`unzip` でZIPを読み、DBの一時コピーへマージして差し替え、メディアを `unzip -n` で展開する | archive, sqlite, media |
| sqlite | SQLite | `DATA_DIR/db/tweets.sqlite` | 本体DB。FTS5(trigram)による全文検索。テーブル: tweets, media, likes, dm_conversations, dm_messages, imports, meta | - |
| media | Host Folder | `DATA_DIR/media/` | 展開済みの画像・動画(例: 約15GB) | - |
| archive | Host Folder | `DATA_DIR/archive/` | Twitterアーカイブ公式ZIPの置き場。コンテナへは読み取り専用でマウント | - |
| internet | Internet | - | オーナーのブラウザとGitHubが位置する、システム外の領域 | - |
| cloudflare | Cloudflare | - | Cloudflareアカウント内の領域。DNSゾーンとZero Trust(Access, Tunnel)を含む | - |
| home-lan | Home / LAN | - | 自宅などのローカルネットワーク。DockerホストとオーナーPCが接続する | - |
| nas | Docker host | - | NASやサーバーなどのDockerホスト。データは `DATA_DIR`(既定 `./data`)配下の `archive/`, `db/`, `media/` に置く | home-lan |
| docker-net | Docker network | - | Docker Composeプロジェクト `twitter-archive` のプライベートブリッジネットワーク `internal`。cloudflaredとviewerの2コンテナを収容。importはviewerコンテナ内の子プロセス | nas |

※ 図(diagram.drawio)の `import` は、viewerコンテナ内の子プロセスを見やすくするため独立したノードとして描いている。コンテナとしては `viewer` に含まれる。
※ 図では `internet` / `cloudflare` / `home-lan` / `nas` / `docker-net` は外枠のグループとして描いている(`svc-group-*` ではない)。

## データフロー

図中のステップ番号(バッジ)は、下表の `#` の数字部分に対応する。

| # | from | to | プロトコル | 内容 |
|---|------|----|-----------|------|
| 1-a | user | dns | HTTPS | ブラウザが `viewer.example.com` へアクセスし、名前解決してCloudflareエッジに到達する |
| 1-b | dns | access | HTTPS | Cloudflare Accessがオーナーのemail(ワンタイムPIN)で認証する。許可されたリクエストのみ先へ進む |
| 2-a | access | tunnel | HTTPS | 認証済みリクエストをCloudflare Tunnelへ渡す |
| 2-b | tunnel | cloudflared | QUIC/HTTP2 | cloudflaredがDockerホスト側からアウトバウンドで張ったトンネル経由でリクエストを届ける |
| 3 | cloudflared | viewer | HTTP | `http://viewer:8080` へ転送する |
| 4-a | viewer | sqlite | SQL | `/api/*` のためSQLiteを読み取り専用で参照する |
| 4-b | viewer | media | ファイル読み出し | `/media/*` をHTTP Range対応で配信する |
| 5-a | viewer | import | プロセス起動 | 管理画面のインポート開始操作で子プロセス `node src/import/cli.ts` を起動する |
| 5-b | import | archive | ファイル読み出し | 管理画面で選択したZIPを `unzip` で読む |
| 5-c | import | sqlite | SQL/ファイル操作 | `VACUUM INTO` で作った一時コピーへマージし、アトミックなrenameで差し替える |
| 5-d | import | media | ファイル書き込み | メディアを `unzip -n` で展開する |
| 6 | pc | archive | SMB/ファイルコピー | (オフライン操作) ダウンロードしたZIPをDockerホストの `DATA_DIR/archive/` へコピーする |
| 7 | github | viewer | docker compose build | (オフライン操作) リポジトリをcloneし、`docker compose up -d --build`(Tunnel利用時は `--profile tunnel`)でイメージをビルドして起動する |

## 運用

- 監視・アラート: 未導入。コンテナは `restart: unless-stopped`、viewerにはDockerのhealthcheck(`/healthz`)を設定している
- ログ出力先と保持期間: 各コンテナの標準出力(`docker logs`で参照)。保持期間は未設定(Docker既定)
- バックアップ: `db/` と `archive/` はDockerホスト上にあるのみで、オフサイトバックアップは含まない(利用者側で用意する)
- 環境: 単一環境(`${env}` は展開しない)
- デプロイ: 手動。リポジトリをcloneし `docker compose up -d --build` を実行する

## 設計判断

| 決定事項 | 採用案 | 却下した案 | 理由 |
|---------|-------|-----------|------|
| ホスティング | Dockerホスト + Cloudflare Tunnel | Cloudflareのみ(R2/D1等) | Cloudflareのみの構成では、メディア約15GBがR2の無料枠10GBを超え、D1の制限もあるため |
| 認証 | Cloudflare Access(エッジで認証) | アプリ内認証 | 外部からのリクエストの認証をCloudflare Accessに任せ、アプリ側に認証を実装しないため |
| 日本語検索 | SQLite FTS5 trigram | クライアント側インデックス | 日本語の全文検索をサーバー側のDBで行うため |
| インポート方式 | 既存DBへマージして履歴を保持(消えたツイート・いいねも残し、削除日時 `removedAt` を導出) | 毎回作り直す(再構築) | 削除されたツイート・いいねも履歴として残すため |
| ZIPの指定方法 | 管理画面でホストのフォルダ内のZIPを選択 | ブラウザからのアップロード | Cloudflare無料プランのリクエストボディ上限100MBを超える(ZIPは十数GB)ため |
| DB差し替え | 一時DBへ書いてアトミックにrename | 本体DBへ直接書き込み | インポート中も閲覧を継続できるようにするため |

## 未決事項

なし

## 変更履歴

| 日付 | 変更内容 | 変更者 |
|------|---------|--------|
| 2026-11-21 | 初版 | Claude |
