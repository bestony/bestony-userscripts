// ==UserScript==
// @name         X Pro Deck 智能屏蔽
// @namespace    https://github.com/bestony/userscripts
// @version      0.2.0
// @description  X Pro Deck（pro.x.com）：关键词规则优先，未命中再调用 TypeSafe JEV 模型智能判别，屏蔽赌博/博彩等引流推广内容
// @author       bestony
// @match        https://pro.x.com/i/decks/*
// @grant        GM_xmlhttpRequest
// @connect      api.typesafe.ai
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ======================= 配置 ======================= */

  const DEFAULT_API_KEY = ''; // 默认 TypeSafe API Key（https://docs.typesafe.ai），可在右下角「设置」面板里覆盖
  const MODEL_NAME = 'jev-latest';
  const BASE_URL = 'https://api.typesafe.ai/v1/systemone';

  // 默认关键词规则：命中任意一个直接屏蔽。运行中可在右下角「设置」面板里增删
  const DEFAULT_KEYWORDS = [
    '彩票',
    '六合彩',
    '大轮盘',
    '太阳城',
  ];

  const BLOCK_THRESHOLD = 0.5; // JEV 概率 ≥ 该值即判定为需要屏蔽
  const MAX_CONCURRENT = 2; // 同时进行的智能判别请求数
  const MAX_RETRY = 3; // 429 / 529 / 网络错误重试次数
  const CACHE_TTL = 7 * 24 * 3600 * 1000; // 结果缓存有效期（7 天）

  const ENABLE_KEY = 'xdeck-filter-enabled';
  const KEYWORDS_KEY = 'xdeck-filter-keywords';
  const API_KEY_KEY = 'xdeck-filter-apikey';
  const CACHE_KEY = 'xdeck-filter-cache-v1';
  const LOG = '[xdeck-filter]';
  const log = (...args) => console.debug(LOG, ...args);

  /* ==================== API Key 配置 ==================== */

  function loadApiKey() {
    try {
      const stored = localStorage.getItem(API_KEY_KEY);
      if (stored !== null) return stored;
    } catch (e) {
      /* ignore */
    }
    return DEFAULT_API_KEY;
  }

  let apiKey = loadApiKey();

  function saveApiKey() {
    try {
      localStorage.setItem(API_KEY_KEY, apiKey);
    } catch (e) {
      log('save api key failed', e);
    }
  }

  /* ==================== 关键词配置 ==================== */

  function loadKeywords() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEYWORDS_KEY));
      if (Array.isArray(raw)) return raw.filter((k) => typeof k === 'string' && k.trim());
    } catch (e) {
      /* ignore */
    }
    return DEFAULT_KEYWORDS.slice();
  }

  let keywords = loadKeywords();

  function saveKeywords() {
    try {
      localStorage.setItem(KEYWORDS_KEY, JSON.stringify(keywords));
    } catch (e) {
      log('save keywords failed', e);
    }
  }

  function matchKeyword(text) {
    return keywords.find((k) => k && text.indexOf(k) !== -1) || '';
  }

  /* ==================== 智能判别（JEV） ==================== */

  const QUESTION = {
    type: 'noul',
    instructions:
      '这条推文是否属于应被屏蔽的垃圾引流内容？包括赌博/博彩/彩票/棋牌平台推广，以及色情、诈骗、办证、刷单、外挂等违法违规或黑灰产广告。',
    criteria: {
      true: '在推广赌博、博彩、彩票、棋牌等平台，或色情、诈骗、办证、刷单等黑灰产引流广告',
      false: '正常的技术、新闻、生活、观点分享，不涉及上述引流推广',
    },
  };

  function postJSON(body, retries) {
    return new Promise((resolve, reject) => {
      const retryLater = (reason) => {
        if (retries <= 0) return reject(reason);
        const wait = (MAX_RETRY - retries + 1) * 1000;
        setTimeout(() => postJSON(body, retries - 1).then(resolve, reject), wait);
      };

      GM_xmlhttpRequest({
        method: 'POST',
        url: BASE_URL,
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + apiKey,
        },
        data: JSON.stringify(body),
        timeout: 30000,
        onload: (res) => {
          if (res.status === 200) {
            try {
              resolve(JSON.parse(res.responseText));
            } catch (e) {
              reject(e);
            }
            return;
          }
          if (res.status === 429 || res.status === 529) return retryLater(new Error('HTTP ' + res.status));
          reject(new Error('HTTP ' + res.status + ' ' + res.responseText));
        },
        onerror: () => retryLater(new Error('network error')),
        ontimeout: () => retryLater(new Error('timeout')),
      });
    });
  }

  async function judge(text) {
    const json = await postJSON(
      { state: text, model: MODEL_NAME, questions: { blocked: QUESTION } },
      MAX_RETRY,
    );
    const answer = json && json.answers && json.answers.blocked;
    if (!answer || typeof answer.noul !== 'number') throw new Error('unexpected response');
    return answer.noul;
  }

  /* ====================== 缓存 ====================== */

  function loadCache() {
    try {
      const raw = JSON.parse(localStorage.getItem(CACHE_KEY)) || {};
      const now = Date.now();
      const out = {};
      Object.keys(raw).forEach((k) => {
        if (raw[k] && now - raw[k].t < CACHE_TTL) out[k] = raw[k];
      });
      return out;
    } catch (e) {
      return {};
    }
  }

  const cache = loadCache();
  let saveTimer = 0;
  function saveCache() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
      } catch (e) {
        log('save cache failed', e);
      }
    }, 1000);
  }

  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function normalize(text) {
    return text.replace(/\s+/g, ' ').trim().slice(0, 2000);
  }

  /* ===================== 并发队列 ===================== */

  const queue = [];
  let active = 0;

  function enqueue(task) {
    queue.push(task);
    pump();
  }

  function pump() {
    while (active < MAX_CONCURRENT && queue.length) {
      const task = queue.shift();
      active++;
      task().finally(() => {
        active--;
        pump();
      });
    }
  }

  /* ====================== 扫描 ====================== */

  let enabled = localStorage.getItem(ENABLE_KEY) !== '0';
  let blockedCount = 0;
  const inFlight = new Set();

  function tweetText(article) {
    return [...article.querySelectorAll('[data-testid="tweetText"]')]
      .map((el) => el.textContent)
      .join('\n');
  }

  function apply(container, blocked, key) {
    container.dataset.sfKey = key;
    container.dataset.sfState = blocked ? 'blocked' : 'allowed';
    container.classList.toggle('xdeck-filter-blocked', blocked);
    if (blocked) {
      blockedCount++;
      refreshBadge();
    }
  }

  function scan() {
    if (!enabled) return;

    document.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
      const text = normalize(tweetText(article));
      if (!text) return;

      const container = article.closest('[data-testid="cellInnerDiv"]') || article;
      const key = hash(text);

      // 节点被回收复用时，先清掉上一条内容留下的状态
      if (container.dataset.sfKey !== key) {
        container.dataset.sfKey = '';
        container.dataset.sfState = '';
        container.classList.remove('xdeck-filter-blocked');
      }

      if (container.dataset.sfState === 'blocked' || container.dataset.sfState === 'allowed') return;

      // 1) 关键词规则优先
      const hit = matchKeyword(text);
      if (hit) {
        log('keyword hit:', hit, text.slice(0, 40));
        apply(container, true, key);
        return;
      }

      // 2) 命中缓存
      if (cache[key]) {
        apply(container, !!cache[key].b, key);
        return;
      }

      // 3) 无 API Key 时只跑关键词
      if (!apiKey) return;

      if (inFlight.has(key)) return;
      inFlight.add(key);
      container.dataset.sfState = 'pending';

      enqueue(() =>
        judge(text).then((p) => {
          const blocked = p >= BLOCK_THRESHOLD;
          cache[key] = { b: blocked, t: Date.now() };
          saveCache();
          log('jev:', p.toFixed(3), blocked ? 'blocked' : 'keep', text.slice(0, 40));
          apply(container, blocked, key);
        }).catch((e) => {
          log('jev failed:', e.message, text.slice(0, 40));
          container.dataset.sfState = '';
        }).finally(() => {
          inFlight.delete(key);
        }),
      );
    });
  }

  // 重置所有卡片的判定状态，然后重新扫描（关键词或缓存变更后调用）
  function rescanAll() {
    document.querySelectorAll('[data-sf-key]').forEach((el) => {
      el.classList.remove('xdeck-filter-blocked');
      el.dataset.sfKey = '';
      el.dataset.sfState = '';
    });
    blockedCount = 0;
    refreshBadge();
    scan();
  }

  /* ======================= UI ======================= */

  let badge;
  let panel;
  let chipsEl;
  let contextMenu;

  function refreshBadge() {
    if (!badge) return;
    badge.querySelector('.xdeck-filter-count').textContent = String(blockedCount);
    badge.querySelector('.xdeck-filter-toggle').textContent = enabled ? '关闭' : '开启';
    badge.classList.toggle('xdeck-filter-off', !enabled);
  }

  function renderChips() {
    if (!chipsEl) return;
    chipsEl.textContent = '';

    if (!keywords.length) {
      const empty = document.createElement('span');
      empty.className = 'xdeck-filter-empty';
      empty.textContent = '暂无关键词';
      chipsEl.append(empty);
      return;
    }

    keywords.forEach((kw) => {
      const chip = document.createElement('span');
      chip.className = 'xdeck-filter-chip';

      const label = document.createElement('span');
      label.textContent = kw;

      const del = document.createElement('a');
      del.className = 'xdeck-filter-chip-del';
      del.href = 'javascript:void(0)';
      del.title = '删除';
      del.textContent = '×';
      del.addEventListener('click', () => {
        keywords = keywords.filter((k) => k !== kw);
        saveKeywords();
        renderChips();
        rescanAll();
      });

      chip.append(label, del);
      chipsEl.append(chip);
    });
  }

  // 拆分输入：用空格、英文/中文逗号或换行分隔
  function splitKeywords(raw) {
    return String(raw || '')
      .split(/[\s,，]+/)
      .map((k) => k.trim())
      .filter(Boolean);
  }

  // 去重，保持原有顺序
  function uniqueKeywords(list) {
    const seen = new Set();
    return list.filter((k) => {
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // 支持一次添加多个关键词，自动去重（含本次输入内部的重复）
  function addKeywords(raw) {
    const seen = new Set(keywords);
    let added = false;

    splitKeywords(raw).forEach((kw) => {
      if (seen.has(kw)) return;
      seen.add(kw);
      keywords.push(kw);
      added = true;
    });

    if (!added) return;

    saveKeywords();
    renderChips();
    rescanAll();
  }

  function clearKeywordCache() {
    Object.keys(cache).forEach((k) => delete cache[k]);
    try {
      localStorage.removeItem(CACHE_KEY);
    } catch (e) {
      /* ignore */
    }
    rescanAll();
  }

  function openPanel() {
    if (!panel) return;
    panel.classList.add('xdeck-filter-open');
  }

  function closePanel() {
    if (panel) panel.classList.remove('xdeck-filter-open');
  }

  function injectPanel() {
    if (panel || !document.body) return;

    panel = document.createElement('div');
    panel.className = 'xdeck-filter-panel';

    const head = document.createElement('div');
    head.className = 'xdeck-filter-panel-head';
    const title = document.createElement('span');
    title.textContent = '屏蔽设置';
    const close = document.createElement('a');
    close.className = 'xdeck-filter-panel-close';
    close.href = 'javascript:void(0)';
    close.title = '关闭';
    close.textContent = '×';
    close.addEventListener('click', closePanel);
    head.append(title, close);

    // API Key 配置
    const keyRow = document.createElement('div');
    keyRow.className = 'xdeck-filter-key';
    const keyLabel = document.createElement('div');
    keyLabel.className = 'xdeck-filter-key-label';
    keyLabel.textContent = 'TypeSafe API Key';
    const keyStatus = document.createElement('span');
    keyStatus.className = 'xdeck-filter-key-status';
    keyLabel.append(keyStatus);

    const keyInputRow = document.createElement('div');
    keyInputRow.className = 'xdeck-filter-panel-row';
    const keyInput = document.createElement('input');
    keyInput.className = 'xdeck-filter-apikey';
    keyInput.type = 'password';
    keyInput.placeholder = '粘贴 API Key，留空仅用关键词';
    keyInput.value = apiKey;
    const keySave = document.createElement('button');
    keySave.className = 'xdeck-filter-save';
    keySave.type = 'button';
    keySave.textContent = '保存';

    const updateKeyStatus = () => {
      const configured = !!apiKey;
      keyStatus.textContent = configured ? '已配置' : '未配置（仅关键词）';
      keyStatus.classList.toggle('xdeck-filter-key-on', configured);
    };
    const saveKey = () => {
      apiKey = keyInput.value.trim();
      saveApiKey();
      updateKeyStatus();
      rescanAll();
    };
    keySave.addEventListener('click', saveKey);
    keyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveKey();
    });
    keyInputRow.append(keyInput, keySave);
    keyRow.append(keyLabel, keyInputRow);
    updateKeyStatus();

    const row = document.createElement('div');
    row.className = 'xdeck-filter-panel-row';
    const input = document.createElement('textarea');
    input.className = 'xdeck-filter-input';
    input.rows = 2;
    input.placeholder = '多个关键词用空格、逗号或换行分隔';
    const add = document.createElement('button');
    add.className = 'xdeck-filter-add';
    add.type = 'button';
    add.textContent = '添加';
    const submit = () => {
      addKeywords(input.value);
      input.value = '';
      input.focus();
    };
    add.addEventListener('click', submit);
    // 回车换行；Ctrl/Cmd + 回车提交
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
    });
    row.append(input, add);

    chipsEl = document.createElement('div');
    chipsEl.className = 'xdeck-filter-chips';

    const foot = document.createElement('div');
    foot.className = 'xdeck-filter-panel-foot';
    const reset = document.createElement('button');
    reset.className = 'xdeck-filter-reset';
    reset.type = 'button';
    reset.textContent = '恢复默认';
    reset.addEventListener('click', () => {
      keywords = DEFAULT_KEYWORDS.slice();
      saveKeywords();
      renderChips();
      rescanAll();
    });
    const clear = document.createElement('button');
    clear.className = 'xdeck-filter-clear';
    clear.type = 'button';
    clear.textContent = '清除智能缓存';
    clear.title = '清除 JEV 判定缓存，重新请求判别';
    clear.addEventListener('click', clearKeywordCache);
    foot.append(reset, clear);

    panel.append(head, keyRow, row, chipsEl, foot);
    document.body.append(panel);
    renderChips();
  }

  /* ==================== 选中文字右键菜单 ==================== */

  // 获取当前选中的纯文本（排除输入框内的选区）
  function getSelectionText() {
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
      return '';
    }
    const sel = window.getSelection();
    return sel ? sel.toString().replace(/\s+/g, ' ').trim() : '';
  }

  function hideContextMenu() {
    if (contextMenu) contextMenu.classList.remove('xdeck-filter-menu-open');
  }

  function showContextMenu(x, y, text) {
    if (!contextMenu) return;

    const label = text.length > 24 ? text.slice(0, 24) + '…' : text;
    contextMenu.textContent = '';

    const add = document.createElement('a');
    add.className = 'xdeck-filter-menu-item';
    add.href = 'javascript:void(0)';
    add.textContent = '加入屏蔽词：' + label;
    add.addEventListener('click', () => {
      addKeywords(text);
      hideContextMenu();
    });

    contextMenu.append(add);
    contextMenu.classList.add('xdeck-filter-menu-open');

    // 定位到鼠标位置，并避免超出视口
    const rect = contextMenu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 8);
    const top = Math.min(y, window.innerHeight - rect.height - 8);
    contextMenu.style.left = Math.max(8, left) + 'px';
    contextMenu.style.top = Math.max(8, top) + 'px';
  }

  function injectContextMenu() {
    if (contextMenu || !document.body) return;

    contextMenu = document.createElement('div');
    contextMenu.className = 'xdeck-filter-menu';
    document.body.append(contextMenu);

    document.addEventListener('contextmenu', (e) => {
      const text = getSelectionText();
      if (!text) {
        hideContextMenu();
        return;
      }
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, text);
    });

    document.addEventListener('mousedown', (e) => {
      if (contextMenu && !contextMenu.contains(e.target)) hideContextMenu();
    });
    document.addEventListener('scroll', hideContextMenu, true);
    window.addEventListener('resize', hideContextMenu);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideContextMenu();
    });
  }

  function injectBadge() {
    if (badge || !document.body) return;

    badge = document.createElement('div');
    badge.className = 'xdeck-filter-badge';

    const count = document.createElement('span');
    count.className = 'xdeck-filter-count';
    count.textContent = '0';

    const label = document.createElement('span');
    label.textContent = ' 条已屏蔽 · ';

    const toggle = document.createElement('a');
    toggle.className = 'xdeck-filter-toggle';
    toggle.href = 'javascript:void(0)';
    toggle.addEventListener('click', () => {
      enabled = !enabled;
      localStorage.setItem(ENABLE_KEY, enabled ? '1' : '0');
      if (!enabled) {
        document.querySelectorAll('.xdeck-filter-blocked').forEach((el) => {
          el.classList.remove('xdeck-filter-blocked');
          el.dataset.sfState = '';
        });
        blockedCount = 0;
        refreshBadge();
      } else {
        scan();
      }
    });

    const sep = document.createElement('span');
    sep.textContent = ' · ';

    const settings = document.createElement('a');
    settings.className = 'xdeck-filter-settings';
    settings.href = 'javascript:void(0)';
    settings.textContent = '设置';
    settings.addEventListener('click', () => {
      if (!panel) return;
      panel.classList.contains('xdeck-filter-open') ? closePanel() : openPanel();
    });

    badge.append(count, label, toggle, sep, settings);
    document.body.append(badge);
    refreshBadge();
  }

  /* ====================== 启动 ====================== */

  const style = document.createElement('style');
  style.textContent = `
    .xdeck-filter-blocked { display: none !important; }
    .xdeck-filter-badge {
      position: fixed; right: 16px; bottom: 16px; z-index: 99999;
      padding: 6px 12px; border-radius: 999px;
      background: rgba(0, 0, 0, .78); color: #fff; font-size: 12px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      user-select: none;
    }
    .xdeck-filter-badge.xdeck-filter-off { opacity: .45; }
    .xdeck-filter-badge a { color: #1d9bf0; text-decoration: none; }
    .xdeck-filter-panel {
      position: fixed; right: 16px; bottom: 52px; z-index: 99999;
      display: none; flex-direction: column; gap: 10px;
      width: 300px; padding: 14px; border-radius: 12px;
      background: #15202b; color: #e7e9ea; font-size: 13px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      box-shadow: 0 8px 28px rgba(0, 0, 0, .45);
    }
    .xdeck-filter-panel.xdeck-filter-open { display: flex; }
    .xdeck-filter-panel-head {
      display: flex; align-items: center; justify-content: space-between;
      font-weight: 600; font-size: 14px;
    }
    .xdeck-filter-panel-close { color: #8b98a5 !important; font-size: 18px; line-height: 1; }
    .xdeck-filter-panel-row { display: flex; gap: 8px; align-items: flex-start; }
    .xdeck-filter-key { display: flex; flex-direction: column; gap: 6px; }
    .xdeck-filter-key-label {
      display: flex; align-items: baseline; justify-content: space-between;
      color: #8b98a5; font-size: 12px;
    }
    .xdeck-filter-key-status { font-size: 11px; color: #f4212e; }
    .xdeck-filter-key-status.xdeck-filter-key-on { color: #00ba7c; }
    .xdeck-filter-input, .xdeck-filter-apikey {
      flex: 1; min-width: 0; padding: 7px 9px; border-radius: 6px;
      border: 1px solid #38444d; background: #192734; color: #e7e9ea; font-size: 13px;
    }
    textarea.xdeck-filter-input {
      min-height: 46px; resize: vertical; line-height: 1.4; font-family: inherit;
    }
    .xdeck-filter-add, .xdeck-filter-save, .xdeck-filter-reset, .xdeck-filter-clear {
      padding: 7px 10px; border-radius: 6px; border: none; cursor: pointer;
      background: #1d9bf0; color: #fff; font-size: 13px; white-space: nowrap;
    }
    .xdeck-filter-reset, .xdeck-filter-clear { background: #253341; color: #e7e9ea; }
    .xdeck-filter-chips { display: flex; flex-wrap: wrap; gap: 6px; max-height: 180px; overflow: auto; }
    .xdeck-filter-chip {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 3px 8px; border-radius: 999px; background: #253341; font-size: 12px;
    }
    .xdeck-filter-chip-del { color: #8b98a5 !important; font-size: 14px; line-height: 1; }
    .xdeck-filter-empty { color: #8b98a5; }
    .xdeck-filter-panel-foot { display: flex; gap: 8px; }
    .xdeck-filter-menu {
      position: fixed; z-index: 100000; display: none; min-width: 140px;
      padding: 4px; border-radius: 8px; background: #15202b;
      box-shadow: 0 8px 24px rgba(0, 0, 0, .5); border: 1px solid #38444d;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .xdeck-filter-menu.xdeck-filter-menu-open { display: block; }
    .xdeck-filter-menu-item {
      display: block; padding: 8px 10px; border-radius: 6px;
      color: #e7e9ea !important; font-size: 13px; text-decoration: none; white-space: nowrap;
    }
    .xdeck-filter-menu-item:hover { background: #1d9bf0; }
  `;
  document.head.append(style);

  let scheduled = 0;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = 0;
      injectBadge();
      injectPanel();
      injectContextMenu();
      scan();
    }, 300);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  injectBadge();
  injectPanel();
  injectContextMenu();
  scan();
  setInterval(scan, 3000); // 兜底：UI 虚拟滚动偶尔不触发 MutationObserver

  if (!apiKey) log('未配置 API Key，仅启用关键词规则');

  // 控制台自测入口：__xdeckFilter.scan() / getKeywords() / setKeywords([...]) / setApiKey('...')
  window.__xdeckFilter = {
    scan,
    cache,
    judge,
    getKeywords: () => keywords.slice(),
    setKeywords: (list) => {
      keywords = uniqueKeywords((list || []).map((k) => String(k).trim()).filter(Boolean));
      saveKeywords();
      renderChips();
      rescanAll();
    },
    setApiKey: (key) => {
      apiKey = String(key || '').trim();
      saveApiKey();
      rescanAll();
    },
  };
  log('loaded');
})();
