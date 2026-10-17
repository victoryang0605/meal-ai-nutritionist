// pages/index/index.js —— 首页：今日预算 + 拍三餐 + 三餐时间线
const api = require('../../utils/api.js');
const imgUtil = require('../../utils/image.js');

const MEALS = [
  { type: 'breakfast', name: '早餐', emoji: '🌅' },
  { type: 'lunch',     name: '午餐', emoji: '☀️' },
  { type: 'dinner',    name: '晚餐', emoji: '🌙' },
  { type: 'snack',     name: '加餐', emoji: '🍎' },
];

/**
 * 按当前时间推断默认餐次（2026-10-17 产品规则）
 *
 *   00:00 - 09:59  早餐
 *   10:00 - 13:59  午餐
 *   14:00 - 18:59  晚餐
 *   19:00 - 23:59  加餐
 *
 * 只决定「点拍照按钮后默认选哪个餐次」，用户仍可在 analyze 页手动改。
 */
function defaultMealType() {
  const h = new Date().getHours();
  if (h < 10) return 'breakfast';
  if (h < 14) return 'lunch';
  if (h < 19) return 'dinner';
  return 'snack';
}

const MEAL_NAMES = {
  breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐',
};

Page({
  data: {
    profile: null,
    isGlycemic: false,
    // 预算条
    intakeLow: 0, intakeHigh: 0,
    targetLow: null, targetHigh: null,
    progressPct: 0,
    budgetText: '',
    // 三餐时间线
    meals: [],
    // 控糖首页
    topRisk: null, // {level, count}
    loading: true,
  },

  onShow() {
    this.load();
    // 从餐位历史页"记录这一餐"跳过来：走 startShoot 以保持覆盖确认一致
    const app = getApp();
    if (app.globalData.pendingMealType) {
      const mt = app.globalData.pendingMealType;
      app.globalData.pendingMealType = null;
      // 等 load() 把 meals 填完，否则 findMeal 拿不到已有记录
      this._pendingShoot = mt;
      setTimeout(() => {
        if (this._pendingShoot) {
          const t = this._pendingShoot;
          this._pendingShoot = null;
          this.startShoot(t);
        }
      }, 800);
    }
  },

  async load() {
    this.setData({ loading: true });
    // 没有登录态 → 引导页（login）分流：新用户去建档，老用户一键登录
    if (!api.hasSession()) {
      this.setData({ loading: false });
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    const okLogin = await api.ensureLogin();
    if (!okLogin) {
      this.setData({ loading: false });
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    let profile = await api.getProfile();
    if (!profile) {
      // 已登录但没建档 → 去补建档
      wx.redirectTo({ url: '/pages/onboarding/onboarding' });
      return;
    }
    getApp().globalData.profile = profile;
    const isGlycemic = profile.persona === 'glycemic';
    const today = api.todayStr();
    const diet = await api.getDietLog(today);

    const byType = {};
    (diet ? diet.logs : []).forEach((l) => { byType[l.mealType] = l; });
    const meals = MEALS.map((m) => {
      const log = byType[m.type];
      return Object.assign({}, m, {
        logged: !!log,
        kcalLow: log ? log.kcalLow : 0,
        kcalHigh: log ? log.kcalHigh : 0,
        score: log ? log.mealScore : null,
        risk: log ? log.glycemicRisk : null,
        firstDish: log && log.dishes.length ? log.dishes[0].name : '',
      });
    });

    // 预算条：已摄入区间 vs 目标区间
    const intakeLow = diet ? diet.total.kcalLow : 0;
    const intakeHigh = diet ? diet.total.kcalHigh : 0;
    const targetLow = diet && diet.target ? diet.target.dailyKcalLow : profile.dailyKcalLow;
    const targetHigh = diet && diet.target ? diet.target.dailyKcalHigh : profile.dailyKcalHigh;
    let progressPct = 0, budgetText = '';
    if (targetLow && targetHigh) {
      const midIn = (intakeLow + intakeHigh) / 2;
      const midT = (targetLow + targetHigh) / 2;
      progressPct = Math.min(100, Math.round((midIn / midT) * 100));
      budgetText = '已摄入 ' + intakeLow + '-' + intakeHigh + ' / 目标 ' +
        targetLow + '-' + targetHigh + ' kcal';
    } else {
      budgetText = intakeLow || intakeHigh
        ? '今日已摄入 ' + intakeLow + '-' + intakeHigh + ' kcal'
        : '今日还没有记录';
    }

    // 控糖模式：今日最高升糖风险
    let topRisk = null;
    if (isGlycemic && diet) {
      const rank = { '高': 3, '中': 2, '低': 1 };
      diet.logs.forEach((l) => {
        if (l.glycemicRisk && (!topRisk || rank[l.glycemicRisk] > rank[topRisk.level])) {
          topRisk = { level: l.glycemicRisk, count: diet.logs.length };
        }
      });
    }

    // 当日剩余分析次数（credits 在 analyze 成功时回传，这里用本地缓存的初值）
    const credits = api.getCachedCredits();
    const dailyLimit = credits.dailyLimit || 10;
    const todayRemaining = credits.todayRemaining == null ? null : credits.todayRemaining;

    this.setData({
      profile, isGlycemic,
      intakeLow, intakeHigh, targetLow, targetHigh,
      progressPct, budgetText,
      overLimit: !!(targetHigh && intakeHigh >= targetHigh),
      meals, topRisk,
      dailyLimit,
      todayRemaining,
      quotaText: todayRemaining === null ? '' : ('今日还可分析 ' + todayRemaining + ' / ' + dailyLimit + ' 次'),
      loading: false,
    });
  },

  // 拍三餐：先检查该餐位是否已记录 → 两级确认 → 选图
  takePhoto() {
    this.startShoot(defaultMealType());
  },

  // 时间线卡片点击：指定餐位拍照
  tapMeal(e) {
    this.startShoot(e.currentTarget.dataset.type);
  },

  /**
   * 拍照前检查（2026-10-17 产品规则）
   *
   * 当日同一餐位重复拍摄的交互流程：
   *   1. 提示「已记录过X，是否继续」—— 用户取消即中止
   *   2. 用户选择继续后，再提示「本次将覆盖上一次记录」—— 确认才继续
   * 两次弹窗都必须用户主动确认，任一步取消都不消耗额度、不选图。
   *
   * 加餐（snack）后端允许多条记录，因此不触发覆盖流程。
   */
  async startShoot(mealType) {
    const name = MEAL_NAMES[mealType] || '这一餐';

    // 加餐可多次记录，跳过确认流程
    if (mealType === 'snack') {
      this.openShootSheet(mealType);
      return;
    }

    const existing = this.findMeal(mealType);
    if (!existing) {
      this.openShootSheet(mealType);
      return;
    }

    // 第一级：是否继续
    const c1 = await this.confirm({
      title: `${name}已经记录过了`,
      content: existing.firstDish
        ? `上次记录的是「${existing.firstDish}」，要重新拍一次吗？`
        : '今天已经记录过这一餐了，要重新拍一次吗？',
      confirmText: '重新记录',
      cancelText: '不用了',
    });
    if (!c1) return;

    // 第二级：确认覆盖
    const c2 = await this.confirm({
      title: '将覆盖上一次记录',
      content: `继续后，今天的${name}记录会替换掉之前那条（之前的记录无法恢复）。`,
      confirmText: '确认覆盖',
      cancelText: '再想想',
    });
    if (!c2) return;

    this.openShootSheet(mealType);
  },

  // Promise 化的 wx.showModal，便于串行 await
  confirm({ title, content, confirmText, cancelText }) {
    return new Promise((resolve) => {
      wx.showModal({
        title, content, confirmText, cancelText,
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false),
      });
    });
  },

  // 从当前 meals 中找指定餐位的记录
  findMeal(mealType) {
    return (this.data.meals || []).find((m) => m.type === mealType && m.logged) || null;
  },

  openShootSheet(mealType) {
    wx.showActionSheet({
      itemList: ['拍照', '从相册选择'],
      success: (res) => {
        this.chooseImage(res.tapIndex === 0 ? 'camera' : 'album', mealType);
      }
    });
  },

  async chooseImage(sourceType, mealType) {
    wx.showLoading({ title: '图片处理中...', mask: true });
    try {
      const picked = await imgUtil.pickAndPrepareImage(sourceType);
      wx.hideLoading();
      if (!picked) return;
      getApp().globalData.pendingMealImage = { dataUri: picked.dataUri, mealType };
      wx.navigateTo({ url: '/pages/analyze/analyze' });
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '图片处理失败', icon: 'none' });
    }
  },

  goWeight() {
    wx.navigateTo({ url: '/pages/weight/weight' });
  },
});
