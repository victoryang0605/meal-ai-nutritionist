// pages/checkin/checkin.js —— 打卡 tab：今日三餐四宫格 + 月历 + 连续打卡 + 提醒订阅
// 数据源：打卡绿点以**服务端 diet_logs** 为准（GET /api/diet-log?from=&to=），
// 本地 storage 仅在网络失败时兜底，避免换机丢失历史绿点。
const api = require('../../utils/api.js');

const SLOTS = [
  { type: 'breakfast', name: '早餐', emoji: '🌅' },
  { type: 'lunch',     name: '午餐', emoji: '☀️' },
  { type: 'dinner',    name: '晚餐', emoji: '🌙' },
  { type: 'snack',     name: '加餐', emoji: '🍎' },
];

Page({
  data: {
    year: 0, month: 0, // month: 0-11
    weeks: [],         // [{days: [{day, dateStr, checked, isToday, inMonth}]}]
    streak: 0,
    monthCount: 0,
    slots: [],         // 今日三餐四宫格
    reminderOn: false,
  },

  onShow() {
    const now = new Date();
    this.setData({ year: now.getFullYear(), month: now.getMonth(), reminderOn: api.isReminderOn() });
    // 先用本地缓存秒出，再异步拉服务端覆盖，避免白屏等待
    this.render();
    this.loadSlots();
    this.loadCheckinDays();
  },

  // 拉服务端打卡日期（覆盖当前月份 + 上个月，足够算连续天数）
  async loadCheckinDays() {
    const { year, month } = this.data;
    const pad = (n) => String(n).padStart(2, '0');
    // 从上个月 1 号开始拉，保证跨月连续打卡能正确计算
    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month + 1, 0);
    const from = start.getFullYear() + '-' + pad(start.getMonth() + 1) + '-01';
    const to = end.getFullYear() + '-' + pad(end.getMonth() + 1) + '-' + pad(end.getDate());

    const days = await api.getCheckinDaysFromServer(from, to);
    if (days && days.length >= 0) {
      // 服务端数据为准：合并进本地缓存（保留更早的本地记录，避免旧数据被抹掉）
      const merged = {};
      api.getCheckinDays().concat(days).forEach((d) => { merged[d] = true; });
      const mergedList = Object.keys(merged).sort();
      api.cacheCheckinDays(mergedList);
      this.render(mergedList);
    } else {
      // 网络失败：用本地缓存兜底，不打断页面
      this.render();
    }
  },

  // 今日三餐四宫格：从服务端拉当日记录
  async loadSlots() {
    const today = api.todayStr();
    const diet = await api.getDietLog(today);
    const byType = {};
    (diet ? diet.logs : []).forEach((l) => {
      // 加餐可能多条：取最后一条展示，历史页看全部
      byType[l.mealType] = l;
    });
    const slots = SLOTS.map((s) => {
      const log = byType[s.type];
      return Object.assign({}, s, {
        logged: !!log,
        dishCount: log ? log.dishes.length : 0,
        kcalText: log ? (log.kcalLow + '-' + log.kcalHigh + ' kcal') : '',
      });
    });
    this.setData({ slots });
  },

  // 点格子：看该餐位的历史记录
  tapSlot(e) {
    const type = e.currentTarget.dataset.type;
    wx.navigateTo({ url: '/pages/history/history?meal_type=' + type });
  },

  // 每日打卡提醒订阅
  async toggleReminder() {
    if (this.data.reminderOn) {
      wx.showToast({ title: '已开启提醒', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '请求授权...', mask: true });
    const r = await api.subscribeReminder();
    wx.hideLoading();
    if (r.ok) {
      this.setData({ reminderOn: true });
      wx.showToast({ title: '已开启每日提醒', icon: 'success' });
    } else if (r.notConfigured) {
      // 模板未配置时 api 内部已 toast
    } else if (r.denied) {
      wx.showToast({ title: '你拒绝了授权，可在设置中开启', icon: 'none' });
    } else {
      wx.showToast({ title: '开启失败，请重试', icon: 'none' });
    }
  },

  // 渲染月历。daysInput 传入服务端数据时以其为准，否则用本地缓存兜底。
  render(daysInput) {
    const { year, month } = this.data;
    const source = Array.isArray(daysInput) ? daysInput : api.getCheckinDays();
    const checked = {};
    source.forEach((d) => { checked[d] = true; });

    const first = new Date(year, month, 1);
    const startDay = first.getDay(); // 0=周日
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const todayStr = api.todayStr();

    const cells = [];
    for (let i = 0; i < startDay; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
      cells.push({ day: d, dateStr: ds, checked: !!checked[ds], isToday: ds === todayStr });
    }
    while (cells.length % 7 !== 0) cells.push(null);

    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push({ days: cells.slice(i, i + 7) });

    const monthPrefix = year + '-' + String(month + 1).padStart(2, '0');
    const monthCount = source.filter((d) => d.indexOf(monthPrefix) === 0).length;

    this.setData({ weeks, streak: api.calcStreak(source), monthCount });
  },

  prevMonth() {
    let { year, month } = this.data;
    month--;
    if (month < 0) { month = 11; year--; }
    this.setData({ year, month });
    this.render();
    this.loadCheckinDays();
  },

  nextMonth() {
    let { year, month } = this.data;
    month++;
    if (month > 11) { month = 0; year++; }
    const now = new Date();
    if (year > now.getFullYear() || (year === now.getFullYear() && month > now.getMonth())) return;
    this.setData({ year, month });
    this.render();
    this.loadCheckinDays();
  },

  goShoot() {
    wx.switchTab({ url: '/pages/index/index' });
  },
});
