/**
 * ============================================================
 * Cloudflare Worker：LINE Webhook 轉接層
 * ============================================================
 * 背景問題：
 * Google Apps Script 的網頁應用程式網址（.../exec）被呼叫時，script.google.com
 * 會先回一個 302 轉址到 script.googleusercontent.com 才拿得到真正的執行結果。
 * 大部分程式（包含這個 Worker 自己發出的 fetch）都會自動跟著轉址走，
 * 但 LINE 的 Webhook 驗證／送訊息機制基於安全理由「不會」跟著轉址走，
 * 只看第一個回應，所以直接把 LINE Webhook URL 指到 Apps Script 網址會一直失敗（302 Found）。
 *
 * 這個 Worker 的工作：
 *   1. 接住 LINE 送來的請求，用「X-Line-Signature」header 做官方建議的簽章驗證
 *      （比 Apps Script 本身更安全，因為 Apps Script 讀不到自訂 Header，Worker 可以）
 *   2. 驗證通過後，立刻回 200 給 LINE（避免 LINE 因為等待後面處理太久而判定逾時）
 *   3. 在背景把原始內容轉發給 Apps Script 的 /exec 網址，由 Apps Script 真正處理
 *      （解析文字、寫入 Sheet、呼叫 LINE Reply API 回覆使用者）
 *
 * 需要設定的環境變數（Cloudflare 後台：此 Worker → Settings → Variables and Secrets）：
 *   LINE_CHANNEL_SECRET (Secret) - LINE Developers Console → Basic settings 分頁 → Channel secret
 *   APPS_SCRIPT_URL     (一般文字) - 你的 Apps Script 部署網址，不要帶任何 ? 參數，例如：
 *                                    https://script.google.com/macros/s/AKfyxxxxx/exec
 *   WEBHOOK_TOKEN       (Secret) - 跟 Apps Script 指令碼屬性 WEBHOOK_TOKEN 設成「同一組」字串
 *
 * 設定好之後，LINE Developers Console 的 Webhook URL 直接填這個 Worker 的網址即可
 * （不用加任何 ?token=... 參數了，因為驗證改用官方簽章機制）：
 *   https://你的worker名稱.你的子網域.workers.dev/
 */

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('OK - LINE webhook relay 運作中', { status: 200 });
    }

    const bodyText = await request.text();
    const signature = request.headers.get('x-line-signature');

    const valid = await verifyLineSignature_(bodyText, signature, env.LINE_CHANNEL_SECRET);
    if (!valid) {
      return new Response('invalid signature', { status: 403 });
    }

    if (!env.APPS_SCRIPT_URL || !env.WEBHOOK_TOKEN) {
      return new Response('Worker 尚未設定 APPS_SCRIPT_URL / WEBHOOK_TOKEN 環境變數', { status: 500 });
    }

    const separator = env.APPS_SCRIPT_URL.indexOf('?') >= 0 ? '&' : '?';
    const targetUrl = env.APPS_SCRIPT_URL + separator + 'token=' + encodeURIComponent(env.WEBHOOK_TOKEN);

    // 已經確認是 LINE 真的送來的請求了，先立刻回 200，
    // 剩下「轉發給 Apps Script 處理」丟到背景做，避免卡著 LINE 等太久。
    ctx.waitUntil(forwardToAppsScript_(targetUrl, bodyText));

    return new Response('OK', { status: 200 });
  },
};

async function forwardToAppsScript_(targetUrl, bodyText) {
  try {
    const resp = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyText,
    });
    const text = await resp.text().catch(function () { return ''; });
    console.log('Apps Script 回應狀態：' + resp.status + '，內容：' + text);
  } catch (err) {
    console.error('轉發到 Apps Script 失敗：' + err);
  }
}

/** 用 LINE Channel secret 驗證 X-Line-Signature header，確認請求真的是 LINE 平台送來的 */
async function verifyLineSignature_(rawBody, signatureHeader, channelSecret) {
  if (!signatureHeader || !channelSecret) return false;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(channelSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signatureBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
    return arrayBufferToBase64_(signatureBuffer) === signatureHeader;
  } catch (err) {
    console.error('驗證簽章時發生錯誤：' + err);
    return false;
  }
}

function arrayBufferToBase64_(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
