import { h } from './dom.ts';

/** 画像ライトボックス。body 直下に 1 つだけオーバーレイを作る */
export const openLightbox = (urls: readonly string[], startIndex: number): void => {
  if (urls.length === 0) return;
  let index = Math.min(Math.max(startIndex, 0), urls.length - 1);

  const img = h('img', { class: 'lb-img', alt: '' });
  const counter = h('div', { class: 'lb-counter' });
  const prev = h('button', { type: 'button', class: 'lb-nav lb-prev', 'aria-label': '前へ' }, '‹');
  const next = h('button', { type: 'button', class: 'lb-nav lb-next', 'aria-label': '次へ' }, '›');
  const closeBtn = h('button', { type: 'button', class: 'lb-close', 'aria-label': '閉じる' }, '×');
  const overlay = h('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': '画像表示' },
    h('div', { class: 'lb-stage' }, img), counter, closeBtn, urls.length > 1 ? [prev, next] : null);

  const show = (i: number): void => {
    index = (i + urls.length) % urls.length;
    img.src = urls[index] ?? '';
    counter.textContent = urls.length > 1 ? `${index + 1} / ${urls.length}` : '';
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') show(index - 1);
    else if (e.key === 'ArrowRight') show(index + 1);
  };

  let startX = 0;
  let startY = 0;
  overlay.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    if (t) { startX = t.clientX; startY = t.clientY; }
  }, { passive: true });
  overlay.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) show(index + (dx < 0 ? 1 : -1));
    else if (dy > 90 && Math.abs(dy) > Math.abs(dx)) close();
  }, { passive: true });

  const previousOverflow = document.body.style.overflow;
  function close(): void {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    document.body.style.overflow = previousOverflow;
  }

  prev.addEventListener('click', (e) => { e.stopPropagation(); show(index - 1); });
  next.addEventListener('click', (e) => { e.stopPropagation(); show(index + 1); });
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay || (e.target as Element).classList.contains('lb-stage')) close(); });

  document.addEventListener('keydown', onKey);
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
  show(index);
  closeBtn.focus();
};
