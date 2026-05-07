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
    const start = Date.now();
    while (locks[key] && Date.now() - start < timeoutMs) {}
    if (locks[key]) throw new Error('写入冲突，请稍后重试');
  }
  locks[key] = true;
  try { return fn(); }
  finally { delete locks[key]; }
}

// ============== JSON 读写 ==============
function loadJSON(filepath, fallback) {
  try {
    if (fs.existsSync(filepath)) return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (e) { console.error('[错误] 读取JSON失败:', filepath, e.message); }
  return fallback;
}

function saveJSON(filepath, data) {
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  atomicSave(filepath, data);
  invalidateCache(filepath);
}

// ============== 内存缓存（减少重复磁盘读取） ==============
const memCache = {};
function cachedRead(filepath, fallback, ttlMs) {
  const now = Date.now();
  const entry = memCache[filepath];
  if (entry && entry.time && (now - entry.time) < ttlMs) {
    return JSON.parse(JSON.stringify(entry.data)); // 返回深拷贝
  }
  const data = loadJSON(filepath, fallback);
  memCache[filepath] = { data, time: now };
  return JSON.parse(JSON.stringify(data));
}
function invalidateCache(filepath) {
  delete memCache[filepath];
}

// ============== 备份 ==============
function doBackup() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(BACKUP_DIR, ts);
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of [POINTS_FILE, HISTORY_FILE, CONFIG_FILE]) {
      if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dir, path.basename(f)));
    }
    console.log('[备份] 完成:', dir);
    return { ok: true, dir, ts };
  } catch (e) { console.error('[备份] 失败:', e.message); return { ok: false, error: e.message }; }
}

// ============== 请求频率限制 ==============
const rateLimitMap = {};
const RATE_LIMIT = { windowMs: 60000, maxAuth: 10, maxApi: 60 };

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  if (!rateLimitMap[ip] || now > rateLimitMap[ip].resetTime) {
    rateLimitMap[ip] = { count: 0, resetTime: now + RATE_LIMIT.windowMs };
  }
  rateLimitMap[ip].count++;
  const max = req.path === '/api/auth' ? RATE_LIMIT.maxAuth : RATE_LIMIT.maxApi;
  if (rateLimitMap[ip].count > max) {
    return res.status(429).json({ success: false, message: '请求过于频繁，请稍后再试' });
  }
  if (Math.random() < 0.01) {
    const cutoff = now - RATE_LIMIT.windowMs;
    for (const key of Object.keys(rateLimitMap)) {
      if (rateLimitMap[key].resetTime - RATE_LIMIT.windowMs < cutoff) delete rateLimitMap[key];
    }
  }
  next();
}
app.use(rateLimit);

// ============== 初始化 + 自动迁移 ==============
// 预置规则模板库（安总家13条经典规则）
function getDefaultRuleTemplates() {
  return {
    reward: [
      {
        category: '📚 学业表现',
        items: [
          { id: 'r_ac_1', label: '作业按时完成', min: 2, max: 5, default: 3, unit: '每科', hint: '每天检查作业完成情况' },
          { id: 'r_ac_2', label: '考试优秀（90分以上）', min: 5, max: 15, default: 10, unit: '每次', hint: '期中/期末考试' },
          { id: 'r_ac_3', label: '考试进步（比上次高）', min: 3, max: 8, default: 5, unit: '每次', hint: '和自己上次成绩比' }
        ]
      },
      {
        category: '🏠 家务劳动',
        items: [
          { id: 'r_ch_1', label: '收拾房间', min: 2, max: 5, default: 3, unit: '每次', hint: '保持房间整洁' },
          { id: 'r_ch_2', label: '洗碗/帮忙做饭', min: 2, max: 4, default: 2, unit: '每次', hint: '帮妈妈分担家务' },
          { id: 'r_ch_3', label: '自己整理书包/衣物', min: 1, max: 3, default: 2, unit: '每天', hint: '养成自理习惯' }
        ]
      },
      {
        category: '🎯 好习惯养成',
        items: [
          { id: 'r_ha_1', label: '早上自觉起床', min: 1, max: 3, default: 2, unit: '每天', hint: '不用大人叫' },
          { id: 'r_ha_2', label: '阅读30分钟以上', min: 2, max: 5, default: 3, unit: '每次', hint: '课外书/绘本都算' }
        ]
      }
    ],
    punish: [
      {
        category: '🚫 行为规范',
        items: [
          { id: 'p_be_1', label: '不听话/顶嘴', min: -5, max: -2, default: -3, unit: '每次', hint: '尊重长辈' },
          { id: 'p_be_2', label: '没按规定收拾东西', min: -3, max: -1, default: -2, unit: '每次', hint: '说到要做到' },
          { id: 'p_be_3', label: '玩游戏超时', min: -5, max: -2, default: -3, unit: '每次', hint: '先做正事再玩' }
        ]
      },
      {
        category: '📖 学习相关',
        items: [
          { id: 'p_st_1', label: '没按时完成作业', min: -5, max: -2, default: -3, unit: '每科', hint: '作业是首要任务' },
          { id: 'p_st_2', label: '考试退步', min: -5, max: -2, default: -3, unit: '每次', hint: '和上次比退步了' }
        ]
      }
    ],
    special: [
      '每月清零日：月底可以将积分兑换为奖励（如买玩具、去游乐园）',
      '连续7天全勤（无扣分）：额外奖励5分',
      '生日当天：奖励双倍积分'
    ]
  };
}

function initData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  // 初始化/迁移 config.json
  let config = loadJSON(CONFIG_FILE, null);
  if (!config) {
    config = {
      families: {},
      rules: getDefaultRuleTemplates(),
      users: []
    };
  }
  // v3→v4 迁移：如果没有 families，创建 default family
  if (!config.families || Object.keys(config.families).length === 0) {
    config.families = {
      default: {
        id: 'default',
        name: '安总家',
        inviteCode: generateInviteCode(),
        createdAt: new Date().toISOString()
      }
    };
    // 给现有用户加上 familyId
    if (config.users) {
      config.users.forEach(u => { if (!u.familyId) u.familyId = 'default'; });
    }
    saveJSON(CONFIG_FILE, config);
    console.log('[迁移] 已创建默认家庭: default');
  }

  // 初始化默认用户（首次启动时 users 为空）
  if (!config.users || config.users.length === 0) {
    config.users = [
      { id: 'baba',  name: '爸爸', role: 'admin',  password: hashPwd('123456'), familyId: 'default' },
      { id: 'mama',  name: '妈妈', role: 'parent', password: hashPwd('123456'), familyId: 'default' },
      { id: 'enhe',  name: '恩赫', role: 'child',  password: hashPwd('123456'), familyId: 'default' },
      { id: 'enfei', name: '恩菲', role: 'child',  password: hashPwd('123456'), familyId: 'default' }
    ];
    console.log('[初始化] 已创建默认用户：爸爸、妈妈、恩赫、恩菲');
  }

  // 初始化/迁移 points.json
  let points = loadJSON(POINTS_FILE, null);
  if (!points) {
    points = { default: { enhe: 0, enfei: 0 } };
  } else if (typeof points.enhe === 'number') {
    // v3 格式：{enhe: 0, enfei: 0} → v4 格式：{default: {enhe: 0, enfei: 0}}
    points = { default: points };
    console.log('[迁移] points.json → 多家庭格式');
  }
  saveJSON(POINTS_FILE, points);

  // 初始化/迁移 history.json
  let history = loadJSON(HISTORY_FILE, []);
  let historyChanged = false;
  history.forEach(r => {
    if (!r.familyId) { r.familyId = 'default'; historyChanged = true; }
  });
  if (historyChanged) { saveJSON(HISTORY_FILE, history); console.log('[迁移] history.json → 含familyId'); }

  saveJSON(CONFIG_FILE, config);
}
// 先备份再迁移（保证迁移前数据可恢复）
doBackup();
initData();

// ============== 邀请码生成 ==============
function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ============== 密码哈希 ==============
function hashPwd(pwd) {
  return crypto.createHash('sha256').update(pwd).digest('hex');
}
function isHashed(pwd) {
  return pwd && pwd.length === 64 && /^[a-f0-9]{64}$/.test(pwd);
}

// ============== Token 工具 ==============
function signToken(userId, role, familyId) {
  const ts = Date.now();
  const payload = `${userId}.${role}.${familyId || 'default'}.${ts}`;
  const hmac = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex').slice(0, 16);
  return `hefei.${payload}.${hmac}`;
}

function verifyToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  // 兼容 v3 token（4段）和 v4 token（5段）
  if (parts.length === 5 && parts[0] === 'hefei') {
    // v3: hefei.userId.role.ts.sig
    const [_, userId, role, ts, sig] = parts;
    const payload = `${userId}.${role}.${ts}`;
    const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex').slice(0, 16);
    if (sig !== expected) return null;
    const age = Date.now() - parseInt(ts);
    if (age > 30 * 24 * 60 * 60 * 1000) return null;
    const config = cachedRead(CONFIG_FILE, {}, 5000);
    const user = (config.users || []).find(u => u.id === userId);
    return user ? { ...user, familyId: user.familyId || 'default' } : null;
  } else if (parts.length === 6 && parts[0] === 'hefei') {
    // v4: hefei.userId.role.familyId.ts.sig
    const [_, userId, role, familyId, ts, sig] = parts;
    const payload = `${userId}.${role}.${familyId}.${ts}`;
    const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex').slice(0, 16);
    if (sig !== expected) return null;
    const age = Date.now() - parseInt(ts);
    if (age > 30 * 24 * 60 * 60 * 1000) return null;
    const config = cachedRead(CONFIG_FILE, {}, 5000);
    const user = (config.users || []).find(u => u.id === userId);
    return user ? { ...user, familyId: familyId } : null;
  }
  return null;
}

function requireRole(token, allowedRoles) {
  const user = verifyToken(token);
  if (!user) return null;
  return allowedRoles.includes(user.role) ? user : null;
}

function getValidKids(familyId) {
  const config = cachedRead(CONFIG_FILE, {}, 5000);
  return (config.users || [])
    .filter(u => u.role === 'child' && u.familyId === (familyId || 'default'))
    .map(u => u.id);
}

function getKidName(kid) {
  const config = cachedRead(CONFIG_FILE, {}, 5000);
  const u = (config.users || []).find(u => u.id === kid);
  return u ? u.name : kid;
}

function getFamilyPoints(familyId) {
  const allPoints = cachedRead(POINTS_FILE, {}, 3000);
  return allPoints[familyId || 'default'] || {};
}

function saveFamilyPoints(familyId, points) {
  const allPoints = loadJSON(POINTS_FILE, {});
  allPoints[familyId || 'default'] = points;
  saveJSON(POINTS_FILE, allPoints);
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
  const familyId = user.familyId || 'default';
  const family = (config.families || {})[familyId] || { id: 'default', name: '默认家庭' };
  const token = signToken(user.id, user.role, familyId);
  res.json({
    success: true,
    token,
    user: { id: user.id, name: user.name, role: user.role, familyId },
    family: { id: family.id, name: family.name }
  });
});

// ============== 获取积分（所有人） ==============
app.get('/api/points', (req, res) => {
  const user = verifyToken(req.query.token || '');
  const familyId = user ? user.familyId : 'default';
  const points = getFamilyPoints(familyId);
  const config = cachedRead(CONFIG_FILE, { rules: {} }, 30000);
  const family = (config.families || {})[familyId] || null;
  res.json({
    success: true,
    points,
    rules: config.rules || {},
    family: family ? { id: family.id, name: family.name } : null,
    user: user ? { id: user.id, name: user.name, role: user.role, familyId } : null
  });
});

// ============== 加减分（admin + parent） ==============
app.post('/api/points/change', (req, res) => {
  const { token, kid, amount, reason, note } = req.body;
  const user = requireRole(token, ['admin', 'parent']);
  if (!user) {
    return res.status(403).json({ success: false, message: '无操作权限' });
  }

  const familyId = user.familyId || 'default';
  if (!getValidKids(familyId).includes(kid)) {
    return res.status(400).json({ success: false, message: '无效的孩子' });
  }

  const amountNum = parseInt(amount);
  if (isNaN(amountNum) || amountNum === 0) {
    return res.status(400).json({ success: false, message: '无效的分数' });
  }

  try {
    const result = withLock('points_change_' + familyId, () => {
      const points = getFamilyPoints(familyId);
      points[kid] = (points[kid] || 0) + amountNum;
      saveFamilyPoints(familyId, points);

      const history = loadJSON(HISTORY_FILE, []);  // 写入必须读最新
      const record = {
        id: Date.now(),
        familyId,
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

// ============== 历史记录 ==============
app.get('/api/history', (req, res) => {
  const history = cachedRead(HISTORY_FILE, [], 3000);
  const user = verifyToken(req.query.token || '');
  const familyId = user ? user.familyId : 'default';
  const { kid } = req.query;

  let filtered = history.filter(r => r.familyId === familyId);
  if (kid && getValidKids(familyId).includes(kid)) {
    filtered = filtered.filter(r => r.kid === kid);
  }
  res.json({ success: true, history: filtered.slice(0, 50) });
});

// ============== 编辑历史记录备注（限定家庭） ==============
app.post('/api/history/note', (req, res) => {
  const { token, recordId, note } = req.body;
  const user = requireRole(token, ['admin', 'parent']);
  if (!user) return res.status(403).json({ success: false, message: '无操作权限' });
  const userFamilyId = user.familyId || 'default';

  try {
    withLock('history_note', () => {
      const history = loadJSON(HISTORY_FILE, []);
      const record = history.find(r => r.id === recordId);
      if (!record) throw new Error('记录不存在');
      if (record.familyId !== userFamilyId) throw new Error('无权操作此记录');
      record.note = note || '';
      saveJSON(HISTORY_FILE, history);
    });
    res.json({ success: true });
  } catch (e) {
    const status = e.message === '记录不存在' ? 404 : (e.message === '无权操作此记录' ? 403 : 503);
    res.status(status).json({ success: false, message: e.message || '操作失败' });
  }
});

// ============== 获取配置 ==============
app.get('/api/config', (req, res) => {
  const config = cachedRead(CONFIG_FILE, { rules: {}, users: [], families: {} }, 15000);
  res.json({
    success: true,
    rules: config.rules || {},
    families: config.families || {},
    users: (config.users || []).map(u => ({ id: u.id, name: u.name, role: u.role, familyId: u.familyId || 'default' }))
  });
});

// ============== 获取家庭信息 ==============
app.get('/api/family', (req, res) => {
  const user = verifyToken(req.query.token || '');
  if (!user) return res.status(403).json({ success: false, message: '请先登录' });
  const config = loadJSON(CONFIG_FILE, {});
  const familyId = user.familyId || 'default';
  const family = (config.families || {})[familyId];
  if (!family) return res.status(404).json({ success: false, message: '家庭不存在' });

  const members = (config.users || [])
    .filter(u => u.familyId === familyId)
    .map(u => ({ id: u.id, name: u.name, role: u.role }));

  res.json({
    success: true,
    family: { id: family.id, name: family.name, inviteCode: family.inviteCode, createdAt: family.createdAt },
    members
  });
});

// ============== 创建新家庭 ==============
app.post('/api/family/create', (req, res) => {
  const { token, familyName } = req.body;
  const user = verifyToken(token);
  if (!user) return res.status(403).json({ success: false, message: '请先登录' });

  if (!familyName || familyName.trim().length < 2) {
    return res.status(400).json({ success: false, message: '家庭名称至少2个字' });
  }

  try {
    const result = withLock('family_create', () => {
      const config = loadJSON(CONFIG_FILE, {});
      const familyId = 'fam_' + Date.now().toString(36);
      const inviteCode = generateInviteCode();

      config.families = config.families || {};
      config.families[familyId] = {
        id: familyId,
        name: familyName.trim(),
        inviteCode,
        createdAt: new Date().toISOString()
      };

      // 将当前用户移入新家庭，角色设为 admin
      const u = (config.users || []).find(u => u.id === user.id);
      if (u) u.familyId = familyId;

      // 为新家庭初始化积分
      const allPoints = loadJSON(POINTS_FILE, {});
      allPoints[familyId] = {};
      saveJSON(POINTS_FILE, allPoints);
      saveJSON(CONFIG_FILE, config);

      return { familyId, inviteCode };
    });

    // 签发新 token
    const newToken = signToken(user.id, user.role, result.familyId);
    res.json({
      success: true,
      token: newToken,
      familyId: result.familyId,
      inviteCode: result.inviteCode,
      message: `家庭「${familyName.trim()}」创建成功！邀请码：${result.inviteCode}`
    });
  } catch (e) {
    res.status(503).json({ success: false, message: '创建失败' });
  }
});

// ============== 通过邀请码加入家庭 ==============
app.post('/api/family/join', (req, res) => {
  const { token, inviteCode } = req.body;
  const user = verifyToken(token);
  if (!user) return res.status(403).json({ success: false, message: '请先登录' });

  if (!inviteCode || inviteCode.trim().length < 4) {
    return res.status(400).json({ success: false, message: '请输入有效邀请码' });
  }

  try {
    let targetFamilyId = null;
    // 先查找目标家庭（锁外查找，避免占用锁）
    const configPre = loadJSON(CONFIG_FILE, {});
    const code = inviteCode.trim().toUpperCase();
    for (const fid of Object.keys(configPre.families || {})) {
      if (configPre.families[fid].inviteCode === code) {
        targetFamilyId = fid;
        break;
      }
    }
    if (!targetFamilyId) {
      return res.status(400).json({ success: false, message: '邀请码无效' });
    }

    const result = withLock('family_join_' + targetFamilyId, () => {
      const config = loadJSON(CONFIG_FILE, {});

      // 查找匹配的邀请码（重新确认）
      let targetFamily = null;
      for (const fid of Object.keys(config.families || {})) {
        if (config.families[fid].inviteCode === code) {
          targetFamily = config.families[fid];
          break;
        }
      }
      if (!targetFamily) throw new Error('邀请码无效');

      // 将用户移入目标家庭
      const u = (config.users || []).find(u => u.id === user.id);
      if (!u) throw new Error('用户不存在');
      if (u.familyId === targetFamily.id) throw new Error('你已在该家庭中');
      u.familyId = targetFamily.id;

      saveJSON(CONFIG_FILE, config);
      return targetFamily;
    });

    const newToken = signToken(user.id, user.role, result.id);
    res.json({
      success: true,
      token: newToken,
      family: { id: result.id, name: result.name },
      message: `已加入家庭「${result.name}」！`
    });
  } catch (e) {
    const code = ['邀请码无效', '用户不存在', '你已在该家庭中'].includes(e.message) ? 400 : 503;
    res.status(code).json({ success: false, message: e.message || '加入失败' });
  }
});

// ============== 更新规则（仅 admin） ==============
app.post('/api/config/rules', (req, res) => {
  const { token, rules } = req.body;
  if (!requireRole(token, ['admin'])) {
    return res.status(403).json({ success: false, message: '仅管理员可修改规则' });
  }
  try {
    withLock('config_rules', () => {
      const config = loadJSON(CONFIG_FILE, { rules: {}, users: [], families: {} });
      config.rules = rules;
      saveJSON(CONFIG_FILE, config);
    });
    res.json({ success: true, rules });
  } catch (e) {
    res.status(503).json({ success: false, message: '保存失败' });
  }
});

// ============== 更新用户（仅 admin，按家庭隔离） ==========
app.post('/api/config/users', (req, res) => {
  const { token, users } = req.body;
  const admin = requireRole(token, ['admin']);
  if (!admin) {
    return res.status(403).json({ success: false, message: '仅管理员可管理用户' });
  }
  const adminFamilyId = admin.familyId || 'default';

  try {
    withLock('config_users_' + adminFamilyId, () => {
      const config = loadJSON(CONFIG_FILE, { rules: {}, users: [], families: {} });
      const allUsers = config.users || [];

      // 保留其他家庭的用户不变
      const otherFamilyUsers = allUsers.filter(u => u.familyId !== adminFamilyId);

      // 只更新当前家庭的用户，新用户自动绑定当前 familyId
      const newUsers = users.map(u => {
        const old = allUsers.find(ou => ou.id === u.id);
        let password = u.password || (old ? old.password : '');
        if (password && !isHashed(password)) password = hashPwd(password);
        return { ...u, password, familyId: adminFamilyId };
      });

      // 合并 = 其他家庭用户 + 当前家庭新用户
      config.users = otherFamilyUsers.concat(newUsers);
      saveJSON(CONFIG_FILE, config);
    });
    // 重新读取输出（从缓存）
    const updated = cachedRead(CONFIG_FILE, {}, 5000);
    const familyUsers = (updated.users || []).filter(u => u.familyId === adminFamilyId);
    res.json({
      success: true,
      users: familyUsers.map(u => ({ id: u.id, name: u.name, role: u.role, familyId: adminFamilyId }))
    });
  } catch (e) {
    res.status(503).json({ success: false, message: '保存失败' });
  }
});

// ============== 历史记录清理（限定家庭） ==========
app.post('/api/history/cleanup', (req, res) => {
  const { token, kid, beforeDate, afterDate } = req.body;
  const admin = requireRole(token, ['admin']);
  if (!admin) {
    return res.status(403).json({ success: false, message: '仅管理员可清理记录' });
  }
  const adminFamilyId = admin.familyId || 'default';

  try {
    let deletedCount = 0;
    withLock('history_cleanup_' + adminFamilyId, () => {
      const history = loadJSON(HISTORY_FILE, []);
      const keep = [];
      history.forEach(r => {
        if (r.familyId !== adminFamilyId) {
          keep.push(r);
          return;
        }
        const matchKid = !kid || r.kid === kid;
        const rDate = r.time ? r.time.split(' ')[0].replace(/\//g, '-') : '';
        const matchBefore = !beforeDate || rDate <= beforeDate;
        const matchAfter = !afterDate || rDate >= afterDate;
        if (matchKid && matchBefore && matchAfter) {
          deletedCount++;
        } else {
          keep.push(r);
        }
      });
      saveJSON(HISTORY_FILE, keep);
    });
    res.json({ success: true, deletedCount, message: `已清理 ${deletedCount} 条记录` });
  } catch (e) {
    res.status(503).json({ success: false, message: '清理失败' });
  }
});

// ============== 备份 API ==============
app.post('/api/backup', (req, res) => {
  if (!requireRole(req.body.token, ['admin'])) {
    return res.status(403).json({ success: false, message: '仅管理员可触发备份' });
  }
  res.json(doBackup());
});

app.get('/api/backups', (req, res) => {
  if (!requireRole(req.query.token || '', ['admin'])) {
    return res.status(403).json({ success: false, message: '仅管理员可查看备份列表' });
  }
  try {
    if (!fs.existsSync(BACKUP_DIR)) return res.json({ success: true, backups: [] });
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => fs.statSync(path.join(BACKUP_DIR, f)).isDirectory())
      .sort().reverse().slice(0, 30);
    res.json({ success: true, backups });
  } catch (e) { res.json({ success: true, backups: [] }); }
});

// ============== 开机自动备份 ==============
doBackup();

const PORT = 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log('[启动] 赫菲积分管理服务 v4.0 已启动：http://0.0.0.0:' + PORT);
  console.log('[v4.0] ✨ 新增：多家庭支持、邀请码机制、语音交互');
});
