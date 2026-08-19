const express = require('express');
const fs = require('fs');
const path = require('path');

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
const POINTS_FILE = path.join(DATA_DIR, 'points.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

function loadJSON(filepath, fallback) {
  try {
    if (fs.existsSync(filepath)) {
      return JSON.parse(fs.readFileSync(filepath, 'utf8'));
    }
  } catch (e) {}
  return fallback;
}

function saveJSON(filepath, data) {
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
}

function initData() {
  if (!fs.existsSync(POINTS_FILE)) {
    saveJSON(POINTS_FILE, { enhe: 0, enfei: 0 });
  }
  if (!fs.existsSync(HISTORY_FILE)) {
    saveJSON(HISTORY_FILE, []);
  }
  if (!fs.existsSync(CONFIG_FILE)) {
    saveJSON(CONFIG_FILE, {
      rules: [
        { id: 1, label: '练琴', points: 10, type: 'reward' },
        { id: 2, label: '做作业', points: 5, type: 'reward' },
        { id: 3, label: '做家务', points: 5, type: 'reward' },
        { id: 4, label: '早起', points: 3, type: 'reward' },
        { id: 5, label: '阅读', points: 5, type: 'reward' },
        { id: 6, label: '不听话', points: -5, type: 'punish' },
        { id: 7, label: '没做作业', points: -5, type: 'punish' },
        { id: 8, label: '玩手机超时', points: -3, type: 'punish' },
      ],
      users: []
    });
  }
}

initData();
function getValidKids() {
  const config = loadJSON(CONFIG_FILE, {});
  return (config.users || []).filter(u => u.role === "child").map(u => u.id);
}
function getKidName(kid) {
  const config = loadJSON(CONFIG_FILE, {});
  const u = (config.users || []).find(u => u.id === kid);
  return u ? u.name : kid;
}


// --- 鉴权工具 ---
function getUserByToken(token) {
  if (!token) return null;
  // token: hefei-{role}-{userId}-{timestamp}
  const parts = token.split('-');
  if (parts.length < 4 || parts[0] !== 'hefei') return null;
  const userId = parts[2];
  const config = loadJSON(CONFIG_FILE, {});
  return (config.users || []).find(u => u.id === userId) || null;
}

function requireRole(token, allowedRoles) {
  const user = getUserByToken(token);
  if (!user) return null;
  return allowedRoles.includes(user.role) ? user : null;
}

// --- 登录 ---
app.post('/api/auth', (req, res) => {
  const { userId, password } = req.body;
  const config = loadJSON(CONFIG_FILE, {});
  const user = (config.users || []).find(u => u.id === userId && u.password === password);
  if (!user) {
    return res.status(403).json({ success: false, message: '用户或密码错误' });
  }
  const token = 'hefei-' + user.role + '-' + user.id + '-' + Date.now();
  res.json({
    success: true,
    token,
    user: { id: user.id, name: user.name, role: user.role }
  });
});

// --- 获取积分（所有人） ---
app.get('/api/points', (req, res) => {
  const points = loadJSON(POINTS_FILE, { enhe: 0, enfei: 0 });
  const config = loadJSON(CONFIG_FILE, { rules: [] });
  const user = getUserByToken(req.query.token || '');
  res.json({
    success: true,
    points,
    rules: config.rules || [],
    user: user ? { id: user.id, name: user.name, role: user.role } : null
  });
});

// --- 加减分（admin + parent） ---
app.post('/api/points/change', (req, res) => {
  const { token, kid, amount, reason } = req.body;
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

  const points = loadJSON(POINTS_FILE, { enhe: 0, enfei: 0 });
  points[kid] += amountNum;
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
  };
  history.unshift(record);
  saveJSON(HISTORY_FILE, history);

  res.json({ success: true, points, record });
});

// --- 历史记录（所有人） ---
app.get('/api/history', (req, res) => {
  const history = loadJSON(HISTORY_FILE, []);
  const { kid } = req.query;
  let filtered = history;
  if (kid && getValidKids().includes(kid)) {
    filtered = history.filter(r => r.kid === kid);
  }
  res.json({ success: true, history: filtered.slice(0, 50) });
});

// --- 获取配置（所有人） ---
app.get('/api/config', (req, res) => {
  const config = loadJSON(CONFIG_FILE, { rules: [], users: [] });
  res.json({ success: true, rules: config.rules || [], users: (config.users || []).map(u => ({ id: u.id, name: u.name, role: u.role })) });
});

// --- 更新规则（仅 admin） ---
app.post('/api/config/rules', (req, res) => {
  const { token, rules } = req.body;
  if (!requireRole(token, ['admin'])) {
    return res.status(403).json({ success: false, message: '仅管理员可修改规则' });
  }
  const config = loadJSON(CONFIG_FILE, { rules: [], users: [] });
  config.rules = rules;
  saveJSON(CONFIG_FILE, config);
  res.json({ success: true, rules: config.rules });
});

// --- 更新用户（仅 admin） ---
app.post('/api/config/users', (req, res) => {
  const { token, users } = req.body;
  if (!requireRole(token, ['admin'])) {
    return res.status(403).json({ success: false, message: '仅管理员可管理用户' });
  }
  const config = loadJSON(CONFIG_FILE, { rules: [], users: [] });
  // 保留密码（如果没传新密码）
  const newUsers = users.map(u => {
    const old = (config.users || []).find(ou => ou.id === u.id);
    return { ...u, password: u.password || (old ? old.password : '') };
  });
  config.users = newUsers;
  saveJSON(CONFIG_FILE, config);
  res.json({ success: true, users: config.users.map(u => ({ id: u.id, name: u.name, role: u.role })) });
});

const PORT = 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log('糖罐积分管理服务已启动：http://0.0.0.0:' + PORT);
});
