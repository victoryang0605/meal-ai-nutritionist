// pages/onboarding/onboarding.js —— 首次进入：选画像 + 建档
const api = require('../../utils/api.js');

const ACTIVITY_OPTIONS = [
  { label: '久坐（办公室为主）', value: 'sedentary' },
  { label: '轻度（偶尔散步）', value: 'light' },
  { label: '中度（每周运动 1-3 次）', value: 'moderate' },
  { label: '活跃（每周运动 3-5 次）', value: 'active' },
  { label: '非常活跃（每天高强度）', value: 'very_active' },
];

Page({
  data: {
    step: 1,
    persona: '', // takeout | glycemic
    heightCm: '',
    weightKg: '',
    age: '',
    gender: 'female',
    activityIndex: 1,
    activityOptions: ACTIVITY_OPTIONS.map((o) => o.label),
    disclaimerAck: false,
    submitting: false,
  },

  selectPersona(e) {
    this.setData({ persona: e.currentTarget.dataset.persona, step: 2 });
  },

  backStep() {
    this.setData({ step: 1 });
  },

  onInput(e) {
    const f = e.currentTarget.dataset.field;
    this.setData({ [f]: e.detail.value });
  },

  onGender(e) {
    this.setData({ gender: e.detail.value });
  },

  onActivity(e) {
    this.setData({ activityIndex: Number(e.detail.value) });
  },

  toggleDisclaimer() {
    this.setData({ disclaimerAck: !this.data.disclaimerAck });
  },

  goDisclaimer() {
    wx.navigateTo({ url: '/pages/disclaimer/disclaimer' });
  },

  async submit() {
    const d = this.data;
    if (!d.persona) { wx.showToast({ title: '请先选择画像', icon: 'none' }); return; }
    if (d.persona === 'glycemic' && !d.disclaimerAck) {
      wx.showToast({ title: '请先阅读并勾选健康声明', icon: 'none' });
      return;
    }
    const heightCm = Number(d.heightCm), weightKg = Number(d.weightKg), age = d.age ? Number(d.age) : null;
    if (!heightCm || heightCm < 100 || heightCm > 250) { wx.showToast({ title: '请填写正确的身高', icon: 'none' }); return; }
    if (!weightKg || weightKg < 30 || weightKg > 300) { wx.showToast({ title: '请填写正确的体重', icon: 'none' }); return; }

    this.setData({ submitting: true });
    wx.showLoading({ title: '建档中...', mask: true });
    const okLogin = await api.ensureLogin();
    if (!okLogin) {
      wx.hideLoading();
      this.setData({ submitting: false });
      wx.showToast({ title: '登录失败，请重试', icon: 'none' });
      return;
    }
    const r = await api.saveProfile({
      persona: d.persona,
      heightCm, weightKg, age,
      gender: d.gender,
      activityLevel: ACTIVITY_OPTIONS[d.activityIndex].value,
      disclaimerAck: d.disclaimerAck,
    });
    wx.hideLoading();
    this.setData({ submitting: false });
    if (r.ok) {
      wx.showToast({ title: '建档成功', icon: 'success' });
      setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 600);
    } else {
      wx.showToast({ title: r.error || '保存失败', icon: 'none' });
    }
  },
});
