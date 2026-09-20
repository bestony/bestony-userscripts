// ==UserScript==
// @name         QQ邮箱增强
// @namespace    https://github.com/bestony/bestony-userscripts
// @version      0.3.0
// @description  QQ邮箱：顶部一键查看未读邮件；工具栏一键把所选邮件标记为已读；隐藏工具栏「全部已读」
// @author       bestony
// @match        https://wx.mail.qq.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_info
// @connect      raw.githubusercontent.com
// @updateURL    https://raw.githubusercontent.com/bestony/bestony-userscripts/main/qqmail-plus.user.js
// @downloadURL  https://raw.githubusercontent.com/bestony/bestony-userscripts/main/qqmail-plus.user.js
// ==/UserScript==

(function () {
  'use strict';

  const LOG = '[qqmail+]';
  const log = (...args) => console.debug(LOG, ...args);

  /* ---------------- 1. 快速查看未读邮件 ---------------- */

  // 搜索页的查询条件存在 localStorage（key = <uin>:xmail_search-options），
  // hash 里的 searchKey 只是索引。所以：写一条「未读」条件 → 跳过去即可。
  function openUnreadSearch() {
    const uin = (document.cookie.match(/(?:^|;\s*)xm_uin=(\d+)/) || [])[1] || 'default';
    const storeKey = uin + ':xmail_search-options';
    const key = '9_' + Date.now();

    let store = { version: 3, items: [] };
    try {
      store = JSON.parse(localStorage.getItem(storeKey)) || store;
    } catch (e) {
      log('parse search options failed, fallback to empty store', e);
    }
    store.items = [{
      key,
      options: { type: 'mail', mailParams: { isUnread: true, keyword: '' }, mailParamsKeys: ['isUnread'] },
    }];
    localStorage.setItem(storeKey, JSON.stringify(store));
    log('open unread search, key =', key);

    const target = '#/search?searchKey=' + key;
    if (location.hash === target) location.hash = '#/list/1';
    location.hash = target;
  }

  /* ---------------- 2. 选中邮件 → 标记为已读 ---------------- */

  const isChecked = (el) =>
    el.classList.contains('mail-item-checked') || !!el.querySelector('.ui-checkbox-icon-checked');

  function selectedMailIds() {
    return [...document.querySelectorAll('.mail-list-page-item')]
      .filter(isChecked)
      .map((el) => el.dataset.mailid)
      .filter(Boolean);
  }

  // 站内「标记为」是个会自己收起来的弹出菜单，脚本去点它不稳定（尤其是搜索结果页）；
  // 这里直接打它背后的接口。func=4 = 标记为已读，folderid 取当前文件夹（搜索页用收件箱）。
  async function markReadApi(ids) {
    const sid = (document.cookie.match(/(?:^|;\s*)xm_sid=([^;]+)/) || [])[1];
    if (!sid) throw new Error('xm_sid not found in cookie');

    const folder = location.hash.match(/^#\/list\/(\d+)/);
    const body = new URLSearchParams({
      func: '4',
      folderid: folder ? folder[1] : '1',
      choose_type: '1',
      language: 'zh',
      r: Date.now() + '000',
      sid,
    });
    ids.forEach((id) => body.append('mailid', id));

    const res = await fetch('/mgr/mailmgr', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const json = await res.json();
    if (json && json.head && json.head.ret !== 0) throw new Error('mailmgr ret=' + json.head.ret);
    log('mark read ok:', ids);
  }

  // 站内标记后列表不会自动重渲染，所以这里直接改视图：
  // 未读搜索结果里把这一行去掉，普通列表里去掉未读样式。
  function updateView(ids) {
    const inSearch = location.hash.startsWith('#/search');
    let changed = 0;

    ids.forEach((id) => {
      const row = document.querySelector(`.mail-list-page-item[data-mailid="${CSS.escape(id)}"]`);
      if (!row) return;
      changed++;
      if (inSearch) return row.remove();
      row.querySelector('.senders-list')?.classList.remove('mail-unread');
      if (isChecked(row)) row.querySelector('.mail-checkbox').click(); // 顺手取消勾选
    });

    if (!inSearch && changed) {
      const total = document.querySelector('.frame-sidebar-menu[data-sidebar-dir-id="1"] .sidebar-menu-total');
      if (total) {
        const left = (parseInt(total.textContent, 10) || 0) - changed;
        if (left > 0) total.textContent = String(left);
        else total.remove();
      }
    }
    return changed;
  }

  async function markSelectedRead() {
    const ids = selectedMailIds();
    if (!ids.length) return toast('请先勾选邮件');
    try {
      await markReadApi(ids);
    } catch (e) {
      log('mark read failed', e);
      return toast('标记失败：' + e.message);
    }
    const changed = updateView(ids);
    toast('已把 ' + changed + ' 封标记为已读');
  }

  /* ---------------- 3. 页面注入 ---------------- */

  function nativeButton(text) {
    const btn = document.createElement('div');
    btn.className = 'qqmail-plus-btn xmail-ui-btn ui-btn-size32 ui-btn-border ui-btn-them-clear-gray';
    btn.setAttribute('data-a11y', 'button');
    const label = document.createElement('div');
    label.className = 'ui-btn-text';
    label.textContent = text;
    btn.append(label);
    return btn;
  }

  function injectHeader() {
    const header = document.querySelector('.frame-header');
    if (!header || header.querySelector('.qqmail-plus-header')) return;

    const box = document.createElement('div');
    box.className = 'qqmail-plus-header';
    const btn = nativeButton('未读');
    btn.title = '只看未读邮件';
    btn.addEventListener('click', openUnreadSearch);
    box.append(btn);

    // 插在搜索框之后、占位元素之前
    const anchor = header.querySelector('.frame-header-space');
    anchor ? header.insertBefore(box, anchor) : header.insertBefore(box, header.querySelector('.xmail-cmp-profile-btn'));
    log('header button injected');
  }

  function injectToolbar() {
    const wrap = document.querySelector('.mail-list-page-toolbar .ui-toolbar-ellipsis-btns');
    if (!wrap || wrap.querySelector('.qqmail-plus-markread')) return;

    const btn = nativeButton('标记已读');
    btn.classList.add('qqmail-plus-markread');
    btn.title = '把勾选的邮件标记为已读';
    btn.style.marginRight = '8px';
    btn.addEventListener('click', markSelectedRead);
    wrap.append(btn);
    log('toolbar button injected');
  }

  // 隐藏站内「全部已读」（包括窄屏下被收进「更多」菜单里的那个）
  function hideMarkAllRead() {
    document.querySelectorAll('.mail-list-page-toolbar .xmail-ui-btn').forEach((btn) => {
      if (btn.classList.contains('qqmail-plus-markread')) return;
      if (btn.textContent.trim() !== '全部已读') return;
      if (btn.classList.contains('qqmail-plus-hide')) return;
      btn.classList.add('qqmail-plus-hide');
      log('hid 全部已读');
    });
  }

  function ensureInjected() {
    injectHeader();
    injectToolbar();
    hideMarkAllRead();
  }

  /* ---------------- 自动检查更新 ---------------- */

  const SCRIPT_VERSION =
    (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '0.3.0';
  const UPDATE_URL = 'https://raw.githubusercontent.com/bestony/bestony-userscripts/main/qqmail-plus.user.js';
  const UPDATE_CHECK_KEY = 'qqmail-plus-update-check';
  const UPDATE_CHECK_INTERVAL = 12 * 3600 * 1000;
  const VERSION_RE = /\/\/\s*@version\s+([^\s]+)/;

  function parseVersion(v) {
    return String(v).split('.').map((n) => parseInt(n, 10) || 0);
  }

  function isNewer(remote, local) {
    const a = parseVersion(remote);
    const b = parseVersion(local);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] || 0;
      const y = b[i] || 0;
      if (x !== y) return x > y;
    }
    return false;
  }

  function showUpdateNotice(version) {
    if (document.querySelector('.qqmail-plus-update')) return;

    const bar = document.createElement('div');
    bar.className = 'qqmail-plus-update';

    const text = document.createElement('span');
    text.textContent = '发现新版本 v' + version + '（当前 v' + SCRIPT_VERSION + '）';

    const link = document.createElement('a');
    link.href = UPDATE_URL;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = '立即更新';

    const close = document.createElement('a');
    close.className = 'qqmail-plus-update-close';
    close.href = 'javascript:void(0)';
    close.title = '忽略';
    close.textContent = '×';
    close.addEventListener('click', () => bar.remove());

    bar.append(text, link, close);
    document.body.append(bar);
  }

  function checkUpdate(force) {
    if (typeof GM_xmlhttpRequest !== 'function') return;
    const now = Date.now();
    try {
      const last = Number(localStorage.getItem(UPDATE_CHECK_KEY)) || 0;
      if (!force && now - last < UPDATE_CHECK_INTERVAL) return;
    } catch (e) {
      /* ignore */
    }

    GM_xmlhttpRequest({
      method: 'GET',
      url: UPDATE_URL + '?t=' + now,
      timeout: 20000,
      onload: (res) => {
        if (res.status !== 200) return;
        const m = VERSION_RE.exec(res.responseText);
        if (!m) return;
        try {
          localStorage.setItem(UPDATE_CHECK_KEY, String(now));
        } catch (e) {
          /* ignore */
        }
        if (isNewer(m[1], SCRIPT_VERSION)) {
          log('update available:', SCRIPT_VERSION, '->', m[1]);
          showUpdateNotice(m[1]);
        }
      },
      onerror: () => log('update check failed'),
      ontimeout: () => log('update check failed'),
    });
  }

  /* ---------------- toast ---------------- */

  let toastTimer = 0;
  function toast(msg) {
    let el = document.querySelector('.qqmail-plus-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'qqmail-plus-toast';
      document.body.append(el);
    }
    el.textContent = msg;
    el.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-show'), 1800);
  }

  /* ---------------- boot ---------------- */

  const style = document.createElement('style');
  style.textContent = `
    .qqmail-plus-btn { cursor: pointer; }
    .qqmail-plus-hide { display: none !important; }
    .qqmail-plus-toast {
      position: fixed; left: 50%; bottom: 48px; z-index: 99999;
      padding: 10px 16px; border-radius: 6px;
      background: rgba(0, 0, 0, .78); color: #fff; font-size: 13px;
      opacity: 0; transform: translateX(-50%) translateY(8px);
      transition: opacity .18s, transform .18s; pointer-events: none;
    }
    .qqmail-plus-toast.is-show { opacity: 1; transform: translateX(-50%) translateY(0); }
    .qqmail-plus-update {
      position: fixed; top: 12px; left: 50%; z-index: 99999;
      display: flex; align-items: center; gap: 10px;
      padding: 8px 14px; border-radius: 8px;
      background: #1d9bf0; color: #fff; font-size: 13px;
      transform: translateX(-50%);
      box-shadow: 0 6px 20px rgba(0, 0, 0, .3);
    }
    .qqmail-plus-update a { color: #fff; font-weight: 600; text-decoration: underline; }
    .qqmail-plus-update-close { text-decoration: none !important; font-size: 16px; line-height: 1; opacity: .85; }
  `;
  document.head.append(style);

  checkUpdate();

  // SPA 路由，DOM 一直在变；debounce 后补齐注入（已注入时是空跑）
  let scheduled = 0;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = setTimeout(() => { scheduled = 0; ensureInjected(); }, 200);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  ensureInjected();

  // 控制台自测入口：__qqmailPlus.openUnreadSearch() / __qqmailPlus.markSelectedRead()
  window.__qqmailPlus = { openUnreadSearch, markSelectedRead, selectedMailIds, updateView, checkUpdate };
  log('loaded');
})();
