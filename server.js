'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const Database = require('better-sqlite3');

// ============ 配置 ============
const PORT = parseInt(process.env.PORT || '3210', 10);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ============ 数据库 ============
const db = new Database(path.join(DATA_DIR, 'square.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    icon TEXT DEFAULT '',
    color TEXT DEFAULT '#3b82f6',
    base_url TEXT DEFAULT '',
    api_key TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    display_name TEXT DEFAULT '',
    description TEXT DEFAULT '',
    tags TEXT DEFAULT '[]',
    context_length INTEGER DEFAULT 0,
    price_input REAL DEFAULT 0,
    price_output REAL DEFAULT 0,
    enabled INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_models_channel ON models(channel_id);
`);

// ===== 字段迁移：兼容旧库 =====
function ensureColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
  if (!cols.includes(col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    console.log(`[migrate] ${table}.${col} 已添加`);
  }
}
ensureColumn('channels', 'base_url', "TEXT DEFAULT ''");
ensureColumn('channels', 'api_key', "TEXT DEFAULT ''");

// 首次启动注入示例数据
const channelCount = db.prepare('SELECT COUNT(*) AS n FROM channels').get().n;
if (channelCount === 0) {
  const now = Date.now();
  const insertChannel = db.prepare(`
    INSERT INTO channels(name, description, icon, color, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertModel = db.prepare(`
    INSERT INTO models(channel_id, name, display_name, description, tags, context_length, price_input, price_output, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const seeds = [
    {
      ch: { name: 'OpenAI', description: '官方旗舰系列', icon: '🤖', color: '#10a37f', sort_order: 1 },
      models: [
        { name: 'gpt-4o', display_name: 'GPT-4o 全能旗舰', description: '多模态旗舰模型，速度快、价格友好', tags: ['视觉','工具调用','推理'], context_length: 128000, price_input: 2.5, price_output: 10 },
        { name: 'gpt-4o-mini', display_name: 'GPT-4o Mini', description: '高性价比小模型', tags: ['工具调用','轻量'], context_length: 128000, price_input: 0.15, price_output: 0.6 },
        { name: 'o1', display_name: 'O1 深度推理', description: '链式思考推理模型', tags: ['深度推理'], context_length: 200000, price_input: 15, price_output: 60 }
      ]
    },
    {
      ch: { name: 'Anthropic', description: 'Claude 系列', icon: '🧠', color: '#d97706', sort_order: 2 },
      models: [
        { name: 'claude-opus-4-7', display_name: 'Claude Opus 4.7', description: '最强综合能力旗舰', tags: ['推理','编码','长文'], context_length: 200000, price_input: 15, price_output: 75 },
        { name: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', description: '平衡型主力模型', tags: ['推理','编码'], context_length: 200000, price_input: 3, price_output: 15 },
        { name: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', description: '极速轻量', tags: ['快速','轻量'], context_length: 200000, price_input: 1, price_output: 5 }
      ]
    },
    {
      ch: { name: 'Google', description: 'Gemini 系列', icon: '✨', color: '#4285f4', sort_order: 3 },
      models: [
        { name: 'gemini-2.5-pro', display_name: 'Gemini 2.5 Pro', description: '百万上下文旗舰', tags: ['超长上下文','多模态'], context_length: 1000000, price_input: 1.25, price_output: 5 },
        { name: 'gemini-2.5-flash', display_name: 'Gemini 2.5 Flash', description: '极速响应', tags: ['快速','多模态'], context_length: 1000000, price_input: 0.075, price_output: 0.3 }
      ]
    }
  ];

  const tx = db.transaction(() => {
    for (const s of seeds) {
      const r = insertChannel.run(s.ch.name, s.ch.description, s.ch.icon, s.ch.color, s.ch.sort_order, now, now);
      const chId = r.lastInsertRowid;
      s.models.forEach((m, idx) => {
        insertModel.run(chId, m.name, m.display_name, m.description, JSON.stringify(m.tags), m.context_length, m.price_input, m.price_output, idx, now, now);
      });
    }
  });
  tx();
  console.log('[seed] 示例数据已注入');
}

// ============ 工具 ============
function nowTs() { return Date.now(); }

function sign(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  if (expect !== sig) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function requireAdmin(req, res, next) {
  const payload = verify(req.cookies.session);
  if (!payload || payload.role !== 'admin') {
    return res.status(401).json({ error: '未登录或登录已过期' });
  }
  req.user = payload;
  next();
}

function parseTags(s) {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

function rowToModel(m) {
  return {
    id: m.id,
    channel_id: m.channel_id,
    name: m.name,
    display_name: m.display_name || m.name,
    description: m.description || '',
    tags: parseTags(m.tags),
    context_length: m.context_length || 0,
    price_input: m.price_input || 0,
    price_output: m.price_output || 0,
    enabled: !!m.enabled,
    sort_order: m.sort_order || 0
  };
}

// ============ App ============
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// 静态资源
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ---------- 公开 API ----------
app.get('/api/public/channels', (req, res) => {
  const channels = db.prepare(`
    SELECT * FROM channels ORDER BY sort_order ASC, id ASC
  `).all();
  const modelsByCh = db.prepare(`
    SELECT * FROM models WHERE enabled = 1 ORDER BY sort_order ASC, id ASC
  `).all();
  const byChannel = new Map();
  for (const m of modelsByCh) {
    if (!byChannel.has(m.channel_id)) byChannel.set(m.channel_id, []);
    byChannel.get(m.channel_id).push(rowToModel(m));
  }
  const result = channels.map(c => ({
    id: c.id,
    name: c.name,
    description: c.description || '',
    icon: c.icon || '',
    color: c.color || '#3b82f6',
    sort_order: c.sort_order || 0,
    models: byChannel.get(c.id) || []
  }));
  res.json({ channels: result, total_channels: result.length, total_models: modelsByCh.length });
});

// ---------- 认证 API ----------
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: '密码错误' });
  }
  const token = sign({ role: 'admin', exp: Date.now() + 7 * 24 * 3600 * 1000 });
  res.cookie('session', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 3600 * 1000
  });
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('session');
  res.json({ ok: true });
});

app.get('/api/admin/me', (req, res) => {
  const payload = verify(req.cookies.session);
  if (!payload || payload.role !== 'admin') return res.status(401).json({ error: '未登录' });
  res.json({ ok: true, role: payload.role });
});

// ---------- 管理 API：渠道 ----------
function safeChannel(c) {
  // 给前端的渠道，api_key 改成布尔标记，不回明文
  return {
    ...c,
    api_key: undefined,
    has_api_key: !!(c.api_key && String(c.api_key).length > 0)
  };
}

app.get('/api/admin/channels', requireAdmin, (req, res) => {
  const channels = db.prepare('SELECT * FROM channels ORDER BY sort_order ASC, id ASC').all();
  const counts = db.prepare('SELECT channel_id, COUNT(*) AS n FROM models GROUP BY channel_id').all();
  const cm = new Map(counts.map(r => [r.channel_id, r.n]));
  res.json({ channels: channels.map(c => ({ ...safeChannel(c), model_count: cm.get(c.id) || 0 })) });
});

app.post('/api/admin/channels', requireAdmin, (req, res) => {
  const { name, description = '', icon = '', color = '#3b82f6', base_url = '', api_key = '', sort_order = 0 } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: '渠道名不能为空' });
  const ts = nowTs();
  const r = db.prepare(`
    INSERT INTO channels(name, description, icon, color, base_url, api_key, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name.trim(), description, icon, color, String(base_url || '').trim(), String(api_key || '').trim(), sort_order, ts, ts);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/admin/channels/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, description = '', icon = '', color = '#3b82f6', base_url = '', api_key, sort_order = 0 } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: '渠道名不能为空' });

  // api_key 仅在前端传入非空字符串时才更新；传 undefined / 空字符串则保留原值（避免误清空）
  const cur = db.prepare('SELECT api_key FROM channels WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: '渠道不存在' });
  const finalApiKey = (typeof api_key === 'string' && api_key.length > 0) ? api_key : cur.api_key;

  const r = db.prepare(`
    UPDATE channels
       SET name=?, description=?, icon=?, color=?, base_url=?, api_key=?, sort_order=?, updated_at=?
     WHERE id=?
  `).run(name.trim(), description, icon, color, String(base_url || '').trim(), finalApiKey, sort_order, nowTs(), id);
  if (r.changes === 0) return res.status(404).json({ error: '渠道不存在' });
  res.json({ ok: true });
});

app.delete('/api/admin/channels/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = db.prepare('DELETE FROM channels WHERE id=?').run(id);
  if (r.changes === 0) return res.status(404).json({ error: '渠道不存在' });
  res.json({ ok: true });
});

// 清除 api_key（单独接口，前端勾选明确清除）
app.post('/api/admin/channels/:id/clear-key', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = db.prepare('UPDATE channels SET api_key=?, updated_at=? WHERE id=?').run('', nowTs(), id);
  if (r.changes === 0) return res.status(404).json({ error: '渠道不存在' });
  res.json({ ok: true });
});

// ---------- 从上游 /v1/models 拉取模型列表 ----------
function buildModelsUrl(base) {
  let u = String(base || '').trim().replace(/\/+$/, '');
  if (!u) throw new Error('base_url 为空');
  // 容错：用户填 https://x.com 或 https://x.com/v1 都接受
  if (/\/v\d+$/i.test(u)) return u + '/models';
  return u + '/v1/models';
}

async function fetchUpstreamModels(base_url, api_key) {
  const url = buildModelsUrl(base_url);
  const headers = { 'Accept': 'application/json' };
  if (api_key) headers['Authorization'] = `Bearer ${api_key}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    const text = await r.text();
    if (!r.ok) {
      throw new Error(`上游返回 ${r.status}: ${text.slice(0, 200)}`);
    }
    let j;
    try { j = JSON.parse(text); }
    catch { throw new Error('上游返回非 JSON: ' + text.slice(0, 200)); }
    const list = Array.isArray(j) ? j : (Array.isArray(j.data) ? j.data : null);
    if (!list) throw new Error('上游响应缺少 data 数组');
    return list;
  } finally {
    clearTimeout(t);
  }
}

// 拉取上游模型，并标记哪些已存在
app.post('/api/admin/channels/:id/fetch-models', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const ch = db.prepare('SELECT * FROM channels WHERE id=?').get(id);
  if (!ch) return res.status(404).json({ error: '渠道不存在' });

  // 允许 body 临时覆盖（在新建渠道但尚未保存时也能测试）
  const base_url = (req.body && req.body.base_url) || ch.base_url;
  const api_key = (req.body && req.body.api_key) || ch.api_key;
  if (!base_url) return res.status(400).json({ error: '渠道未配置 base_url' });

  try {
    const upstream = await fetchUpstreamModels(base_url, api_key);
    const exist = new Set(
      db.prepare('SELECT name FROM models WHERE channel_id=?').all(id).map(r => r.name)
    );
    const items = upstream.map(m => {
      const name = m.id || m.model || m.name;
      return {
        name,
        owned_by: m.owned_by || '',
        created: m.created || null,
        exists: exist.has(name)
      };
    }).filter(x => x.name);
    res.json({
      total: items.length,
      new_count: items.filter(x => !x.exists).length,
      models: items
    });
  } catch (e) {
    res.status(502).json({ error: '拉取失败：' + e.message });
  }
});

// 批量导入选中的模型
app.post('/api/admin/channels/:id/import-models', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const ch = db.prepare('SELECT id FROM channels WHERE id=?').get(id);
  if (!ch) return res.status(404).json({ error: '渠道不存在' });

  const names = Array.isArray(req.body && req.body.names) ? req.body.names : [];
  const enabled = req.body && req.body.enabled !== false;
  const skip_existing = !(req.body && req.body.overwrite_existing);
  if (names.length === 0) return res.status(400).json({ error: 'names 不能为空' });

  const exist = new Set(
    db.prepare('SELECT name FROM models WHERE channel_id=?').all(id).map(r => r.name)
  );
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM models WHERE channel_id=?').get(id).m;

  const insert = db.prepare(`
    INSERT INTO models(channel_id, name, display_name, description, tags, context_length, price_input, price_output, enabled, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0, skipped = 0;
  const now = nowTs();
  const tx = db.transaction(() => {
    let s = maxSort;
    for (const raw of names) {
      const n = String(raw || '').trim();
      if (!n) continue;
      if (skip_existing && exist.has(n)) { skipped++; continue; }
      s += 1;
      insert.run(id, n, n, '', '[]', 0, 0, 0, enabled ? 1 : 0, s, now, now);
      inserted++;
    }
  });
  tx();
  res.json({ inserted, skipped, total_requested: names.length });
});

// ---------- 管理 API：模型 ----------
app.get('/api/admin/models', requireAdmin, (req, res) => {
  const channel_id = req.query.channel_id ? parseInt(req.query.channel_id, 10) : null;
  let rows;
  if (channel_id) {
    rows = db.prepare('SELECT * FROM models WHERE channel_id=? ORDER BY sort_order ASC, id ASC').all(channel_id);
  } else {
    rows = db.prepare('SELECT * FROM models ORDER BY channel_id ASC, sort_order ASC, id ASC').all();
  }
  res.json({ models: rows.map(rowToModel) });
});

app.post('/api/admin/models', requireAdmin, (req, res) => {
  const {
    channel_id,
    name,
    display_name = '',
    description = '',
    tags = [],
    context_length = 0,
    price_input = 0,
    price_output = 0,
    enabled = true,
    sort_order = 0
  } = req.body || {};
  if (!channel_id) return res.status(400).json({ error: '必须指定渠道' });
  if (!name || !name.trim()) return res.status(400).json({ error: '模型名不能为空' });
  const ts = nowTs();
  const r = db.prepare(`
    INSERT INTO models(channel_id, name, display_name, description, tags, context_length, price_input, price_output, enabled, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    channel_id, name.trim(), display_name, description,
    JSON.stringify(Array.isArray(tags) ? tags : []),
    context_length || 0, price_input || 0, price_output || 0,
    enabled ? 1 : 0, sort_order || 0, ts, ts
  );
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/admin/models/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const {
    channel_id,
    name,
    display_name = '',
    description = '',
    tags = [],
    context_length = 0,
    price_input = 0,
    price_output = 0,
    enabled = true,
    sort_order = 0
  } = req.body || {};
  if (!channel_id) return res.status(400).json({ error: '必须指定渠道' });
  if (!name || !name.trim()) return res.status(400).json({ error: '模型名不能为空' });
  const r = db.prepare(`
    UPDATE models SET channel_id=?, name=?, display_name=?, description=?, tags=?, context_length=?, price_input=?, price_output=?, enabled=?, sort_order=?, updated_at=?
    WHERE id=?
  `).run(
    channel_id, name.trim(), display_name, description,
    JSON.stringify(Array.isArray(tags) ? tags : []),
    context_length || 0, price_input || 0, price_output || 0,
    enabled ? 1 : 0, sort_order || 0, nowTs(), id
  );
  if (r.changes === 0) return res.status(404).json({ error: '模型不存在' });
  res.json({ ok: true });
});

app.delete('/api/admin/models/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = db.prepare('DELETE FROM models WHERE id=?').run(id);
  if (r.changes === 0) return res.status(404).json({ error: '模型不存在' });
  res.json({ ok: true });
});

// ============ 启动 ============
app.listen(PORT, '0.0.0.0', () => {
  console.log('====================================');
  console.log(`  模型广场已启动`);
  console.log(`  公开页面:  http://localhost:${PORT}/`);
  console.log(`  管理登录:  http://localhost:${PORT}/login`);
  console.log(`  管理后台:  http://localhost:${PORT}/admin`);
  console.log(`  管理密码:  ${ADMIN_PASSWORD === 'admin123' ? 'admin123 (默认，请改 ADMIN_PASSWORD 环境变量)' : '已自定义'}`);
  console.log('====================================');
});
