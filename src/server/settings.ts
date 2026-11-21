import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Settings } from '../shared/types.ts';
import { HttpError } from './http.ts';
import { canonicalTimeZone } from './timezone.ts';

export type SettingsStore = {
  /** 現在有効なタイムゾーン (リクエストごとに読むこと) */
  readonly timeZone: () => string;
  readonly get: () => Settings;
  /** null で画面設定を解除。不正な IANA 名は HttpError(400) */
  readonly set: (timeZone: string | null) => Settings;
};

export type SettingsDeps = {
  /** settings.json のパス */
  readonly path: string;
  /** 環境変数 TIMEZONE (未設定なら null)。起動時に検証済みであること */
  readonly envTimeZone: string | null;
};

/** settings.json を読む。壊れている・不正な値なら警告して null (起動は止めない)。ファイルが無ければ null */
const loadStored = (path: string): string | null => {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    console.warn(`[settings] ${path} を読めないため無視します: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    console.warn(`[settings] ${path} が JSON オブジェクトではないため無視します`);
    return null;
  }
  const tz = (raw as Record<string, unknown>)['timezone'];
  if (tz === undefined || tz === null) return null;
  const canonical = typeof tz === 'string' ? canonicalTimeZone(tz) : null;
  if (canonical === null) {
    console.warn(`[settings] ${path} の timezone ${JSON.stringify(tz)} は IANA 名として不正なため無視します`);
    return null;
  }
  return canonical;
};

/** tmp に書いてから rename する (途中で壊れたファイルを残さない) */
const writeAtomic = (path: string, value: { readonly timezone: string | null }): void => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
};

export const createSettings = (deps: SettingsDeps): SettingsStore => {
  const { path, envTimeZone } = deps;
  let stored = loadStored(path);

  const get = (): Settings => {
    if (stored !== null) return { timezone: stored, timezoneSource: 'settings', envTimezone: envTimeZone };
    if (envTimeZone !== null) return { timezone: envTimeZone, timezoneSource: 'env', envTimezone: envTimeZone };
    return { timezone: 'UTC', timezoneSource: 'default', envTimezone: null };
  };

  return {
    timeZone: () => get().timezone,
    get,
    set: (timeZone) => {
      let next: string | null = null;
      if (timeZone !== null) {
        next = canonicalTimeZone(timeZone);
        if (next === null) throw new HttpError(400, `timezone "${timeZone}" is not a valid IANA time zone name (e.g. Asia/Tokyo)`);
      }
      writeAtomic(path, { timezone: next });
      stored = next;
      return get();
    },
  };
};
