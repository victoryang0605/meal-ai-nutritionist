// pages/onboarding/onboarding.js —— 首次进入：选画像 + 建档 + 昵称头像 + 协议
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
    // 步骤3
    nickName: '',
    avatarUrl: '',
    agreementAck: false,
    submitting: false,
  },

  selectPersona(e) {
    this.setData({ persona: e.currentTarget.dataset.persona, step: 2 });
  },

  backStep() {
    this.setData({ step: 1 });
  },

  backStep2() {
    this.setData({ step: 2 });
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

  // 步骤2 → 步骤3：校验身体数据
  nextStep() {
    const d = this.data;
    if (d.persona === 'glycemic' && !d.disclaimerAck) {
      wx.showToast({ title: '请先阅读并勾选健康声明', icon: 'none' });
      return;
    }
    const heightCm = Number(d.heightCm), weightKg = Number(d.weightKg);
    if (!heightCm || heightCm < 100 || heightCm > 250) { wx.showToast({ title: '请填写正确的身高', icon: 'none' }); return; }
    if (!weightKg || weightKg < 30 || weightKg > 300) { wx.showToast({ title: '请填写正确的体重', icon: 'none' }); return; }
    this.setData({ step: 3 });
  },

  onNickname(e) {
    this.setData({ nickName: e.detail.value || '' });
  },

  onChooseAvatar(e) {
    if (e.detail && e.detail.avatarUrl) {
      this.setData({ avatarUrl: e.detail.avatarUrl });
    }
  },

  toggleAgreement() {
    this.setData({ agreementAck: !this.data.agreementAck });
  },

  goAgreement() {
    wx.navigateTo({ url: '/pages/agreement/agreement' });
  },

  goPrivacy() {
    wx.navigateTo({ url: '/pages/privacy/privacy' });
  },

  async submit() {
    const d = this.data;
    if (!d.persona) { wx.showToast({ title: '请先选择画像', icon: 'none' }); return; }
    if (!d.agreementAck) {
      wx.showToast({ title: '请先阅读并同意服务协议与隐私指引', icon: 'none' });
      return;
    }
    const heightCm = Number(d.heightCm), weightKg = Number(d.weightKg), age = d.age ? Number(d.age) : null;

    this.setData({ submitting: true });
    wx.showLoading({ title: '建档中...', mask: true });
    // 建档登录：把昵称头像一起传给后端
    const okLogin = await api.wxLogin(d.nickName.trim(), d.avatarUrl);
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
