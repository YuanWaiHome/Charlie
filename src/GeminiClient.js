/**
 * ============================================================
 * Gemini 語意解析
 * ============================================================
 * 負責把使用者的口語文字拆解成結構化 JSON：
 * - 支援「記錄」（商品+價格）與「查詢」（只問商品近期價格）兩種意圖
 * - 支援一句話包含多項商品；商品不限生鮮，也可以是日用品、家電、服飾等
 * - 容錯錯字、缺資訊
 * - 商品名稱會盡量比對「既有已記錄過的標準名稱（含別名）清單」，避免同商品被判斷成不同項目
 * - 地點名稱也比照商品做法，盡量比對「既有已記錄過的地點清單」（例如「好市多」「好事多」「COSTCO」）
 * - 查詢意圖會額外請 Gemini 提供同義詞/簡稱（search_keywords），搭配 Search.js 的模糊比對，減少「明明有卻查不到」
 * - 單位只負責「辨識原始用字」，實際數字換算交給 Units.js 的程式邏輯處理（更準確）
 */

function buildGeminiSchema_() {
  return {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        enum: ['record', 'query', 'unknown'],
        description: 'record=使用者在記錄採買價格；query=只想查某商品近期價格（沒有報新價格）；unknown=無法判斷',
      },
      unparsed: { type: 'boolean', description: '若完全無法抓到任何商品相關資訊則為 true' },
      date: { type: 'string', description: 'YYYY-MM-DD 格式；若訊息中沒有明確日期/相對日期，留空字串代表今天' },
      location: {
        type: 'string',
        description: '購買地點（店家、賣場、網站、市場等）；若整句只提到一次且適用於所有商品，填這裡；沒有則留空字串。若語意上和 existingLocations 清單中某一項相同（即使字略有不同、簡稱、或中英文寫法不同，例如「好市多」「好事多」「COSTCO」可能是同一個地方），請直接重用該既有名稱；否則給一個簡潔一致的新名稱。',
      },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            product_raw: { type: 'string', description: '使用者原始輸入裡這項商品的「名稱本身」，不含數量、單位、價格、地點' },
            product_canonical: {
              type: 'string',
              description: '商品的標準化名稱。若語意上和 existingProducts 清單中某一項（name 或 aliases）相同（即使字略有不同、有錯字、字序不同、簡稱），請直接重用該項的 name；否則給一個簡潔、通用、一致的新名稱。',
            },
            category: {
              type: 'string',
              enum: PRODUCT_CATEGORIES,
              description: '商品類別，從選項中擇一；查詢意圖若無法判斷可填「其他」',
            },
            search_keywords: {
              type: 'array',
              items: { type: 'string' },
              description: '僅查詢意圖需要：使用者可能用來稱呼「同一項商品」的其他說法、同義詞、簡稱（2~5 個）；不要給範圍更廣的泛稱（例如只給「肉」）。記錄意圖或沒有可留空陣列。',
            },
            quantity: { type: 'number', description: '數量，沒特別講通常是 1；查詢意圖可填 0' },
            unit_raw: { type: 'string', description: '原始單位用字本身，例如 斤、台斤、公斤、兩、隻、尾、顆、把、件、瓶、組、公升、毫升 等；不含數字。查詢意圖若沒提到單位可留空字串' },
            price: { type: 'number', description: '對應 quantity+unit_raw 這個份量的總價；查詢意圖沒有新價格時填 0' },
            item_location: { type: 'string', description: '若此商品有獨立於共用 location 的地點才填寫，否則留空字串；同樣要優先比對 existingLocations 清單重用既有名稱' },
            confidence: { type: 'number', description: '0~1 之間，對這筆解析正確性的信心程度' },
            notes: { type: 'string', description: '任何需要提醒使用者或自己記錄的備註，例如疑似錯字、資訊不全；沒有則留空字串' },
          },
          required: ['product_raw', 'product_canonical', 'confidence'],
        },
      },
    },
    required: ['intent', 'unparsed', 'items'],
  };
}

function buildGeminiPrompt_(rawText, vocab, todayStr) {
  const existingProducts = (vocab && vocab.products) || [];
  const existingLocations = (vocab && vocab.locations) || [];

  return [
    '你是一個協助記錄與查詢「日常購物價格」的助理，商品範圍包含傳統市場生鮮、食品飲料、日用清潔、3C 家電、服飾配件等各種東西。使用者多為一般家庭成員，輸入常有錯字、口語、資訊不完整的狀況，請盡量合理推斷，不要太嚴格。',
    '今天的日期是 ' + todayStr + '（用來換算「今天」「昨天」「前天」等相對日期；若完全沒提到日期，date 欄位請留空字串，代表預設今天）。',
    '',
    '請先判斷意圖 intent：',
    '- record：訊息裡有「商品 + 價格」（例如「豬梅花一斤205」「活草蝦750」「iPhone 15 29900 蝦皮」），使用者是在請你記下來。',
    '- query：訊息主要是在問某商品的價格／近期紀錄，但沒有報出新的採買價格（例如「梅花肉」「豬梅花多少錢」「草蝦最近多少」）。就算只打商品名也算 query。',
    '- unknown：完全看不出是在記錄或查詢商品價格。',
    '訊息中若出現「' + CONFIG.HISTORY_KEYWORD + '」兩個字，且訊息是在查詢（沒有報新價格），那是「要求查全部歷史資料」的指令詞，不是商品名稱的一部分，請不要把它放進 product_raw / product_canonical / search_keywords；若訊息有報價格（record），則把它當一般文字處理（例如商品就叫「歷史課本」）。',
    '',
    '一則訊息可能同時描述多項商品（常用頓號、空白、逗號分隔），請拆成 items 陣列中的多筆，不要合併成一筆。',
    '地點通常出現在句尾，而且常常是講完所有商品之後才提一次，但其實適用於前面所有商品——除非語意上明顯只屬於某一項，才個別填在該項的 item_location。地點可能是市場、店家、賣場，也可能是網購平台（蝦皮、momo 等）。',
    '單位只需要抓出「原始用字本身」放到 unit_raw（例如 斤/台斤/公斤/兩/隻/尾/顆/把/包/盒/罐/片/件/瓶/組/雙/公升/毫升），不用自己換算數字，換算會由程式處理。查詢意圖若沒提到單位，unit_raw 留空、price 填 0、quantity 填 0。',
    '關於「台」：在買菜、買肉、買海鮮這類生鮮情境，「台」幾乎都是「台斤」的口語簡稱，unit_raw 照填「台」即可（程式會依類別處理）；但如果是電視、冷氣、手機等「一台機器」的意思，unit_raw 也填「台」，並把 category 填為「3C家電」。',
    'category 請從 schema 提供的選項擇一，生鮮蔬果肉魚蛋類 → 生鮮食材；包裝食品、飲料、零食 → 加工食品飲料；衛生紙、洗衣精等 → 日用清潔；電子產品與家電 → 3C家電；衣褲鞋包等 → 服飾配件；其他 → 其他。',
    '',
    '商品名稱正規化非常重要，目的是讓「同一項東西」永遠用同一個標準名稱，之後才查得到。規則：',
    '1. 標準名稱要簡潔、通用，不含數量、單位、價格、地點；「新鮮」「特選」「大/小」等不影響本質的修飾詞可省略，但品牌、型號、規格差異（例如「iPhone 15 Pro」和「iPhone 15」、不同品牌的牛奶）屬於不同商品，要保留。',
    '2. 以下是目前已經記錄過的標準商品清單（JSON 陣列，依最近使用排序）。每一項的 name 是標準名稱，aliases 是過去使用者曾用過的其他說法。請優先比對語意：如果這次輸入其實是同一項商品（可能有錯字、字序不同、簡稱、或是 aliases 裡的某個說法，例如「梅花肉」與「豬梅花」可能是同一種），請直接重用該項的 name（只輸出 name，不要輸出別名）；只有在確定是不同商品時才建立新名稱：',
    JSON.stringify(existingProducts),
    '3. 地點名稱也要做一樣的正規化：以下是目前已經記錄過的地點清單（JSON 陣列），請優先比對語意，如果這次輸入其實是同一個地方（可能簡稱、錯字、或中英文寫法不同，例如「好市多」「好事多」「COSTCO」可能是同一個賣場），請直接重用清單中的名稱；只有在確定是不同地點時才建立新名稱：',
    JSON.stringify(existingLocations),
    '',
    '若整句話完全無法辨識出任何商品相關資訊，將 unparsed 設為 true、intent 設為 unknown，items 給空陣列。',
    '務必只輸出符合給定 schema 的 JSON，不要有多餘文字或說明。',
    '',
    '使用者訊息：「' + rawText + '」',
  ].join('\n');
}

/**
 * 呼叫 Gemini API，回傳結構化解析結果（已經是 parse 完的 JS 物件）
 * @param {string} rawText 使用者訊息（已去掉 @mention）
 * @param {{products: Object[], locations: string[]}} vocab 由 getKnownVocabulary_() 取得的既有商品/地點清單
 * @param {string} todayStr yyyy-MM-dd
 */
function parseMessageWithGemini_(rawText, vocab, todayStr) {
  const apiKey = getGeminiApiKey_();
  const model = CONFIG.GEMINI_MODEL;
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey;

  const payload = {
    contents: [
      { role: 'user', parts: [{ text: buildGeminiPrompt_(rawText, vocab, todayStr) }] },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: buildGeminiSchema_(),
      temperature: 0.1,
    },
  };

  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  if (code !== 200) {
    throw new Error('Gemini API 呼叫失敗 (' + code + ')：' + res.getContentText());
  }

  const json = JSON.parse(res.getContentText());
  const candidate = json.candidates && json.candidates[0];
  const text = candidate && candidate.content && candidate.content.parts &&
    candidate.content.parts[0] && candidate.content.parts[0].text;

  if (!text) {
    throw new Error('Gemini 回傳格式異常：' + res.getContentText());
  }

  return JSON.parse(text);
}

/**
 * 小工具：在 Apps Script 編輯器直接執行這個函式，
 * 可以快速測試 Gemini API Key 有沒有設定正確、解析結果長怎樣，
 * 不用真的透過 LINE 傳訊息。執行後到「執行記錄」看結果。
 * 注意：故意不用底線結尾命名（例如 testParse_），
 * 是因為 Apps Script 會把底線結尾的函式當成「私有函式」，
 * 不會出現在編輯器頂端的「執行函式」下拉選單裡。
 */
function testParse() {
  const today = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const result = parseMessageWithGemini_('豬梅花一斤205、活草蝦一斤750 竹圍漁港', getKnownVocabulary_(), today);
  Logger.log(JSON.stringify(result, null, 2));
}

/** 測試一般購物（非生鮮）的記錄，例如家電、日用品 */
function testParseGeneral() {
  const today = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const result = parseMessageWithGemini_('洗衣精 2公升 189、電鍋一台 1980 好市多', getKnownVocabulary_(), today);
  Logger.log(JSON.stringify(result, null, 2));
}

/** 測試純查詢意圖（例如只打商品名），可以看 search_keywords 有沒有給出合理的同義詞 */
function testQuery() {
  const today = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const result = parseMessageWithGemini_('梅花肉', getKnownVocabulary_(), today);
  Logger.log(JSON.stringify(result, null, 2));
}

/** 測試「歷史」關鍵字：查詢時不應該把「歷史」當成商品名稱 */
function testQueryHistory() {
  const today = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const result = parseMessageWithGemini_('梅花肉 歷史', getKnownVocabulary_(), today);
  Logger.log(JSON.stringify(result, null, 2));
}
