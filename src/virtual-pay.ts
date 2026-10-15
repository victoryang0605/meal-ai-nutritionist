// virtual-pay.ts — 微信小程序虚拟支付（米大师）
// ============================================================
// 官方文档（实现须以最新文档为准）：
//   能力说明：https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment.html
//   客户端API：https://developers.weixin.qq.com/miniprogram/dev/api/payment/wx.requestVirtualPayment.html
//   运营指南：  https://developers.weixin.qq.com/community/minihome/doc/00002cf077cd4810fee42f4b865c01
//
// 为什么必须用它：
//   自 2026-04-01 起，小程序内销售虚拟商品（含 AI 生成次数/额度、会员、
//   解锁功能等）必须全终端接入虚拟支付，不得再使用普通微信支付
//   （wx.requestPayment），也不得引导至公众号/H5/外部网站完成支付。
//   本项目的 4 档次数包属于官方《虚拟支付业务运营指南》「场景二 AI 服务付费」。
//
// ⚠️ 与普通微信支付的差异（易踩坑，勿混用）：
//   | 项 | 普通微信支付 | 虚拟支付 |
//   |---|---|---|
//   | 客户端 API | wx.requestPayment | wx.requestVirtualPayment |
//   | 签名算法 | SHA256-RSA2048 | HMAC-SHA256（两套） |
//   | 签名密钥 | 商户 API 私钥 | AppKey + session_key |
//   | 商户号 | 需要（企业/个体户） | 虚拟支付商户号（offerId）|
//   | 发货依据 | 支付回调 | **消息推送**（success 回调不可靠）|
//
// ⚠️ 支付成功回调（success）可能丢失，不能作为发货依据！
//    必须在服务端实现【发货推送】或【主动轮询订单】至少一种。
//    本模块提供 orderStatus 查询接口 + notifyGoods 接口作为兜底。

import crypto from 'crypto';
import https from 'https';

// ============================================================
// 配置
// ============================================================

// ============================================================
// 配置读取
// ------------------------------------------------------------
// ⚠️ 必须用 getter 惰性读取，不能在模块顶层用 const 固化。
//
// 原因：ESM 的 import 是静态提升的 —— 本模块的顶层代码会在
// server.ts 的 `dotenv.config()` **之前**执行。若顶层 const 固化
// process.env.VX_PUSH_TOKEN，则 .env 中的值永远读不到（表现为
// "未配置 VX_PUSH_TOKEN"，且日志反复报 fail-closed）。
//
// 云托管面板注入的环境变量在容器启动时已存在，不受此影响；
// 但本地 .env 开发与部分部署场景会踩坑，故统一改为惰性读取。
// ============================================================

/** OfferID（支付账号）—— MP 后台「虚拟支付 → 基本配置」获取 */
const OFFER_ID = () => (process.env.VX_OFFER_ID || '').trim();
/** 现网 AppKey（支付签名用）—— MP 后台「虚拟支付 → 基本配置」获取 */
const APP_KEY = () => (process.env.VX_APP_KEY || '').trim();
/** 沙箱 AppKey（env=1 时使用）—— 可选，测试期需要 */
const SANDBOX_APP_KEY = () => (process.env.VX_SANDBOX_APP_KEY || '').trim();

/**
 * 消息推送 Token —— MP 后台「虚拟支付 → 发货推送配置」中自行填写的值。
 * 微信用它计算推送的 signature，服务端须用同值校验消息来源。
 * ⚠️ 缺失时**拒绝校验**（fail-closed）：否则任何人 POST 该接口即可伪造发货请求刷次数。
 */
const PUSH_TOKEN = () => (process.env.VX_PUSH_TOKEN || '').trim();

const API_BASE = 'https://api.weixin.qq.com';

/**
 * 允许跳过 TLS 证书验证的**白名单域名**。
 *
 * ⚠️ 背景：云托管容器访问 api.weixin.qq.com 走内网网关，其证书链不被 Node 认可，
 *   报 DEPTH_ZERO_SELF_SIGNED_CERT / self-signed certificate。
 *   server.ts 的 wxRequestJson 早已用 rejectUnauthorized:false 处理过同类问题，
 *   但虚拟支付这条链路漏了，导致查单、通知发货全部失败。
 *
 * ⚠️ 这里必须做**域名白名单**而非一刀关掉校验，
 *   否则一旦url 参数可被影响就会变成任意主机绕过证书验证的漏洞。
 */
const ALLOWED_SKIP_TLS_HOSTS = ['api.weixin.qq.com'];

export const VirtualPayEnv = {
  /** 0 = 正式环境，1 = 沙箱环境 */
  PROD: 0,
  SANDBOX: 1,
} as const;

export function isVirtualPayConfigured(): boolean {
  return !!(OFFER_ID() && APP_KEY());
}

/**
 * 取对应环境的 AppKey。
 * ⚠️ errCode -15011：现网版本的 env 只能是 0，不能填 1。
 */
function appKeyForEnv(env: number): string {
  if (env === VirtualPayEnv.SANDBOX && SANDBOX_APP_KEY()) return SANDBOX_APP_KEY();
  return APP_KEY();
}

// ============================================================
// 签名（官方《签名详解》）
// ------------------------------------------------------------
// 支付签名：paySig = to_hex(hmac_sha256(appKey, uri + '&' + signData))
// 用户态签名：signature = to_hex(hmac_sha256(session_key, signData))
// 注意：两者都是 HMAC-SHA256 十六进制小写，签的都是 signData 字符串本身。
// uri 固定填字符串 "requestVirtualPayment"。
// ============================================================

const PAY_URI = 'requestVirtualPayment';

/** 计算支付签名 paySig */
export function calcPaySig(signData: string, env: number = VirtualPayEnv.PROD): string {
  const key = appKeyForEnv(env);
  if (!key) throw new Error('虚拟支付未配置 VX_APP_KEY');
  return crypto.createHmac('sha256', key).update(`${PAY_URI}&${signData}`).digest('hex');
}

/** 计算用户态签名 signature（需服务端持有 session_key） */
export function calcUserSig(signData: string, sessionKey: string): string {
  if (!sessionKey) throw new Error('缺少 session_key，无法计算用户态签名');
  return crypto.createHmac('sha256', sessionKey).update(signData).digest('hex');
}

// ============================================================
// 消息推送校验（防止伪造发货请求）
// ------------------------------------------------------------
// 官方校验流程：
//   1. 将 token、timestamp、nonce 三个参数按字典序排序
//   2. 拼接成一个字符串
//   3. SHA1 加密得十六进制小写
//   4. 与请求中的 signature 比对，匹配则原样返回 echostr
//
// ⚠️ 这是**发货接口的唯一防线**。若不校验，任何人只要知道 URL 即可伪造
//    xpay_goods_deliver_notify 推送，白嫖付费次数。
// ============================================================

export interface PushQueryParams {
  signature?: string;      // 明文模式签名（首次接入验证）
  msg_signature?: string;  // 安全模式签名（消息体签名）
  timestamp?: string;
  nonce?: string;
  echostr?: string;
  encrypt?: string;        // 安全模式的密文（可能放在query，也可能只在 body）
}

/**
 * 校验微信推送请求的签名（同时支持明文与安全模式两套体系）。
 *
 * ⚠️ 微信有**两套独立签名**，切勿混用（混用是本项目踩过的坑）：
 *   | 场景 | 参数 | 参与签名的值 |
 *   |---|---|---|
 *   | 首次接入验证 | `signature` | token + timestamp + nonce |
 *   | 后续消息推送 | `msg_signature` | token + timestamp + nonce + **encrypt** |
 *
 *   安全模式下 encrypt（密文）**必须参与签名**，且用**原始密文**而非解密后的明文。
 *   铁律：**先验签，后解密**。
 *
 * @returns 校验通过且为验证请求（带 echostr）时返回 `{ ok: true, echostr }`
 */
export function verifyPushSignature(
  params: PushQueryParams,
  token: string = PUSH_TOKEN()
): { ok: boolean; echostr?: string } {
  // ⚠️ fail-closed：未配置 Token 一律拒绝，避免误以为已开启防护
  if (!token) {
    console.error('[虚拟支付] 未配置 VX_PUSH_TOKEN，拒绝校验（fail-closed）');
    return { ok: false };
  }

  const { signature, msg_signature, timestamp, nonce, echostr, encrypt } = params;
  if (!timestamp || !nonce) return { ok: false };

  // ① 安全模式：msg_signature = SHA1(sort(token, timestamp, nonce, encrypt))
  if (msg_signature) {
    if (!encrypt) {
      console.warn('[虚拟支付] 有 msg_signature 但缺少 encrypt，无法验签');
      return { ok: false };
    }
    const arrSecure = [token, String(timestamp), String(nonce), encrypt].sort();
    const expSecure = crypto
      .createHash('sha1')
      .update(arrSecure.join(''), 'utf8')
      .digest('hex');
    if (expSecure !== msg_signature) {
      console.warn('[虚拟支付] 安全模式签名校验失败（疑似伪造请求）');
      return { ok: false };
    }
    return { ok: true, echostr: echostr || '' };
  }

  // ② 明文模式：signature = SHA1(sort(token, timestamp, nonce))
  if (signature) {
    const arrPlain = [token, String(timestamp), String(nonce)].sort();
    const expPlain = crypto
      .createHash('sha1')
      .update(arrPlain.join(''), 'utf8')
      .digest('hex');
    if (expPlain !== signature) {
      console.warn('[虚拟支付] 明文模式签名校验失败（疑似伪造请求）');
      return { ok: false };
    }
    return { ok: true, echostr: echostr || '' };
  }

  return { ok: false };
}

/** 是否已配置推送 Token（用于启动自检） */
export function isPushTokenConfigured(): boolean {
  return !!PUSH_TOKEN();
}

// ============================================================
// 解密自测（诊断用）
// ------------------------------------------------------------
// 用途：`bad decrypt` 原因不止「key 不对」，还可能是 padding 方式、
// IV 取法等实现细节差异。传统排查方式是把密文捞出来反复本地试，
// 但那需要把密钥搬出环境。
//
// 本函数在**服务端内部**用当前配置的 key 试解多种方案，只返回「哪种可行」
// 与解出消息的预览，**绝不返回密钥**。由 /api/virtual-pay/decrypt-probe 调用。
// ============================================================

export interface DecryptProbeResult {
  /** 是否任一方案解出成功 */
  ok: boolean;
  /** 成功的方案名 */
  workingMethod?: string;
  /** 各方案尝试结果 */
  attempts: { method: string; ok: boolean; error?: string; note?: string }[];
  /** 解出的消息预览（成功时，最多 300 字符） */
  preview?: string;
  /** 解出的 appid（成功时，用于校验是否是自己小程序） */
  appId?: string;
}

export function probeDecrypt(encrypt: string): DecryptProbeResult {
  const keyRaw = ENCODING_AES_KEY();
  const attempts: DecryptProbeResult['attempts'] = [];

  if (!keyRaw) return { ok: false, attempts: [{ method: '-', ok: false, error: '未配置 AESKey' }] };
  if (!encrypt) return { ok: false, attempts: [{ method: '-', ok: false, error: '缺少密文' }] };

  const aesKey = Buffer.from(keyRaw + '=', 'base64');
  if (aesKey.length !== 32) {
    return { ok: false, attempts: [{ method: '-', ok: false, error: `key 长度异常 ${aesKey.length}` }] };
  }

  const ct = Buffer.from(encrypt, 'base64');

  /** 解析明文结构：random(16) + msg_len(4, 网络字节序) + msg + appid */
  const parse = (plain: Buffer) => {
    if (plain.length < 20) return null;
    const msgLen = plain.readUInt32BE(16);
    if (msgLen <= 0 || 20 + msgLen > plain.length) return null;
    return {
      msg: plain.subarray(20, 20 + msgLen).toString('utf8'),
      appId: plain.subarray(20 + msgLen).toString('utf8'),
    };
  };

  // 方案1：IV = key 前 16 字节 + 默认 PKCS#7（当前实现，官方 Java 示例等价）
  const tryMethod = (
    name: string,
    iv: Buffer,
    autoPadding: boolean,
    note?: string
  ) => {
    try {
      const d = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
      d.setAutoPadding(autoPadding);
      let out = Buffer.concat([d.update(ct), d.final()]);
      if (!autoPadding) {
        // 手动去 PKCS#7 填充（官方 Java 示例用 NoPadding + trimPadding）
        const pad = out[out.length - 1];
        if (pad >= 1 && pad <= 16 && pad <= out.length) out = out.subarray(0, out.length - pad);
      }
      const parsed = parse(out);
      if (!parsed) {
        attempts.push({ method: name, ok: false, error: '解密成功但结构不符合 random+len+msg+appid', note });
        return null;
      }
      attempts.push({ method: name, ok: true, note });
      return parsed;
    } catch (e: any) {
      attempts.push({ method: name, ok: false, error: String(e?.message || e).slice(0, 60), note });
      return null;
    }
  };

  const ivFromKey = aesKey.subarray(0, 16);
  const ivZero = Buffer.alloc(16, 0);

  const candidates = [
    tryMethod('IV=key[:16], PKCS#7', ivFromKey, true, '当前实现 / 官方 Java 示例等价'),
    tryMethod('IV=key[:16], NoPadding+手动去填充', ivFromKey, false, '官方 Java 示例原写法'),
    tryMethod('IV=全0, PKCS#7', ivZero, true, '部分实现用全 0 IV'),
    tryMethod('IV=全0, NoPadding+手动去填充', ivZero, false, ''),
  ];

  const hit = candidates.find(Boolean);
  if (!hit) return { ok: false, attempts };

  return {
    ok: true,
    workingMethod: attempts.find((a) => a.ok)?.method,
    attempts,
    preview: hit!.msg.slice(0, 300),
    appId: hit!.appId,
  };
}

/** 最近一次收到的密文（用于解密自测，避免用户手动传密文） */
let _lastEncrypt = '';
export function rememberEncrypt(encrypt: string): void {
  if (encrypt) _lastEncrypt = encrypt;
}
export function getLastEncrypt(): string {
  return _lastEncrypt;
}

// ============================================================
// 安全模式：消息解密（AES-256-CBC）
// ------------------------------------------------------------
// 官方算法：
//   1. AESKey = Base64_Decode(EncodingAESKey + "=") → 32 字节
//   2. IV = AESKey 的前 16 字节
//   3. 用 AES-256-CBC + PKCS#7Padding 解密 Base64 密文
//   4. 解密结果结构：random(16B) + msg_len(4B 网络字节序) + msg + appid
//      → 剥离前 20 字节即为真实消息体，尾部为 appid（须校验是否为自己的）
//
// ⚠️ 必须**先验签后解密**（微信官方明确要求），不要颠倒顺序。
// ============================================================

/** EncodingAESKey —— MP 后台「消息推送 → EncodingAESKey」获取 */
const ENCODING_AES_KEY= () => (process.env.VX_ENCODING_AES_KEY || '').trim();

/**
 * 生成配置指纹（不含原文，用于核对配置是否一致）。
 *
 * ⚠️ 为什么需要：EncodingAESKey 是 43 位长字符串，配置在云托管面板时
 *极易出现**肉眼看不出的差异**——尾部换行、复制时被截断、
 * 前后多一个空格、中英文字符混入等。排查时打印指纹即可确认
 * 「后台的值」与「线上生效的值」是否同一个，无需暴露密钥原文。
 */
function configFingerprint(value: string): string {
  if (!value) return '(未配置)';
  // ⚠️ 必须用文件顶部的静态 import，**不能用 require('crypto')**。
  //   产物为 ESM（dist/server.mjs），动态 require 会抛
  //   "Dynamic require of crypto is not supported" 并导致接口 500。
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

/** 返回各凭证的配置指纹，用于诊断接口 */
export function getConfigFingerprints(): Record<string, string> {
  const raw = process.env.VX_ENCODING_AES_KEY || '';
  return {
    // 原始值长度（未trim）—— 若与 43 不符，说明有隐藏字符
    aesKeyRawLength: String(raw.length),
    aesKeyFingerprint: configFingerprint((raw || '').trim()),
    pushTokenFingerprint: configFingerprint(PUSH_TOKEN()),
  };
}
/** 小程序 AppID —— 解密后需校验尾部 appid 是否匹配，防止他人伪造 */
const WX_APPID_FOR_VERIFY = () => (process.env.WX_APPID || '').trim();

export function isAesKeyConfigured(): boolean {
  return !!ENCODING_AES_KEY();
}

/**
 * 解密安全模式的密文。
 *
 * @param encrypt Base64 密文
 * @param aesKeyRaw EncodingAESKey（43 位）
 * @param expectedAppId 期望的 appid；传入则校验解密尾部
 * @returns 解密并剥离后的消息体；失败返回 null
 */
export function decryptPushMessage(
  encrypt: string,
  aesKeyRaw: string = ENCODING_AES_KEY(),
  expectedAppId: string = WX_APPID_FOR_VERIFY()
): string | null {
  if (!aesKeyRaw) {
    console.error('[虚拟支付] 未配置 VX_ENCODING_AES_KEY，无法解密（fail-closed）');
    return null;
  }
  if (!encrypt) return null;

  try {
    // ① Base64_Decode(EncodingAESKey + "=") → 32 字节 AESKey
    const aesKey = Buffer.from(aesKeyRaw + '=', 'base64');
    if (aesKey.length !== 32) {
      console.error(`[虚拟支付] EncodingAESKey 解码后长度异常: ${aesKey.length}（应为 32）`);
      return null;
    }

    // ② IV = AESKey 前 16 字节
    const iv = aesKey.subarray(0, 16);

    // ③ AES-256-CBC 解密
    //
    // ⚠️⚠️ 必须用 **NoPadding + 手动去填充**，不能依赖默认 PKCS#7！
    //   微信端的加解密实现沿用公众号消息推送的做法（NoPadding），
    //   若此处用Node 默认的 PKCS#7 校验填充，`final()` 会因填充字节不合法
    //   而抛 `error:1C800064: Provider routines::bad decrypt`——
    //   **症状与「密钥错误」完全相同，极易误判**（本项目踩过，排查多轮）。
    //
    //   正确姿势：setAutoPadding(false) 拿到原始明文，再按 PKCS#7 规则手动去填充。
    const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
    decipher.setAutoPadding(false);
    let plain = Buffer.concat([
      decipher.update(Buffer.from(encrypt, 'base64')),
      decipher.final(),
    ]);

    // ③.5 手动去 PKCS#7 填充
    //   末字节即填充长度。⚠️ 这里做严格校验（每个填充字节都应等于 padByte）：
    //   若不合法，说明**密钥本身错误**（解出来的是随机数据），
    //   此时的报错语义必须与「填充异常」区分开，避免再次误判为密钥问题。
    if (plain.length > 0) {
      const padByte = plain[plain.length - 1];
      const padValid = padByte >= 1 && padByte <= 16 && padByte <= plain.length;
      if (padValid) {
        // 逐字节校验填充内容
        let allPad = true;
        for (let i = plain.length - padByte; i < plain.length; i++) {
          if (plain[i] !== padByte) { allPad = false; break; }
        }
        if (allPad) {
          plain = plain.subarray(0, plain.length - padByte);
        } else {
          console.error('[虚拟支付] PKCS#7 填充字节不连续 —— 密钥错误（解出的是随机数据）');
          return null;
        }
      }
      // padValid 为 false 时不裁剪，交给下方的 msg_len 校验去失败——
      // 因为密钥错误时长度几乎必然不合法，会在那里给出准确报错。
    }

    // ④ 结构：random(16B) + msg_len(4B) + msg + appid
    if (plain.length < 20) {
      console.error('[虚拟支付] 解密结果长度异常');
      return null;
    }
    const msgLen = plain.readUInt32BE(16); // 前16字节随机，后4字节是长度（网络字节序）
    const msgStart = 20;
    const msgEnd = msgStart + msgLen;
    if (msgLen <= 0 || msgEnd > plain.length) {
      console.error(`[虚拟支付] 解密后的 msg_len 非法: ${msgLen}`);
      return null;
    }
    const message = plain.subarray(msgStart, msgEnd).toString('utf8');

    // ⑤ 校验尾部 appid（防止他人用其他 appid 的密文伪造）
    //
    // ⚠️⚠️ 尾部清理必须**两步**，缺一不可（本项目连续踩了两次）：
    //   ① 只用 trim() 不够——微信的填充字节是 **0x00（空字节）**，
    //      而 String.trim() 只去 Unicode 空白（空格/制表/换行），**不去 \u0000**；
    //   ② 只去不可见字符也不够——普通空格 0x20 属于「可见ASCII」范围，会被留下。
    //   → 症状都是「解出正确 appid 却报疑似伪造请求」。
    //
    // AppID 本身只含 a-z0-9_，两步清理不影响其正确性；伪造的 appid 仍会被拦。
    const tailRaw = plain.subarray(msgEnd).toString('utf8');
    const tailAppId = tailRaw
      .replace(/[^\x20-\x7E]/g, '') // ① 去不可见字符（含 \u0000，trim 处理不了）
      .trim();                    // ② 再去普通空格（0x20 属于可见范围）
    if (expectedAppId && tailAppId !== expectedAppId.trim()) {
      console.error(
        `[虚拟支付] 解密尾部 appid 不匹配（解出 ${JSON.stringify(tailAppId.slice(0, 30))}` +
        `原始长度 ${tailRaw.length}），疑似伪造请求`
      );
      return null;
    }

    return message;
  } catch (err: any) {
    // 诊断信息：key 指纹 + 密文特征，用于区分「key 不对」与「密文来源不对」。
// ⚠️ 只打指纹与长度，绝不打 key 原文或解密内容。
console.error(
      `[虚拟支付] 解密诊断：` +
      `key指纹=${crypto.createHash('sha256').update(aesKeyRaw).digest('hex').slice(0, 12)} ` +
      `key长度=${aesKeyRaw.length} ` +
      `密文长度=${encrypt.length} ` +
      `密文前32字符=${encrypt.slice(0, 32)}`
    );
    console.error('[虚拟支付] 解密失败:', err?.message || err);
    return null;
  }
}

/**
 * 从请求体中提取密文。
 * 安全模式下密文可能在 query（少数情况）或 JSON body 的 Encrypt 字段。
 */
export function extractEncryptField(
  query: Record<string, any>,
  body: any
): string {
  if (query?.encrypt) return String(query.encrypt);
  if (body?.Encrypt) return String(body.Encrypt);
  if (body?.encrypt) return String(body.encrypt);
  return '';
}

// ============================================================
// 下单参数
// ============================================================

export interface VirtualPayOrderParams {
  productId: string;      // 道具 ID（须与后台「道具管理」创建的一致）
  goodsPrice: number;     // 道具单价，单位：分。须与后台配置一致，否则 -15013
  outTradeNo: string;     // 业务订单号：8-32 位，仅数字/大小写字母/_-|*@，不能以下划线开头
  attach: string;         // 透传数据，发货通知会原样带回
  env?: number;           // 环境，默认正式
  buyQuantity?: number;   // 购买数量，默认 1
}

/** 客户端调起支付所需的完整参数 */
export interface VirtualPayClientParams {
  signData: string;  // 注意：必须是 JSON 字符串，不能传对象
  paySig: string;
  signature: string;
  mode: 'short_series_goods';
}

/**
 * 生成虚拟支付下单参数。
 *
 * @param params 下单参数
 * @param sessionKey 用户 session_key（用于用户态签名）
 * @returns 可直接传给 wx.requestVirtualPayment 的参数
 */
export function createVirtualPayParams(
  params: VirtualPayOrderParams,
  sessionKey: string
): VirtualPayClientParams {
  if (!isVirtualPayConfigured()) {
    throw new Error('虚拟支付未配置（需 VX_OFFER_ID 与 VX_APP_KEY）');
  }
  if (!OFFER_ID()) throw new Error('虚拟支付未配置 VX_OFFER_ID');
  if (!params.productId) throw new Error('缺少 productId（道具 ID）');
  if (!Number.isInteger(params.goodsPrice) || params.goodsPrice <= 0) {
    throw new Error('goodsPrice 必须为正整数（单位：分）');
  }
  validateOutTradeNo(params.outTradeNo);

  const env = params.env ?? VirtualPayEnv.PROD;

  const signDataObj = {
    offerId: OFFER_ID(),
    buyQuantity: params.buyQuantity ?? 1,
    env,
    currencyType: 'CNY',
    productId: params.productId,
    goodsPrice: params.goodsPrice,
    outTradeNo: params.outTradeNo,
    attach: params.attach || '',
  };

  // signData 必须以字符串形式传给 wx.requestVirtualPayment
  const signData = JSON.stringify(signDataObj);

  return {
    signData,
    paySig: calcPaySig(signData, env),
    signature: calcUserSig(signData, sessionKey),
    mode: 'short_series_goods',
  };
}

/**
 * 校验业务订单号格式。
 * 官方要求：8-32 字符，仅数字/大小写字母/ _-|*@ ，不能以下划线开头。
 */
export function validateOutTradeNo(outTradeNo: string): void {
  if (!outTradeNo || outTradeNo.length < 8 || outTradeNo.length > 32) {
    throw new Error(`outTradeNo 长度须为 8-32 位（当前 ${outTradeNo?.length ?? 0}）`);
  }
  if (outTradeNo.startsWith('_')) {
    throw new Error('outTradeNo 不能以下划线开头');
  }
  if (!/^[0-9A-Za-z_\-|*@]+$/.test(outTradeNo)) {
    throw new Error('outTradeNo 只能包含数字、大小写字母及 _ - | * @');
  }
}

/**
 * 生成业务订单号。
 * 用时间戳 + 随机串，长度与字符集均符合官方要求。
 */
export function genOutTradeNo(prefix = 'VS'): string {
  const ts = Date.now().toString();
  const rand = crypto.randomBytes(4).toString('hex'); // 8位小写十六进制
  return `${prefix}${ts}${rand}`.slice(0, 32);
}

// ============================================================
// 服务器 API 调用（通用签名请求）
// ============================================================

/**
 * 调用虚拟支付服务器 API。
 * 签名：paySig = hmac_sha256(appKey, uri + '&' + JSON.stringify(postbody))
 *
 * @param uri 例如 /xpay/query_order
 * @param postBody 请求体对象
 * @param sessionKey 用户 session_key，用于生成用户态 signature（部分接口需要）
 * @param env 环境，默认为正式
 */
export async function xpayRequest<T = any>(
  uri: string,
  postBody: Record<string, any>,
  sessionKey?: string,
  env: number = VirtualPayEnv.PROD
): Promise<T> {
  const body = JSON.stringify(postBody);

  // 支付签名：HMAC(appKey, uri + '&' + body)
  const key = appKeyForEnv(env);
  if (!key) throw new Error('虚拟支付未配置 VX_APP_KEY');
  const paySig = crypto.createHmac('sha256', key).update(`${uri}&${body}`).digest('hex');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'paySig': paySig,
    'X-TC-Env': String(env),
  };

  // 部分接口需带用户态签名
  if (sessionKey) {
    headers['signature'] = calcUserSig(body, sessionKey);
  }

  const data = await httpsPost(`${API_BASE}${uri}`, headers, body);
  return data as T;
}

/**
 * 判断是否可跳过 TLS 证书验证。
 *
 * ⚠️ 仅对**微信官方固定域名**放行，杜绝任意域名绕过证书校验。
 */
function canSkipTlsVerify(hostname: string): boolean {
  return ALLOWED_SKIP_TLS_HOSTS.includes(hostname);
}

function httpsPost(url: string, headers: Record<string, string>, body: string, timeoutMs = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const skipVerify = canSkipTlsVerify(u.hostname);
    const req = https.request(
      {
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method: 'POST',
        headers,
        timeout: timeoutMs,
        // ⚠️⚠️ 云托管容器访问 api.weixin.qq.com 走内网网关，**证书链不被 Node 认可**
        //   （DEPTH_ZERO_SELF_SIGNED_CERT / self-signed certificate），
        //   导致所有虚拟支付请求（查单/通知发货）失败。
        //   与 server.ts 的 wxRequestJson 同一解法：**仅对微信官方域名跳过证书验证**。
        //
        //   安全边界（重要）：
        //     · 由 canSkipTlsVerify() 做域名白名单，**不是任意域名都跳过**
        //     · 请求体含 paySig 签名，微信侧仍会校验，伪造请求无法通过
        //     · 传输内容为订单号等非敏感数据
        //   若将来需更严格，可在容器内挂载完整 CA 链后移除。
        rejectUnauthorized: !skipVerify,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data || '{}'));
          } catch (e) {
            reject(new Error('虚拟支付响应解析失败'));
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('虚拟支付请求超时'));
    });
    // ⚠️ 网络层错误诊断：证书类问题在容器内常见（云托管自带 CA 不完整等），
    // 打完整 code + message，便于区分「证书链」「DNS」「连接被拒」等问题。
    req.on('error', (err: any) => {
      if (err?.code) {
        console.error(
          `[虚拟支付] 网络错误 code=${err.code} ` +
          `message=${err.message} url=${url} ` +
          `env=${process.env.NODE_ENV || 'unknown'}`
        );
      }
      reject(err);
    });
    req.write(body);
    req.end();
  });
}

// ============================================================
// 常用服务器 API 封装
// ============================================================

/** 查询订单状态（errcode=0 且 order_state 支付成功时视为已付款） */
export async function queryOrder(
  outTradeNo: string,
  sessionKey?: string,
  env: number = VirtualPayEnv.PROD
): Promise<any> {
  return xpayRequest('/xpay/query_order', { out_trade_no: outTradeNo }, sessionKey, env);
}

/** 通知已发货完成（现金单）。正常收到发货推送后调用即可，此处为兜底 */
export async function notifyGoods(
  outTradeNo: string,
  sessionKey?: string,
  env: number = VirtualPayEnv.PROD
): Promise<any> {
  return xpayRequest('/xpay/notify_provide_goods', { out_trade_no: outTradeNo }, sessionKey, env);
}

/**
 * 订单是否已支付。
 * ⚠️ 虚拟支付的 errcode=0 仅代表接口调用成功，须再判断 order_state。
 */
export function isOrderPaid(queryResult: any): boolean {
  if (!queryResult || queryResult.errcode !== 0) return false;
  const state = queryResult.order_state;
  // 官方：order_state=1 表示支付成功
  return state === 1 || state === '1';
}