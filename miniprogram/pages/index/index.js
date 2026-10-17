// pages/index/index.js —— 首页：今日预算 + 拍三餐 + 三餐时间线
const api = require('../../utils/api.js');
const imgUtil = require('../../utils/image.js');

const MEALS = [
  { type: 'breakfast', name: '早餐', emoji: '🌅' },
  { type: 'lunch',     name: '午餐', emoji: '☀️' },
  { type: 'dinner',    name: '晚餐', emoji: '🌙' },
  { type: 'snack',     name: '加餐', emoji: '🍎' },
];

function defaultMealType() {
  const h = new Date().getHours();
  if (h < 10) return 'breakfast';
  if (h < 14) return 'lunch';
  if (h < 21) return 'dinner';
  return 'snack';
}

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
    // 从餐位历史页"记录这一餐"跳过来：直接打开该餐位的拍照
    const app = getApp();
    if (app.globalData.pendingMealType) {
      const mt = app.globalData.pendingMealType;
      app.globalData.pendingMealType = null;
      setTimeout(() => this.openShootSheet(mt), 600);
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

    this.setData({
      profile, isGlycemic,
      intakeLow, intakeHigh, targetLow, targetHigh,
      progressPct, budgetText,
      overLimit: !!(targetHigh && intakeHigh >= targetHigh),
      meals, topRisk,
      loading: false,
    });
  },

  // 拍三餐：先选餐次（默认按时间），再选图
  takePhoto() {
    this.openShootSheet(defaultMealType());
  },

  openShootSheet(mealType) {
    const that = this;
    wx.showActionSheet({
      itemList: ['拍照', '从相册选择'],
      success(res) {
        that.chooseImage(res.tapIndex === 0 ? 'camera' : 'album', mealType);
      }
    });
  },

  // 时间线卡片点击：直接进入该餐次的拍照
  tapMeal(e) {
    this.openShootSheet(e.currentTarget.dataset.type);
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
