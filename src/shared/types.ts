// サーバーとブラウザで共有する API の型。実行時コードは置かない (型のみ)。
//
// 複数アカウント: アカウントごとに別の SQLite (db/accounts/<accountId>.sqlite) と
// メディア (media/<accountId>/...) を持つ。アカウント単位の API はすべてクエリ `account=<accountId>` を受け付ける。
// 省略時は既定アカウント (最後に取り込んだアカウント)。存在しない accountId は 404。

export type MediaType = 'photo' | 'video' | 'animated_gif';

export type Media = {
  readonly type: MediaType;
  /** `/media/<accountId>/...` の URL。ファイルが無い場合は null */
  readonly url: string | null;
  readonly width: number | null;
  readonly height: number | null;
};

export type Tweet = {
  readonly id: string;
  /** ISO 8601 (UTC) */
  readonly createdAt: string;
  readonly text: string;
  readonly lang: string | null;
  readonly source: string | null;
  readonly replyTo: { readonly id: string; readonly screenName: string | null } | null;
  readonly isRetweet: boolean;
  readonly favoriteCount: number;
  readonly retweetCount: number;
  /** ISO 8601。削除済みツイートのみ */
  readonly deletedAt: string | null;
  /** ISO 8601。最新のアーカイブで見つからなくなった場合、消えていたアーカイブの生成日時 */
  readonly removedAt: string | null;
  readonly media: readonly Media[];
};

export type Page<T> = {
  readonly items: readonly T[];
  /** 次ページ取得用。最後のページなら null */
  readonly nextCursor: string | null;
};

export type TweetType = 'all' | 'original' | 'reply' | 'retweet';

/** GET /api/tweets のクエリ */
export type TweetQuery = {
  readonly q?: string;
  /** YYYY-MM-DD (Meta.timezone 基準, 含む) */
  readonly from?: string;
  /** YYYY-MM-DD (Meta.timezone 基準, 含む) */
  readonly to?: string;
  readonly type?: TweetType;
  /** '1' ならメディア付きのみ */
  readonly media?: '1';
  readonly order?: 'desc' | 'asc';
  /** 消失・削除済みの扱い。既定 include */
  readonly removed?: RemovedFilter;
  readonly cursor?: string;
  readonly limit?: string;
};

/** include: すべて / exclude: 現存のみ / only: 消失・削除済みのみ (removedAt か deletedAt があるもの) */
export type RemovedFilter = 'include' | 'exclude' | 'only';

/** GET /api/tweets/:id */
export type TweetDetail = {
  readonly tweet: Tweet;
  /** リプライ先がアーカイブ内にあれば */
  readonly parent: Tweet | null;
  /** このツイートへの自分のリプライ */
  readonly replies: readonly Tweet[];
};

/** GET /api/calendar : 月ごとの件数 (Meta.timezone 基準) */
export type MonthCount = { readonly month: string; readonly count: number };

/** GET /api/accounts : 取り込み済みアカウント (最後に取り込んだ順) */
export type AccountSummary = {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly tweetCount: number;
  /** ISO 8601 */
  readonly lastImportedAt: string | null;
  /** ISO 8601 最新アーカイブの生成日時 */
  readonly archiveGeneratedAt: string | null;
};

/** GET /api/meta?account= */
export type Meta = {
  /** アカウントが 1 つも無ければ null */
  readonly account: { readonly id: string; readonly username: string; readonly displayName: string } | null;
  readonly profile: { readonly bio: string | null; readonly avatarUrl: string | null };
  /** ISO 8601 */
  readonly archiveGeneratedAt: string | null;
  readonly importedAt: string | null;
  /** 取り込み済みアーカイブ数 */
  readonly importCount: number;
  /** 表示・日付絞り込み・集計に使うタイムゾーン (IANA 名)。Settings.timezone と同じ */
  readonly timezone: string;
  readonly counts: {
    readonly tweets: number;
    readonly likes: number;
    readonly dmConversations: number;
  };
  /** 最古・最新ツイートの ISO 8601 */
  readonly range: { readonly first: string | null; readonly last: string | null };
};

/** GET /api/likes?q=&cursor=&limit= */
export type Like = {
  readonly tweetId: string;
  readonly text: string;
  readonly url: string;
  /** ISO 8601。最新のアーカイブで見つからなくなった場合、消えていたアーカイブの生成日時 */
  readonly removedAt: string | null;
};

/** GET /api/dm */
export type DmConversation = {
  readonly id: string;
  readonly isGroup: boolean;
  readonly participants: readonly string[];
  /** ISO 8601 */
  readonly lastAt: string;
  readonly messageCount: number;
};

/** GET /api/dm/:id?cursor=&limit=  (古い順) */
export type DmMessage = {
  readonly id: string;
  readonly senderId: string;
  readonly isMine: boolean;
  /** ISO 8601 */
  readonly createdAt: string;
  readonly text: string;
  readonly media: readonly string[];
  readonly reactions: readonly { readonly senderId: string; readonly reactionKey: string }[];
  /** ISO 8601。最新のアーカイブで見つからなくなった場合、消えていたアーカイブの生成日時 */
  readonly removedAt: string | null;
};

// ---- 管理 (取り込み) ----
// POST は Content-Type: application/json と X-Requested-With: fetch ヘッダー必須 (CSRF 対策)

/** GET /api/admin/archives : ARCHIVE_DIR 内の ZIP (新しい順)。imported は全アカウントの履歴から探す */
export type ArchiveFile = {
  readonly name: string;
  readonly size: number;
  /** ISO 8601 (ファイル更新日時) */
  readonly modifiedAt: string;
  /** 取り込み済みならその記録 */
  readonly imported: ImportRecord | null;
};

export type TableStats = {
  readonly added: number;
  /** 内容が新しいアーカイブの値で更新された件数 */
  readonly updated: number;
  /** 今回のアーカイブに含まれていた件数 */
  readonly seen: number;
};

export type ImportStats = {
  readonly tweets: TableStats;
  readonly likes: TableStats;
  readonly dmMessages: TableStats;
  /** 取り込み後、最新アーカイブで見つからない (消失扱いの) 件数 */
  readonly removed: { readonly tweets: number; readonly likes: number; readonly dmMessages: number };
  readonly mediaFiles: number;
};

/** GET /api/admin/imports?account= : そのアカウントの取り込み履歴 (新しい順) */
export type ImportRecord = {
  readonly id: number;
  readonly accountId: string;
  readonly username: string;
  readonly fileName: string;
  readonly fileSize: number;
  /** ISO 8601 アーカイブ生成日時 */
  readonly generatedAt: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly stats: ImportStats;
};

export type ImportStage = 'queued' | 'reading' | 'writing' | 'swapping' | 'media' | 'done' | 'failed';

/** GET /api/admin/import/status : 実行中または直近のジョブ (サーバー起動後に無ければ null) */
export type ImportJob = {
  readonly id: string;
  readonly fileName: string;
  /** ZIP を読んでアカウントが判明するまで null */
  readonly account: { readonly id: string; readonly username: string } | null;
  readonly stage: ImportStage;
  /** メディア展開などの進捗 */
  readonly progress: { readonly done: number; readonly total: number } | null;
  readonly message: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly error: string | null;
  readonly stats: ImportStats | null;
};

/** POST /api/admin/import → 202 ImportJob / 409 実行中。取り込み先アカウントは ZIP の manifest から自動判定 (新規なら作成) */
export type ImportRequest = { readonly fileName: string; readonly skipMedia?: boolean };

/** POST /api/admin/reset → 204 / 409 実行中 / 404 不明なアカウント。そのアカウントの DB を削除する (メディアは残す) */
export type ResetRequest = { readonly confirm: 'RESET'; readonly accountId: string };

// ---- 統計 ----

/** GET /api/stats?account= */
export type StatsSummary = {
  readonly totals: {
    readonly tweets: number;
    readonly original: number;
    readonly replies: number;
    readonly retweets: number;
    /** メディア付きツイート数 */
    readonly withMedia: number;
    readonly deleted: number;
    /** 消失 (最新アーカイブに無い) ツイート数 */
    readonly removed: number;
    readonly likes: number;
    readonly dmConversations: number;
    readonly dmMessages: number;
  };
  /** ISO 8601 */
  readonly first: string | null;
  readonly last: string | null;
  /** ツイートがある年 (設定タイムゾーン基準, 昇順) */
  readonly years: readonly number[];
  /** 月別 (設定タイムゾーン基準, 'YYYY-MM' 昇順, 0 件の月も first〜last の範囲で含める) */
  readonly monthly: readonly MonthlyStats[];
};

export type MonthlyStats = {
  readonly month: string;
  readonly original: number;
  readonly reply: number;
  readonly retweet: number;
};

/** GET /api/stats/daily?account=&year=YYYY : その年の日別件数 (件数 0 の日は含めない) */
export type DailyCount = { readonly day: string; readonly count: number };

// ---- 設定 ----

/** GET /api/settings */
export type Settings = {
  /** 現在有効なタイムゾーン */
  readonly timezone: string;
  /** settings: 管理画面で設定 / env: 環境変数 TIMEZONE / default: UTC */
  readonly timezoneSource: 'settings' | 'env' | 'default';
  /** 環境変数 TIMEZONE の値 (未設定なら null) */
  readonly envTimezone: string | null;
};

/** POST /api/admin/settings → 200 Settings。timezone: null で画面設定を解除 (環境変数/既定に戻す)。不正な IANA 名は 400 */
export type SettingsRequest = { readonly timezone: string | null };

export type ApiError = { readonly error: string };
