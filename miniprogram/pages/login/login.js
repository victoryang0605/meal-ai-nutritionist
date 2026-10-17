// pages/login/login.js —— 登录/建档分流引导页
// ============================================================
// 分流规则：
//   · 本地无 token                → 新用户，引导去建档（onboarding）
//   · 本地有 token 且无 profile    → 建过档但缓存丢了，仍引导去 onboarding 补档
//   · 本地有 token 且有 profile    → 老用户，直接静默换 token 续期并进入首页
//
// 合规：必须勾选「用户协议 + 隐私保护指引」才能点登录按钮，
// 这是微信小程序隐私合规的硬要求（以微信官方最新审核规范为准）。
// ============================================================
const api = require('../../utils/api.js');

Page({
  data: {
    agreed: false,
    logging: false,
    // 老用户（有本地登录态）直接展示一键登录，不显示「去建档」按钮
    isReturning: false,
    checking: true,
  },

  onLoad() {
    this.checkLocalState();
  },

  checkLocalState() {
    // 有 token 说明之前登录过（建档成功时后端已返回 token）
    const hasToken = !!api.getToken();
    const profile = hasToken ? (api.getCachedProfile() || null) : null;
    this.setData({
      isReturning: hasToken && !!profile,
      checking: false,
    });
  },

  toggleAgree() {
    this.setData({ agreed: !this.data.agreed });
  },

  goAgreement() {
    wx.navigateTo({ url: '/pages/agreement/agreement' });
  },

  goPrivacy() {
    wx.navigateTo({ url: '/pages/privacy/privacy' });
  },

  // 新用户：去建档。onboarding 内部会完成 wxLogin + 保存画像。
  goOnboarding() {
    if (!this.data.agreed) {
      wx.showToast({ title: '请先阅读并同意协议与隐私指引', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/onboarding/onboarding' });
  },

  // 老用户：微信一键登录
  async doLogin() {
    if (this.data.logging) return;
    if (!this.data.agreed) {
      wx.showToast({ title: '请先阅读并同意协议与隐私指引', icon: 'none' });
      return;
    }
    this.setData({ logging: true });
    wx.showLoading({ title: '登录中...', mask: true });

    const ok = await api.wxLogin();
    wx.hideLoading();
    this.setData({ logging: false });

    if (!ok) return;

    // 登录成功但没有画像 → 说明是建档中断的老用户，补去建档
    const profile = await api.getProfile();
    if (!profile) {
      wx.showModal({
        title: '还差一步',
        content: '检测到你还没有建立健康档案，先花 30 秒填一下，之后就能直接记录三餐了。',
        confirmText: '去建档',
        cancelText: '稍后',
        success: (m) => {
          if (m.confirm) wx.navigateTo({ url: '/pages/onboarding/onboarding' });
          else wx.switchTab({ url: '/pages/index/index' });
        },
      });
      return;
    }

    wx.switchTab({ url: '/pages/index/index' });
  },
});