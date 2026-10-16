// pages/checkin/checkin.js —— 打卡 tab：今日三餐四宫格 + 月历 + 连续打卡 + 提醒订阅
// 说明：后端暂无按月查询接口，打卡日期记在本地（utils/api.js markCheckinDay）。
// TODO(后端对齐): 未来加 GET /api/diet-log?from=&to= 后改从服务端拉取。
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
    this.render();
    this.loadSlots();
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

  render() {
    const { year, month } = this.data;
    const checked = {};
    api.getCheckinDays().forEach((d) => { checked[d] = true; });

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
    const monthCount = api.getCheckinDays().filter((d) => d.indexOf(monthPrefix) === 0).length;

    this.setData({ weeks, streak: api.calcStreak(), monthCount });
  },

  prevMonth() {
    let { year, month } = this.data;
    month--;
    if (month < 0) { month = 11; year--; }
    this.setData({ year, month });
    this.render();
  },

  nextMonth() {
    let { year, month } = this.data;
    month++;
    if (month > 11) { month = 0; year++; }
    const now = new Date();
    if (year > now.getFullYear() || (year === now.getFullYear() && month > now.getMonth())) return;
    this.setData({ year, month });
    this.render();
  },

  goShoot() {
    wx.switchTab({ url: '/pages/index/index' });
  },
});
