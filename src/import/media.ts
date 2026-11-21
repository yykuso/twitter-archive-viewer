/** メディアを含む ZIP 内ディレクトリ */
export const MEDIA_DIRS = [
  'data/tweets_media',
  'data/deleted_tweets_media',
  'data/direct_messages_media',
  'data/direct_messages_group_media',
  'data/profile_media',
] as const;

/** ZIP のエントリ一覧に実在するメディアディレクトリの unzip パターン */
export const mediaPatterns = (entries: readonly string[]): readonly string[] =>
  MEDIA_DIRS.filter((d) => entries.some((e) => e.startsWith(`${d}/`))).map((d) => `${d}/*`);

/** メディアファイル (ディレクトリエントリを除く) のエントリ数 */
export const countMediaEntries = (entries: readonly string[]): number =>
  entries.filter((e) => !e.endsWith('/') && MEDIA_DIRS.some((d) => e.startsWith(`${d}/`))).length;
