// ==UserScript==
// @name         即刻圈子统计
// @namespace    io.github.booker.kojike
// @version      0.1.0
// @description  在即刻网页版个人页统计当前浏览用户在哪些圈子发过动态、各发了多少条
// @match        https://web.okjike.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const API_HOST = 'api.ruguoapp.com';
  const ENDPOINT = '/1.0/personalUpdate/single';
  const LS_KEY = 'kojike_circle_stats_v1';
  const MAX_USERS = 30;
  const MAX_POSTS_PER_USER = 3000;
  const JIKE_BLUE = '#03A9F4';

  // ---------- 存储 ----------
  // db: { [username]: { byId: { [postId]: { type, topic, content, date } }, touched } }
  // 圈子计数不落库，渲染时从 byId 派生——单一事实来源，避免双账本（App 版 touch() 丢桶的教训）
  const loadDb = () => {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || {} } catch { return {} }
  };
  const saveDb = (db) => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(db)) } catch { /* 配额满等场景静默 */ }
  };
  const touchLru = (db, username) => {
    db[username].touched = Date.now();
    const users = Object.keys(db);
    if (users.length <= MAX_USERS) return;
    users.sort((a, b) => (db[a].touched || 0) - (db[b].touched || 0));
    for (const u of users.slice(0, users.length - MAX_USERS)) delete db[u];
  };

  // ---------- 路由 ----------
  // 网页版 URL 的 username 段就是接口参数，无需换算（recon 证实）
  const profileUsername = () => {
    const m = location.pathname.match(/^\/u\/([^/]+?)(?:\/(gallery|collection|topic|post|repost))?\/?$/);
    return m ? decodeURIComponent(m[1]) : null;
  };
  // 动态详情路由映射，与宿主 bundle 的 De 常量一致
  const detailRoute = (type, id, username) => {
    const t = { ORIGINAL_POST: 'post', REPOST: 'repost', PERSONAL_UPDATE: 'post' }[type];
    return t ? `/u/${username}/${t}/${id}` : null;
  };

  // ---------- 统计核心（平移自 App 版 GsonResponseHook） ----------
  function recordPage(posts, profileUser) {
    if (!Array.isArray(posts) || !profileUser) return 0;
    // 单作者判别：个人页接口每条属主应同一人；多作者说明是发现页等共用结构的 feed，整页跳过防污染
    const owners = new Set();
    for (const p of posts) {
      const o = p?.user?.username;
      if (o) owners.add(o);
    }
    if (owners.size > 1 || (owners.size === 1 && !owners.has(profileUser))) return 0;

    const db = loadDb();
    const bucket = (db[profileUser] ||= { byId: {}, touched: 0 });
    let added = 0;
    for (const p of posts) {
      if (!p?.id || bucket.byId[p.id]) continue;
      if (Object.keys(bucket.byId).length >= MAX_POSTS_PER_USER) break;
      // 转发自身无 topic 时用被转发原动态的 topic 兜底归类（与 App 版一致）
      const topic = p.topic?.content?.trim() || p.target?.topic?.content?.trim() || '无圈子';
      bucket.byId[p.id] = {
        type: p.type || '',
        topic,
        content: String(p.content || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        date: p.createdAt || '',
      };
      added++;
    }
    if (added) { touchLru(db, profileUser); saveDb(db); notifyChange(profileUser); }
    return added;
  }

  // ---------- 流量拦截（页面 axios 走默认 XHR adapter，fetch 是冗余保险） ----------
  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  let captureArmed = false;

  function handleResponseText(text) {
    let json;
    try { json = JSON.parse(text) } catch { return }
    if (json?.data) recordPage(json.data, profileUsername());
  }

  function armCapture() {
    if (captureArmed) return;
    captureArmed = true;
    const oOpen = pageWindow.XMLHttpRequest.prototype.open;
    const oSend = pageWindow.XMLHttpRequest.prototype.send;
    pageWindow.XMLHttpRequest.prototype.open = function (method, url) {
      this.__kojikeUrl = String(url || '');
      return oOpen.apply(this, arguments);
    };
    pageWindow.XMLHttpRequest.prototype.send = function (body) {
      if (this.__kojikeUrl?.includes(ENDPOINT)) {
        this.addEventListener('load', () => {
          try { handleResponseText(this.responseText) } catch { /* 单次解析失败不影响宿主 */ }
        });
      }
      return oSend.apply(this, arguments);
    };
    const oFetch = pageWindow.fetch;
    if (oFetch) {
      pageWindow.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : input?.url || '';
        const p = oFetch.apply(this, arguments);
        if (url.includes(ENDPOINT)) {
          p.then((res) => res.clone().text().then(handleResponseText).catch(() => {})).catch(() => {});
        }
        return p;
      };
    }
  }

  // ---------- UI ----------
  let uiRoot = null;
  let panelOpen = false;
  let viewingUser = null;
  // 两级视图：topics=圈子列表（一级），posts=某圈子动态明细（二级），对应 App 版统计页结构
  let panelView = { mode: 'topics' };

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const statsOf = (username) => {
    const bucket = loadDb()[username];
    if (!bucket) return { total: 0, topics: [] };
    const byTopic = new Map();
    // id 存在 byId 的 key 上，摊平进 post 对象供明细卡片跳转用
    for (const [id, p] of Object.entries(bucket.byId)) {
      const post = { ...p, id };
      const t = byTopic.get(p.topic) || { name: p.topic, count: 0, posts: [] };
      t.count++; t.posts.push(post);
      byTopic.set(p.topic, t);
    }
    const topics = [...byTopic.values()].sort((a, b) => b.count - a.count);
    return { total: Object.keys(bucket.byId).length, topics };
  };

  function renderChip() {
    const user = profileUsername();
    if (!user) { uiRoot?.remove(); uiRoot = null; viewingUser = null; return; }
    const { total } = statsOf(user);
    if (!uiRoot) {
      uiRoot = document.createElement('div');
      uiRoot.id = 'kojike-stats-chip';
      Object.assign(uiRoot.style, {
        position: 'fixed', right: '18px', bottom: '18px', zIndex: '2147483000',
        display: 'flex', alignItems: 'center', gap: '6px', padding: '9px 16px',
        borderRadius: '999px', background: '#fff', boxShadow: '0 4px 16px rgba(0,0,0,.18)',
        cursor: 'pointer', font: '600 13px/1 -apple-system, sans-serif', color: JIKE_BLUE,
        userSelect: 'none',
      });
      uiRoot.addEventListener('click', () => { panelOpen = true; renderPanel(); });
      document.body.appendChild(uiRoot);
    }
    viewingUser = user;
    uiRoot.textContent = `📊 圈子统计 · ${total}`;
  }

  function renderPanel() {
    document.getElementById('kojike-stats-panel')?.remove();
    if (!panelOpen || !viewingUser) return;
    const { total, topics } = statsOf(viewingUser);

    const panel = document.createElement('div');
    panel.id = 'kojike-stats-panel';
    Object.assign(panel.style, {
      position: 'fixed', right: '18px', bottom: '64px', zIndex: '2147483000',
      width: '360px', maxHeight: '70vh', overflowY: 'auto',
      background: '#fff', borderRadius: '16px', boxShadow: '0 8px 32px rgba(0,0,0,.22)',
      font: '13px/1.5 -apple-system, sans-serif', color: '#333',
    });

    let bodyHtml;
    let title = `圈子统计 · 共 ${total} 条动态`;
    if (panelView.mode === 'posts') {
      const t = topics.find((x) => x.name === panelView.topic);
      title = `‹ ${panelView.topic}`;
      const cards = (t?.posts || [])
        .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
        .map((p) => `
          <div class="kojike-post" data-id="${esc(p.id)}" data-type="${esc(p.type)}" style="margin:8px 12px;padding:10px 12px;background:#f7f8fa;border-radius:10px;cursor:pointer">
            <div style="color:#999;font-size:11px;margin-bottom:3px">${esc((p.date || '').slice(0, 10) || '日期未知')}</div>
            <div style="overflow:hidden">${esc(p.content || '<i>无文字内容</i>')}</div>
          </div>`)
        .join('');
      bodyHtml = cards || `<div style="padding:24px 16px;text-align:center;color:#999">该圈子暂无明细</div>`;
    } else {
      // 注意 topics 数组必须 join('')，否则隐式 toString 会在行间插入逗号
      bodyHtml = topics.length
        ? topics.map((t, i) => `
          <div class="kojike-topic" data-i="${i}" style="display:flex;align-items:center;gap:8px;padding:9px 16px;cursor:pointer;border-top:1px solid #f2f2f2">
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.name)}</span>
            <span style="color:${JIKE_BLUE};font-weight:700">${t.count}</span><span style="color:#bbb">条 ›</span>
          </div>`).join('')
        : `<div style="padding:24px 16px;text-align:center;color:#999">暂无数据，先上下滚动加载动态</div>`;
    }

    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid #f2f2f2">
        <b id="kojike-title" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:${panelView.mode === 'posts' ? 'pointer' : 'default'}">${esc(title)}</b>
        <span id="kojike-clear" style="color:#e5484d;cursor:pointer">清空</span>
        <span id="kojike-close" style="color:#999;cursor:pointer;padding:0 4px">✕</span>
      </div>${bodyHtml}`;
    panel.querySelector('#kojike-close').onclick = () => { panelOpen = false; panelView = { mode: 'topics' }; renderPanel(); };
    panel.querySelector('#kojike-clear').onclick = () => {
      const db = loadDb();
      delete db[viewingUser];
      saveDb(db);
      notifyChange(viewingUser);
      panelView = { mode: 'topics' };
      renderPanel(); renderChip();
    };
    if (panelView.mode === 'posts') {
      // 标题即「‹ 圈子名」返回按钮（对应 App 版二级页交互）
      panel.querySelector('#kojike-title').onclick = () => { panelView = { mode: 'topics' }; renderPanel(); };
      panel.querySelectorAll('.kojike-post').forEach((el) => {
        el.onclick = () => {
          const route = detailRoute(el.dataset.type, el.dataset.id, viewingUser);
          if (route) location.assign(route);
        };
      });
    } else {
      panel.querySelectorAll('.kojike-topic').forEach((el) => {
        el.onclick = () => {
          panelView = { mode: 'posts', topic: topics[Number(el.dataset.i)].name };
          renderPanel();
        };
      });
    }
    document.body.appendChild(panel);
  }

  const notifyChange = (user) => {
    if (user === profileUsername()) renderChip();
  };

  // SPA 路由变化 + 数据到达都要重渲染（对应 App 版两处自动刷新）
  let lastPath = location.pathname;
  const wrapHistory = (name) => {
    const orig = history[name];
    history[name] = function () {
      const r = orig.apply(this, arguments);
      queueMicrotask(() => { if (location.pathname !== lastPath) { lastPath = location.pathname; panelOpen = false; renderPanel(); renderChip(); } });
      return r;
    };
  };
  wrapHistory('pushState');
  wrapHistory('replaceState');
  addEventListener('popstate', () => { lastPath = location.pathname; panelOpen = false; renderPanel(); renderChip(); });

  // ---------- 启动 ----------
  armCapture();
  const mount = () => { document.body ? renderChip() : setTimeout(mount, 50); };
  mount();
})();
