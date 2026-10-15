// pages/analyze/analyze.js —— 餐食分析结果 + 确认记录
const api = require('../../utils/api.js');

const MEAL_NAMES = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' };

Page({
  data: {
    loading: true,
    error: '',
    analysis: null,   // mapAnalysis 结果
    medSafetyHit: false,
    mealType: 'lunch',
    mealTypeName: '午餐',
    mealTypeIndex: 1,
    mealTypeOptions: ['早餐', '午餐', '晚餐', '加餐'],
    mealTypeValues: ['breakfast', 'lunch', 'dinner', 'snack'],
    isGlycemic: false,
    saving: false,
  },

  onLoad() {
    const app = getApp();
    const pending = app.globalData.pendingMealImage;
    if (!pending || !pending.dataUri) {
      this.setData({ loading: false, error: '没有待分析的图片，请重新拍摄' });
      return;
    }
    const mealType = pending.mealType || 'lunch';
    const idx = this.data.mealTypeValues.indexOf(mealType);
    this.setData({
      mealType,
      mealTypeIndex: idx >= 0 ? idx : 1,
      mealTypeName: MEAL_NAMES[mealType] || '午餐',
      isGlycemic: app.globalData.profile && app.globalData.profile.persona === 'glycemic',
    });
    app.globalData.pendingMealImage = null; // 取出即清，避免重复提交
    this.analyze(pending.dataUri);
  },

  async analyze(dataUri) {
    const persona = getApp().globalData.profile
      ? getApp().globalData.profile.persona : 'takeout';
    const r = await api.mealAnalyze({ imageDataUri: dataUri, persona });
    if (r.ok) {
      this.setData({
        loading: false,
        analysis: r.analysis,
        medSafetyHit: r.medSafetyHit,
      });
      this.drawScoreRing(r.analysis.mealScore);
    } else {
      this.setData({
        loading: false,
        error: r.quotaExhausted ? '今日分析次数已用完，明天再来吧' : (r.error || '分析失败'),
      });
    }
  },

  // meal_score 环形分（canvas）
  drawScoreRing(score) {
    if (score == null) return;
    const query = wx.createSelectorQuery().in(this);
    query.select('#scoreRing').fields({ node: true, size: true }).exec((res) => {
      const r = res && res[0];
      if (!r || !r.node) return;
      const canvas = r.node;
      const dpr = wx.getSystemInfoSync().pixelRatio || 2;
      const size = r.width || 160;
      canvas.width = size * dpr;
      canvas.height = size * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      const cx = size / 2, cy = size / 2, rad = size / 2 - 12;
      ctx.lineWidth = 12;
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#eef1ee';
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.stroke();
      const color = score >= 70 ? '#07c160' : score >= 50 ? '#fa9d3b' : '#fa5151';
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cy, rad, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (score / 100));
      ctx.stroke();
    });
  },

  onMealTypeChange(e) {
    const idx = Number(e.detail.value);
    const v = this.data.mealTypeValues[idx];
    this.setData({ mealTypeIndex: idx, mealType: v, mealTypeName: MEAL_NAMES[v] });
  },

  // MVP 级手动修正：删除某道菜
  removeDish(e) {
    const idx = Number(e.currentTarget.dataset.index);
    const analysis = this.data.analysis;
    const dishes = analysis.dishes.slice();
    const removed = dishes.splice(idx, 1)[0];
    analysis.dishes = dishes;
    this.setData({ analysis });
    wx.showToast({ title: '已移除' + (removed.name || ''), icon: 'none' });
  },

  retry() {
    wx.navigateBack();
  },

  async confirmSave() {
    const d = this.data;
    if (!d.analysis || !d.analysis.dishes.length) {
      wx.showToast({ title: '没有可记录的菜品', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    wx.showLoading({ title: '记录中...', mask: true });
    const r = await api.saveDietLog({
      date: api.todayStr(),
      mealType: d.mealType,
      persona: d.analysis.persona,
      analysis: d.analysis,
    });
    wx.hideLoading();
    this.setData({ saving: false });
    if (r.ok) {
      wx.showToast({ title: '已记录', icon: 'success' });
      setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 600);
    } else {
      wx.showToast({ title: r.error || '保存失败', icon: 'none' });
    }
  },
});
