import type { ArchiveFile, ImportJob, ImportRecord, ImportStage, ImportStats, Meta, Settings } from '../../src/shared/types.ts';
import { ApiFailure, fetchArchives, fetchImports, fetchImportStatus, fetchMeta, fetchSettings, resetDatabase, saveSettings, startImport } from './api.ts';
import { h, type Child } from './dom.ts';
import { spinner } from './feed.ts';
import { formatDateTime, formatDay, setDisplayTimeZone } from './format.ts';
import type { View } from './timeline.ts';

export type AdminProps = {
  /** 対象アカウント (URL の account)。未指定ならサーバーの既定 */
  readonly account: string | undefined;
  /** 取り込み完了・リセット後に呼ばれる (ヘッダー等の再取得用) */
  readonly onChanged: () => Promise<void>;
};

type Load<T> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'error'; readonly message: string };

type Notice = { readonly kind: 'error' | 'info'; readonly text: string };

type State = {
  readonly archives: Load<readonly ArchiveFile[]>;
  readonly history: Load<readonly ImportRecord[]>;
  readonly meta: Meta | null;
  readonly settings: Load<Settings>;
  readonly savingTz: boolean;
  /** 選択中 (未保存) のタイムゾーン。null なら現在の設定値 */
  readonly tzDraft: string | null;
  readonly tzFilter: string;
  readonly job: ImportJob | null;
  readonly now: number;
  readonly skipMedia: boolean;
  readonly pendingFile: string | null;
  readonly starting: boolean;
  readonly notice: Notice | null;
  readonly resetOpen: boolean;
  readonly resetText: string;
  readonly resetting: boolean;
};

const STAGE_LABELS: Readonly<Record<ImportStage, string>> = {
  queued: '待機中', reading: 'ZIP読み込み中', writing: 'DB書き込み中', swapping: '切り替え中',
  media: 'メディア展開中', done: '完了', failed: '失敗',
};

const POLL_MS = 2000;

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isRunning = (job: ImportJob | null): boolean => job !== null && job.stage !== 'done' && job.stage !== 'failed';
const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const num = (n: number): string => n.toLocaleString('ja-JP');

const elapsed = (job: ImportJob, now: number): string => {
  const start = Date.parse(job.startedAt);
  const end = job.finishedAt ? Date.parse(job.finishedAt) : now;
  if (Number.isNaN(start) || Number.isNaN(end)) return '-';
  const s = Math.max(0, Math.floor((end - start) / 1000));
  return `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒`;
};

// ---- 純粋な描画関数 ----

const loadBox = <T>(l: Load<T>, ok: (v: T) => Node): Node =>
  l.kind === 'loading' ? spinner()
    : l.kind === 'error' ? h('div', { class: 'state state-error', role: 'alert' }, l.message)
    : ok(l.value);

const renderMetaLine = (meta: Meta | null): Node =>
  h('p', { class: 'muted adm-meta' },
    meta === null ? '' : `${meta.account ? `@${meta.account.username} ・ ` : ''}取り込み済みアーカイブ: ${meta.importCount} 件 / ツイート ${num(meta.counts.tweets)} / いいね ${num(meta.counts.likes)}`);

const renderNotice = (n: Notice | null): Node =>
  n === null ? document.createDocumentFragment()
    : h('div', { class: n.kind === 'error' ? 'adm-notice adm-error' : 'adm-notice', role: n.kind === 'error' ? 'alert' : 'status' }, n.text);

const statsTable = (s: ImportStats): HTMLElement => {
  const rows: readonly (readonly [string, ImportStats['tweets'], number])[] = [
    ['ツイート', s.tweets, s.removed.tweets],
    ['いいね', s.likes, s.removed.likes],
    ['DM', s.dmMessages, s.removed.dmMessages],
  ];
  return h('div', { class: 'tbl-wrap' },
    h('table', { class: 'tbl adm-stats' },
      h('thead', null, h('tr', null, ['', '追加', '更新', '含まれていた件数', '消失件数'].map((t) => h('th', null, t)))),
      h('tbody', null, rows.map(([label, t, removed]) =>
        h('tr', null, h('th', { scope: 'row' }, label), h('td', null, num(t.added)), h('td', null, num(t.updated)), h('td', null, num(t.seen)), h('td', null, num(removed)))))),
    h('p', { class: 'muted' }, `メディアファイル数: ${num(s.mediaFiles)}`));
};

const renderJob = (job: ImportJob | null, now: number): Node => {
  if (job === null) return h('p', { class: 'muted' }, '実行中・直近のジョブはありません');
  const p = job.progress;
  const pct = p && p.total > 0 ? Math.min(100, Math.floor((p.done / p.total) * 100)) : null;
  return h('div', { class: `adm-job stage-${job.stage}` },
    h('div', { class: 'adm-job-head' },
      h('span', { class: 'adm-file' }, job.fileName),
      h('span', { class: `badge badge-stage-${job.stage}`, 'data-stage': job.stage }, STAGE_LABELS[job.stage])),
    h('p', { class: 'muted adm-job-acct' }, job.account ? `取り込み先アカウント: @${job.account.username}` : '取り込み先アカウント: 判定中…'),
    p ? h('div', { class: 'adm-progress' },
        h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': p.total, 'aria-valuenow': p.done },
          h('div', { class: 'bar-fill', style: `width:${pct ?? 0}%` })),
        h('span', { class: 'muted' }, `${num(p.done)} / ${num(p.total)}${pct === null ? '' : ` (${pct}%)`}`))
      : null,
    job.message ? h('p', { class: 'adm-msg' }, job.message) : null,
    h('p', { class: 'muted' }, `経過時間: ${elapsed(job, now)}`),
    job.error ? h('p', { class: 'adm-error-text', role: 'alert' }, job.error) : null,
    job.stage === 'done' && job.stats ? statsTable(job.stats) : null);
};

type ArchiveActions = {
  readonly ask: (name: string) => void;
  readonly cancel: () => void;
  readonly run: (name: string) => void;
};

const renderArchives = (list: readonly ArchiveFile[], s: State, act: ArchiveActions): Node => {
  const locked = isRunning(s.job) || s.starting;
  if (list.length === 0) return h('p', { class: 'muted' }, 'ZIPファイルが見つかりません');
  return h('div', { class: 'adm-archives' }, list.map((a) => {
    const confirming = s.pendingFile === a.name;
    return h('div', { class: 'arch-row', 'data-name': a.name },
      h('div', { class: 'arch-main' },
        h('div', { class: 'adm-file' }, a.name),
        h('div', { class: 'muted' }, `${gb(a.size)} ・ ${formatDateTime(a.modifiedAt)}`),
        a.imported ? h('span', { class: 'badge badge-imported' }, `取り込み済み (@${a.imported.username} ・ アーカイブ ${formatDay(a.imported.generatedAt)})`) : null),
      h('div', { class: 'arch-act' },
        confirming
          ? [h('span', { class: 'arch-q' }, '本当に取り込む？'),
             h('button', { type: 'button', class: 'btn btn-primary', onclick: () => act.run(a.name) }, '実行'),
             h('button', { type: 'button', class: 'btn', onclick: act.cancel }, 'やめる')]
          : h('button', { type: 'button', class: 'btn btn-import', disabled: locked, onclick: () => act.ask(a.name) }, '取り込む')));
  }));
};

const renderHistory = (list: readonly ImportRecord[], meta: Meta | null): Node => {
  const label = h('p', { class: 'muted adm-hist-acct' }, meta?.account ? `対象アカウント: @${meta.account.username} の取り込み履歴` : '取り込み履歴');
  if (list.length === 0) return h('div', null, label, h('p', { class: 'muted' }, '取り込み履歴はまだありません'));
  return h('div', null, label, h('div', { class: 'tbl-wrap' },
    h('table', { class: 'tbl adm-history' },
      h('thead', null, h('tr', null, ['完了日時', 'ファイル', 'アーカイブ日', 'ツイート', '消失'].map((t) => h('th', null, t)))),
      h('tbody', null, list.map((r) => {
        const rm = r.stats.removed;
        return h('tr', null,
          h('td', null, formatDateTime(r.finishedAt)),
          h('td', { class: 'adm-file' }, r.fileName),
          h('td', null, formatDay(r.generatedAt)),
          h('td', null, `追加 ${num(r.stats.tweets.added)} / 更新 ${num(r.stats.tweets.updated)}`),
          h('td', { title: `ツイート ${rm.tweets} / いいね ${rm.likes} / DM ${rm.dmMessages}` }, num(rm.tweets + rm.likes + rm.dmMessages)));
      })))));
};

// ---- 表示設定 (タイムゾーン) ----

const SOURCE_LABELS: Readonly<Record<Settings['timezoneSource'], string>> = {
  settings: '管理画面で設定', env: '環境変数', default: '既定(UTC)',
};

/** ブラウザが列挙できる IANA タイムゾーン名。未対応なら null (テキスト入力にフォールバック) */
const supportedZones = (): readonly string[] | null => {
  if (typeof Intl.supportedValuesOf !== 'function') return null;
  try {
    const list = Intl.supportedValuesOf('timeZone');
    return list.length > 0 ? list : null;
  } catch (e) {
    console.warn('[admin] Intl.supportedValuesOf failed', e);
    return null;
  }
};

const zonesWith = (extra: readonly string[]): readonly string[] | null => {
  const base = supportedZones();
  return base === null ? null : [...new Set([...base, 'UTC', ...extra])].sort();
};

type SettingsActions = {
  readonly picked: (tz: string) => void;
  readonly filtered: (text: string) => void;
  readonly save: () => void;
  readonly reset: () => void;
};

const renderSettings = (st: Settings, s: State, act: SettingsActions): Node => {
  const draft = s.tzDraft ?? st.timezone;
  const zones = zonesWith([st.timezone, ...(st.envTimezone ? [st.envTimezone] : []), draft]);
  const busy = s.savingTz;

  let field: HTMLInputElement | HTMLSelectElement;
  let filterRow: Node | null = null;
  if (zones === null) {
    const input = h('input', { type: 'text', class: 'tz-input', 'aria-label': 'タイムゾーン (IANA 名)', placeholder: 'Asia/Tokyo', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    input.value = draft;
    input.addEventListener('input', () => act.picked(input.value.trim()));
    field = input;
  } else {
    const select = h('select', { class: 'tz-select', 'aria-label': 'タイムゾーン' });
    const count = h('span', { class: 'muted tz-count' });
    const fill = (filter: string): void => {
      const f = filter.trim().toLowerCase();
      const keep = select.value || draft;
      const matches = zones.filter((z) => f === '' || z.toLowerCase().includes(f));
      const list = matches.includes(keep) ? matches : [keep, ...matches];
      select.replaceChildren(...list.map((z) => h('option', { value: z }, z)));
      select.value = keep;
      count.textContent = `${matches.length} 件`;
    };
    const filter = h('input', { type: 'search', class: 'tz-filter', 'aria-label': 'タイムゾーンを絞り込み', placeholder: '絞り込み (例: Tokyo)', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    filter.value = s.tzFilter;
    select.value = draft;
    fill(s.tzFilter);
    filter.addEventListener('input', () => {
      act.filtered(filter.value);
      fill(filter.value);
    });
    select.addEventListener('change', () => act.picked(select.value));
    filterRow = h('div', { class: 'tz-row' }, filter, count);
    field = select;
  }
  field.disabled = busy;

  return h('div', { class: 'adm-tz' },
    h('p', { class: 'adm-tz-now' }, '現在のタイムゾーン: ', h('strong', null, st.timezone), ' ', h('span', { class: 'badge tz-source' }, SOURCE_LABELS[st.timezoneSource])),
    st.envTimezone !== null ? h('p', { class: 'muted' }, `環境変数 TIMEZONE の値: ${st.envTimezone}`) : null,
    filterRow,
    h('div', { class: 'tz-row' }, field),
    h('div', { class: 'tz-row' },
      h('button', { type: 'button', class: 'btn btn-primary tz-save', disabled: busy, onclick: act.save }, busy ? '保存中…' : '保存'),
      h('button', { type: 'button', class: 'btn tz-reset', disabled: busy || st.timezoneSource !== 'settings', onclick: act.reset }, '環境変数/既定に戻す')),
    h('p', { class: 'muted' }, '日時の表示、期間での絞り込み、統計の集計に使われます。'));
};

type DangerActions = {
  readonly open: () => void;
  readonly cancel: () => void;
  readonly typed: (text: string) => void;
  readonly run: () => void;
};

const renderDanger = (s: State, act: DangerActions): Node => {
  const running = isRunning(s.job);
  const acct = s.meta?.account ?? null;
  if (acct === null) return h('p', { class: 'muted' }, '対象のアカウントがありません');
  const intro = h('p', { class: 'muted' }, `このアカウント(@${acct.username})のDBを削除します。メディアは残ります。`);
  if (!s.resetOpen) {
    return h('div', null, intro,
      h('button', { type: 'button', class: 'btn btn-danger', disabled: running || s.resetting, onclick: act.open }, 'データベースを作り直す'));
  }
  const exec = h('button', { type: 'button', class: 'btn btn-danger', disabled: s.resetText !== 'RESET' || running || s.resetting, onclick: act.run }, s.resetting ? '実行中…' : '実行');
  const input = h('input', { type: 'text', class: 'reset-input', 'aria-label': '確認のため RESET と入力', placeholder: 'RESET', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  input.value = s.resetText;
  input.addEventListener('input', () => {
    exec.disabled = input.value !== 'RESET' || running || s.resetting;
    act.typed(input.value);
  });
  return h('div', null, intro,
    h('p', null, '確認のため RESET と入力してください'),
    h('div', { class: 'reset-row' }, input, exec, h('button', { type: 'button', class: 'btn', onclick: act.cancel }, 'やめる')));
};

// ---- 画面 ----

type Section = {
  readonly host: HTMLElement;
  readonly view: (s: State) => Node;
  readonly deps: (s: State) => readonly unknown[];
};

export const createAdmin = (props: AdminProps): View => {
  let alive = true;
  let timer: number | undefined;
  let state: State = {
    archives: { kind: 'loading' }, history: { kind: 'loading' }, meta: null, settings: { kind: 'loading' }, savingTz: false, tzDraft: null, tzFilter: '', job: null, now: Date.now(),
    skipMedia: false, pendingFile: null, starting: false, notice: null, resetOpen: false, resetText: '', resetting: false,
  };

  const archiveActions: ArchiveActions = {
    ask: (name) => setState({ pendingFile: name, notice: null }),
    cancel: () => setState({ pendingFile: null }),
    run: (name) => void runImport(name),
  };
  const dangerActions: DangerActions = {
    open: () => setState({ resetOpen: true, resetText: '', notice: null }),
    cancel: () => setState({ resetOpen: false, resetText: '' }),
    typed: (text) => { state = { ...state, resetText: text }; },
    run: () => void runReset(),
  };

  const settingsActions: SettingsActions = {
    picked: (tz) => { state = { ...state, tzDraft: tz }; },
    filtered: (text) => { state = { ...state, tzFilter: text }; },
    save: () => void runSaveTz(state.tzDraft),
    reset: () => void runSaveTz(null),
  };

  const sect = (cls: string, view: Section['view'], deps: Section['deps']): Section =>
    ({ host: h('div', { class: cls }), view, deps });

  const skip = h('input', { type: 'checkbox', id: 'skip-media' });
  skip.addEventListener('change', () => { state = { ...state, skipMedia: skip.checked }; });

  const sections: readonly Section[] = [
    sect('adm-metaline', (s) => renderMetaLine(s.meta), (s) => [s.meta]),
    sect('adm-notices', (s) => renderNotice(s.notice), (s) => [s.notice]),
    sect('adm-job-host', (s) => renderJob(s.job, s.now), (s) => [s.job, s.now]),
    sect('adm-archives-host', (s) => loadBox(s.archives, (l) => renderArchives(l, s, archiveActions)),
      (s) => [s.archives, s.pendingFile, s.starting, isRunning(s.job)]),
    sect('adm-settings-host', (s) => loadBox(s.settings, (st) => renderSettings(st, s, settingsActions)), (s) => [s.settings, s.savingTz]),
    sect('adm-history-host', (s) => loadBox(s.history, (l) => renderHistory(l, s.meta)), (s) => [s.history, s.meta]),
    sect('adm-danger-host', (s) => renderDanger(s, dangerActions), (s) => [s.resetOpen, s.resetting, isRunning(s.job), s.meta]),
  ];
  const [metaLine, notices, jobHost, archivesHost, settingsHost, historyHost, dangerHost] = sections;

  const setState = (patch: Partial<State>): void => {
    if (!alive) return;
    const prev = state;
    state = { ...state, ...patch };
    for (const sec of sections) {
      const a = sec.deps(prev);
      const b = sec.deps(state);
      if (a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]))) sec.host.replaceChildren(sec.view(state));
    }
  };

  const card = (title: string, ...body: Child[]): HTMLElement =>
    h('section', { class: 'adm-card' }, h('h2', { class: 'adm-title' }, title), body);

  const el = h('section', { class: 'view view-admin' },
    h('div', { class: 'subhead' }, h('span', null, '管理')),
    h('div', { class: 'adm-body' },
      metaLine?.host,
      h('p', { class: 'adm-note' }, 'ZIPはデータフォルダの archive/ (コンテナ内では /data/archive) に置いてください。取り込みは既存データに追加・更新され、新しいアーカイブで消えたツイートやいいねも『消失』として残ります。ZIPを取り込むと、アーカイブ内のアカウントに自動で振り分けられます（新しいアカウントは自動で追加）'),
      notices?.host,
      card('表示設定', settingsHost?.host),
      card('取り込みジョブ', jobHost?.host),
      card('アーカイブ一覧', h('label', { class: 'chk adm-skip', for: 'skip-media' }, skip, 'メディア展開をスキップ'), archivesHost?.host),
      card('取り込み履歴', historyHost?.host),
      h('section', { class: 'adm-card adm-danger' }, h('h2', { class: 'adm-title' }, '危険な操作'), dangerHost?.host)));
  for (const sec of sections) sec.host.replaceChildren(sec.view(state));

  // ---- データ取得 ----

  const loadArchives = async (): Promise<void> => {
    try {
      setState({ archives: { kind: 'ok', value: await fetchArchives() } });
    } catch (e) {
      console.error('[admin] archives load failed', e);
      setState({ archives: { kind: 'error', message: `アーカイブ一覧を取得できませんでした: ${messageOf(e)}` } });
    }
  };
  const loadHistory = async (): Promise<void> => {
    try {
      setState({ history: { kind: 'ok', value: await fetchImports(props.account) } });
    } catch (e) {
      console.error('[admin] history load failed', e);
      setState({ history: { kind: 'error', message: `取り込み履歴を取得できませんでした: ${messageOf(e)}` } });
    }
  };
  const loadMeta = async (): Promise<void> => {
    try {
      setState({ meta: await fetchMeta(props.account) });
    } catch (e) {
      console.error('[admin] meta load failed', e);
      setState({ notice: { kind: 'error', text: `メタ情報を取得できませんでした: ${messageOf(e)}` } });
    }
  };

  const loadSettings = async (): Promise<void> => {
    try {
      setState({ settings: { kind: 'ok', value: await fetchSettings() } });
    } catch (e) {
      console.error('[admin] settings load failed', e);
      setState({ settings: { kind: 'error', message: `表示設定を取得できませんでした: ${messageOf(e)}` } });
    }
  };

  const refreshAll = async (): Promise<void> => {
    await Promise.all([loadArchives(), loadHistory(), loadMeta()]);
    try {
      await props.onChanged();
    } catch (e) {
      console.error('[admin] onChanged failed', e);
      setState({ notice: { kind: 'error', text: `画面の更新に失敗しました: ${messageOf(e)}` } });
    }
  };

  const schedule = (): void => {
    if (!alive) return;
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => void poll(), POLL_MS);
  };

  const poll = async (): Promise<void> => {
    timer = undefined;
    try {
      const job = await fetchImportStatus();
      if (!alive) return;
      const wasRunning = isRunning(state.job);
      setState({ job, now: Date.now() });
      if (isRunning(job)) schedule();
      else if (wasRunning) await refreshAll();
    } catch (e) {
      if (!alive) return;
      console.error('[admin] status poll failed', e);
      setState({ notice: { kind: 'error', text: `進捗を取得できませんでした: ${messageOf(e)}` } });
      schedule();
    }
  };

  const runImport = async (fileName: string): Promise<void> => {
    setState({ pendingFile: null, starting: true, notice: null });
    try {
      const job = await startImport({ fileName, skipMedia: state.skipMedia });
      setState({ job, starting: false, now: Date.now() });
      schedule();
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 409) {
        console.warn(`[admin] import already running: ${fileName}`);
        setState({ starting: false, notice: { kind: 'error', text: '取り込み実行中です' } });
        void poll();
      } else {
        console.error(`[admin] import start failed: ${fileName}`, e);
        setState({ starting: false, notice: { kind: 'error', text: `取り込みを開始できませんでした: ${messageOf(e)}` } });
      }
    }
  };

  /** timezone: null で画面設定を解除 (環境変数/既定に戻す)。保存後に日付表示を新しいタイムゾーンで描き直す */
  const runSaveTz = async (timezone: string | null): Promise<void> => {
    if (timezone !== null && timezone === '') {
      setState({ notice: { kind: 'error', text: 'タイムゾーンを入力してください' } });
      return;
    }
    setState({ savingTz: true, notice: null });
    try {
      const saved = await saveSettings(timezone);
      setDisplayTimeZone(saved.timezone);
      // 保持中のビューを破棄してから完了を表示する (古い表示タイムゾーンのまま戻れないように)
      await props.onChanged();
      setState({ settings: { kind: 'ok', value: saved }, savingTz: false, tzDraft: null, notice: { kind: 'info', text: `タイムゾーンを ${saved.timezone} にしました` } });
      await Promise.all([loadArchives(), loadHistory(), loadMeta()]);
    } catch (e) {
      console.error('[admin] settings save failed', e);
      setState({ savingTz: false, notice: { kind: 'error', text: `設定を保存できませんでした: ${messageOf(e)}` } });
    }
  };

  const runReset = async (): Promise<void> => {
    const target = state.meta?.account ?? null;
    if (state.resetText !== 'RESET' || target === null) return;
    setState({ resetting: true, notice: null });
    try {
      await resetDatabase(target.id);
      setState({ resetting: false, resetOpen: false, resetText: '', job: null, notice: { kind: 'info', text: `@${target.username} のデータベースを作り直しました。再度取り込みを行ってください。` } });
      await refreshAll();
    } catch (e) {
      const conflict = e instanceof ApiFailure && e.status === 409;
      if (!conflict) console.error('[admin] reset failed', e);
      const text = conflict ? '取り込み実行中です' : `リセットに失敗しました: ${messageOf(e)}`;
      setState({ resetting: false, notice: { kind: 'error', text } });
      if (e instanceof ApiFailure && e.status === 409) void poll();
    }
  };

  void loadArchives();
  void loadHistory();
  void loadMeta();
  void loadSettings();
  void poll();

  return {
    el,
    destroy: () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    },
  };
};
