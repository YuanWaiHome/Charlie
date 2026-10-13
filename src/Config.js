/**
 * ============================================================
 * 全域設定檔
 * ============================================================
 * 機密資訊（API Key、Token）請不要寫死在程式碼裡，
 * 而是到「專案設定（齒輪圖示）→ 指令碼屬性 (Script Properties)」新增，
 * 程式執行時會自動讀取，比較安全。
 *
 * 需要設定的指令碼屬性：
 *   GEMINI_API_KEY         - 在 https://aistudio.google.com/ 取得
 *   LINE_CHANNEL_ACCESS_TOKEN - 在 LINE Developers Console 的 Channel 頁面取得
 *   WEBHOOK_TOKEN          - 自己設一組複雜亂數字串，當作簡易的驗證密鑰
 *                            （可以執行下面的 generateWebhookToken() 產生一組）
 */

const CONFIG = {
  // 「目前使用中」的工作表名稱：新紀錄一律寫進這張，一般查詢也只查這張。
  // 資料太多想換新表時：把舊表改名（例如「價格記錄_2026」），程式會在下次記錄時自動重建一張新的「價格記錄」。
  // 其他表頭格式相同的工作表會被視為「歷史資料」，只有查詢時帶「歷史」二字才會一起搜尋。
  SHEET_NAME: '價格記錄',
  TIMEZONE: 'Asia/Taipei',
  HISTORY_LOOKBACK_COUNT: 3,            // 記錄成功時，附帶列出幾筆歷史價格
  QUERY_LOOKBACK_COUNT: 10,             // 一般查詢時，最多列出幾筆近期價格（只查目前使用中的工作表）
  GEMINI_MODEL: 'gemini-2.5-flash',     // 使用的 Gemini 模型，之後要換可以改這裡

  // ----- 「歷史」查詢（搜尋所有工作表）-----
  HISTORY_KEYWORD: '歷史',              // 訊息中出現這個詞，查詢就會涵蓋所有工作表
  HISTORY_MAX_RECORDS: 30,              // 歷史查詢時，每個查詢項目最多顯示幾筆
  HISTORY_MAX_SHEETS: 10,               // 歷史查詢最多掃描幾張工作表（目前這張 + 最右邊(最新)的其他表優先）
  MAX_QUERY_ITEMS: 5,                   // 一則訊息最多同時查幾個商品

  // ----- 商品 / 地點名稱統一（給 Gemini 參考的既有清單）-----
  MAX_VOCAB_PRODUCTS: 300,              // 最多帶幾個「最近用過」的標準商品名稱給 Gemini
  MAX_VOCAB_LOCATIONS: 100,             // 最多帶幾個「最近用過」的地點給 Gemini
  MAX_ALIASES_PER_PRODUCT: 5,           // 每個標準商品最多帶幾個別名（過去出現過的其他說法）
  VOCAB_CACHE_SECONDS: 600,             // 名稱清單的快取秒數（手動改了試算表，最久這麼久後生效；有新紀錄會立刻更新）

  // ----- LINE 回覆限制（LINE 單則文字上限 5000 字、一次最多 5 則）-----
  LINE_MAX_TEXT_CHARS: 4500,
  LINE_MAX_MESSAGES: 5,
};

/** 從 Script Properties 讀取機密設定，沒設定會丟出明確的錯誤訊息 */
function getSecret_(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) {
    throw new Error('缺少指令碼屬性：' + key + '，請到「專案設定 → 指令碼屬性」新增後再試一次。');
  }
  return value;
}

function getLineAccessToken_() { return getSecret_('LINE_CHANNEL_ACCESS_TOKEN'); }
function getGeminiApiKey_() { return getSecret_('GEMINI_API_KEY'); }
function getWebhookToken_() { return getSecret_('WEBHOOK_TOKEN'); }

/**
 * 小工具：在 Apps Script 編輯器選這個函式執行一次，
 * 到「執行紀錄」(View → Logs / 執行記錄) 複製產生的亂數字串，
 * 設成 WEBHOOK_TOKEN 這個指令碼屬性，同時也要設成 Cloudflare Worker 的 WEBHOOK_TOKEN 環境變數
 * （兩邊要一模一樣；Worker 轉發時會自動帶上，LINE Webhook 網址本身不用加任何參數）。
 */
function generateWebhookToken() {
  const token = Utilities.getUuid().replace(/-/g, '');
  Logger.log('產生的 WEBHOOK_TOKEN：' + token);
  Logger.log('請把它設成 Apps Script 指令碼屬性 WEBHOOK_TOKEN，同時也設成 Cloudflare Worker 的 WEBHOOK_TOKEN 環境變數（兩邊相同）。');
}
