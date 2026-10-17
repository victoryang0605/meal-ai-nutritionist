// pages/weight/weight.js —— 轻量体重记录 + 30 天曲线
const api = require('../../utils/api.js');

Page({
  data: {
    input: '',
    lastWeight: null,   // 上次体重
    points: [],         // [{date, weightKg}]
    feedback: '',
    saving: false,
    hasData: false,
  },

  onShow() {
    this._alive = true;
    this.load();
  },

  onHide() { this._alive = false; },
  onUnload() { this._alive = false; },

  async load() {
    if (!api.hasSession()) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    const okLogin = await api.ensureLogin();
    if (!okLogin) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    const points = await api.getWeightCurve(30);
    const lastWeight = points.length ? points[points.length - 1].weightKg : null;
    this.setData({ points, lastWeight, hasData: points.length > 0, feedback: '' });
    // ⚠️ canvas 位于 wx:if="{{hasData}}" 内，必须等 setData 让节点完成布局后再取尺寸，
    // 否则 r.width/r.height 是未布局值，折线会画到卡片外（真机复现过的回归）。
    if (points.length > 1) {
      wx.nextTick(() => { if (this._alive) this.drawCurve(0); });
    }
  },

  onInput(e) {
    this.setData({ input: e.detail.value });
  },

  // 一键沿用上次体重
  useLast() {
    if (this.data.lastWeight == null) return;
    this.setData({ input: String(this.data.lastWeight) });
  },

  async save() {
    const w = Number(this.data.input);
    if (!w || w < 20 || w > 300) {
      wx.showToast({ title: '请输入正确的体重', icon: 'none' });
      return;
    }
    const prev = this.data.lastWeight;
    this.setData({ saving: true });
    wx.showLoading({ title: '记录中...', mask: true });
    const r = await api.saveWeight({ date: api.todayStr(), weightKg: w });
    wx.hideLoading();
    this.setData({ saving: false, input: '' });
    if (r.ok) {
      // 即时反馈：只陈述变化，绝不承诺减重效果
      let feedback = '已记录 ' + r.weightKg + 'kg';
      if (prev != null) {
        const diff = Math.round((r.weightKg - prev) * 10) / 10;
        if (diff < 0) feedback += '，比上次轻了 ' + Math.abs(diff) + 'kg，继续保持 🙂';
        else if (diff > 0) feedback += '，比上次重了 ' + diff + 'kg，别灰心，明天继续';
        else feedback += '，和上次持平，稳住就是胜利';
      } else {
        feedback += '，这是你的第一次记录，曲线开始啦 🎉';
      }
      this.setData({ feedback });
      wx.showToast({ title: '记录成功', icon: 'success' });
      this.load();
    } else {
      wx.showToast({ title: r.error || '保存失败', icon: 'none' });
    }
  },

  // canvas 画 30 天折线
  // attempt 为重试次数：nextTick 后仍可能未完成布局，最多再试 3 次
  drawCurve(attempt = 0) {
    const points = this.data.points;
    if (points.length < 2 || !this._alive) return;
    const query = wx.createSelectorQuery().in(this);
    query.select('#weightCurve').fields({ node: true, size: true }).exec((res) => {
      const r = res && res[0];
      if (!r || !r.node) return;
      // 节点未完成布局时宽高为 0，此时绘制会把内容画到错误位置
      if (!r.width || !r.height) {
        if (attempt < 3) setTimeout(() => this.drawCurve(attempt + 1), 60);
        else console.warn('[weight] canvas 反复重试仍无尺寸，放弃绘制');
        return;
      }
      const canvas = r.node;
      const dpr = wx.getSystemInfoSync().pixelRatio || 2;
      const W = r.width, H = r.height;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, W, H);

      const weights = points.map((p) => p.weightKg);
      let min = Math.min.apply(null, weights), max = Math.max.apply(null, weights);
      if (max - min < 2) { const mid = (max + min) / 2; min = mid - 1; max = mid + 1; }
      const padL = 70, padR = 20, padT = 24, padB = 44;
      const x = (i) => padL + (i / (points.length - 1)) * (W - padL - padR);
      const y = (v) => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);

      // 网格 + y 轴刻度
      ctx.strokeStyle = '#eef1ee';
      ctx.fillStyle = '#b0b5b0';
      ctx.font = '20px sans-serif';
      ctx.lineWidth = 1;
      for (let g = 0; g <= 4; g++) {
        const v = min + ((max - min) / 4) * g;
        const yy = y(v);
        ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
        ctx.fillText(v.toFixed(1), 8, yy + 7);
      }
      // x 轴日期（首/中/末）
      ctx.fillText(points[0].date.slice(5), padL - 10, H - 12);
      ctx.fillText(points[points.length - 1].date.slice(5), W - padR - 60, H - 12);

      // 折线
      ctx.strokeStyle = '#07c160';
      ctx.lineWidth = 4;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      points.forEach((p, i) => { if (i === 0) ctx.moveTo(x(i), y(p.weightKg)); else ctx.lineTo(x(i), y(p.weightKg)); });
      ctx.stroke();

      // 数据点
      ctx.fillStyle = '#07c160';
      points.forEach((p, i) => {
        ctx.beginPath();
        ctx.arc(x(i), y(p.weightKg), 5, 0, Math.PI * 2);
        ctx.fill();
      });
      // 最新点高亮
      const li = points.length - 1;
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(x(li), y(points[li].weightKg), 8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#07c160';
      ctx.beginPath(); ctx.arc(x(li), y(points[li].weightKg), 5, 0, Math.PI * 2); ctx.fill();
    });
  },
});
