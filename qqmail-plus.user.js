// ==UserScript==
// @name         QQ邮箱增强
// @namespace    https://github.com/bestony/userscripts
// @version      0.2.0
// @description  QQ邮箱：顶部一键查看未读邮件；工具栏一键把所选邮件标记为已读；隐藏工具栏「全部已读」
// @author       bestony
// @match        https://wx.mail.qq.com/*
// @run-at       document-idle
// @grant        none
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
  `;
  document.head.append(style);

  // SPA 路由，DOM 一直在变；debounce 后补齐注入（已注入时是空跑）
  let scheduled = 0;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = setTimeout(() => { scheduled = 0; ensureInjected(); }, 200);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  ensureInjected();

  // 控制台自测入口：__qqmailPlus.openUnreadSearch() / __qqmailPlus.markSelectedRead()
  window.__qqmailPlus = { openUnreadSearch, markSelectedRead, selectedMailIds, updateView };
  log('loaded');
})();
