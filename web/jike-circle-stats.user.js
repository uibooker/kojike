// ==UserScript==
// @name         即刻圈子统计
// @namespace    io.github.booker.kojike
// @version      0.3.0
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

  // ---------- 图表（手写 SVG，不引库） ----------
  const CHART_LS_KEY = 'kojike_chart_type_v1';
  const chartType = () => { try { return localStorage.getItem(CHART_LS_KEY) || 'pie' } catch { return 'pie' } };
  const setChartType = (t) => { try { localStorage.setItem(CHART_LS_KEY, t) } catch { /* 忽略 */ } };
  const PALETTE = ['#03A9F4', '#FF9800', '#8BC34A', '#E91E63', '#9C27B0', '#00BCD4', '#FFC107', '#795548'];

  // 饼图/柱状图只画 top N，其余合并为「其他」
  const sliceData = (topics, max) => {
    const top = topics.slice(0, max).map((t) => ({ name: t.name, count: t.count }));
    const rest = topics.slice(max).reduce((s, t) => s + t.count, 0);
    if (rest) top.push({ name: '其他', count: rest });
    return top;
  };

  function pieSvg(topics) {
    const data = sliceData(topics, 8);
    const total = data.reduce((s, d) => s + d.count, 0) || 1;
    const cx = 75, cy = 75, r2 = 66, r1 = 40;
    let a = -Math.PI / 2;
    const slices = data.map((d, i) => {
      const color = PALETTE[i % PALETTE.length];
      const pct = Math.round((d.count / total) * 1000) / 10;
      const title = `<title>${esc(d.name)} ${d.count}条 (${pct}%)</title>`;
      // 单一扇区画不成弧（起终点重合），退化为整环
      if (data.length === 1) {
        return `<circle cx="${cx}" cy="${cy}" r="${(r1 + r2) / 2}" fill="none" stroke="${color}" stroke-width="${r2 - r1}">${title}</circle>`;
      }
      const ang = (d.count / total) * Math.PI * 2;
      const a0 = a; a += ang;
      const p = (r, x) => [cx + r * Math.cos(x), cy + r * Math.sin(x)].map((n) => n.toFixed(1));
      const [x0, y0] = p(r2, a0), [x1, y1] = p(r2, a), [x2, y2] = p(r1, a), [x3, y3] = p(r1, a0);
      const large = ang > Math.PI ? 1 : 0;
      return `<path class="kojike-slice" data-i="${i}" d="M${x0} ${y0} A${r2} ${r2} 0 ${large} 1 ${x1} ${y1} L${x2} ${y2} A${r1} ${r1} 0 ${large} 0 ${x3} ${y3} Z" fill="${color}">${title}</path>`;
    }).join('');
    const legend = data.map((d, i) => {
      const pct = Math.round((d.count / total) * 1000) / 10;
      return `<span class="kojike-legend" data-i="${i}" style="display:inline-flex;align-items:center;gap:5px;margin:3px 10px 3px 0;cursor:pointer">
        <i style="width:9px;height:9px;border-radius:50%;background:${PALETTE[i % PALETTE.length]}"></i>
        <span style="max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.name)}</span>
        <b style="color:${JIKE_BLUE}">${d.count}</b><span style="color:#bbb">${pct}%</span></span>`;
    }).join('');
    return `<div style="text-align:center;padding-top:6px">
      <svg width="150" height="150" viewBox="0 0 150 150" style="display:block;margin:0 auto">${slices}
        <text x="75" y="71" text-anchor="middle" font-size="20" font-weight="700" fill="#333">${total}</text>
        <text x="75" y="88" text-anchor="middle" font-size="10" fill="#999">条动态</text></svg>
      <div style="text-align:left;padding:6px 12px 10px">${legend}</div></div>`;
  }

  function barsHtml(topics) {
    const data = sliceData(topics, 10);
    const max = Math.max(...data.map((d) => d.count), 1);
    return `<div style="padding:10px 14px 12px">` + data.map((d, i) => `
      <div class="kojike-bar" data-i="${i}" style="display:flex;align-items:center;gap:8px;margin:7px 0;cursor:pointer">
        <span style="flex:0 0 96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#555;text-align:right">${esc(d.name)}</span>
        <span style="flex:1;height:14px;background:#f0f1f3;border-radius:7px;overflow:hidden">
          <i style="display:block;height:100%;width:${(d.count / max * 100).toFixed(1)}%;background:${PALETTE[i % PALETTE.length]};border-radius:7px"></i>
        </span>
        <b style="flex:0 0 28px;color:${JIKE_BLUE};text-align:right">${d.count}</b>
      </div>`).join('') + `</div>`;
  }

  function lineSvg(topics) {
    // 按月聚合，画最近 12 个月，只画动态数 top5 的圈子
    const byMonth = new Map(); // 'YYYY-MM' -> { topicName: count }
    for (const t of topics) {
      for (const p of t.posts) {
        const m = (p.date || '').slice(0, 7);
        if (!/^\d{4}-\d{2}$/.test(m)) continue;
        const o = byMonth.get(m) || {};
        o[t.name] = (o[t.name] || 0) + 1;
        byMonth.set(m, o);
      }
    }
    if (!byMonth.size) return `<div style="padding:24px 16px;text-align:center;color:#999">动态缺少日期信息，无法画折线图</div>`;
    const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const sorted = [...byMonth.keys()].sort();
    const end = new Date(sorted[sorted.length - 1] + '-01T00:00:00');
    const start = new Date(end); start.setMonth(start.getMonth() - 11);
    const keys = [];
    for (const d = new Date(start); d <= end; d.setMonth(d.getMonth() + 1)) keys.push(monthKey(d));
    const top5 = topics.slice(0, 5);
    const W = 328, H = 170, pl = 30, pr = 10, pt = 12, pb = 22;
    const maxY = Math.max(1, ...keys.map((k) => top5.reduce((s, t) => s + (byMonth.get(k)?.[t.name] || 0), 0)));
    const x = (i) => pl + i * (W - pl - pr) / Math.max(1, keys.length - 1);
    const y = (v) => pt + (1 - v / maxY) * (H - pt - pb);
    const grid = [0, Math.round(maxY / 2), maxY].map((v) =>
      `<line x1="${pl}" y1="${y(v).toFixed(1)}" x2="${W - pr}" y2="${y(v).toFixed(1)}" stroke="#eef0f2"/>
       <text x="${pl - 5}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#bbb">${v}</text>`).join('');
    const every = Math.ceil(keys.length / 6);
    const xlabels = keys.map((k, i) => {
      if (i % every && i !== keys.length - 1) return '';
      // 首月与一月带年份缩写，跨年可读
      const label = (i === 0 || k.endsWith('-01') ? k.slice(2, 4) + '年' : '') + parseInt(k.slice(5), 10) + '月';
      return `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="9" fill="#bbb">${label}</text>`;
    }).join('');
    const lines = top5.map((t, i) => {
      const color = PALETTE[i % PALETTE.length];
      const pts = keys.map((k, j) => `${x(j).toFixed(1)},${y(byMonth.get(k)?.[t.name] || 0).toFixed(1)}`).join(' ');
      const dots = keys.map((k, j) => {
        const v = byMonth.get(k)?.[t.name] || 0;
        return v ? `<circle cx="${x(j).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.6" fill="${color}"><title>${esc(t.name)} ${k} · ${v}条</title></circle>` : '';
      }).join('');
      return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round"/>${dots}`;
    }).join('');
    const legend = top5.map((t, i) => `<span style="display:inline-flex;align-items:center;gap:4px;margin:3px 8px 3px 0">
        <i style="width:9px;height:9px;border-radius:50%;background:${PALETTE[i % PALETTE.length]}"></i>
        <span style="max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.name)}</span></span>`).join('');
    return `<div style="padding:8px 10px 10px"><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${grid}${lines}${xlabels}</svg>
      <div style="padding:0 4px">${legend}</div></div>`;
  }

  // ---------- 全量抓取（平移 App 版 FetchEngine 策略） ----------
  // 手动触发；loadMoreKey 游标翻页；限速 + 退避 + 硬上限，fail-closed
  const fetchState = { running: false, user: null, fetched: 0, error: null };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fetchAll(user) {
    if (fetchState.running) return;
    fetchState.running = true;
    fetchState.user = user;
    fetchState.fetched = 0;
    fetchState.error = null;
    let consecutiveFailures = 0;

    try {
      let loadMoreKey;
      for (let page = 0; page < 600; page++) {
        // 离开该用户主页（SPA 路由变化）即中止
        if (profileUsername() !== user) throw new Error('已离开该用户主页，抓取中止');
        const headers = { 'content-type': 'application/json', platform: 'web' };
        const token = localStorage.getItem('JK_ACCESS_TOKEN');
        if (token) headers['x-jike-access-token'] = token;
        const deviceId = localStorage.getItem('JK_DEVICE_ID');
        if (deviceId) headers['x-jike-device-id'] = deviceId;

        let res, json;
        try {
          res = await fetch(`https://${API_HOST}${ENDPOINT}`, {
            method: 'POST',
            headers,
            // 服务端单页上限 25（实测 limit>25 也只返回 25），与 App 版 FetchEngine 一致
            body: JSON.stringify({ limit: 25, loadMoreKey, username: user }),
          });
          if (res.status === 429 || res.status === 403) throw new Error(`HTTP ${res.status}，触发限流，已中止`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          json = await res.json();
          consecutiveFailures = 0;
        } catch (e) {
          if (++consecutiveFailures >= 3) throw e;
          await sleep(2000 * consecutiveFailures); // 退避后重试当前页
          page--;
          continue;
        }

        const db = loadDb();
        const stored = Object.keys(db[user]?.byId || {}).length;
        if (stored >= MAX_POSTS_PER_USER) {
          fetchState.error = `已达单用户 ${MAX_POSTS_PER_USER} 条入库上限，更早的动态未入库`;
          break;
        }
        recordPage(json.data || [], user);
        fetchState.fetched += (json.data || []).length;
        notifyChange(user);
        renderPanelProgress();

        if (!json.loadMoreKey) break; // 游标到底
        loadMoreKey = json.loadMoreKey;
        await sleep(400 + Math.random() * 400);
      }
    } catch (e) {
      fetchState.error = String(e?.message || e);
    } finally {
      fetchState.running = false;
      if (profileUsername() === fetchState.user) {
        notifyChange(fetchState.user);
        renderPanel();
      }
    }
  }

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
    if (panelView.mode === 'chart') {
      const type = chartType();
      title = '📈 图表统计';
      const body = type === 'pie' ? pieSvg(topics) : type === 'bars' ? barsHtml(topics) : lineSvg(topics);
      const opts = [['pie', '饼图'], ['bars', '柱状图'], ['line', '折线图']]
        .map(([v, label]) => `<option value="${v}" ${type === v ? 'selected' : ''}>${label}</option>`).join('');
      bodyHtml = `<div style="display:flex;align-items:center;justify-content:flex-end;gap:6px;padding:8px 12px 0;color:#999;font-size:12px">
          按圈子·条数
          <select id="kojike-chart-type" style="border:1px solid #e3e5e8;border-radius:8px;padding:3px 6px;font-size:12px;color:#333;background:#fff">${opts}</select>
        </div>${body}`;
    } else if (panelView.mode === 'posts') {
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
      if (fetchState.error) {
        bodyHtml += `<div style="padding:6px 16px 10px;color:#e5484d;font-size:12px">✕ ${esc(fetchState.error)}</div>`;
      }
      bodyHtml += `<div style="border-top:1px solid #f2f2f2;padding:8px 16px;color:#bbb;font-size:11px">
        统计范围 = 已加载/已抓取的动态；「全量」自动翻页抓取该用户全部动态（限速约 1-2 条/秒）</div>`;
    }

    const fetching = fetchState.running && fetchState.user === viewingUser;
    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid #f2f2f2">
        <b id="kojike-title" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:${panelView.mode !== 'topics' ? 'pointer' : 'default'}">${esc(title)}</b>
        ${panelView.mode === 'topics' ? `<span id="kojike-progress" style="color:#999;font-size:12px;white-space:nowrap">${fetching ? `${fetchState.fetched} 条…` : ''}</span>` : ''}
        ${panelView.mode === 'topics' && !fetching ? `<span id="kojike-fetchall" style="color:${JIKE_BLUE};font-weight:600;cursor:pointer;white-space:nowrap">全量</span>` : ''}
        ${panelView.mode === 'topics' && topics.length ? `<span id="kojike-chart" title="图表统计" style="cursor:pointer">📈</span>` : ''}
        <span id="kojike-clear" style="color:#e5484d;cursor:pointer">清空</span>
        <span id="kojike-close" style="color:#999;cursor:pointer;padding:0 4px">✕</span>
      </div>${bodyHtml}`;
    panel.querySelector('#kojike-close').onclick = () => { panelOpen = false; panelView = { mode: 'topics' }; renderPanel(); };
    panel.querySelector('#kojike-chart')?.addEventListener('click', () => { panelView = { mode: 'chart' }; renderPanel(); });
    panel.querySelector('#kojike-chart-type')?.addEventListener('change', (e) => { setChartType(e.target.value); renderPanel(); });
    panel.querySelector('#kojike-fetchall')?.addEventListener('click', () => { fetchAll(viewingUser); renderPanel(); });
    panel.querySelector('#kojike-clear').onclick = () => {
      const db = loadDb();
      delete db[viewingUser];
      saveDb(db);
      notifyChange(viewingUser);
      panelView = { mode: 'topics' };
      renderPanel(); renderChip();
    };
    if (panelView.mode === 'chart') {
      // 饼图扇区/图例、柱状图行点击 → 该圈子明细（「其他」除外）
      const openTopic = (i) => {
        const name = sliceData(topics, chartType() === 'bars' ? 10 : 8)[i]?.name;
        if (name && name !== '其他') { panelView = { mode: 'posts', topic: name }; renderPanel(); }
      };
      panel.querySelectorAll('.kojike-slice, .kojike-legend, .kojike-bar').forEach((el) => {
        el.onclick = () => openTopic(Number(el.dataset.i));
      });
      panel.querySelector('#kojike-title').onclick = () => { panelView = { mode: 'topics' }; renderPanel(); };
    } else if (panelView.mode === 'posts') {
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

  // 抓取中的进度只更新行内文字，不整面板重绘（避免打断用户滚动列表）
  function renderPanelProgress() {
    if (!panelOpen) return;
    const el = document.getElementById('kojike-progress');
    if (el && fetchState.running) el.textContent = `${fetchState.fetched} 条…`;
  }

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
