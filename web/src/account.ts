// 最後に選んだアカウントの保存 (localStorage)。ストレージが使えない環境でも動くよう、失敗は警告して続行する。

/** ビューが属するアカウント。account は URL に載せる id (既定アカウントなら undefined)、username は現在のアカウント名 (不明なら null) */
export type Scope = { readonly account: string | undefined; readonly username: string | null };

const KEY = 'twitter-archive-viewer.account';

export const loadStoredAccount = (): string | undefined => {
  try {
    const v = localStorage.getItem(KEY);
    return v !== null && v !== '' ? v : undefined;
  } catch (e) {
    console.warn('[account] localStorage を読めません', e);
    return undefined;
  }
};

export const storeAccount = (id: string): void => {
  try {
    localStorage.setItem(KEY, id);
  } catch (e) {
    console.warn('[account] localStorage に保存できません', e);
  }
};

/** 保存されているのが id と同じ場合だけ消す */
export const forgetStoredAccount = (id: string): void => {
  try {
    if (localStorage.getItem(KEY) === id) localStorage.removeItem(KEY);
  } catch (e) {
    console.warn('[account] localStorage から削除できません', e);
  }
};
