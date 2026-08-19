const express = require('express');
const router = express.Router();
const { users, families } = require('../db/repositories');
const { signToken, hashPwd, verifyPwd } = require('../lib/token');
const { wxCode2Session } = require('../lib/wx-auth');
const logger = require('../lib/logger');

function loginResponse(user) {
  const familyId = user.familyId || 'default';
  const family = families.findById(familyId) || { id: 'default', name: '默认家庭' };
  return {
    token: signToken(user.id, user.role, familyId),
    user: { id: user.id, name: user.name, role: user.role, familyId },
    family: { id: family.id, name: family.name }
  };
}

router.post('/auth', (req, res) => {
  const { userId, password } = req.body;
  const user = users.findById(userId);
  if (!user || !verifyPwd(password, user.password)) {
    return res.status(403).json({ success: false, message: '用户或密码错误' });
  }
  if (user.password && !user.password.includes(':')) {
    user.password = hashPwd(password);
    users.updatePassword(user.id, user.password);
  }
  res.json({ success: true, ...loginResponse(user) });
});

router.post('/wx-login', async (req, res) => {
  const { code } = req.body || {};
  if (!code || typeof code !== 'string') return res.status(400).json({ success: false, message: '缺少 code' });
  try {
    const { openid } = await wxCode2Session(code);
    const user = users.findByOpenId(openid);
    if (!user) return res.json({ success: true, isNew: true, openid, message: '首次使用，请选择用户并输入密码完成绑定' });
    return res.json({ success: true, isNew: false, ...loginResponse(user) });
  } catch (e) {
    (req.log || logger).error({ event: 'auth.wx_login.failed', error: e.message }, 'WeChat login failed');
    return res.status(500).json({ success: false, message: '微信登录失败：' + e.message });
  }
});

router.post('/wx-bind', async (req, res) => {
  const { openid, userId, password } = req.body || {};
  if (!openid || !userId || !password) return res.status(400).json({ success: false, message: '参数不完整（需 openid + userId + password）' });
  try {
    const user = users.findById(userId);
    if (!user || !verifyPwd(password, user.password)) throw new Error('账号或密码错误');
    const bound = users.bindOpenId(userId, openid, new Date().toISOString());
    if (bound.conflict) throw new Error(`此微信已绑定到「${bound.conflict.name}」账号，如需切换请先解绑`);
    if (!bound.user) throw new Error('用户不存在');
    const result = loginResponse(bound.user);
    return res.json({ success: true, ...result, message: `「${result.user.name}」绑定成功` });
  } catch (e) {
    const code = e.message === '账号或密码错误' ? 403 : e.message.includes('已绑定到') ? 409 : 500;
    return res.status(code).json({ success: false, message: e.message });
  }
});

module.exports = router;
