// utils/image.js —— 选图 → 压缩 → dataURI
// 改编自 vibeshot 的 image-compress.js，保留关键教训：
//   wx.compressImage 在某些基础库版本下可能既不回调 success 也不回调 fail，
//   必须加超时兜底，否则 await 卡死、界面无响应。

function getFileSize(filePath) {
  return new Promise((resolve) => {
    try {
      wx.getFileSystemManager().stat({
        filePath,
        success: (res) => resolve((res.stats && res.stats.size) || 0),
        fail: () => resolve(0),
      });
    } catch (_) { resolve(0); }
  });
}

// 单次压缩（只传 quality，最稳妥）+ 8 秒超时兜底
function compressOnce(filePath, quality) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    if (typeof wx.compressImage !== 'function') { done(null); return; }
    const timer = setTimeout(() => done(null), 8000);
    try {
      wx.compressImage({
        src: filePath,
        quality,
        success: async (res) => {
          clearTimeout(timer);
          const size = await getFileSize(res.tempFilePath);
          done(size ? { path: res.tempFilePath, size } : null);
        },
        fail: () => { clearTimeout(timer); done(null); },
      });
    } catch (_) { clearTimeout(timer); done(null); }
  });
}

// 压缩到目标体积以下（默认 400KB，base64 后约 533KB，服务端 25mb 上限内很宽松）
async function compressToSize(filePath, targetBytes) {
  targetBytes = targetBytes || 400 * 1024;
  let current = filePath;
  const qualities = [80, 65, 50, 35];
  for (const q of qualities) {
    const size = await getFileSize(current);
    if (size > 0 && size <= targetBytes) break;
    const r = await compressOnce(current, q);
    if (r && r.path) current = r.path;
    else break;
  }
  return current;
}

function toDataUri(filePath) {
  return new Promise((resolve, reject) => {
    const ext = (filePath.split('.').pop() || '').toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    wx.getFileSystemManager().readFile({
      filePath,
      encoding: 'base64',
      success: (res) => resolve('data:' + mime + ';base64,' + res.data),
      fail: (e) => reject(e),
    });
  });
}

// 选图（拍照/相册）→ 压缩 → dataURI，一步到位
// sourceType: 'camera' | 'album'，不传则让用户选
async function pickAndPrepareImage(sourceType) {
  const chosen = await new Promise((resolve) => {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: sourceType ? [sourceType] : ['album', 'camera'],
      sizeType: ['compressed'],
      success: (res) => {
        const f = res.tempFiles && res.tempFiles[0];
        resolve(f ? f.tempFilePath : null);
      },
      fail: () => resolve(null),
    });
  });
  if (!chosen) return null;
  const compressed = await compressToSize(chosen);
  const dataUri = await toDataUri(compressed);
  return { dataUri, tempPath: compressed };
}

module.exports = {
  pickAndPrepareImage,
  compressToSize,
  toDataUri,
};
