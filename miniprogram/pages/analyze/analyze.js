// pages/analyze/analyze.js —— 餐食分析结果 + 确认记录
const api = require('../../utils/api.js');

const MEAL_NAMES = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' };

Page({
  data: {
    loading: true,
    error: '',
    errTip: '',
    analysis: null,   // mapAnalysis 结果
    medSafetyHit: false,
    mealType: 'lunch',
    mealTypeName: '午餐',
    mealTypeIndex: 1,
    mealTypeOptions: ['早餐', '午餐', '晚餐', '加餐'],
    mealTypeValues: ['breakfast', 'lunch', 'dinner', 'snack'],
    isGlycemic: false,
    saving: false,
    // 剩余可分析次数（P1-3，来自后端 credits.totalRemaining）
    remaining: null,
    remainingText: '',
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
      // 图片不落库：这里不缓存原图，服务端识别后即丢弃
      this.setData({
        loading: false,
        analysis: r.analysis,
        medSafetyHit: r.medSafetyHit,
        remaining: r.remaining,          // 剩余可分析次数（P1-3）
        remainingText: r.remainingText,
      });
      // ⚠️ canvas 在 wx:if 内，需等节点完成布局再取尺寸，
      // 否则 r.width/r.height 为未布局值，评分环会画错位置
      wx.nextTick(() => this.drawScoreRing(r.analysis.mealScore));
    } else if (r.dailyLimitReached) {
      // 今日已达每日上限（默认 10 次），次日重置
      this.setData({
        loading: false,
        error: '今天的分析次数已用完',
        errTip: 'AI 分析每天最多 10 次，请明天再来记录三餐。',
      });
    } else if (r.quotaExhausted) {
      // 终身免费额度用完 —— 不是「今天用完」，提示不能误导用户等明天
      this.setData({
        loading: false,
        error: '免费分析次数已用完',
        errTip: '你的免费分析额度已全部使用完毕。',
      });
    } else {
      this.setData({
        loading: false,
        error: r.error || '分析失败',
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
      // 节点未完成布局时宽高为 0，跳过绘制，避免画到错误位置
      if (!r.width || !r.height) {
        console.warn('[analyze] scoreRing 未完成布局，跳过绘制');
        return;
      }
      const canvas = r.node;
      const dpr = wx.getSystemInfoSync().pixelRatio || 2;
      const size = r.width;
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

    // 只落库 AI 给出的建议与估算数据（菜品/热量/营养素/评分/建议）。
    // 图片不落库：原图仅用于本次识别，服务端内存中转后即丢弃。
    const r = await api.saveDietLog({
      date: api.todayStr(),
      mealType: d.mealType,
      persona: d.analysis.persona,
      analysis: d.analysis,
    });
    wx.hideLoading();
    this.setData({ saving: false });
    if (r.ok) {
      const msg = r.replaced ? '已更新今日这餐记录' : '已记录';
      wx.showToast({ title: msg, icon: 'success' });
      setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 600);
      this.maybePromptReminder();
    } else {
      wx.showToast({ title: r.error || '保存失败', icon: 'none' });
    }
  },

  // 记录成功后：每天首次引导一次订阅消息（已开启则跳过）
  maybePromptReminder() {
    if (api.isReminderOn()) return;
    const key = 'meal_reminder_prompt_' + api.todayStr();
    try {
      if (wx.getStorageSync(key)) return;
      wx.setStorageSync(key, true);
    } catch (_) { /* ignore */ }
    wx.showModal({
      title: '开启每日打卡提醒？',
      content: '当天没记录三餐，晚上 8 点微信提醒你，不错过打卡。',
      confirmText: '开启',
      cancelText: '不用',
      success: async (m) => {
        if (!m.confirm) return;
        const r = await api.subscribeReminder();
        if (r.ok) wx.showToast({ title: '已开启每日提醒', icon: 'success' });
      },
    });
  },
});
