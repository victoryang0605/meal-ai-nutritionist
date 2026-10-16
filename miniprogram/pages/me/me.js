// pages/me/me.js —— 我的：画像切换 / 目标查看 / 免责声明 / 退出
const api = require('../../utils/api.js');

Page({
  data: {
    profile: null,
    isGlycemic: false,
    targetText: '',
  },

  onShow() {
    this.load();
  },

  async load() {
    const okLogin = await api.ensureLogin();
    if (!okLogin) return;
    const profile = await api.getProfile();
    if (!profile) {
      wx.redirectTo({ url: '/pages/onboarding/onboarding' });
      return;
    }
    const isGlycemic = profile.persona === 'glycemic';
    let targetText = '暂未计算';
    if (profile.dailyKcalLow && profile.dailyKcalHigh) {
      targetText = profile.dailyKcalLow + '-' + profile.dailyKcalHigh + ' kcal / 天';
    }
    this.setData({ profile, isGlycemic, targetText });
  },

  // 画像切换
  switchPersona() {
    const to = this.data.isGlycemic ? 'takeout' : 'glycemic';
    const name = to === 'glycemic' ? '控糖' : '减脂 · 外卖党';
    if (to === 'glycemic') {
      // 切换到控糖：重新弹知悉确认
      wx.showModal({
        title: '切换到控糖模式',
        content: '我已知悉：本产品只做营养信息参考，不构成医疗建议，用药问题请咨询医生或药师。',
        confirmText: '我已知悉',
        cancelText: '再想想',
        success: (m) => { if (m.confirm) this.doSwitch(to); },
      });
    } else {
      this.doSwitch(to);
    }
  },

  async doSwitch(persona) {
    wx.showLoading({ title: '切换中...', mask: true });
    const p = this.data.profile;
    const r = await api.saveProfile({
      persona,
      heightCm: p.heightCm, weightKg: p.weightKg, age: p.age,
      gender: p.gender, activityLevel: p.activityLevel,
      disclaimerAck: persona === 'glycemic' ? true : p.disclaimerAck,
    });
    wx.hideLoading();
    if (r.ok) {
      wx.showToast({ title: '已切换', icon: 'success' });
      this.load();
    } else {
      wx.showToast({ title: r.error || '切换失败', icon: 'none' });
    }
  },

  goDisclaimer() {
    wx.navigateTo({ url: '/pages/disclaimer/disclaimer' });
  },

  goAgreement() {
    wx.navigateTo({ url: '/pages/agreement/agreement' });
  },

  goPrivacy() {
    wx.navigateTo({ url: '/pages/privacy/privacy' });
  },

  goWeight() {
    wx.navigateTo({ url: '/pages/weight/weight' });
  },

  logout() {
    wx.showModal({
      title: '退出登录',
      content: '退出后需要重新登录才能使用',
      success: (m) => {
        if (m.confirm) {
          api.logout();
          wx.reLaunch({ url: '/pages/index/index' });
        }
      }
    });
  },
});
