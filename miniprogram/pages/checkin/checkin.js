// pages/checkin/checkin.js —— 打卡 tab：月历 + 连续打卡
// 说明：后端暂无按月查询接口，打卡日期记在本地（utils/api.js markCheckinDay）。
// TODO(后端对齐): 未来加 GET /api/diet-log?from=&to= 后改从服务端拉取。
const api = require('../../utils/api.js');

Page({
  data: {
    year: 0, month: 0, // month: 0-11
    weeks: [],         // [{days: [{day, dateStr, checked, isToday, inMonth}]}]
    streak: 0,
    monthCount: 0,
  },

  onShow() {
    const now = new Date();
    this.setData({ year: now.getFullYear(), month: now.getMonth() });
    this.render();
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
