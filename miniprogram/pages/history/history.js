// pages/history/history.js —— 某餐位历史记录（从打卡页四宫格进入）
const api = require('../../utils/api.js');

const NAMES = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' };

Page({
  data: {
    mealType: '',
    mealName: '',
    records: [], // {id, date, dishes, kcalLow, kcalHigh, mealScore, dishNames, expanded}
    loading: true,
    empty: false,
  },

  onLoad(options) {
    const mealType = options.meal_type || 'breakfast';
    this.setData({ mealType, mealName: NAMES[mealType] || mealType });
    wx.setNavigationBarTitle({ title: (NAMES[mealType] || '') + '历史记录' });
  },

  onShow() {
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    const okLogin = await api.ensureLogin();
    if (!okLogin) { this.setData({ loading: false }); return; }
    const list = await api.getDietLogHistory(this.data.mealType, 30);
    // 透传 AI 诊断字段给模板；数组兜底为空数组，
    // 否则 wx:if="{{item.highlights.length}}" 在字段缺失时会报错
    const records = list.map((r) => Object.assign({}, r, {
      dishNames: r.dishes.map((d) => d.name).join('、') || '（无菜品明细）',
      highlights: Array.isArray(r.highlights) ? r.highlights : [],
      warnings: Array.isArray(r.warnings) ? r.warnings : [],
      suggestion: r.suggestion || '',
      giNotes: r.giNotes || '',
      mealOrderTip: r.mealOrderTip || '',
      expanded: false,
    }));
    this.setData({ records, loading: false, empty: records.length === 0 });
  },

  toggleExpand(e) {
    const id = e.currentTarget.dataset.id;
    const records = this.data.records.map((r) =>
      r.id === id ? Object.assign({}, r, { expanded: !r.expanded }) : r
    );
    this.setData({ records });
  },

  // 记录这一餐：回首页并直接打开该餐位的拍照
  recordNow() {
    getApp().globalData.pendingMealType = this.data.mealType;
    wx.switchTab({ url: '/pages/index/index' });
  },
});
