/**
 * ============================================================
 * LINE Messaging API 工具
 * ============================================================
 * 驗證說明：
 * Google Apps Script 的網頁應用程式（doPost）無法讀取自訂的 HTTP Header，
 * 所以 LINE 官方的「X-Line-Signature」簽章驗證是在前面的 Cloudflare Worker（worker/relay.js）完成的；
 * Worker 驗證通過後，再帶著 WEBHOOK_TOKEN 轉發給這裡，Main.js 的 doPost 會檢查這組 token。
 */

/**
 * 把多段文字區塊組成 LINE 文字訊息：區塊之間空一行，
 * 單則超過 CONFIG.LINE_MAX_TEXT_CHARS 就自動切成下一則，最多 CONFIG.LINE_MAX_MESSAGES 則
 * （LINE 單則文字上限 5000 字、一次回覆最多 5 則，超過的內容會被截掉並提示）。
 */
function buildTextMessages_(blocks) {
  const maxChars = CONFIG.LINE_MAX_TEXT_CHARS;
  const maxMessages = CONFIG.LINE_MAX_MESSAGES;
  const chunks = [];
  let current = '';

  // 先把「單一區塊就超過上限」的情況依行切開
  const pieces = [];
  blocks.forEach(function (block) {
    if (block.length <= maxChars) {
      pieces.push(block);
      return;
    }
    let buf = '';
    block.split('\n').forEach(function (line) {
      if (buf && (buf + '\n' + line).length > maxChars) {
        pieces.push(buf);
        buf = line;
      } else {
        buf = buf ? buf + '\n' + line : line;
      }
    });
    if (buf) pieces.push(buf);
  });

  pieces.forEach(function (piece) {
    if (current && (current + '\n\n' + piece).length > maxChars) {
      chunks.push(current);
      current = piece;
    } else {
      current = current ? current + '\n\n' + piece : piece;
    }
  });
  if (current) chunks.push(current);

  if (chunks.length > maxMessages) {
    chunks.length = maxMessages;
    chunks[maxMessages - 1] += '\n\n⚠️ 內容太多，後面的結果省略了，請縮小查詢範圍。';
  }

  return chunks.map(function (text) { return { type: 'text', text: text }; });
}

function replyToLine_(replyToken, messages) {
  const token = getLineAccessToken_();
  const url = 'https://api.line.me/v2/bot/message/reply';
  const payload = { replyToken: replyToken, messages: messages };
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) {
    Logger.log('LINE reply 失敗 (' + res.getResponseCode() + ')：' + res.getContentText());
  }
}

/**
 * 判斷這則訊息是否「tag了機器人」，並回傳去掉 mention 標記後的純文字內容
 * - 1對1聊天：不需要tag，任何文字都視為對機器人說話
 * - 群組/多人聊天室：需要確認有 @機器人 本身，才處理
 *   優先用官方的 mention 物件判斷（isSelf === true 代表提到機器人自己）
 *   若沒有 mention 物件（例如部分舊版事件格式），退而求其次用純文字含「@」判斷
 * 回傳 null 代表「這則不用處理」
 */
function extractMentionedText_(event) {
  const message = event.message;
  if (!message || message.type !== 'text') return null;

  const sourceType = event.source && event.source.type; // user | group | room

  if (sourceType === 'user') {
    return message.text;
  }

  const mention = message.mention;
  if (mention && Array.isArray(mention.mentionees)) {
    const mentionedSelf = mention.mentionees.some(function (m) { return m.isSelf === true; });
    if (!mentionedSelf) return null;

    let text = message.text;
    const mentionees = mention.mentionees.slice().sort(function (a, b) { return b.index - a.index; });
    mentionees.forEach(function (m) {
      text = text.slice(0, m.index) + text.slice(m.index + m.length);
    });
    return text.trim();
  }

  if (message.text && message.text.indexOf('@') !== -1) {
    return message.text.replace(/@\S+\s*/g, '').trim();
  }

  return null;
}
