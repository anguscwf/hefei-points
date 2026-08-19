const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
app.use(express.static('public'));

const DATA_DIR = path.join(__dirname, 'data');
const BACKUP_DIR = path.join(__dirname, 'backups');
const POINTS_FILE = path.join(DATA_DIR, 'points.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// ============== Token 签名密钥 ==============
// 服务启动时自动生成随机密钥（重启后旧 token 失效是预期行为）
const TOKEN_SECRET = crypto.randomBytes(32).toString('hex');
console.log('[安全] Token 签名密钥已生成（本次会话）');

// ============== 原子写入 ==============
function atomicSave(filepath, data) {
  const tmp = filepath + '.tmp.' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filepath);
}

// ============== 并发写入锁 ==============
const locks = {};
function withLock(key, fn, timeoutMs = 3000) {
  if (locks[key]) {
    // 等待锁释放（最多 timeoutMs）
    const start = Date.now();
    while (locks[key] && Date.now() - start < timeoutMs) {
      // 同步等待（Node.js 单线程，实际不会阻塞太久因为锁很快释放）
    }
    if (locks[key]) {
      throw new Error('写入冲突，请稍后重试');
    }
  }
  locks[key] = true;
  try {
    return fn();
  } finally {
    delete locks[key];
  }
}

// ============== JSON 读写 ==============
function loadJSON(filepath, fallback) {
  try {
    if (fs.existsSync(filepath)) {
      return JSON.parse(fs.readFileSync(filepath, 'utf8'));
    }
  } catch (e) {
    console.error('[错误] 读取 JSON 失败:', filepath, e.message);
  }
  return fallback;
}

function saveJSON(filepath, data) {
  // 确保目录存在
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // 原子写入
  atomicSave(filepath, data);
}

// ============== 备份 ==============
function doBackup() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(BACKUP_DIR, ts);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const files = [POINTS_FILE, HISTORY_FILE, CONFIG_FILE];
    for (const f of files) {
      if (fs.existsSync(f)) {
        fs.copyFileSync(f, path.join(dir, path.basename(f)));
      }
    }
    console.log('[备份] 完成:', dir);
    return { ok: true, dir, ts };
  } catch (e) {
    console.error('[备份] 失败:', e.message);
    return { ok: false, error: e.message };
  }
}

// ============== 请求频率限制 ==============
const rateLimitMap = {}; // IP → { count, resetTime }
const RATE_LIMIT = { windowMs: 60000, maxAuth: 10, maxApi: 60 };

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();

  if (!rateLimitMap[ip] || now > rateLimitMap[ip].resetTime) {
    rateLimitMap[ip] = { count: 0, resetTime: now + RATE_LIMIT.windowMs };
  }

  rateLimitMap[ip].count++;

  // 登录接口限制更严格
  const max = req.path === '/api/auth' ? RATE_LIMIT.maxAuth : RATE_LIMIT.maxApi;
  if (rateLimitMap[ip].count > max) {
    return res.status(429).json({ success: false, message: '请求过于频繁，请稍后再试' });
  }

  // 定期清理过期记录
  if (Math.random() < 0.01) {
    const cutoff = now - RATE_LIMIT.windowMs;
    for (const key of Object.keys(rateLimitMap)) {
      if (rateLimitMap[key].resetTime - RATE_LIMIT.windowMs < cutoff) {
        delete rateLimitMap[key];
      }
    }
  }

  next();
}
app.use(rateLimit);

// ============== 初始化 ==============
function initData() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(POINTS_FILE)) {
    saveJSON(POINTS_FILE, { enhe: 0, enfei: 0 });
  }
  if (!fs.existsSync(HISTORY_FILE)) {
    saveJSON(HISTORY_FILE, []);
  }
  if (!fs.existsSync(CONFIG_FILE)) {
    saveJSON(CONFIG_FILE, {
      rules: {
        reward: [],
        punish: [],
        special: []
      },
      users: []
    });
  }
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

initData();

// ============== 密码哈希 ==============
function hashPwd(pwd) {
  return crypto.createHash('sha256').update(pwd).digest('hex');
}

function isHashed(pwd) {
  // 已哈希的密码是64位hex字符串
  return pwd && pwd.length === 64 && /^[a-f0-9]{64}$/.test(pwd);
}

// ============== Token 工具 ==============
function signToken(userId, role) {
  const ts = Date.now();
  const payload = `${userId}.${role}.${ts}`;
  const hmac = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex').slice(0, 16);
  return `hefei.${payload}.${hmac}`;
}

function verifyToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== 'hefei') return null;

  const [_, userId, role, ts, sig] = parts;
  const payload = `${userId}.${role}.${ts}`;
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex').slice(0, 16);

  if (sig !== expected) return null;

  // Token 有效期 30 天
  const age = Date.now() - parseInt(ts);
  if (age > 30 * 24 * 60 * 60 * 1000) return null;

  const config = loadJSON(CONFIG_FILE, {});
  const user = (config.users || []).find(u => u.id === userId);
  return user || null;
}

function requireRole(token, allowedRoles) {
  const user = verifyToken(token);
  if (!user) return null;
  return allowedRoles.includes(user.role) ? user : null;
}

function getValidKids() {
  const config = loadJSON(CONFIG_FILE, {});
  return (config.users || []).filter(u => u.role === 'child').map(u => u.id);
}

function getKidName(kid) {
  const config = loadJSON(CONFIG_FILE, {});
  const u = (config.users || []).find(u => u.id === kid);
  return u ? u.name : kid;
}

// ============== 登录 ==============
app.post('/api/auth', (req, res) => {
  const { userId, password } = req.body;
  const config = loadJSON(CONFIG_FILE, {});
  const pwdHash = hashPwd(password);
  const user = (config.users || []).find(u => u.id === userId && u.password === pwdHash);
  if (!user) {
    return res.status(403).json({ success: false, message: '用户或密码错误' });
  }
  const token = signToken(user.id, user.role);
  res.json({
    success: true,
    token,
    user: { id: user.id, name: user.name, role: user.role }
  });
});

// ============== 获取积分（所有人） ==============
app.get('/api/points', (req, res) => {
  const points = loadJSON(POINTS_FILE, { enhe: 0, enfei: 0 });
  const config = loadJSON(CONFIG_FILE, { rules: {} });
  const user = verifyToken(req.query.token || '');
  res.json({
    success: true,
    points,
    rules: config.rules || {},
    user: user ? { id: user.id, name: user.name, role: user.role } : null
  });
});

// ============== 加减分（admin + parent） ==============
app.post('/api/points/change', (req, res) => {
  const { token, kid, amount, reason, note } = req.body;
  const user = requireRole(token, ['admin', 'parent']);
  if (!user) {
    return res.status(403).json({ success: false, message: '无操作权限' });
  }

  if (!getValidKids().includes(kid)) {
    return res.status(400).json({ success: false, message: '无效的孩子' });
  }

  const amountNum = parseInt(amount);
  if (isNaN(amountNum) || amountNum === 0) {
    return res.status(400).json({ success: false, message: '无效的分数' });
  }

  try {
    const result = withLock('points_change', () => {
      const points = loadJSON(POINTS_FILE, { enhe: 0, enfei: 0 });
      points[kid] = (points[kid] || 0) + amountNum;
      saveJSON(POINTS_FILE, points);

      const history = loadJSON(HISTORY_FILE, []);
      const record = {
        id: Date.now(),
        time: new Date().toLocaleString('zh-CN', { hour12: false }),
        kid,
        kidName: getKidName(kid),
        amount: amountNum,
        reason: reason || (amountNum > 0 ? '手动加分' : '手动减分'),
        operator: user.name,
        note: note || '',
      };
      history.unshift(record);
      saveJSON(HISTORY_FILE, history);

      return { points, record };
    });

    res.json({ success: true, ...result });
  } catch (e) {
    res.status(503).json({ success: false, message: e.message || '操作失败，请稍后重试' });
  }
});

// ============== 历史记录（所有人） ==============
app.get('/api/history', (req, res) => {
  const history = loadJSON(HISTORY_FILE, []);
  const { kid } = req.query;
  let filtered = history;
  if (kid && getValidKids().includes(kid)) {
    filtered = history.filter(r => r.kid === kid);
  }
  res.json({ success: true, history: filtered.slice(0, 50) });
});

// ============== 编辑历史记录备注 ==============
app.post('/api/history/note', (req, res) => {
  const { token, recordId, note } = req.body;
  const user = requireRole(token, ['admin', 'parent']);
  if (!user) {
    return res.status(403).json({ success: false, message: '无操作权限' });
  }

  try {
    withLock('history_note', () => {
      const history = loadJSON(HISTORY_FILE, []);
      const record = history.find(r => r.id === recordId);
      if (!record) {
        throw new Error('记录不存在');
      }
      record.note = note || '';
      saveJSON(HISTORY_FILE, history);
    });
    res.json({ success: true });
  } catch (e) {
    const code = e.message === '记录不存在' ? 404 : 503;
    res.status(code).json({ success: false, message: e.message || '操作失败' });
  }
});

// ============== 获取配置（所有人） ==============
app.get('/api/config', (req, res) => {
  const config = loadJSON(CONFIG_FILE, { rules: {}, users: [] });
  res.json({
    success: true,
    rules: config.rules || {},
    users: (config.users || []).map(u => ({ id: u.id, name: u.name, role: u.role }))
  });
});

// ============== 更新规则（仅 admin） ==============
app.post('/api/config/rules', (req, res) => {
  const { token, rules } = req.body;
  if (!requireRole(token, ['admin'])) {
    return res.status(403).json({ success: false, message: '仅管理员可修改规则' });
  }
  try {
    withLock('config_rules', () => {
      const config = loadJSON(CONFIG_FILE, { rules: {}, users: [] });
      config.rules = rules;
      saveJSON(CONFIG_FILE, config);
    });
    res.json({ success: true, rules });
  } catch (e) {
    res.status(503).json({ success: false, message: '保存失败' });
  }
});

// ============== 更新用户（仅 admin） ==============
app.post('/api/config/users', (req, res) => {
  const { token, users } = req.body;
  if (!requireRole(token, ['admin'])) {
    return res.status(403).json({ success: false, message: '仅管理员可管理用户' });
  }
  try {
    withLock('config_users', () => {
      const config = loadJSON(CONFIG_FILE, { rules: {}, users: [] });
      const newUsers = users.map(u => {
        const old = (config.users || []).find(ou => ou.id === u.id);
        // 密码处理：已哈希的保持，新明文哈希化
        let password = u.password || (old ? old.password : '');
        if (password && !isHashed(password)) {
          password = hashPwd(password);
        }
        return { ...u, password };
      });
      config.users = newUsers;
      saveJSON(CONFIG_FILE, config);
    });
    res.json({ success: true, users: config.users.map(u => ({ id: u.id, name: u.name, role: u.role })) });
  } catch (e) {
    res.status(503).json({ success: false, message: '保存失败' });
  }
});

// ============== 备份 API（仅 admin） ==============
app.post('/api/backup', (req, res) => {
  const { token } = req.body;
  if (!requireRole(token, ['admin'])) {
    return res.status(403).json({ success: false, message: '仅管理员可触发备份' });
  }
  const result = doBackup();
  res.json(result);
});

// ============== 备份列表 ==============
app.get('/api/backups', (req, res) => {
  const token = req.query.token || '';
  if (!requireRole(token, ['admin'])) {
    return res.status(403).json({ success: false, message: '仅管理员可查看备份列表' });
  }
  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      return res.json({ success: true, backups: [] });
    }
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => fs.statSync(path.join(BACKUP_DIR, f)).isDirectory())
      .sort()
      .reverse()
      .slice(0, 30);
    res.json({ success: true, backups });
  } catch (e) {
    res.json({ success: true, backups: [] });
  }
});

// ============== 开机自动备份 ==============
doBackup();

const PORT = 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log('[启动] 糖罐积分管理服务 v3.1 已启动：http://0.0.0.0:' + PORT);
});
