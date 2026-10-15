// app.js —— 三餐 AI 营养师
App({
  onLaunch() {
    wx.getSystemInfo({
      success: (res) => {
        this.globalData.systemInfo = res;
        this.globalData.statusBarHeight = res.statusBarHeight || 20;
      }
    });
  },

  globalData: {
    systemInfo: null,
    statusBarHeight: 20,
    token: '',
    user: null,
    profile: null,          // 用户画像（takeout / glycemic）
    pendingMealImage: null, // { dataUri, mealType } 待分析的餐食图
  }
});
