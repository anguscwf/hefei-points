const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const repositories = require('../db/repositories');
const { DATA_DIR } = require('../db/connection');
const logger = require('../lib/logger');

function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(chars.length)];
  return code;
}

function getDefaultRuleTemplates() {
  return {
    reward: [
      { id: 'cat_reward_academic', category: '📚 学业表现', items: [
        { id: 'r_ac_1', label: '作业按时完成', min: 2, max: 5, default: 3, unit: '每科', hint: '每天检查作业完成情况' },
        { id: 'r_ac_2', label: '考试优秀（90分以上）', min: 5, max: 15, default: 10, unit: '每次', hint: '期中/期末考试' },
        { id: 'r_ac_3', label: '考试进步（比上次高）', min: 3, max: 8, default: 5, unit: '每次', hint: '和自己上次成绩比' }
      ] },
      { id: 'cat_reward_chores', category: '🏠 家务劳动', items: [
        { id: 'r_ch_1', label: '收拾房间', min: 2, max: 5, default: 3, unit: '每次', hint: '保持房间整洁' },
        { id: 'r_ch_2', label: '洗碗/帮忙做饭', min: 2, max: 4, default: 2, unit: '每次', hint: '帮妈妈分担家务' },
        { id: 'r_ch_3', label: '自己整理书包/衣物', min: 1, max: 3, default: 2, unit: '每天', hint: '养成自理习惯' }
      ] },
      { id: 'cat_reward_habits', category: '🎯 好习惯养成', items: [
        { id: 'r_ha_1', label: '早上自觉起床', min: 1, max: 3, default: 2, unit: '每天', hint: '不用大人叫' },
        { id: 'r_ha_2', label: '阅读30分钟以上', min: 2, max: 5, default: 3, unit: '每次', hint: '课外书/绘本都算' }
      ] }
    ],
    punish: [
      { id: 'cat_punish_behavior', category: '🚫 行为规范', items: [
        { id: 'p_be_1', label: '不听话/顶嘴', min: -5, max: -2, default: -3, unit: '每次', hint: '尊重长辈' },
        { id: 'p_be_2', label: '没按规定收拾东西', min: -3, max: -1, default: -2, unit: '每次', hint: '说到要做到' },
        { id: 'p_be_3', label: '玩游戏超时', min: -5, max: -2, default: -3, unit: '每次', hint: '先做正事再玩' }
      ] },
      { id: 'cat_punish_study', category: '📖 学习相关', items: [
        { id: 'p_st_1', label: '没按时完成作业', min: -5, max: -2, default: -3, unit: '每科', hint: '作业是首要任务' },
        { id: 'p_st_2', label: '考试退步', min: -5, max: -2, default: -3, unit: '每次', hint: '和上次比退步了' }
      ] }
    ],
    special: ['每月清零日：月底可以将积分兑换为奖励（如买玩具、去游乐园）', '连续7天全勤（无扣分）：额外奖励5分', '生日当天：奖励双倍积分']
  };
}

function initData() {
  const syntheticRuntime = process.env.NODE_ENV === 'production'
    && process.env.DEPLOYMENT_TIER === 'synthetic';
  repositories.families.ensureDefault({
    id: 'default',
    name: syntheticRuntime ? '合成默认家庭' : '安总家',
    inviteCode: generateInviteCode(),
    createdAt: new Date().toISOString()
  });
  if (Object.keys(repositories.config.getRules('default')).length === 0) {
    repositories.config.setRules('default', getDefaultRuleTemplates(), { updatedBy: 'system' });
  }
  if (repositories.users.listAll().length === 0) {
    let legacyHasUsers = false;
    if (!syntheticRuntime) {
      const legacyConfigFile = path.join(DATA_DIR, 'config.json');
      try {
        const legacy = JSON.parse(fs.readFileSync(legacyConfigFile, 'utf8'));
        legacyHasUsers = Array.isArray(legacy.users) && legacy.users.length > 0;
      } catch (_) {}
    }
    if (legacyHasUsers) {
      throw new Error('检测到尚未迁移的 JSON 用户数据，请先运行 npm run migrate:sqlite');
    }
    logger.warn({ event: 'bootstrap.no_users' }, 'no users configured; create an administrator securely');
  }
  if (syntheticRuntime) {
    logger.info({ event: 'backup.synthetic_skipped' }, 'automatic backup is disabled for synthetic data');
  } else {
    require('../lib/backup').doBackup();
  }
}

module.exports = { initData, getDefaultRuleTemplates };
