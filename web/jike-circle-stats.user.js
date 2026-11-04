// ==UserScript==
// @name         即刻圈子统计
// @namespace    io.github.booker.kojike
// @version      0.7.0
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
  // 「无圈子」与 App 版一致用灰蓝圆标区分，避免和真圈子混淆
  const NO_TOPIC = '无圈子';
  const NO_TOPIC_COLOR = '#90A4AE';

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
  // /u/ 下任意路由（含动态详情页）的所属用户——UI 展示用；入库仍用 profileUsername 严格判定
  const pageUser = () => {
    const m = location.pathname.match(/^\/u\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  };
  // 详情页路由（/u/{user}/post/{id} 等）
  const isDetailPath = (p) => /^\/u\/[^/]+\/(post|repost)\//.test(p);
  // 动态详情路由映射，与宿主 bundle 的 De 常量一致
  const detailRoute = (type, id, username) => {
    const t = { ORIGINAL_POST: 'post', REPOST: 'repost', PERSONAL_UPDATE: 'post' }[type];
    return t ? `/u/${username}/${t}/${id}` : null;
  };
  // SPA 原生方式进详情：pushState + popstate 驱动宿主路由。
  // 整页 location.assign 会让宿主在新文档里渲染「什么也找不到｜返回首页」，
  // 且浏览器返回后 SPA 状态全丢；SPA 路由则 feed 保持在内存里，返回即回个人页原位。
  // 面板在同用户内跳详情时保持展开（v0.7.0），无需再借 sessionStorage 恢复视图。
  const goDetail = (type, id) => {
    const route = detailRoute(type, id, viewingUser);
    if (!route) return;
    history.pushState({}, '', route);
    window.dispatchEvent(new PopStateEvent('popstate'));
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
      const topic = p.topic?.content?.trim() || p.target?.topic?.content?.trim() || NO_TOPIC;
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

  // 宿主 TopicTagLayout 同款胶囊（App 版 commit 7fef776 反编译规格）：
  // 灰底 bg_on_body_2 圆角 10dp + 16dp 即刻蓝圆形图标 + 蓝字；「无圈子」灰蓝圆标区分
  const tagDotColor = (name) => (name === NO_TOPIC ? NO_TOPIC_COLOR : JIKE_BLUE);
  const tagHtml = (name) => `
    <span style="display:inline-flex;align-items:center;gap:5px;background:#f5f6f7;border-radius:10px;
      padding:4px 10px 4px 5px;color:${JIKE_BLUE};font-weight:500;max-width:250px;overflow:hidden;flex:none">
      <i style="width:14px;height:14px;border-radius:50%;background:${tagDotColor(name)};flex:none"></i>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</span>
    </span>`;
  // 计数徽章：蓝色加粗数字 + 弱化「条›」，Space 占位固定最右（App 版 f674fad 布局调整）
  const countHtml = (n) => `
    <span style="margin-left:auto;white-space:nowrap;color:#bbb;flex:none">
      <b style="color:${JIKE_BLUE};font-weight:700;font-size:14px">${n}</b> 条 ›
    </span>`;

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
  const DIM_LS_KEY = 'kojike_chart_dim';
  // 图表类型：仅「按圈子」维度下的饼/柱/折线；「按年」是独立的统计维度，不与图表类型混在同一下拉
  const chartType = () => { try { const t = localStorage.getItem(CHART_LS_KEY); return ['pie', 'bars', 'line'].includes(t) ? t : 'pie' } catch { return 'pie' } };
  const setChartType = (t) => { try { localStorage.setItem(CHART_LS_KEY, t) } catch { /* 忽略 */ } };
  // 统计维度：'topics'（按圈子）/ 'years'（按年）；兼容 v0.5.0 把「按年」存在图表类型里的旧选择
  const dim = () => {
    try {
      const stored = localStorage.getItem(DIM_LS_KEY);
      if (stored === 'years' || stored === 'topics') return stored;
      if (localStorage.getItem(CHART_LS_KEY) === 'years') return 'years';
      return 'topics';
    } catch { return 'topics' }
  };
  const setDim = (d) => { try { localStorage.setItem(DIM_LS_KEY, d) } catch { /* 忽略 */ } };
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
    const W = 348, H = 248, cx = 174, cy = 122, r1 = 44, r2 = 76;
    const colorOf = (name, i) => (name === NO_TOPIC ? NO_TOPIC_COLOR : PALETTE[i % PALETTE.length]);
    let a = -Math.PI / 2;
    const geo = data.map((d, i) => {
      const a0 = a;
      const ang = (d.count / total) * Math.PI * 2;
      a += ang;
      return { d, i, ang, mid: a0 + ang / 2 };
    });
    const slices = geo.map(({ d, i, ang, mid }) => {
      const color = colorOf(d.name, i);
      const pct = Math.round((d.count / total) * 1000) / 10;
      const title = `<title>${esc(d.name)} ${d.count}条 (${pct}%)</title>`;
      // 单一扇区画不成弧（起终点重合），退化为整环
      if (geo.length === 1) {
        return `<circle cx="${cx}" cy="${cy}" r="${(r1 + r2) / 2}" fill="none" stroke="${color}" stroke-width="${r2 - r1}">${title}</circle>`;
      }
      const a0 = mid - ang / 2, a1 = mid + ang / 2;
      const p = (r, x) => [cx + r * Math.cos(x), cy + r * Math.sin(x)].map((n) => n.toFixed(1));
      const [x0, y0] = p(r2, a0), [x1, y1] = p(r2, a1), [x2, y2] = p(r1, a1), [x3, y3] = p(r1, a0);
      const large = ang > Math.PI ? 1 : 0;
      return `<path class="kojike-slice" data-i="${i}" d="M${x0} ${y0} A${r2} ${r2} 0 ${large} 1 ${x1} ${y1} L${x2} ${y2} A${r1} ${r1} 0 ${large} 0 ${x3} ${y3} Z" fill="${color}">${title}</path>`;
    }).join('');
    // 外侧标签（引导线 + 圈子名 + 占比）：左右两侧分组，各按 y 排序后拉开最小间距防重叠
    const left = [], right = [];
    for (const g of geo) (Math.cos(g.mid) >= 0 ? right : left).push(g);
    for (const side of [left, right]) {
      side.sort((x, y) => Math.sin(x.mid) - Math.sin(y.mid));
      let last = -Infinity;
      for (const g of side) {
        let ly = Math.max(14, Math.min(H - 14, cy + Math.sin(g.mid) * (r2 + 14)));
        g.ly = last > -Infinity && ly - last < 13 ? last + 13 : ly;
        last = g.ly;
      }
    }
    const label = (g) => {
      const pct = Math.round((g.d.count / total) * 1000) / 10;
      const isR = Math.cos(g.mid) >= 0;
      const name = g.d.name.length > 5 ? g.d.name.slice(0, 5) + '…' : g.d.name;
      const sx = cx + Math.cos(g.mid) * (r2 + 2), sy = cy + Math.sin(g.mid) * (r2 + 2);
      const mx = cx + Math.cos(g.mid) * (r2 + 12);
      const tx = cx + (isR ? 1 : -1) * (r2 + 18);
      return `<polyline points="${sx.toFixed(1)},${sy.toFixed(1)} ${mx.toFixed(1)},${g.ly.toFixed(1)} ${(isR ? tx - 3 : tx + 3).toFixed(1)},${g.ly.toFixed(1)}" fill="none" stroke="${colorOf(g.d.name, g.i)}" stroke-width="1"/>
        <text x="${tx.toFixed(1)}" y="${(g.ly + 3).toFixed(1)}" text-anchor="${isR ? 'start' : 'end'}" font-size="10" fill="#555">${esc(name)} <tspan fill="#999">${pct}%</tspan></text>`;
    };
    const legend = data.map((d, i) => {
      const pct = Math.round((d.count / total) * 1000) / 10;
      return `<span class="kojike-legend" data-i="${i}" style="display:inline-flex;align-items:center;gap:5px;margin:3px 10px 3px 0;cursor:pointer">
        <i style="width:9px;height:9px;border-radius:50%;background:${colorOf(d.name, i)}"></i>
        <span style="max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.name)}</span>
        <b style="color:${JIKE_BLUE}">${d.count}</b><span style="color:#bbb">${pct}%</span></span>`;
    }).join('');
    return `<div style="text-align:center;padding-top:6px">
      <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;margin:0 auto">${slices}${left.map(label).join('')}${right.map(label).join('')}
        <text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="20" font-weight="700" fill="#333">${total}</text>
        <text x="${cx}" y="${cy + 15}" text-anchor="middle" font-size="10" fill="#999">条动态</text></svg>
      <div style="text-align:left;padding:6px 12px 10px">${legend}</div></div>`;
  }

  function barsHtml(topics) {
    const data = sliceData(topics, 10);
    const max = Math.max(...data.map((d) => d.count), 1);
    return `<div style="padding:10px 14px 12px">` + data.map((d, i) => `
      <div class="kojike-bar" data-i="${i}" style="display:flex;align-items:center;gap:8px;margin:7px 0;cursor:pointer">
        <span style="flex:0 0 96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#555;text-align:right">${esc(d.name)}</span>
        <span style="flex:1;height:14px;background:#f0f1f3;border-radius:7px;overflow:hidden">
          <i style="display:block;height:100%;width:${(d.count / max * 100).toFixed(1)}%;background:${d.name === NO_TOPIC ? NO_TOPIC_COLOR : PALETTE[i % PALETTE.length]};border-radius:7px"></i>
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
      const color = t.name === NO_TOPIC ? NO_TOPIC_COLOR : PALETTE[i % PALETTE.length];
      const pts = keys.map((k, j) => `${x(j).toFixed(1)},${y(byMonth.get(k)?.[t.name] || 0).toFixed(1)}`).join(' ');
      const dots = keys.map((k, j) => {
        const v = byMonth.get(k)?.[t.name] || 0;
        return v ? `<circle cx="${x(j).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.6" fill="${color}"><title>${esc(t.name)} ${k} · ${v}条</title></circle>` : '';
      }).join('');
      return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round"/>${dots}`;
    }).join('');
    const legend = top5.map((t, i) => `<span style="display:inline-flex;align-items:center;gap:4px;margin:3px 8px 3px 0">
        <i style="width:9px;height:9px;border-radius:50%;background:${t.name === NO_TOPIC ? NO_TOPIC_COLOR : PALETTE[i % PALETTE.length]}"></i>
        <span style="max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.name)}</span></span>`).join('');
    return `<div style="padding:8px 10px 10px"><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${grid}${lines}${xlabels}</svg>
      <div style="padding:0 4px">${legend}</div></div>`;
  }

  // ---------- 年度统计 ----------
  // 年份视图是时间维度的图表：汇总行给覆盖跨度，堆叠柱画每年总量与 top 圈子占比，点柱下钻该年明细
  function yearBuckets(topics) {
    const byYear = new Map(); // 'YYYY' -> { total, byTopic: Map<name, count> }
    let noDate = 0;
    for (const t of topics) {
      for (const p of t.posts) {
        const y = (p.date || '').slice(0, 4);
        if (!/^\d{4}$/.test(y)) { noDate++; continue }
        const o = byYear.get(y) || { total: 0, byTopic: new Map() };
        o.total++;
        o.byTopic.set(t.name, (o.byTopic.get(t.name) || 0) + 1);
        byYear.set(y, o);
      }
    }
    return { years: [...byYear.entries()].sort(([a], [b]) => a.localeCompare(b)), noDate };
  }

  function yearStackSvg(topics) {
    const { years, noDate } = yearBuckets(topics);
    if (!years.length) return `<div style="padding:24px 16px;text-align:center;color:#999">动态缺少日期信息，无法做年度统计</div>`;
    // top4 排除「无圈子」：否则它会既占一个 palette 蓝色分段、又叠加灰色分段，图上出现两个无圈子（朋友反馈 #5）
    const top4 = topics.filter((t) => t.name !== NO_TOPIC).slice(0, 4).map((t) => t.name);
    const W = 328, H = 190, pl = 30, pr = 10, pt = 12, pb = 22;
    const maxY = Math.max(...years.map(([, o]) => o.total), 1);
    const bw = Math.min(46, (W - pl - pr) / years.length * 0.62);
    const x = (i) => pl + (i + 0.5) * (W - pl - pr) / years.length;
    const y = (v) => pt + (1 - v / maxY) * (H - pt - pb);
    const grid = [0, Math.round(maxY / 2), maxY].map((v) =>
      `<line x1="${pl}" y1="${y(v).toFixed(1)}" x2="${W - pr}" y2="${y(v).toFixed(1)}" stroke="#eef0f2"/>
       <text x="${pl - 5}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#bbb">${v}</text>`).join('');
    const bars = years.map(([yr, o], i) => {
      const colorOf = (name) => (name === NO_TOPIC ? NO_TOPIC_COLOR : PALETTE[top4.indexOf(name) % PALETTE.length]);
      // 堆叠顺序：top 圈子按 palette，其余圈子合并为灰段，最上叠「无圈子」
      const segs = [];
      let rest = o.total;
      for (const name of top4) {
        const c = o.byTopic.get(name) || 0;
        if (!c) continue;
        segs.push({ name, count: c, color: colorOf(name) });
        rest -= c;
      }
      const noTopic = o.byTopic.get(NO_TOPIC) || 0;
      rest -= noTopic;
      if (rest > 0) segs.push({ name: '其他圈子', count: rest, color: '#cfd8dc' });
      if (noTopic) segs.push({ name: NO_TOPIC, count: noTopic, color: NO_TOPIC_COLOR });
      let acc = 0;
      const rects = segs.map((s) => {
        const y0 = y(acc + s.count), h = Math.max(1.5, y(acc) - y(acc + s.count));
        acc += s.count;
        return `<rect class="kojike-yearbar" data-y="${yr}" x="${(x(i) - bw / 2).toFixed(1)}" y="${y0.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${s.color}"><title>${yr} · ${esc(s.name)} ${s.count}条</title></rect>`;
      }).join('');
      const label = `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="#666">${yr.slice(2)}年</text>
        <text x="${x(i).toFixed(1)}" y="${(y(o.total) - 4).toFixed(1)}" text-anchor="middle" font-size="9" fill="${JIKE_BLUE}" font-weight="600">${o.total}</text>`;
      return rects + label;
    }).join('');
    const legend = [...top4.map((name) => ({ name, color: PALETTE[top4.indexOf(name) % PALETTE.length] })),
      { name: '其他圈子', color: '#cfd8dc' }, { name: NO_TOPIC, color: NO_TOPIC_COLOR }]
      .map(({ name, color }) => `<span style="display:inline-flex;align-items:center;gap:4px;margin:3px 8px 3px 0">
        <i style="width:9px;height:9px;border-radius:2px;background:${color}"></i>
        <span style="max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</span></span>`).join('');
    const [firstY] = years[0], [lastY, lastO] = years[years.length - 1];
    const earliest = topics.flatMap((t) => t.posts).map((p) => p.date || '').filter(Boolean).sort()[0] || '';
    return `<div style="padding:8px 10px 4px">
      <div style="color:#bbb;font-size:11px;padding:0 4px 4px">覆盖 ${firstY}~${lastY} 年 · 最早 ${esc(earliest.slice(0, 10))}${noDate ? ` · ${noDate} 条无日期` : ''} · 统计范围 = 已抓取动态</div>
      <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${grid}${bars}</svg>
      <div style="padding:2px 4px 0">${legend}</div></div>`;
  }

  function yearPostsView(topics, year) {
    const posts = topics.flatMap((t) => t.posts)
      .filter((p) => (p.date || '').startsWith(year))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (!posts.length) return { html: `<div style="padding:24px 16px;text-align:center;color:#999">${esc(year)} 年暂无明细</div>`, count: 0 };
    const byTopic = new Map();
    for (const p of posts) byTopic.set(p.topic, (byTopic.get(p.topic) || 0) + 1);
    const summary = [...byTopic.entries()].sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      // 胶囊可点击：下钻「该年 × 该圈子」交叉明细
      .map(([name, n]) => `<span class="kojike-ytopic" data-topic="${esc(name)}" style="cursor:pointer">${tagHtml(name).replace('max-width:250px', 'max-width:170px')}${countHtml(n)}</span>`)
      .join('');
    const cards = posts.map((p) => `
      <div class="kojike-post" data-id="${esc(p.id)}" data-type="${esc(p.type)}" style="margin:8px 12px;padding:10px 12px;background:#f7f8fa;border-radius:10px;cursor:pointer">
        <div style="color:#999;font-size:11px;margin-bottom:3px">${esc((p.date || '').slice(0, 10) || '日期未知')} · ${esc(p.topic)}</div>
        <div style="overflow:hidden">${esc(p.content || '〈无文字内容〉')}</div>
      </div>`).join('');
    return { html: `<div style="display:flex;flex-wrap:wrap;gap:6px 2px;padding:10px 16px 2px;border-bottom:1px solid #f5f5f5">${summary}</div>${cards}`, count: posts.length };
  }

  // 圈子详情内的按年分布图：哪年发得多一眼可见，点击柱 = 只看该年（再点取消）
  function topicYearBars(posts, activeYear) {
    const byYear = new Map();
    for (const p of posts) {
      const y = (p.date || '').slice(0, 4);
      if (/^\d{4}$/.test(y)) byYear.set(y, (byYear.get(y) || 0) + 1);
    }
    const years = [...byYear.entries()].sort(([a], [b]) => a.localeCompare(b));
    if (years.length < 2) return ''; // 单年（或全部无日期）没有分布可言
    const maxY = Math.max(...years.map(([, c]) => c), 1);
    const pl = 30, pr = 8, pt = 14, pb = 20;
    const W = Math.max(328, pl + pr + years.length * 34); // 年份多时横向滚动
    const H = 150, plotH = H - pt - pb;
    const slot = (W - pl - pr) / years.length;
    const x = (i) => pl + (i + 0.5) * slot;
    const y = (v) => pt + (1 - v / maxY) * plotH;
    const bw = Math.min(28, slot * 0.6);
    const grid = [0, Math.round(maxY / 2), maxY].map((v) =>
      `<line x1="${pl}" y1="${y(v).toFixed(1)}" x2="${W - pr}" y2="${y(v).toFixed(1)}" stroke="#eef0f2"/>
       <text x="${pl - 5}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#bbb">${v}</text>`).join('');
    const bars = years.map(([yr, c], i) => {
      const on = yr === activeYear;
      const color = on ? JIKE_BLUE : '#d6dade';
      const rect = `<rect class="kojike-tyear" data-y="${yr}" x="${(x(i) - bw / 2).toFixed(1)}" y="${y(c).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(2, plotH + pt - y(c)).toFixed(1)}" rx="3" fill="${color}"/>`;
      const labels = `<text x="${x(i).toFixed(1)}" y="${(y(c) - 4).toFixed(1)}" text-anchor="middle" font-size="10" fill="${on ? JIKE_BLUE : '#999'}" font-weight="${on ? 600 : 400}">${c}</text>
        <text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="${on ? JIKE_BLUE : '#666'}">${yr.slice(2)}年</text>`;
      // 整列命中区放最上层：柱、数字、年份标签任意位置点击都生效
      const hit = `<rect class="kojike-tyear" data-y="${yr}" x="${(x(i) - slot / 2).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${H}" fill="transparent"><title>${yr} 年 ${c} 条 · 点击${on ? '取消过滤' : '只看该年'}</title></rect>`;
      return rect + labels + hit;
    }).join('');
    return `<div style="overflow-x:auto;padding:10px 10px 2px 4px">
      <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;min-width:100%">${grid}${bars}</svg></div>`;
  }

  // ---------- 全量抓取（平移 App 版 FetchEngine 策略） ----------
  // 手动触发；loadMoreKey 游标翻页；限速 + 退避 + 硬上限，fail-closed
  const fetchState = { running: false, user: null, fetched: 0, error: null, stopRequested: false, notice: null };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fetchAll(user) {
    if (fetchState.running || loadDb()[user]?.full) return;
    fetchState.running = true;
    fetchState.user = user;
    fetchState.fetched = 0;
    fetchState.error = null;
    fetchState.notice = null;
    fetchState.stopRequested = false;
    let consecutiveFailures = 0;

    try {
      let loadMoreKey;
      for (let page = 0; page < 600; page++) {
        if (fetchState.stopRequested) {
          fetchState.notice = `已停止，本次新增 ${fetchState.fetched} 条`;
          break;
        }
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

        if (!json.loadMoreKey) {
          // 游标到底：标记该用户已全量，按钮置灰防重复抓（朋友反馈：全量会被连按两次）
          const db = loadDb();
          if (db[user]) { db[user].full = true; saveDb(db); }
          break;
        }
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
    const user = pageUser(); // /u/ 下任意路由（含动态详情页）都显示 chip（朋友反馈 #4）
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
      ensureStyles();
    }
    viewingUser = user;
    uiRoot.textContent = `📊 圈子统计 · ${total}`;
  }

  // 扇区/图例/列表行的 hover 反馈（SVG 内联元素无 :hover 以外的廉价方案）
  const ensureStyles = () => {
    if (document.getElementById('kojike-style')) return;
    const s = document.createElement('style');
    s.id = 'kojike-style';
    s.textContent = `.kojike-slice:hover,.kojike-legend:hover{opacity:.72}
      .kojike-bar:hover,.kojike-topic:hover,.kojike-post:hover{background:#f7f8fa}`;
    document.head.appendChild(s);
  };

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
    // 记忆的面板尺寸：左缘拖宽、上缘拖高（朋友反馈 #3：看长列表想一屏显示更多）
    let panelSize = {};
    try { panelSize = JSON.parse(localStorage.getItem('kojike_panel_size')) || {} } catch { /* 忽略 */ }
    if (panelSize.w) panel.style.width = `${panelSize.w}px`;
    if (panelSize.h) panel.style.maxHeight = `${panelSize.h}px`;

    let bodyHtml;
    let title = `圈子统计 · 共 ${total} 条动态`;
    if (panelView.mode === 'year') {
      title = `📅 ${panelView.year} 年动态`;
      const { html } = yearPostsView(topics, panelView.year);
      bodyHtml = html;
    } else if (panelView.mode === 'chart') {
      const type = chartType();
      const d = dim();
      title = '📈 图表统计';
      const body = d === 'years' ? yearStackSvg(topics) : type === 'pie' ? pieSvg(topics) : type === 'bars' ? barsHtml(topics) : lineSvg(topics);
      const dimOpts = [['topics', '按圈子'], ['years', '按年']]
        .map(([v, label]) => `<option value="${v}" ${d === v ? 'selected' : ''}>${label}</option>`).join('');
      const dimSel = `<label style="display:inline-flex;align-items:center;gap:4px;color:#999;font-size:12px">统计维度
          <select id="kojike-chart-dim" style="border:1px solid #e3e5e8;border-radius:8px;padding:3px 6px;font-size:12px;color:#333;background:#fff">${dimOpts}</select></label>`;
      // 图表类型只属于「按圈子」维度；「按年」是堆叠柱，没有图表类型可选
      const typeSel = d === 'topics'
        ? (() => {
            const opts = [['pie', '饼图'], ['bars', '柱状图'], ['line', '折线图']]
              .map(([v, label]) => `<option value="${v}" ${type === v ? 'selected' : ''}>${label}</option>`).join('');
            return `<label style="display:inline-flex;align-items:center;gap:4px;color:#999;font-size:12px">图表
              <select id="kojike-chart-type" style="border:1px solid #e3e5e8;border-radius:8px;padding:3px 6px;font-size:12px;color:#333;background:#fff">${opts}</select></label>`;
          })()
        : `<span style="color:#bbb;font-size:12px">按年份·堆叠</span>`;
      bodyHtml = `<div style="display:flex;align-items:center;justify-content:space-between;gap:6px;padding:8px 12px 0;color:#999;font-size:12px">
          ${dimSel}${typeSel}
        </div>${body}`;
    } else if (panelView.mode === 'posts') {
      const t = topics.find((x) => x.name === panelView.topic);
      const fy = panelView.year;
      title = fy ? `‹ ${panelView.topic} · ${fy}` : `‹ ${panelView.topic}`;
      const all = (t?.posts || []).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      const shown = fy ? all.filter((p) => (p.date || '').startsWith(fy)) : all;
      const dist = topicYearBars(all, fy);
      const cards = shown
        .map((p) => `
          <div class="kojike-post" data-id="${esc(p.id)}" data-type="${esc(p.type)}" style="margin:8px 12px;padding:10px 12px;background:#f7f8fa;border-radius:10px;cursor:pointer">
            <div style="color:#999;font-size:11px;margin-bottom:3px">${esc((p.date || '').slice(0, 10) || '日期未知')}</div>
            <div style="overflow:hidden">${esc(p.content || '<i>无文字内容</i>')}</div>
          </div>`)
        .join('');
      bodyHtml = dist + (cards || `<div style="padding:24px 16px;text-align:center;color:#999">${fy ? `${esc(fy)} 年该圈子暂无动态` : '该圈子暂无明细'}</div>`);
    } else {
      // 注意 topics 数组必须 join('')，否则隐式 toString 会在行间插入逗号
      bodyHtml = topics.length
        ? topics.map((t, i) => `
          <div class="kojike-topic" data-i="${i}" style="display:flex;align-items:center;gap:10px;padding:8px 16px 8px 24px;cursor:pointer;border-top:1px solid #f5f5f5">
            ${tagHtml(t.name)}
            ${countHtml(t.count)}
          </div>`).join('')
        : `<div style="padding:24px 16px;text-align:center;color:#999">暂无数据，先上下滚动加载动态</div>`;
      if (fetchState.error) {
        bodyHtml += `<div style="padding:6px 16px 10px;color:#e5484d;font-size:12px">✕ ${esc(fetchState.error)}</div>`;
      }
      if (fetchState.notice) {
        bodyHtml += `<div style="padding:6px 16px 10px;color:#999;font-size:12px">⏹ ${esc(fetchState.notice)}</div>`;
      }
      bodyHtml += `<div style="border-top:1px solid #f2f2f2;padding:8px 16px;color:#bbb;font-size:11px">
        统计范围 = 已加载/已抓取的动态；「全量」自动翻页抓取该用户全部动态（限速约 1-2 条/秒）；拖面板左缘/上缘可调整大小</div>`;
    }

    const fetching = fetchState.running && fetchState.user === viewingUser;
    const fullDone = !!loadDb()[viewingUser]?.full;
    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid #f2f2f2">
        ${panelView.mode !== 'topics' ? `<span id="kojike-back" style="color:${JIKE_BLUE};font-weight:600;cursor:pointer;white-space:nowrap;flex:none">‹ 返回</span>` : ''}
        <b id="kojike-title" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:${panelView.mode !== 'topics' ? 'pointer' : 'default'}">${esc(title)}</b>
        ${panelView.mode === 'topics' ? `<span id="kojike-progress" style="color:#999;font-size:12px;white-space:nowrap">${fetching ? `${fetchState.fetched} 条…` : ''}</span>` : ''}
        ${panelView.mode === 'topics' && fetching ? `<span id="kojike-stop" style="color:#e5484d;font-weight:600;cursor:pointer;white-space:nowrap">■ 停止</span>` : ''}
        ${panelView.mode === 'topics' && !fetching ? (fullDone
          ? `<span title="该用户动态已全部抓取入库" style="color:#c9cdd1;font-weight:600;white-space:nowrap">已全量</span>`
          : `<span id="kojike-fetchall" style="color:${JIKE_BLUE};font-weight:600;cursor:pointer;white-space:nowrap">全量</span>`) : ''}
        ${panelView.mode === 'topics' && topics.length ? `<span id="kojike-chart" title="查看图表统计" style="color:#fff;background:${JIKE_BLUE};border-radius:12px;padding:3px 9px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;flex:none">📈 图表</span>` : ''}
        <span id="kojike-clear" style="color:#e5484d;cursor:pointer;flex:none">清空</span>
        <span id="kojike-close" style="color:#999;cursor:pointer;padding:0 4px;flex:none">✕</span>
      </div>${bodyHtml}`;
    // 「‹ 返回」按视图层级回退：年度明细 → 图表；圈子明细 → 记住的来源（年度页或列表）；其余 → 列表
    panel.querySelector('#kojike-back')?.addEventListener('click', () => {
      panelView = panelView.mode === 'year' ? { mode: 'chart' }
        : panelView.mode === 'posts' && panelView.back ? { ...panelView.back }
        : { mode: 'topics' };
      renderPanel();
    });
    panel.querySelector('#kojike-close').onclick = () => { panelOpen = false; panelView = { mode: 'topics' }; renderPanel(); };
    panel.querySelector('#kojike-chart')?.addEventListener('click', () => { panelView = { mode: 'chart' }; renderPanel(); });
    panel.querySelector('#kojike-chart-dim')?.addEventListener('change', (e) => { setDim(e.target.value); renderPanel(); });
    panel.querySelector('#kojike-chart-type')?.addEventListener('change', (e) => { setChartType(e.target.value); renderPanel(); });
    panel.querySelector('#kojike-fetchall')?.addEventListener('click', () => { fetchAll(viewingUser); renderPanel(); });
    panel.querySelector('#kojike-stop')?.addEventListener('click', () => { fetchState.stopRequested = true; renderPanelProgress(); });
    panel.querySelector('#kojike-clear').onclick = () => {
      const db = loadDb();
      delete db[viewingUser];
      saveDb(db);
      notifyChange(viewingUser);
      panelView = { mode: 'topics' };
      renderPanel(); renderChip();
    };
    if (panelView.mode === 'year') {
      // 年度明细：标题返回图表，卡片跳详情；圈子胶囊下钻「该年 × 该圈子」
      panel.querySelector('#kojike-title').onclick = () => { panelView = { mode: 'chart' }; renderPanel(); };
      panel.querySelectorAll('.kojike-post').forEach((el) => {
        el.onclick = () => goDetail(el.dataset.type, el.dataset.id);
      });
      panel.querySelectorAll('.kojike-ytopic').forEach((el) => {
        el.onclick = () => { panelView = { mode: 'posts', topic: el.dataset.topic, year: panelView.year, back: { mode: 'year', year: panelView.year } }; renderPanel(); };
      });
    } else if (panelView.mode === 'chart') {
      // 饼图扇区/图例、柱状图行点击 → 该圈子明细（「其他」除外）；年度柱点击 → 该年明细
      const openTopic = (i) => {
        const name = sliceData(topics, chartType() === 'bars' ? 10 : 8)[i]?.name;
        if (name && name !== '其他') { panelView = { mode: 'posts', topic: name }; renderPanel(); }
      };
      panel.querySelectorAll('.kojike-slice, .kojike-legend, .kojike-bar').forEach((el) => {
        el.onclick = () => openTopic(Number(el.dataset.i));
      });
      panel.querySelectorAll('.kojike-yearbar').forEach((el) => {
        el.onclick = () => { panelView = { mode: 'year', year: el.dataset.y }; renderPanel(); };
      });
      panel.querySelector('#kojike-title').onclick = () => { panelView = { mode: 'topics' }; renderPanel(); };
    } else if (panelView.mode === 'posts') {
      // 标题即「‹ 圈子名」返回按钮：从年度页下钻来的返回年度页，否则回列表
      panel.querySelector('#kojike-title').onclick = () => { panelView = panelView.back ? { ...panelView.back } : { mode: 'topics' }; renderPanel(); };
      // 年度分布柱：点击 = 只看该年（再点取消；取消后返回箭头回到列表）
      panel.querySelectorAll('.kojike-tyear').forEach((el) => {
        el.onclick = () => {
          const y = el.dataset.y;
          panelView = panelView.year === y
            ? { mode: 'posts', topic: panelView.topic }
            : { mode: 'posts', topic: panelView.topic, year: y, back: panelView.back };
          renderPanel();
        };
      });
      panel.querySelectorAll('.kojike-post').forEach((el) => {
        el.onclick = () => goDetail(el.dataset.type, el.dataset.id);
      });
    } else {
      panel.querySelectorAll('.kojike-topic').forEach((el) => {
        el.onclick = () => {
          panelView = { mode: 'posts', topic: topics[Number(el.dataset.i)].name };
          renderPanel();
        };
      });
    }
    // 边缘拖拽调尺寸：命中面板左缘 10px 拖宽、上缘 10px 拖高；面板每次重绘都重新挂监听
    panel.addEventListener('pointerdown', (e) => {
      const rect = panel.getBoundingClientRect();
      const nearLeft = e.clientX - rect.left < 10;
      const nearTop = e.clientY - rect.top < 10;
      if (!nearLeft && !nearTop) return;
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY, sw = panel.offsetWidth, sh = panel.offsetHeight;
      const move = (ev) => {
        if (nearLeft) {
          panelSize.w = Math.min(560, Math.max(300, sw + (sx - ev.clientX)));
          panel.style.width = `${panelSize.w}px`;
        }
        if (nearTop) {
          panelSize.h = Math.min(window.innerHeight - 90, Math.max(240, sh + (sy - ev.clientY)));
          panel.style.maxHeight = `${panelSize.h}px`;
        }
      };
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        try { localStorage.setItem('kojike_panel_size', JSON.stringify(panelSize)) } catch { /* 忽略 */ }
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    });
    document.body.appendChild(panel);
  }

  const notifyChange = (user) => {
    if (user === pageUser()) renderChip();
  };

  // 抓取中的进度只更新行内文字，不整面板重绘（避免打断用户滚动列表）
  function renderPanelProgress() {
    if (!panelOpen) return;
    const el = document.getElementById('kojike-progress');
    if (el && fetchState.running) el.textContent = `${fetchState.fetched} 条…${fetchState.stopRequested ? '（停止中）' : ''}`;
  }

  // SPA 路由变化 + 数据到达都要重渲染（对应 App 版两处自动刷新）
  let lastPath = location.pathname;
  const handleRoute = () => {
    if (location.pathname === lastPath) return; // goDetail 自派的 popstate，pushState 包装器已处理
    const prevUser = viewingUser;
    const wasOpen = panelOpen;
    lastPath = location.pathname;
    renderChip(); // 先刷新 viewingUser（/u/ 下任意路由都保留 chip，含详情页），renderPanel 依赖它
    const user = pageUser();
    if (!user || user !== prevUser || !wasOpen) {
      // 换了浏览对象 / 离开 /u/ 域 / 面板本来关着：收起复位
      panelOpen = false;
      panelView = { mode: 'topics' };
    }
    // 同一用户内跳转（典型：从卡片进动态详情）且面板开着 → 面板原地保持、视图不动（朋友反馈 #4）
    renderPanel();
  };
  const wrapHistory = (name) => {
    const orig = history[name];
    history[name] = function () {
      const r = orig.apply(this, arguments);
      queueMicrotask(handleRoute);
      return r;
    };
  };
  wrapHistory('pushState');
  wrapHistory('replaceState');
  addEventListener('popstate', () => queueMicrotask(handleRoute));

  // ---------- 启动 ----------
  armCapture();
  const mount = () => { document.body ? renderChip() : setTimeout(mount, 50); };
  mount();
})();
