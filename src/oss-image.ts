// oss-image.ts — 图片上传至阿里云 OSS 并生成临时访问 URL
// ============================================================
// 背景（2026-10-13 排查结论）：
//   部分 AI 识别服务要求图片以**公网可访问 URL** 传入，且对下载有时限要求
//   （如官方明确「建议使用阿里云 OSS 存储文件」）。
//   非上海地域 OSS / 自建域名链接可能被拒（InvalidImage.URL）。
//
//   故正式方案：**图片先上传至上海地域 OSS，用 OSS 标准域名链接识别**。
//
// 【隐私设计】
//   用户上传的是**餐食照片**，可能含隐私信息，故：
//     1. Bucket 建议设为「私有」，代码用 **5 分钟有效的签名 URL** 供识别服务下载，
//        避免图片长期公开可访问（既防隐私泄露，也避免被爬取）。
//     2. 分析完成后**及时删除** OSS 上的对象，不留存量。
//     3. 对象路径用随机 token，不含用户信息与原始文件名。
//
// 【降级策略】
//   未配置 OSS 时 isEnabled() 返回 false，调用方应回退到原图床 URL
//   （虽可能下载失败，但不至于让功能整体崩溃）。
// ============================================================

import crypto from 'crypto';
// ⚠️ 静态 import：ESM 产物中动态 require 会抛
//    「Dynamic require of xxx is not supported」（本项目已踩四次，详见档案 8.8）
import nodeHttp from 'http';
import nodeHttps from 'https';
import OSS from 'ali-oss';

// ============================================================
// 配置
// ============================================================

/** Bucket 名 */
const BUCKET = () => (process.env.OSS_BUCKET || '').trim();

/**
 * 地域（阿里云 OSS 的 region 格式为 `oss-<regionId>`）。
 *
 * ⚠️⚠️ 必须是**华东2（上海）**。部分阿里云识别服务只接受上海地域 OSS：
 *   报错原文「对于上海 oss 链接请使用标准的 oss 域名，目前暂不支持绑定 CDN」
 *   「非上海 OSS 图片链接请参见文件 URL 处理」
 *   用其他地域会被拒（InvalidImage.URL）。
 *
 * ⚠️ 此处**允许只填 `cn-shanghai`**（与控制台显示一致，更符合直觉），
 *   内部会自动补 `oss-` 前缀 —— ali-oss 需要完整格式 `oss-cn-shanghai`，
 *   填错会报「getaddrinfo ENOTFOUND <bucket>.cn-shanghai.aliyuncs.com」。
 */
const OSS_REGION_RAW = () => (process.env.OSS_REGION || 'cn-shanghai').trim();

/** 归一化为 ali-oss 需要的 `oss-cn-shanghai` 格式 */
function normalizeRegion(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (!v) return 'oss-cn-shanghai';
  // 已是完整格式则原样返回
  if (v.startsWith('oss-')) return v;
  // 兼容 oss-cn-shanghai / cn-shanghai / cn-shanghai-internal-contrast
  return `oss-${v.replace(/^oss-/, '')}`;
}

/** 用于展示与签名的地域（不含 oss- 前缀） */
const REGION = () => OSS_REGION_RAW().replace(/^oss-/, '');

/** AccessKey（阿里云 OSS 读写） */
const AK_ID = () =>
  (process.env.OSS_ACCESS_KEY_ID || '').trim();
const AK_SECRET = () =>
  (process.env.OSS_ACCESS_KEY_SECRET || '').trim();

/**
 * 访问模式：
 *   'private'  私有 Bucket + 签名 URL（默认，隐私更好）
 *   'public'   公共读 Bucket + 直链
 *
 * ⚠️ 选public 的前提：把 Bucket ACL 设为「公共读」。
 *   此时用不带签名的标准 OSS 域名直链，**可省掉签名环节的所有不确定性**
 *   （STS token 过期、签名算法差异、URL 二次编码等）。
 *   官方文档的请求示例用的也是这种直链。
 *
 * ⚠️ 隐私权衡：
 *   · 对象名是 32 位随机 token，不可枚举
 *   · 识别完成后立即（或延迟）删除对象
 *   · 故「公共读 + 短生命周期 + 随机名」的实际泄露风险可控，
 *     但严格而言不如私有 Bucket。
 *   若在意隐私，保持 private 即可。
 */
const ACL_MODE = () => (process.env.OSS_ACL_MODE || 'private').toLowerCase();

/** 签名 URL 有效期（秒）—— 仅 private 模式使用 */
const SIGN_TTL_SEC = () => Number(process.env.OSS_SIGN_TTL_SEC || 300);

/**
 * OSS 自定义域名（可选但**强烈建议配置**）。
 *
 * ⚠️⚠️ 为什么需要（2026-10-14 实测确认）：
 *   使用 OSS **默认域名**访问文件时，OSS 强制返回
 *     Content-Disposition: attachment
 *   即「强制下载」而非「内联预览」。阿里云识别服务下载到该响应时，
 *   无法按图片解析，遂判定「任务无效」
 *     （InvalidParameter - tasks must not be empty or null）。
 *
 *   实测证据（上传后自检日志）：
 *     [OSS] ✅ URL 可下载（HTTP 200，170616 字节，
 *            Content-Type=image/jpeg，Content-Disposition=attachment）
 *   已尝试设置 Content-Disposition: inline **无效**——
 *   OSS 默认域名的行为由服务端控制，不接受对象元数据覆盖。
 *
 *   OSS 官方提示亦印证：
 *     「访问使用 OSS 默认域名生成的文件 URL 会触发浏览器默认强制下载。
 *       如需在浏览器中通过文件 URL 在线预览文件，
 *       请为 OSS 默认域名绑定自定义域名，然后使用自定义域名访问文件。」
 *
 * 【配置步骤】
 *   1. 准备已备案的域名，如 img.example.com
 *   2. OSS 控制台 → Bucket vibeshots → 数据传输 → 自定义域名
 *      → 绑定 img.example.com
 *   3. 在域名服务商加 CNAME 记录：
 *      img.example.com  →  vibeshots.oss-cn-shanghai.aliyuncs.com
 *   4. 配好后填入环境变量 OSS_CUSTOM_DOMAIN
 *
 * ⚠️ 隐私提示：自定义域名通常配合 CDN 加速，**Bucket 需为公共读**
 *    才能被外部访问。本项目已用「随机 token 文件名 + 5 分钟自动删除」
 *    控制风险（见 uploadForDetection 的清理逻辑）。
 */
const CUSTOM_DOMAIN = () => (process.env.OSS_CUSTOM_DOMAIN || '').trim();

/** 构造可被外部下载的图片 URL */
function buildImageUrl(objectKey: string): string {
  const custom = CUSTOM_DOMAIN();
  if (custom) {
    // 自定义域名（协议由用户在环境变量中一并指定，如 https://img.example.com）
    return `${custom.replace(/\/+$/, '')}/${objectKey}`;
  }
  // 回退到 OSS 默认域名（会返回 attachment，可能导致识别失败）
  return `https://${BUCKET()}.${normalizeRegion(OSS_REGION_RAW())}.aliyuncs.com/${objectKey}`;
}

/**
 * 走 OSS 还是走**本服务自建图床**？
 *
 * ⚠️⚠️ 关键依据（2026-10-14 实测）：
 *   · OSS 默认域名 → `Content-Disposition: attachment`（强制下载），
 *     阿里云识别服务无法按图片解析 → tasks must not be empty or null
 *   · 本服务自建图床（/api/tmp-img/<token>）→
 *     `Content-Type: image/jpeg` + `Cache-Control: no-store`，
 *     **没有 attachment 头**，响应头完全由我们控制 ✅
 *
 *   故默认改走自建图床（`self`），不再依赖 OSS 默认域名。
 *   需先启动本服务的对外访问地址（如 https://api.aivibeshot.com.cn）。
 *
 *   设为 `oss` 则仍走 OSS（此时建议配好 OSS_CUSTOM_DOMAIN）。
 */
const USE_OSS = () => (process.env.IMAGE_HOST_MODE || 'self').toLowerCase() !== 'self';

/** 本服务对外地址（自建图床模式需要） */
const SELF_BASE_URL = () => (process.env.SELF_PUBLIC_URL || '').trim();

export function isEnabled(): boolean {
  return !!BUCKET() && !!AK_ID() && !!AK_SECRET();
}

/** 启动自检说明 */
export function describeConfig(): string {
  if (!USE_OSS()) {
    const base = SELF_BASE_URL();
    return base
      ? `自建图床（${base}，响应头完全可控，推荐）`
      : '自建图床（**未配置 SELF_PUBLIC_URL，将无法上传**）';
  }
  if (!isEnabled()) {
    return 'OSS 模式但未配置 OSS_BUCKET / AccessKey，将回退自建图床';
  }
  return (
    `OSS（Bucket=${BUCKET()}，Region=${REGION()}，` +
    `域名=${CUSTOM_DOMAIN() || '默认域名(会强制下载，建议配OSS_CUSTOM_DOMAIN)'}，` +
    `模式=${ACL_MODE() === 'public' ? '公共读' : `私有+签名URL(${SIGN_TTL_SEC()}s)`}）`
  );
}

// ============================================================
// Client
// ============================================================

let client: any = null;
function getClient(): any {
  if (!client) {
    const O = (OSS as any);
    const Ctor = typeof O === 'function' ? O : O?.default;
    if (typeof Ctor !== 'function') {
      throw new Error('ali-oss 模块加载异常（ESM/CJS 互操作失败）');
    }
    client = new Ctor({
      region: normalizeRegion(OSS_REGION_RAW()), // ali-oss 需oss-cn-shanghai 完整格式
      accessKeyId: AK_ID(),
      accessKeySecret: AK_SECRET(),
      bucket: BUCKET(),
      // 云托管容器出站走内网网关，证书链不被 Node 认可
      // （DEPTH_ZERO_SELF_SIGNED_CERT），与 virtual-pay/aliyun 两处同一问题。
      secure: false,
      timeout: '30s',
    });
  }
  return client;
}

// ============================================================
// 上传
// ============================================================

export interface OssUploadResult {
  ok: boolean;
  /** 供识别服务使用的签名 URL（私有 Bucket 必需） */
  signedUrl?: string;
  /** 对象 key（用于后续删除） */
  objectKey?: string;
  error?: string;
  hint?: string;
}

/**
 * 上传图片到 OSS，返回**带签名的临时 URL**。
 *
 * @param base64 图片 Base64（纯 base64，不含 data URI 前缀）
 * @param mime   MIME类型，默认image/jpeg
 * @param ext    文件扩展名，默认 jpg
 */
export async function uploadImage(
  base64: string,
  mime = 'image/jpeg',
  ext = 'jpg'
): Promise<OssUploadResult> {
  // 去掉可能的 data URI 前缀
  let b64 = String(base64 || '');
  if (b64.startsWith('data:')) {
    const i = b64.indexOf(',');
    if (i >= 0) b64 = b64.slice(i + 1);
  }
  if (!b64) return { ok: false, error: '图片内容为空' };
  const buffer = Buffer.from(b64, 'base64');

  // ── 模式一：自建图床（默认）────────────────────────────────
  // 响应头完全由本服务控制，无 attachment，识别服务可正常按图片解析。
  if (!USE_OSS()) {
    const self = SELF_BASE_URL();
    if (!self) {
      return {
        ok: false,
        error: '未配置 SELF_PUBLIC_URL',
        hint: '自建图床模式需告知本服务对外地址，如 SELF_PUBLIC_URL=https://your-api-domain.com',
      };
    }
    const token = crypto.randomBytes(16).toString('hex');
    const objectKey = `tmp-img/${token}`;
    // 复用 temp-image-store 的落盘与读取逻辑
    const { saveTempImage, buildTempImageUrl, deleteTempImage } =
      await import('./temp-image-store.js');
    const savedToken = saveTempImage(b64, mime);
    if (!savedToken) return { ok: false, error: '临时图床落盘失败' };

    const url = buildTempImageUrl(self.replace(/\/+$/, ''), savedToken);
    const dl = await verifyDownloadable(url);
    if (dl.ok) {
      console.log(
        `[图片托管] ✅ 自建图床可下载（HTTP ${dl.status}，${dl.bytes} 字节）`
      );
    } else {
      console.warn(
        `[图片托管] ⚠️ 自建图床下载异常：status=${dl.status || '-'} ${dl.error || ''} ${dl.hint || ''}`
      );
    }
    return { ok: true, signedUrl: url, objectKey: `self:${savedToken}` };
  }

  // ── 模式二：OSS ────────────────────────────────────────────
  if (!isEnabled()) {
    return { ok: false, error: '未配置 OSS', hint: '设置 OSS_BUCKET 与 AccessKey 后生效' };
  }
  // 随机 token，避免可枚举与信息泄露
  const token = crypto.randomBytes(16).toString('hex');
  const objectKey = `uploads/${token}.${ext}`;

  try {
    const c = getClient();
    await c.put(objectKey, buffer, {
      headers: {
        'Content-Type': mime,
        // ⚠️⚠️ 必须显式声明 inline，否则 OSS 默认返回
        //   Content-Disposition: attachment（**强制下载**而非预览）。
        //   阿里云识别服务下载到 attachment 响应时，可能把它当文件而非图片
        //   解析，进而判定「任务无效」（tasks must not be empty or null）。
        //
        //   OSS 官方提示亦印证这一点：
        //     「访问使用 OSS 默认域名生成的文件 URL 会触发浏览器默认强制下载。
        //       如需在线预览文件，请为 OSS 默认域名绑定自定义域名。」
        //   即默认域名的行为就是下载；加 inline 头可让识别服务正确按图片处理。
        'Content-Disposition': 'inline',
        'Cache-Control': 'no-store',
      },
    });

    const isPublic = ACL_MODE() === 'public';

    // public 模式用直链（自定义域名优先）；private 模式用带签名的临时 URL
    const effectiveUrl = isPublic
      ? buildImageUrl(objectKey)
      : String(c.signatureUrl(objectKey, { expires: SIGN_TTL_SEC(), method: 'GET' }));

    console.log(
      `[OSS] 已上传：${objectKey}（${(buffer.length / 1024).toFixed(0)}KB，` +
      `模式=${isPublic ? (CUSTOM_DOMAIN() ? '自定义域名直链' : 'OSS默认域名直链(可能强制下载)') : `私有+签名URL(${SIGN_TTL_SEC()}s)`}）`
    );

    // 立即自测下载：确认阿里云真的能拉到这张图
    // （「上传成功」≠「可下载」，后者才是识别成败的关键）
    const dl = await verifyDownloadable(effectiveUrl);
    if (dl.ok) {
      console.log(`[OSS] ✅ URL 可下载（HTTP ${dl.status}，${dl.bytes} 字节）`);
    } else {
      let hint = dl.hint || '';
      if (!isPublic && dl.status === 403) {
        hint =
          '当前为 private 模式但下载 403。若已将 Bucket 设为公共读，' +
          '请设环境变量 OSS_ACL_MODE=public 改用直链（更稳定，也省去签名环节）。';
      }
      console.warn(
        `[OSS] ⚠️ 上传成功但 URL 无法下载：status=${dl.status || '-'} ` +
        `${dl.error || ''} ${hint} —— 识别大概率会失败`
      );
    }

    return { ok: true, signedUrl: effectiveUrl, objectKey };
  } catch (e: any) {
    const code = e?.code || e?.statusCode || e?.name || 'Unknown';
    const msg = String(e?.message || '');
    let hint = '';

    if (code === 404 || /NoSuchBucket/i.test(msg)) {
      hint =
        `Bucket「${BUCKET()}」不存在或区域不对。` +
        '⚠️ 必须为**华东2（上海）**地域，其他地域阿里云识别接口会拒绝。';
    } else if (code === 403 || /AccessDenied|InvalidAccessKey/i.test(msg)) {
      hint = 'OSS 权限不足：请确认 AccessKey 所属账号对 OSS 有读写权限。';
    } else if (code === 400 && /InvalidRegion/i.test(msg)) {
      hint = `区域无效：当前配置 ${REGION()}，请改为 cn-shanghai（华东2 上海）。`;
    }

    console.error(`[OSS] 上传失败 code=${code} ${msg.slice(0, 120)}${hint ? ' | ' + hint : ''}`);
    return { ok: false, error: `${code} ${msg}`.slice(0, 200), hint };
  }
}

/** 删除对象（分析完成后调用，不长期留存用户图片） */
export async function removeObject(objectKey: string): Promise<void> {
  if (!objectKey) return;

  // 自建图床模式
  if (objectKey.startsWith('self:')) {
    try {
      const { deleteTempImage } = await import('./temp-image-store.js');
      deleteTempImage(objectKey.slice(5));
      console.log(`[图片托管] 已清理临时图：${objectKey.slice(5, 12)}…`);
    } catch {
      /* 忽略 */
    }
    return;
  }

  // OSS 模式
  if (!isEnabled()) return;
  try {
    await getClient().delete(objectKey);
    console.log(`[OSS] 已清理：${objectKey}`);
  } catch {
    // 清理失败不影响主流程；OSS 生命周期规则也会兜底清理
  }
}

/** 仅诊断用：测试能否连通并访问 Bucket */
export async function probe(): Promise<{
  ok: boolean;
  bucket?: string;
  region?: string;
  error?: string;
  hint?: string;
}> {
  if (!isEnabled()) return { ok: false, error: '未配置 OSS' };
  try {
    const c = getClient();
    // list 一个不存在的对象不会报错，但能验证鉴权与网络
    await c.list({ 'max-keys': 1 }, {});
    return { ok: true, bucket: BUCKET(), region: REGION() };
  } catch (e: any) {
    const code = e?.code || e?.statusCode || e?.name || 'Unknown';
    const msg = String(e?.message || '');
    let hint = '';
    if (code === 404 || /NoSuchBucket/i.test(msg)) {
      hint = `Bucket「${BUCKET()}」不存在。⚠️ 请确认已创建，且区域为**华东2（上海）**。`;
    } else if (code === 403 || /AccessDenied/i.test(msg)) {
      hint = '权限不足：AccessKey 所属账号需对 OSS 有读写权限。';
    }
    return { ok: false, bucket: BUCKET(), region: REGION(), error: `${code} ${msg}`.slice(0, 200), hint };
  }
}

/**
 * 诊断：验证签名 URL 是否真能被下载。
 *
 * ⚠️「上传成功」≠「阿里云能下载」——这是两个不同环节：
 *   · put() 成功        → 文件确实在 OSS 上
 *   · 阿里云拿 URL 去 GET → 可能因签名/权限/有效期/网络失败
 *   后者失败时，识别接口报「tasks must not be empty or null」。
 *
 * 本函数在上传后立刻自测一次下载，把结论显式化，避免再靠猜。
 */
export async function verifyDownloadable(
  signedUrl: string
): Promise<{ ok: boolean; status?: number; bytes?: number; error?: string; hint?: string }> {
  try {
    // ⚠️ 静态 import，避免 ESM 产物中动态 require 崩溃
    const lib = signedUrl.startsWith('https') ? nodeHttps : nodeHttp;
    return await new Promise((resolve) => {
      const req = (lib as any).request(signedUrl, { method: 'GET', timeout: 10000 }, (res: any) => {
        let n = 0;
        res.on('data', (c: any) => (n += c.length));
        res.on('end', () => {
          const disposition = String(res.headers?.['content-disposition'] || '(未返回)');
          const contentType = String(res.headers?.['content-type'] || '(未返回)');
          if (res.statusCode === 200 && n > 0) {
            // ⚠️ 打印真实响应头，便于判断「强制下载」是否真成为问题。
            //   阿里云 OSS 默认域名可能返回 Content-Disposition: attachment
            //   （强制下载）；若识别服务因此无法按图片解析，
            //   需绑定自定义域名 + CDN 才能彻底解决（OSS 官方建议）。
            console.log(
              `[OSS] ✅ URL 可下载（HTTP ${res.statusCode}，${n} 字节，` +
              `Content-Type=${contentType}，Content-Disposition=${disposition}）`
            );
            resolve({
              ok: true,
              status: res.statusCode,
              bytes: n,
              hint: /attachment/i.test(disposition)
                ? '返回 attachment（强制下载）。OSS 默认域名的行为无法用元数据覆盖，' +
                  '需绑定自定义域名（环境变量 OSS_CUSTOM_DOMAIN）后重试。'
                : undefined,
            });
          } else {
            let hint = '';
            if (res.statusCode === 403) {
              hint =
                '403：签名无效或已过期。请确认有效期足够（建议 ≥5 分钟），' +
                '且 AccessKey 对该 Bucket 有读权限。';
            } else if (res.statusCode === 404) {
              hint = '404：对象不存在。可能上传后被清理，或 objectKey 与实际不符。';
            }
            resolve({ ok: false, status: res.statusCode, bytes: n, hint });
          }
        });
      });
      req.on('error', (e: any) => {
        let hint = '';
        if (e.code === 'ENOTFOUND') {
          hint = `DNS 解析失败：检查 Bucket 名与地域（应为 oss-cn-shanghai）。当前 region=${OSS_REGION_RAW()}`;
        } else if (e.code === 'ETIMEDOUT' || e.code === 'ESOCKETTIMEDOUT') {
          hint = '连接超时：官方要求图片 3 秒内可下载，请检查网络与 Bucket 区域。';
        }
        resolve({ ok: false, error: `${e.code || ''} ${e.message || ''}`.slice(0, 120), hint });
      });
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, error: 'TIMEOUT', hint: '下载超时（官方限制 3 秒）' });
      });
      req.end();
    });
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}
