/**
 * ============================================================
 * 文字正規化與模糊比對
 * ============================================================
 * 目的：讓「同樣商品、不同說法」在查詢時也能被找出來，不會因為字面不完全相同就漏掉。
 * 這是 Gemini 語意判斷之外的「程式端保險」，Gemini 判斷不準或 API 暫時失敗時仍然有用。
 *
 * 比對規則（query = 使用者查的詞、candidate = 試算表裡的商品名稱，兩者都先正規化）：
 *   1. 完全相同                              → 1.0
 *   2. 查詢詞是名稱的一部分（梅花 ⊂ 豬梅花）    → 0.9（單字也算，例如查「蝦」）
 *   3. 名稱是查詢詞的一部分（草蝦 ⊂ 活草蝦一斤）→ 0.85（名稱至少 2 字，避免單字誤中）
 *   4. 雙字組重疊度 ≥ 50%（梅花肉 vs 豬梅花）   → 0.6（兩邊都至少 3 字）
 * 分數 > 0 即視為相符。偏向「寧可多查到」，因為使用者最在意的是「明明有卻查不到」。
 */

/** 正規化：全形轉半形、轉小寫、「臺」→「台」、去掉空白與常見標點 */
function normalizeText_(value) {
  let s = String(value == null ? '' : value);
  try {
    s = s.normalize('NFKC');
  } catch (err) {
    // 舊環境不支援 normalize 時就略過
  }
  return s
    .toLowerCase()
    .replace(/臺/g, '台')
    .replace(/[\s\u3000·・.,，、。!！?？~～\-_\/\\()（）\[\]【】「」『』"'`:：;；]/g, '');
}

/** 取得字串的「雙字組」集合（例如「豬梅花」→ 豬梅、梅花） */
function charBigrams_(s) {
  const set = Object.create(null);
  let size = 0;
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.substr(i, 2);
    if (!set[g]) {
      set[g] = true;
      size++;
    }
  }
  return { set: set, size: size };
}

/** 計算兩段「已正規化」文字的相符分數，0 代表不相符 */
function textMatchScore_(query, candidate) {
  if (!query || !candidate) return 0;
  if (query === candidate) return 1;
  if (candidate.indexOf(query) !== -1) return 0.9;
  if (query.length >= 2 && candidate.length >= 2 && query.indexOf(candidate) !== -1) return 0.85;

  if (query.length >= 3 && candidate.length >= 3) {
    // 兩邊都有數字但數字不同（iPhone 15 vs iPhone 16 Pro），多半是不同型號/規格，不做模糊比對
    const qNums = (query.match(/\d+/g) || []).join(',');
    const cNums = (candidate.match(/\d+/g) || []).join(',');
    if (qNums && cNums && qNums !== cNums) return 0;

    const a = charBigrams_(query);
    const b = charBigrams_(candidate);
    const minSize = Math.min(a.size, b.size);
    if (minSize > 0) {
      let common = 0;
      Object.keys(a.set).forEach(function (g) {
        if (b.set[g]) common++;
      });
      if (common / minSize >= 0.5) return 0.6;
    }
  }
  return 0;
}

/**
 * 建立一個「這個商品名稱符不符合查詢詞」的判斷函式。
 * @param {string[]} terms 查詢詞（標準名稱、原始說法、同義詞...），會自動正規化、去重
 * @returns {function(string): boolean}
 */
function buildNameMatcher_(terms) {
  const seen = Object.create(null);
  const queries = [];
  (terms || []).forEach(function (t) {
    const q = normalizeText_(t);
    if (q && !seen[q]) {
      seen[q] = true;
      queries.push(q);
    }
  });

  const memo = Object.create(null); // 同一個名稱在大量紀錄中重複出現，只算一次
  return function (name) {
    const candidate = normalizeText_(name);
    if (!candidate) return false;
    if (memo[candidate] !== undefined) return memo[candidate];
    let ok = false;
    for (let i = 0; i < queries.length; i++) {
      if (textMatchScore_(queries[i], candidate) > 0) {
        ok = true;
        break;
      }
    }
    memo[candidate] = ok;
    return ok;
  };
}

/**
 * 由 Gemini 解析出的單一查詢項目，組出所有要拿去比對的詞：
 * 標準名稱 + 使用者原始說法 + Gemini 想到的同義詞/簡稱
 */
function buildSearchTerms_(item) {
  const terms = [];
  if (item.product_canonical) terms.push(item.product_canonical);
  if (item.product_raw) terms.push(item.product_raw);
  if (Array.isArray(item.search_keywords)) {
    item.search_keywords.forEach(function (k) {
      if (k) terms.push(k);
    });
  }
  return terms
    .map(function (t) { return String(t).trim(); })
    .filter(function (t) { return t.length > 0 && t.length <= 40; });
}
