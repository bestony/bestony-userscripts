// ==UserScript==
// @name         X Pro Deck 智能屏蔽
// @namespace    https://github.com/bestony/userscripts
// @version      0.6.2
// @description  X Pro Deck（pro.x.com）：按用户 handle 封禁优先，其次关键词规则，最后调用 TypeSafe JEV 模型智能判别，屏蔽赌博/博彩等引流推广内容；支持手动封禁用户、右键加词与配置导入导出
// @author       bestony
// @match        https://pro.x.com/i/decks/*
// @grant        GM_xmlhttpRequest
// @grant        GM_info
// @connect      api.typesafe.ai
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/bestony/bestony-userscripts/main/xdeck-smart-filter.user.js
// @downloadURL  https://raw.githubusercontent.com/bestony/bestony-userscripts/main/xdeck-smart-filter.user.js
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

  // 默认封禁的 handle（不带 @，不区分大小写）。JEV 判定为屏蔽时会自动追加到这里
  const DEFAULT_BLOCKED_HANDLES = [];

  const BLOCK_THRESHOLD = 0.5; // JEV 概率 ≥ 该值即判定为需要屏蔽
  const MAX_CONCURRENT = 2; // 同时进行的智能判别请求数
  const MAX_RETRY = 3; // 429 / 529 / 网络错误重试次数
  const CACHE_TTL = 7 * 24 * 3600 * 1000; // 结果缓存有效期（7 天）

  const ENABLE_KEY = 'xdeck-filter-enabled';
  const KEYWORDS_KEY = 'xdeck-filter-keywords';
  const HANDLES_KEY = 'xdeck-filter-handles';
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

  /* ==================== 用户封禁配置 ==================== */

  // 统一 handle 形式：去掉 @ 前缀、转小写
  function normalizeHandle(h) {
    return String(h || '').trim().replace(/^@+/, '').toLowerCase();
  }

  function uniqueHandles(list) {
    const seen = new Set();
    const out = [];
    (list || []).forEach((h) => {
      const v = normalizeHandle(h);
      if (!v || seen.has(v)) return;
      seen.add(v);
      out.push(v);
    });
    return out;
  }

  function loadHandles() {
    try {
      const raw = JSON.parse(localStorage.getItem(HANDLES_KEY));
      if (Array.isArray(raw)) return uniqueHandles(raw);
    } catch (e) {
      /* ignore */
    }
    return DEFAULT_BLOCKED_HANDLES.slice();
  }

  let blockedHandles = loadHandles();
  let blockedHandleSet = new Set(blockedHandles);

  function saveHandles() {
    try {
      localStorage.setItem(HANDLES_KEY, JSON.stringify(blockedHandles));
    } catch (e) {
      log('save handles failed', e);
    }
  }

  // 手动/自动把 handle 加入封禁列表；返回是否有新增
  function addBlockedHandle(handle, opts) {
    const v = normalizeHandle(handle);
    if (!v || blockedHandleSet.has(v)) return false;
    blockedHandles.push(v);
    blockedHandleSet.add(v);
    saveHandles();
    renderHandleChips();
    if (!(opts && opts.silent)) rescanAll();
    return true;
  }

  function removeBlockedHandle(handle) {
    const v = normalizeHandle(handle);
    if (!blockedHandleSet.has(v)) return false;
    blockedHandleSet.delete(v);
    blockedHandles = blockedHandles.filter((h) => h !== v);
    saveHandles();
    renderHandleChips();
    rescanAll();
    return true;
  }

  function setBlockedHandles(list) {
    blockedHandles = uniqueHandles(list);
    blockedHandleSet = new Set(blockedHandles);
    saveHandles();
    renderHandleChips();
    rescanAll();
  }

  function matchHandle(handle) {
    return handle && blockedHandleSet.has(handle) ? handle : '';
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

  // 用户名（昵称 + @handle），用于关键词匹配
  function tweetAuthor(article) {
    const name = article.querySelector('[data-testid="User-Name"]');
    return name ? name.textContent : '';
  }

  // 提取作者 handle（小写，不带 @），用于用户封禁匹配
  function tweetHandle(article) {
    const links = article.querySelectorAll('[data-testid="User-Name"] a[href^="/"]');
    for (const a of links) {
      const href = (a.getAttribute('href') || '').split(/[?#]/)[0].replace(/\/+$/, '');
      const m = /^\/([A-Za-z0-9_]+)$/.exec(href);
      if (m) return m[1].toLowerCase();
    }
    const name = article.querySelector('[data-testid="User-Name"]');
    if (name) {
      const m = /@([A-Za-z0-9_]{1,15})/.exec(name.textContent || '');
      if (m) return m[1].toLowerCase();
    }
    return '';
  }

  // 提取显示昵称（用于右键屏蔽时的确认）
  function tweetDisplayName(article) {
    const link = article.querySelector('[data-testid="User-Name"] a[href^="/"]');
    return link ? normalize(link.textContent) : '';
  }

  // 提取头像地址（用于右键屏蔽时的确认）
  function tweetAvatar(article) {
    const img = article.querySelector('[data-testid="Tweet-User-Avatar"] img');
    return img ? img.getAttribute('src') || '' : '';
  }

  // 缓存/判定用的稳定标识：只用正文 + handle。
  // 注意不要用 tweetAuthor，它带有「· 2m」这类相对时间，会随时间变化导致重复判定与闪动
  function contentKey(text, handle) {
    return hash(text + '\u0000' + (handle || ''));
  }

  // 折叠隐藏：同时用 class 与内联样式，避免 React 重渲染时清掉其中一种导致内容闪现
  function markBlocked(el) {
    el.classList.add('xdeck-filter-blocked');
    el.style.setProperty('display', 'none', 'important');
  }

  function unmarkBlocked(el) {
    el.classList.remove('xdeck-filter-blocked');
    el.style.removeProperty('display');
  }

  function apply(container, blocked, key) {
    container.dataset.sfKey = key;
    container.dataset.sfState = blocked ? 'blocked' : 'allowed';
    if (blocked) {
      markBlocked(container);
      blockedCount++;
      refreshBadge();
    } else {
      unmarkBlocked(container);
    }
  }

  // 在文字/用户名全文里匹配关键词（用户名也参与命中）
  function matchContent(text, author) {
    const hit = matchKeyword(text);
    if (hit) return { hit, where: 'text' };
    // 用户名同时按原文与小写匹配（@handle 通常是小写）
    const hitAuthor = matchKeyword(author) || matchKeyword(author.toLowerCase());
    if (hitAuthor) return { hit: hitAuthor, where: 'author' };
    return null;
  }

  function scan() {
    if (!enabled) return;

    document.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
      const text = normalize(tweetText(article));
      const author = normalize(tweetAuthor(article));
      const handle = tweetHandle(article);
      if (!text && !author) return;

      const container = article.closest('[data-testid="cellInnerDiv"]') || article;
      const key = contentKey(text, handle);

      // 节点被回收复用时，先清掉上一条内容留下的状态
      if (container.dataset.sfKey !== key) {
        container.dataset.sfKey = '';
        container.dataset.sfState = '';
        unmarkBlocked(container);
      }

      // 已判定为屏蔽的节点，每次扫描都重新补上隐藏，防止 React 重渲染把标记清掉造成闪动
      if (container.dataset.sfState === 'blocked') {
        markBlocked(container);
        return;
      }
      if (container.dataset.sfState === 'allowed') return;

      // 1) 用户封禁优先：命中封禁列表直接隐藏（在关键词与 JEV 之前）
      if (matchHandle(handle)) {
        log('handle blocked:', '@' + handle, text.slice(0, 40));
        apply(container, true, key);
        return;
      }

      // 2) 关键词规则（正文或用户名命中即屏蔽）
      const matched = matchContent(text, author);
      if (matched) {
        log('keyword hit:', matched.hit, matched.where, (text || author).slice(0, 40));
        apply(container, true, key);
        return;
      }

      // 3) 命中缓存（无正文时不缓存，避免污染）
      if (text && cache[key]) {
        apply(container, !!cache[key].b, key);
        return;
      }

      // 4) 无 API Key 时只跑关键词
      if (!apiKey || !text) return;

      if (inFlight.has(key)) return;
      inFlight.add(key);
      container.dataset.sfState = 'pending';

      enqueue(() =>
        judge(text).then((p) => {
          const blocked = p >= BLOCK_THRESHOLD;
          cache[key] = { b: blocked, t: Date.now() };
          saveCache();
          // JEV 判定为屏蔽时，把作者 handle 收入封禁列表（后续同作者内容直接隐藏）
          if (blocked && handle) {
            if (addBlockedHandle(handle, { silent: true })) {
              log('jev auto-blocked user:', '@' + handle);
              scheduleRescan();
            }
          }
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

  // 新节点插入时同步做一次关键词预屏蔽：
  // 只处理关键词能立刻命中的内容，让它在进入视口前就隐藏，避免先显示再消失的跳变
  function preHideByKeyword(root) {
    const articles =
      root.matches && root.matches('article[data-testid="tweet"]')
        ? [root]
        : root.querySelectorAll
          ? [...root.querySelectorAll('article[data-testid="tweet"]')]
          : [];

    articles.forEach((article) => {
      const text = normalize(tweetText(article));
      const author = normalize(tweetAuthor(article));
      const handle = tweetHandle(article);
      if (!text && !author) return;

      const container = article.closest('[data-testid="cellInnerDiv"]') || article;
      // 只做屏蔽，未命中不标记 allowed，交给 scan 走缓存/智能判别
      if (container.dataset.sfState === 'blocked') {
        markBlocked(container);
        return;
      }

      // 用户封禁优先于关键词
      if (matchHandle(handle)) {
        markBlocked(container);
        log('pre-hide handle:', '@' + handle, text.slice(0, 40));
        const hkey = contentKey(text, handle);
        if (container.dataset.sfState !== 'blocked') {
          container.dataset.sfKey = hkey;
          container.dataset.sfState = 'blocked';
          blockedCount++;
          refreshBadge();
        }
        return;
      }

      const matched = matchContent(text, author);
      if (!matched) return;

      markBlocked(container);
      log('pre-hide:', matched.hit, matched.where, (text || author).slice(0, 40));
      // 直接用 article 文本做 key，与 scan 保持一致
      const key = contentKey(text, handle);
      if (container.dataset.sfState !== 'blocked') {
        container.dataset.sfKey = key;
        container.dataset.sfState = 'blocked';
        blockedCount++;
        refreshBadge();
      }
    });
  }

  // 防抖重扫：JEV 自动加入封禁用户后，让同一作者的其他卡片也立即隐藏
  let rescanTimer = 0;
  function scheduleRescan() {
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(rescanAll, 300);
  }

  // 重置所有卡片的判定状态，然后重新扫描（关键词或缓存变更后调用）
  function rescanAll() {
    document.querySelectorAll('[data-sf-key]').forEach((el) => {
      unmarkBlocked(el);
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
  let handleChipsEl;
  let chipsToggle;
  let configWrapEl;
  let contextMenu;
  let confirmEl;
  let chipsExpanded = false;

  function refreshBadge() {
    if (!badge) return;
    badge.querySelector('.xdeck-filter-count').textContent = String(blockedCount);
    badge.querySelector('.xdeck-filter-toggle').textContent = enabled ? '关闭' : '开启';
    badge.classList.toggle('xdeck-filter-off', !enabled);
  }

  // 默认只展示一行关键词，内容放不下时才显示「查看完整清单」开关
  function updateChipsToggle() {
    if (!chipsToggle || !chipsEl) return;
    const overflow = chipsEl.scrollWidth > chipsEl.clientWidth + 1;
    chipsToggle.style.display = overflow || chipsExpanded ? 'inline-block' : 'none';
    chipsToggle.textContent = chipsExpanded ? '收起清单' : '查看完整清单';
  }

  function setChipsExpanded(expanded) {
    chipsExpanded = expanded;
    if (chipsEl) chipsEl.classList.toggle('xdeck-filter-chips-collapsed', !expanded);
    updateChipsToggle();
  }

  function renderChips() {
    if (!chipsEl) return;
    chipsEl.textContent = '';

    if (!keywords.length) {
      const empty = document.createElement('span');
      empty.className = 'xdeck-filter-empty';
      empty.textContent = '暂无关键词';
      chipsEl.append(empty);
      updateChipsToggle();
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

    updateChipsToggle();
  }

  function renderHandleChips() {
    if (!handleChipsEl) return;
    handleChipsEl.textContent = '';

    if (!blockedHandles.length) {
      const empty = document.createElement('span');
      empty.className = 'xdeck-filter-empty';
      empty.textContent = '暂无封禁用户';
      handleChipsEl.append(empty);
      return;
    }

    blockedHandles.forEach((handle) => {
      const chip = document.createElement('span');
      chip.className = 'xdeck-filter-chip';

      const label = document.createElement('span');
      label.textContent = '@' + handle;

      const del = document.createElement('a');
      del.className = 'xdeck-filter-chip-del';
      del.href = 'javascript:void(0)';
      del.title = '解除封禁';
      del.textContent = '×';
      del.addEventListener('click', () => removeBlockedHandle(handle));

      chip.append(label, del);
      handleChipsEl.append(chip);
    });
  }

  // 支持一次添加多个 handle，自动去重
  function addHandles(raw) {
    let added = false;
    splitKeywords(raw).forEach((h) => {
      if (addBlockedHandle(h, { silent: true })) added = true;
    });
    if (added) rescanAll();
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

  // 导出配置：包含关键词与封禁用户，不包含 API Key（最小化 JSON，无空格换行）
  function exportConfig() {
    return JSON.stringify({
      type: 'xdeck-filter-keywords',
      version: 1,
      keywords: keywords.slice(),
      handles: blockedHandles.slice(),
    });
  }

  // 解析导入的配置：支持 { keywords: [...], handles: [...] } 或直接的字符串数组
  function parseConfig(raw) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      throw new Error('不是合法的 JSON');
    }
    const list = Array.isArray(data) ? data : data && Array.isArray(data.keywords) ? data.keywords : null;
    if (!list) throw new Error('未找到关键词列表');
    const handles = !Array.isArray(data) && data && Array.isArray(data.handles) ? data.handles : null;
    return {
      keywords: uniqueKeywords(list.map((k) => String(k).trim()).filter(Boolean)),
      handles: handles ? uniqueHandles(handles) : null,
    };
  }

  function importConfig(raw) {
    const parsed = parseConfig(raw);
    keywords = parsed.keywords;
    saveKeywords();
    // 旧版配置没有 handles 字段时保留现有封禁列表
    if (parsed.handles) {
      blockedHandles = parsed.handles;
      blockedHandleSet = new Set(blockedHandles);
      saveHandles();
    }
    renderChips();
    renderHandleChips();
    rescanAll();
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return Promise.reject(new Error('clipboard unavailable'));
  }

  function downloadConfig(text) {
    try {
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = 'xdeck-filter-keywords-' + stamp + '.json';
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      log('download config failed', e);
    }
  }

  function openPanel() {
    if (!panel) return;
    panel.classList.add('xdeck-filter-open');
    // 面板显示后才有真实宽度，此时再判断清单是否需要折叠开关
    updateChipsToggle();
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

    // 关键词输入默认收起，点击标题右侧「添加关键词」展开
    const kwBlock = document.createElement('div');
    kwBlock.className = 'xdeck-filter-section';
    const kwLabel = document.createElement('div');
    kwLabel.className = 'xdeck-filter-key-label';
    const kwTitle = document.createElement('span');
    kwTitle.textContent = '关键词';
    const kwToggle = document.createElement('a');
    kwToggle.className = 'xdeck-filter-config-toggle';
    kwToggle.href = 'javascript:void(0)';
    kwToggle.textContent = '添加关键词';
    kwLabel.append(kwTitle, kwToggle);
    const kwBody = document.createElement('div');
    kwBody.className = 'xdeck-filter-section-body';

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
    chipsEl.className = 'xdeck-filter-chips xdeck-filter-chips-collapsed';

    // 关键词清单折叠开关（内容溢出时才显示）
    chipsToggle = document.createElement('a');
    chipsToggle.className = 'xdeck-filter-chips-toggle';
    chipsToggle.href = 'javascript:void(0)';
    chipsToggle.style.display = 'none';
    chipsToggle.textContent = '查看完整清单';
    chipsToggle.addEventListener('click', () => setChipsExpanded(!chipsExpanded));

    kwBody.append(row);
    kwBlock.append(kwLabel, kwBody, chipsEl, chipsToggle);
    kwToggle.addEventListener('click', () => {
      const open = kwBlock.classList.toggle('xdeck-filter-section-open');
      kwToggle.textContent = open ? '收起' : '添加关键词';
    });

    // 封禁用户（handle）：命中的内容在关键词与 JEV 之前直接隐藏；输入框默认收起
    const handleBlock = document.createElement('div');
    handleBlock.className = 'xdeck-filter-section';
    const handleLabel = document.createElement('div');
    handleLabel.className = 'xdeck-filter-key-label';
    const handleTitle = document.createElement('span');
    handleTitle.textContent = '封禁用户（@handle）';
    const handleToggle = document.createElement('a');
    handleToggle.className = 'xdeck-filter-config-toggle';
    handleToggle.href = 'javascript:void(0)';
    handleToggle.textContent = '添加封禁';
    handleLabel.append(handleTitle, handleToggle);
    const handleBody = document.createElement('div');
    handleBody.className = 'xdeck-filter-section-body';

    const handleRow = document.createElement('div');
    handleRow.className = 'xdeck-filter-panel-row';
    const handleInput = document.createElement('textarea');
    handleInput.className = 'xdeck-filter-input';
    handleInput.rows = 2;
    handleInput.placeholder = '多个 @handle 用空格、逗号或换行分隔';
    const handleAdd = document.createElement('button');
    handleAdd.className = 'xdeck-filter-add';
    handleAdd.type = 'button';
    handleAdd.textContent = '封禁';
    const submitHandles = () => {
      addHandles(handleInput.value);
      handleInput.value = '';
      handleInput.focus();
    };
    handleAdd.addEventListener('click', submitHandles);
    handleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitHandles();
    });
    handleRow.append(handleInput, handleAdd);

    handleChipsEl = document.createElement('div');
    handleChipsEl.className = 'xdeck-filter-chips xdeck-filter-chips-collapsed';

    handleBody.append(handleRow);
    handleBlock.append(handleLabel, handleBody, handleChipsEl);
    handleToggle.addEventListener('click', () => {
      const open = handleBlock.classList.toggle('xdeck-filter-section-open');
      handleToggle.textContent = open ? '收起' : '添加封禁';
    });

    // 导入 / 导出关键词与封禁用户（不含 API Key）
    const configWrap = document.createElement('div');
    configWrap.className = 'xdeck-filter-config';

    const configLabel = document.createElement('div');
    configLabel.className = 'xdeck-filter-key-label';
    const configHint = document.createElement('span');
    configHint.textContent = '导入导出（关键词 + 封禁用户，不含 API Key）';

    const configToggle = document.createElement('a');
    configToggle.className = 'xdeck-filter-config-toggle';
    configToggle.href = 'javascript:void(0)';
    configToggle.textContent = '导入导出配置';
    configLabel.append(configHint, configToggle);

    const configBody = document.createElement('div');
    configBody.className = 'xdeck-filter-config-body';

    const configArea = document.createElement('textarea');
    configArea.className = 'xdeck-filter-config-area';
    configArea.rows = 3;
    configArea.placeholder = '点击「导出配置」生成内容；粘贴配置后点击「导入配置」';

    const configRow = document.createElement('div');
    configRow.className = 'xdeck-filter-panel-row';
    const exportBtn = document.createElement('button');
    exportBtn.className = 'xdeck-filter-save';
    exportBtn.type = 'button';
    exportBtn.textContent = '导出配置';
    const importBtn = document.createElement('button');
    importBtn.className = 'xdeck-filter-save';
    importBtn.type = 'button';
    importBtn.textContent = '导入配置';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.style.display = 'none';

    const flash = (btn, text) => {
      if (!btn.dataset.label) btn.dataset.label = btn.textContent;
      btn.textContent = text;
      clearTimeout(btn._flashTimer);
      btn._flashTimer = setTimeout(() => {
        btn.textContent = btn.dataset.label;
      }, 1200);
    };

    exportBtn.addEventListener('click', () => {
      const text = exportConfig();
      configArea.value = text;
      configArea.select();
      copyText(text).then(
        () => flash(exportBtn, '已复制并下载'),
        () => flash(exportBtn, '已生成并下载'),
      );
      downloadConfig(text);
    });

    importBtn.addEventListener('click', () => {
      if (!configArea.value.trim()) {
        fileInput.click();
        return;
      }
      try {
        importConfig(configArea.value);
        flash(importBtn, '已导入');
      } catch (e) {
        alert('导入失败：' + e.message);
      }
    });

    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        configArea.value = String(reader.result || '');
        try {
          importConfig(configArea.value);
          flash(importBtn, '已导入');
        } catch (e) {
          alert('导入失败：' + e.message);
        }
      };
      reader.readAsText(file);
      fileInput.value = '';
    });

    configRow.append(exportBtn, importBtn, fileInput);
    configBody.append(configArea, configRow);
    configWrap.append(configLabel, configBody);
    // 输入框默认收起，点击「导入导出配置」后再展开
    configWrapEl = configWrap;
    configToggle.addEventListener('click', () => {
      configWrap.classList.toggle('xdeck-filter-config-open');
      configToggle.textContent = configWrap.classList.contains('xdeck-filter-config-open')
        ? '收起'
        : '导入导出配置';
    });

    const foot = document.createElement('div');
    foot.className = 'xdeck-filter-panel-foot';
    const reset = document.createElement('button');
    reset.className = 'xdeck-filter-reset';
    reset.type = 'button';
    reset.textContent = '恢复默认';
    reset.addEventListener('click', () => {
      keywords = DEFAULT_KEYWORDS.slice();
      saveKeywords();
      blockedHandles = DEFAULT_BLOCKED_HANDLES.slice();
      blockedHandleSet = new Set(blockedHandles);
      saveHandles();
      renderChips();
      renderHandleChips();
      rescanAll();
    });
    const clear = document.createElement('button');
    clear.className = 'xdeck-filter-clear';
    clear.type = 'button';
    clear.textContent = '清除智能缓存';
    clear.title = '清除 JEV 判定缓存，重新请求判别';
    clear.addEventListener('click', clearKeywordCache);
    foot.append(reset, clear);

    const info = document.createElement('div');
    info.className = 'xdeck-filter-info';

    const versionLine = document.createElement('div');
    versionLine.textContent = '版本 v' + SCRIPT_VERSION;

    const repoLine = document.createElement('div');
    const repoLabel = document.createElement('span');
    repoLabel.textContent = '仓库：';
    const repoLink = document.createElement('a');
    repoLink.href = REPO_URL;
    repoLink.target = '_blank';
    repoLink.rel = 'noopener';
    repoLink.textContent = 'bestony/bestony-userscripts';
    repoLine.append(repoLabel, repoLink);

    const checkLine = document.createElement('div');
    const checkLink = document.createElement('a');
    checkLink.href = 'javascript:void(0)';
    checkLink.textContent = '检查更新';
    checkLink.addEventListener('click', () => {
      checkLink.textContent = '检查中…';
      checkUpdate(true, (updated) => {
        checkLink.textContent = updated ? '已是最新' : '检查更新';
        if (updated) setTimeout(() => (checkLink.textContent = '检查更新'), 2000);
      });
    });
    checkLine.append(checkLink);

    info.append(versionLine, repoLine, checkLine);

    panel.append(head, keyRow, kwBlock, handleBlock, configWrap, foot, info);
    document.body.append(panel);
    renderChips();
    renderHandleChips();
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

  // 判断选中的文字本身是否就是一个 @handle（用于区分「选中账号」与「普通文字」）
  function handleFromText(text) {
    const t = String(text || '').trim();
    const m = /^@?([A-Za-z0-9_]{1,15})$/.exec(t);
    return t.charAt(0) === '@' && m ? m[1].toLowerCase() : '';
  }

  function showContextMenu(x, y, text, user) {
    if (!contextMenu) return;

    contextMenu.textContent = '';

    const cardHandle = (user && user.handle) || '';
    const selectedHandle = handleFromText(text);

    // 屏蔽目标：优先「选中的账号」，其次「当前卡片作者」，去重后逐个展示
    const targets = [];
    if (selectedHandle && !blockedHandleSet.has(selectedHandle)) {
      // 选中的正是当前卡片作者时，带上昵称与头像，方便确认
      const same = selectedHandle === cardHandle;
      targets.push({
        handle: selectedHandle,
        name: same ? user.name : '',
        avatar: same ? user.avatar : '',
        selected: true,
      });
    }
    if (cardHandle && cardHandle !== selectedHandle && !blockedHandleSet.has(cardHandle)) {
      targets.push({ handle: cardHandle, name: user.name, avatar: user.avatar, selected: false });
    }

    targets.forEach((target) => {
      const item = document.createElement('a');
      item.className = 'xdeck-filter-menu-item';
      item.href = 'javascript:void(0)';
      if (target.selected) {
        item.textContent = '屏蔽选中账号：@' + target.handle;
      } else {
        item.textContent = '屏蔽该用户：@' + target.handle + (target.name ? '（' + target.name + '）' : '');
      }
      item.addEventListener('click', () => {
        hideContextMenu();
        // 屏蔽前先确认，避免选错账号
        openConfirm(target, () => addBlockedHandle(target.handle));
      });
      contextMenu.append(item);
    });

    // 选中普通文字时提供加词；选中的是 @handle 则不再重复提供
    if (text && !selectedHandle) {
      const label = text.length > 24 ? text.slice(0, 24) + '…' : text;
      const add = document.createElement('a');
      add.className = 'xdeck-filter-menu-item';
      add.href = 'javascript:void(0)';
      add.textContent = '加入屏蔽词：' + label;
      add.addEventListener('click', () => {
        addKeywords(text);
        hideContextMenu();
      });
      contextMenu.append(add);
    }

    if (!contextMenu.childElementCount) {
      hideContextMenu();
      return;
    }

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
      const article = e.target && e.target.closest ? e.target.closest('article[data-testid="tweet"]') : null;
      const handle = article ? tweetHandle(article) : '';
      const name = article ? tweetDisplayName(article) : '';
      const avatar = article ? tweetAvatar(article) : '';
      if (!text && !handle) {
        hideContextMenu();
        return;
      }
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, text, { handle, name, avatar });
    });

    document.addEventListener('mousedown', (e) => {
      if (contextMenu && !contextMenu.contains(e.target)) hideContextMenu();
    });
    document.addEventListener('scroll', hideContextMenu, true);
    window.addEventListener('resize', hideContextMenu);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        hideContextMenu();
        closeConfirm();
      }
    });
  }

  /* ==================== 屏蔽确认弹窗 ==================== */

  function closeConfirm() {
    if (confirmEl) confirmEl.classList.remove('xdeck-filter-confirm-open');
  }

  function openConfirm(user, onConfirm) {
    if (!confirmEl) return;
    confirmEl.textContent = '';

    const box = document.createElement('div');
    box.className = 'xdeck-filter-confirm-box';

    const title = document.createElement('div');
    title.className = 'xdeck-filter-confirm-title';
    title.textContent = '确认屏蔽账号';

    const userRow = document.createElement('div');
    userRow.className = 'xdeck-filter-confirm-user';
    if (user.avatar) {
      const img = document.createElement('img');
      img.className = 'xdeck-filter-confirm-avatar';
      img.src = user.avatar;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      userRow.append(img);
    }
    const info = document.createElement('div');
    info.className = 'xdeck-filter-confirm-info';
    if (user.name) {
      const nameEl = document.createElement('div');
      nameEl.className = 'xdeck-filter-confirm-name';
      nameEl.textContent = user.name;
      info.append(nameEl);
    }
    const handleEl = document.createElement('div');
    handleEl.className = 'xdeck-filter-confirm-handle';
    handleEl.textContent = '@' + user.handle;
    info.append(handleEl);
    userRow.append(info);

    const hint = document.createElement('div');
    hint.className = 'xdeck-filter-confirm-hint';
    hint.textContent = '屏蔽后该账号的所有内容都会被隐藏，确认是这个账号吗？';

    const actions = document.createElement('div');
    actions.className = 'xdeck-filter-confirm-actions';
    const cancel = document.createElement('button');
    cancel.className = 'xdeck-filter-confirm-cancel';
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.addEventListener('click', closeConfirm);
    const ok = document.createElement('button');
    ok.className = 'xdeck-filter-confirm-ok';
    ok.type = 'button';
    ok.textContent = '确认屏蔽';
    ok.addEventListener('click', () => {
      closeConfirm();
      onConfirm();
    });
    actions.append(cancel, ok);

    box.append(title, userRow, hint, actions);
    confirmEl.append(box);
    confirmEl.classList.add('xdeck-filter-confirm-open');
  }

  function injectConfirm() {
    if (confirmEl || !document.body) return;

    confirmEl = document.createElement('div');
    confirmEl.className = 'xdeck-filter-confirm';
    confirmEl.addEventListener('click', (e) => {
      if (e.target === confirmEl) closeConfirm();
    });
    document.body.append(confirmEl);
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
        document.querySelectorAll('[data-sf-state="blocked"]').forEach((el) => {
          unmarkBlocked(el);
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

  /* ==================== 自动检查更新 ==================== */

  const SCRIPT_VERSION =
    (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '0.6.2';
  const REPO_URL = 'https://github.com/bestony/bestony-userscripts';
  const UPDATE_URL = 'https://raw.githubusercontent.com/bestony/bestony-userscripts/main/xdeck-smart-filter.user.js';
  const UPDATE_CHECK_KEY = 'xdeck-filter-update-check';
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
    if (!document.body || document.querySelector('.xdeck-filter-update')) return;

    const bar = document.createElement('div');
    bar.className = 'xdeck-filter-update';

    const text = document.createElement('span');
    text.textContent = '发现新版本 v' + version + '（当前 v' + SCRIPT_VERSION + '）';

    const link = document.createElement('a');
    link.href = UPDATE_URL;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = '立即更新';

    const close = document.createElement('a');
    close.className = 'xdeck-filter-update-close';
    close.href = 'javascript:void(0)';
    close.title = '忽略';
    close.textContent = '×';
    close.addEventListener('click', () => bar.remove());

    bar.append(text, link, close);
    document.body.append(bar);
  }

  function checkUpdate(force, done) {
    const finish = (updated) => {
      if (typeof done === 'function') done(!!updated);
    };
    if (typeof GM_xmlhttpRequest !== 'function') return finish(false);
    const now = Date.now();
    try {
      const last = Number(localStorage.getItem(UPDATE_CHECK_KEY)) || 0;
      if (!force && now - last < UPDATE_CHECK_INTERVAL) return finish(false);
    } catch (e) {
      /* ignore */
    }

    GM_xmlhttpRequest({
      method: 'GET',
      url: UPDATE_URL + '?t=' + now,
      timeout: 20000,
      onload: (res) => {
        if (res.status !== 200) return finish(false);
        const m = VERSION_RE.exec(res.responseText);
        if (!m) return finish(false);
        try {
          localStorage.setItem(UPDATE_CHECK_KEY, String(now));
        } catch (e) {
          /* ignore */
        }
        if (isNewer(m[1], SCRIPT_VERSION)) {
          log('update available:', SCRIPT_VERSION, '->', m[1]);
          showUpdateNotice(m[1]);
          return finish(true);
        }
        finish(false);
      },
      onerror: () => {
        log('update check failed');
        finish(false);
      },
      ontimeout: () => {
        log('update check failed');
        finish(false);
      },
    });
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
    .xdeck-filter-section { display: flex; flex-direction: column; gap: 6px; }
    .xdeck-filter-section-body { display: none; flex-direction: column; gap: 6px; }
    .xdeck-filter-section.xdeck-filter-section-open .xdeck-filter-section-body { display: flex; }
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
    .xdeck-filter-chips.xdeck-filter-chips-collapsed {
      flex-wrap: nowrap; overflow: hidden; max-height: 26px; align-items: center;
    }
    .xdeck-filter-chip {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 3px 8px; border-radius: 999px; background: #253341; font-size: 12px;
    }
    .xdeck-filter-chips-collapsed .xdeck-filter-chip { flex: none; }
    .xdeck-filter-chip-del { color: #8b98a5 !important; font-size: 14px; line-height: 1; }
    .xdeck-filter-empty { color: #8b98a5; }
    .xdeck-filter-chips-toggle, .xdeck-filter-config-toggle {
      color: #1d9bf0 !important; font-size: 12px; text-decoration: none; cursor: pointer;
    }
    .xdeck-filter-chips-toggle { align-self: flex-start; }
    .xdeck-filter-config { display: flex; flex-direction: column; gap: 6px; }
    .xdeck-filter-config-body { display: none; flex-direction: column; gap: 6px; }
    .xdeck-filter-config.xdeck-filter-config-open .xdeck-filter-config-body { display: flex; }
    textarea.xdeck-filter-config-area {
      width: 100%; box-sizing: border-box; padding: 7px 9px; border-radius: 6px;
      border: 1px solid #38444d; background: #192734; color: #e7e9ea;
      font-size: 12px; line-height: 1.4; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      min-height: 54px; resize: vertical;
    }
    .xdeck-filter-config .xdeck-filter-panel-row button { flex: 1; background: #253341; color: #e7e9ea; }
    .xdeck-filter-panel-foot { display: flex; gap: 8px; }
    .xdeck-filter-info {
      display: flex; flex-direction: column; gap: 3px;
      padding-top: 8px; border-top: 1px solid #38444d;
      color: #8b98a5; font-size: 11px; line-height: 1.5;
    }
    .xdeck-filter-info a { color: #1d9bf0 !important; text-decoration: none; }
    .xdeck-filter-info a:hover { text-decoration: underline; }
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
    .xdeck-filter-confirm {
      position: fixed; inset: 0; z-index: 100002;
      display: none; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, .55);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .xdeck-filter-confirm.xdeck-filter-confirm-open { display: flex; }
    .xdeck-filter-confirm-box {
      width: 270px; padding: 16px; border-radius: 12px;
      background: #15202b; color: #e7e9ea; font-size: 13px;
      box-shadow: 0 8px 28px rgba(0, 0, 0, .5);
    }
    .xdeck-filter-confirm-title { font-weight: 600; font-size: 14px; }
    .xdeck-filter-confirm-user { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
    .xdeck-filter-confirm-avatar { width: 40px; height: 40px; border-radius: 50%; flex: none; object-fit: cover; }
    .xdeck-filter-confirm-info { min-width: 0; }
    .xdeck-filter-confirm-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .xdeck-filter-confirm-handle { color: #8b98a5; font-size: 12px; }
    .xdeck-filter-confirm-hint { color: #8b98a5; font-size: 12px; line-height: 1.5; margin-top: 12px; }
    .xdeck-filter-confirm-actions { display: flex; gap: 8px; margin-top: 16px; }
    .xdeck-filter-confirm-actions button {
      flex: 1; padding: 8px 10px; border-radius: 6px; border: none; cursor: pointer; font-size: 13px;
    }
    .xdeck-filter-confirm-cancel { background: #253341; color: #e7e9ea; }
    .xdeck-filter-confirm-ok { background: #f4212e; color: #fff; }
    .xdeck-filter-update {
      position: fixed; top: 12px; left: 50%; z-index: 100001;
      display: flex; align-items: center; gap: 10px;
      padding: 8px 14px; border-radius: 8px;
      background: #1d9bf0; color: #fff; font-size: 13px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      transform: translateX(-50%);
      box-shadow: 0 6px 20px rgba(0, 0, 0, .35);
    }
    .xdeck-filter-update a { color: #fff; font-weight: 600; text-decoration: underline; }
    .xdeck-filter-update-close { text-decoration: none !important; font-size: 16px; line-height: 1; opacity: .85; }
  `;
  document.head.append(style);

  let scheduled = 0;
  const observer = new MutationObserver((mutations) => {
    // 新增节点先做一次同步的「关键词预屏蔽」，尽量在进入视口前就隐藏，避免跳变
    if (enabled) {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          preHideByKeyword(node);
        }
      }
    }

    if (scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = 0;
      injectBadge();
      injectPanel();
      injectContextMenu();
      injectConfirm();
      scan();
    }, 150);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  injectBadge();
  injectPanel();
  injectContextMenu();
  injectConfirm();
  scan();
  checkUpdate();
  setInterval(scan, 3000); // 兜底：UI 虚拟滚动偶尔不触发 MutationObserver

  if (!apiKey) log('未配置 API Key，仅启用关键词规则');

  // 控制台自测入口：__xdeckFilter.scan() / getKeywords() / setKeywords([...]) / setApiKey('...')
  window.__xdeckFilter = {
    scan,
    cache,
    judge,
    exportConfig,
    importConfig,
    checkUpdate,
    getKeywords: () => keywords.slice(),
    setKeywords: (list) => {
      keywords = uniqueKeywords((list || []).map((k) => String(k).trim()).filter(Boolean));
      saveKeywords();
      renderChips();
      rescanAll();
    },
    getHandles: () => blockedHandles.slice(),
    setHandles: setBlockedHandles,
    blockHandle: (handle) => addBlockedHandle(handle),
    unblockHandle: (handle) => removeBlockedHandle(handle),
    setApiKey: (key) => {
      apiKey = String(key || '').trim();
      saveApiKey();
      rescanAll();
    },
  };
  log('loaded');
})();
