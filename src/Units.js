/**
 * ============================================================
 * 單位換算邏輯
 * ============================================================
 * 設計原則：
 * - 「重量類」單位一律換算成「台斤」(1台斤 = 600公克)，方便同商品不同次購買的價格互相比較
 * - 「容量類」單位（公升、毫升...）一律換算成「公升」
 * - 「計數類」單位（隻/尾/顆/件/瓶...）不換算數字，只統一相似字詞的寫法
 * - 實際的數字換算交給程式（這裡）用固定倍率計算，不交給 AI，確保數學一定正確；
 *   AI（Gemini）只負責判斷使用者打的「原始單位文字」是什麼
 */

// 商品類別（Gemini 會從中擇一，寫入試算表的「類別」欄）
const PRODUCT_CATEGORIES = ['生鮮食材', '加工食品飲料', '日用清潔', '3C家電', '服飾配件', '其他'];
const FRESH_FOOD_CATEGORY = '生鮮食材';

// 重量單位 → 換算成「1 台斤」的倍率
// 例：quantity(公斤) * WEIGHT_UNIT_TO_JIN['公斤'] = 換算後的台斤數
// 注意：「台」不在這裡，因為它在買菜是「台斤」、在買家電是「一台」，要看類別才能決定（見 normalizeUnit_）
const WEIGHT_UNIT_TO_JIN = {
  '斤': 1,
  '台斤': 1,
  '兩': 1 / 16,      // 傳統上 16 兩 = 1 台斤
  '公斤': 1000 / 600,
  '公斤重': 1000 / 600,
  'kg': 1000 / 600,
  'KG': 1000 / 600,
  'Kg': 1000 / 600,
  '克': 1 / 600,
  '公克': 1 / 600,
  'g': 1 / 600,
  'G': 1 / 600,
  '磅': 453.6 / 600,
};

// 容量單位（key 一律小寫比對）→ 換算成「1 公升」的倍率
const VOLUME_UNIT_TO_LITER = {
  '公升': 1,
  '升': 1,
  'l': 1,
  '毫升': 1 / 1000,
  'ml': 1 / 1000,
  'cc': 1 / 1000,
};

// 計數類單位的同義字 → 統一寫法（只是整理用字，數字不換算）
const COUNT_UNIT_ALIASES = {
  '隻': '隻', '只': '隻',
  '尾': '尾', '条': '條', '條': '條',
  '顆': '顆', '粒': '顆',
  '個': '個', '个': '個',
  '把': '把',
  '串': '串',
  '包': '包',
  '盒': '盒',
  '罐': '罐',
  '片': '片',
  '份': '份',
  '條/尾': '尾',
  // 一般購物常見單位
  '件': '件',
  '支': '支', '枝': '支',
  '瓶': '瓶',
  '雙': '雙',
  '組': '組', '套': '組',
  '箱': '箱',
  '袋': '袋',
  '張': '張',
  '本': '本',
  '塊': '塊',
  '根': '根',
  '杯': '杯',
  '碗': '碗',
  '打': '打',
  '對': '對',
  '捲': '捲', '卷': '捲',
  '入': '入',
};

/**
 * 判斷單位類型並正規化
 * @param {string} rawUnit 使用者原始輸入的單位文字
 * @param {string=} category 商品類別（用來判斷「台」是台斤還是一台機器）
 * @returns {{type: 'weight'|'volume'|'count', normalizedUnit: string, factor: number}}
 *   factor：重量類時，1 原始單位 = factor 台斤；容量類時 = factor 公升；計數類時固定為 1（不換算）
 */
function normalizeUnit_(rawUnit, category) {
  if (!rawUnit) return { type: 'count', normalizedUnit: '份', factor: 1 };
  const u = String(rawUnit).trim();

  // 「台」：生鮮食材（或沒有類別資訊時）視為台斤；其他類別（家電等）視為「一台」
  if (u === '台') {
    if (!category || category === FRESH_FOOD_CATEGORY) {
      return { type: 'weight', normalizedUnit: '斤', factor: 1 };
    }
    return { type: 'count', normalizedUnit: '台', factor: 1 };
  }

  if (Object.prototype.hasOwnProperty.call(WEIGHT_UNIT_TO_JIN, u)) {
    return { type: 'weight', normalizedUnit: '斤', factor: WEIGHT_UNIT_TO_JIN[u] };
  }
  const lower = u.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(VOLUME_UNIT_TO_LITER, lower)) {
    return { type: 'volume', normalizedUnit: '公升', factor: VOLUME_UNIT_TO_LITER[lower] };
  }
  if (Object.prototype.hasOwnProperty.call(COUNT_UNIT_ALIASES, u)) {
    return { type: 'count', normalizedUnit: COUNT_UNIT_ALIASES[u], factor: 1 };
  }
  // 無法辨識的單位：原樣保留當成計數類，避免程式出錯，之後可以手動在表單裡修正
  return { type: 'count', normalizedUnit: u, factor: 1 };
}

/**
 * 將 Gemini 解析出的「原始數量 + 原始單位 + 原始總價」換算成統一後的「單位價格」
 * @param {number} quantity 數量（例如「兩斤400元」的 quantity 是 2）
 * @param {string} rawUnit 原始單位文字
 * @param {number} price 對應 quantity 份數量的總價
 * @param {string=} category 商品類別
 */
function computeNormalizedPrice_(quantity, rawUnit, price, category) {
  const q = Number(quantity) || 1;
  const p = Number(price) || 0;
  const info = normalizeUnit_(rawUnit, category);

  if (info.type === 'weight' || info.type === 'volume') {
    const totalBase = q * info.factor;
    const pricePerBase = totalBase > 0 ? p / totalBase : p;
    return {
      type: info.type,
      normalizedUnit: info.normalizedUnit,
      normalizedUnitPrice: round2_(pricePerBase),
    };
  }

  const pricePerUnit = q > 0 ? p / q : p;
  return {
    type: 'count',
    normalizedUnit: info.normalizedUnit,
    normalizedUnitPrice: round2_(pricePerUnit),
  };
}

function round2_(n) {
  return Math.round(n * 100) / 100;
}
