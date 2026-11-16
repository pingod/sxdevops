/**
 * 搜索定位面板：按柜号/名称/ID 精确或前缀匹配，最多 10 条，↑↓ 选择、Enter 定位、Esc 清空。
 */
import {
  searchObjects, searchStatus, matchSegments, typeLabelOf, normalizeLimit, resultHint,
} from '../features/searchplan.js';

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

export function createSearchPanel(cb = {}) {
  const el = document.createElement('div');
  el.className = 'vd-search';
  el.setAttribute('role', 'search');
  el.innerHTML = `
    <label class="vd-search-label" for="vd-search-input">搜索定位</label>
    <div class="vd-search-box">
      <span class="vd-search-ico" aria-hidden="true">⌕</span>
      <input id="vd-search-input" class="vd-search-input" type="search"
        placeholder="柜号 / 名称 / ID，如 A01" autocomplete="off" autocapitalize="off"
        spellcheck="false" maxlength="64" role="combobox" aria-autocomplete="list"
        aria-expanded="false" aria-controls="vd-search-list" aria-label="搜索柜号、名称或 ID">
      <button type="button" class="vd-search-clear" data-search-clear aria-label="清空搜索" hidden>×</button>
    </div>
    <ul id="vd-search-list" class="vd-search-list" role="listbox" aria-label="搜索结果" hidden></ul>
    <div class="vd-search-foot">
      <span class="vd-search-status" role="status" aria-live="polite">
        <b class="vd-search-status-text"></b><small class="vd-search-status-hint"></small>
      </span>
      <small class="vd-search-note">精确/前缀 · 最多 10 条 · Enter 定位 · Esc 清空</small>
    </div>`;

  const input = el.querySelector('.vd-search-input');
  const clearBtn = el.querySelector('[data-search-clear]');
  const list = el.querySelector('.vd-search-list');
  const statusText = el.querySelector('.vd-search-status-text');
  const statusHint = el.querySelector('.vd-search-status-hint');

  let index = null;
  let indexRef = null;
  let results = [];
  let active = -1;
  let busy = false;
  let composing = false;

  function buildIndex() {
    const objects = cb.getObjects ? cb.getObjects() : [];
    if (objects !== indexRef) {
      indexRef = objects;
      index = objects;
    }
    return objects;
  }

  function highlight(text, q) {
    const segs = matchSegments(text, q);
    if (!Array.isArray(segs) || !segs.length) return esc(text);
    return segs.map(s => (s.hit ? `<mark>${esc(s.text)}</mark>` : esc(s.text))).join('');
  }

  function render() {
    const q = input.value;
    const objects = buildIndex();
    const limit = normalizeLimit(10);
    if (!q.trim()) {
      results = [];
      active = -1;
      list.hidden = true;
      list.innerHTML = '';
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      setStatus(searchStatus({ query: '', results: [], total: 0 }));
      clearBtn.hidden = true;
      el.dataset.state = busy ? 'busy' : 'idle';
      return results;
    }
    const res = searchObjects(objects, q, { limit });
    results = res.results || [];
    active = results.length ? 0 : -1;
    const status = searchStatus(res);
    setStatus(status);
    el.dataset.state = status.kind;
    clearBtn.hidden = false;
    input.setAttribute('aria-expanded', results.length ? 'true' : 'false');
    list.innerHTML = results.map((r, i) => {
      const nameHtml = r.via === 'id' && r.name
        ? `${esc(r.label)} <span class="vd-search-id">ID ${highlight(r.id, q)}</span>`
        : highlight(r.label, q);
      const hint = resultHint(r);
      const match = r.name && r.id ? `${r.name} · ID ${r.id}` : r.label;
      return `<li class="vd-search-li" role="none"><button type="button" class="vd-search-item" role="option"
        id="vd-search-opt-${i}" data-search-index="${i}" data-object-id="${esc(r.id)}"
        aria-selected="${i === active ? 'true' : 'false'}"
        title="${esc(match)}">
        <span class="vd-search-item-ico" aria-hidden="true">◆</span>
        <span class="vd-search-txt"><b class="vd-search-name">${nameHtml}</b>
        <small class="vd-search-hint">${esc(hint)}</small></span></button></li>`;
    }).join('');
    list.hidden = results.length === 0;
    if (active >= 0) setActive(active, false);
    return results;
  }

  function setStatus(status) {
    const s = status || { text: '', hint: '', kind: 'idle' };
    statusText.textContent = s.text || '';
    statusHint.textContent = s.hint || '';
    statusText.classList.toggle('is-empty', s.kind === 'empty');
    statusText.classList.toggle('is-more', s.kind === 'more');
  }

  function setActive(i, scroll = true) {
    if (!results.length) {
      active = -1;
      return;
    }
    active = (i + results.length) % results.length;
    for (const b of list.querySelectorAll('[data-search-index]')) {
      const on = +b.dataset.searchIndex === active;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.classList.toggle('is-active', on);
      if (on && scroll) b.scrollIntoView({ block: 'nearest' });
    }
    input.setAttribute('aria-activedescendant', 'vd-search-opt-' + active);
  }

  function activate(i) {
    const r = results[i];
    if (!r) return false;
    input.blur();
    const ok = cb.onLocate ? cb.onLocate(r.obj) : false;
    if (ok) {
      input.value = '';
      render();
      if (cb.onClose) cb.onClose();
    } else {
      setStatus({ kind: 'empty', text: '定位失败 · 对象不在当前场景', hint: '刷新项目后重试' });
    }
    return ok;
  }

  input.addEventListener('input', () => {
    if (composing) return;
    render();
  });
  input.addEventListener('compositionstart', () => {
    composing = true;
  });
  input.addEventListener('compositionend', () => {
    composing = false;
    render();
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (results.length) setActive(active + 1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length) setActive(active - 1);
      return;
    }
    if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
      return;
    }
    if (e.key === 'End') {
      e.preventDefault();
      setActive(results.length - 1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (input.value.trim()) activate(active < 0 ? 0 : active);
      else render();
      return;
    }
    if (e.key === 'Escape') {
      if (handleEscape()) e.stopPropagation();
    }
  });
  input.addEventListener('focus', () => input.select());
  clearBtn.addEventListener('click', () => {
    input.value = '';
    render();
    input.focus();
  });
  list.addEventListener('pointerdown', e => {
    const b = e.target.closest('[data-search-index]');
    if (b) e.preventDefault();
  });
  list.addEventListener('click', e => {
    const b = e.target.closest('[data-search-index]');
    if (b) activate(+b.dataset.searchIndex);
  });

  function focus() {
    input.focus({ preventScroll: true });
    input.select();
    render();
  }

  /** 有内容则清空并消费 Esc */
  function handleEscape() {
    if (input.value || !list.hidden) {
      input.value = '';
      render();
      return true;
    }
    return false;
  }

  function setBusy(v) {
    busy = !!v;
    input.disabled = busy;
    if (busy) {
      results = [];
      list.hidden = true;
      list.innerHTML = '';
      setStatus(busy ? { kind: 'busy', text: '巡视 / 爆炸中不可搜索', hint: '结束当前模式后再试' } : searchStatus({ query: input.value, results: [], total: 0 }));
    } else {
      render();
    }
  }

  function refresh() {
    // 对象集合变化时重建结果
    if (input.value) render();
    else setStatus(busy
      ? { kind: 'busy', text: '巡视 / 爆炸中不可搜索', hint: '结束当前模式后再试' }
      : searchStatus({ query: '', results: [], total: 0 }));
  }

  function info() {
    return {
      query: input.value,
      results: results.length,
      active,
      busy,
      state: el.dataset.state || 'idle',
      status: { text: statusText.textContent, hint: statusHint.textContent },
    };
  }

  return { el, focus, handleEscape, setBusy, refresh, info, render };
}
