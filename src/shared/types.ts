// サーバーとブラウザで共有する API の型。実行時コードは置かない (型のみ)。

export type MediaType = 'photo' | 'video' | 'animated_gif';

export type Media = {
  readonly type: MediaType;
  /** `/media/...` の URL。ファイルが無い場合は null */
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

/** GET /api/meta */
export type Meta = {
  /** 未取り込みなら null */
  readonly account: { readonly id: string; readonly username: string; readonly displayName: string } | null;
  readonly profile: { readonly bio: string | null; readonly avatarUrl: string | null };
  /** ISO 8601 */
  readonly archiveGeneratedAt: string | null;
  readonly importedAt: string | null;
  /** 取り込み済みアーカイブ数 */
  readonly importCount: number;
  /** 表示・日付絞り込み・月別集計に使うタイムゾーン (IANA 名, 環境変数 TIMEZONE) */
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

/** GET /api/admin/archives : ARCHIVE_DIR 内の ZIP (新しい順) */
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

/** GET /api/admin/imports : 取り込み履歴 (新しい順) */
export type ImportRecord = {
  readonly id: number;
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
  readonly stage: ImportStage;
  /** メディア展開などの進捗 */
  readonly progress: { readonly done: number; readonly total: number } | null;
  readonly message: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly error: string | null;
  readonly stats: ImportStats | null;
};

/** POST /api/admin/import → 202 ImportJob / 409 実行中 */
export type ImportRequest = { readonly fileName: string; readonly skipMedia?: boolean };

/** POST /api/admin/reset → 204 / 409 実行中。DB を空にする (メディアは残す) */
export type ResetRequest = { readonly confirm: 'RESET' };

export type ApiError = { readonly error: string };
