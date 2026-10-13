/**
 * ============================================================
 * 試算表讀寫邏輯（當作資料庫使用）
 * ============================================================
 * 工作表欄位（第一列為標題列）：
 * A 時間戳記 | B 來源ID | C 原始訊息 | D 日期 | E 商品(標準) | F 商品(原始)
 * G 單位類型 | H 單位(標準) | I 數量 | J 單價(標準單位) | K 原始單位 | L 原始價格 | M 地點 | N 信心 | O 備註 | P 類別
 *
 * 多工作表規則：
 * - 「目前使用中」的工作表（CONFIG.SHEET_NAME）：新紀錄寫在這張，一般查詢也只查這張。
 * - 其他表頭格式相同（A1=「時間戳記」、E1=「商品(標準)」）的工作表視為「歷史資料」，
 *   只有查詢時帶「歷史」才會一起搜尋，最多掃描 CONFIG.HISTORY_MAX_SHEETS 張。
 * - 想換新表：把舊表改名，程式下次記錄時會自動重建一張新的使用中工作表。
 *
 * 寫入規則：同一來源 + 同一天 + 同商品(標準) + 同地點 → 覆蓋既有列，不新增（只比對目前使用中的工作表）。
 */

const SHEET_HEADERS = [
  '時間戳記', '來源ID', '原始訊息', '日期', '商品(標準)', '商品(原始)',
  '單位類型', '單位(標準)', '數量', '單價(標準單位)', '原始單位', '原始價格', '地點', '信心', '備註', '類別',
];

const VOCAB_CACHE_KEY = 'known_vocabulary_v1';

// ------------------------------------------------------------
// 工作表取得
// ------------------------------------------------------------

/** 取得（必要時建立）「目前使用中」的工作表，並確保表頭是最新版（舊表會自動補上新欄位標題） */
function getRecordSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
  }
  ensureSheetHeaders_(sheet);
  return sheet;
}

function ensureSheetHeaders_(sheet) {
  const n = SHEET_HEADERS.length;
  if (sheet.getLastRow() === 0) {
    if (sheet.getMaxColumns() < n) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), n - sheet.getMaxColumns());
    }
    sheet.appendRow(SHEET_HEADERS);
    sheet.setFrozenRows(1);
    return;
  }
  // 舊版工作表只有 15 欄：補上欄位與標題，不動既有資料
  if (sheet.getMaxColumns() < n) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), n - sheet.getMaxColumns());
  }
  const lastHeader = String(sheet.getRange(1, n).getValue() || '').trim();
  if (lastHeader !== SHEET_HEADERS[n - 1]) {
    sheet.getRange(1, n).setValue(SHEET_HEADERS[n - 1]);
  }
}

/** 是不是「價格記錄」格式的工作表（用表頭判斷，不看名稱） */
function isRecordSheet_(sheet) {
  if (sheet.getLastRow() < 1 || sheet.getLastColumn() < 5) return false;
  const h = sheet.getRange(1, 1, 1, 5).getValues()[0];
  return String(h[0]).trim() === SHEET_HEADERS[0] && String(h[4]).trim() === SHEET_HEADERS[4];
}

/** 取得「目前使用中」以外的紀錄工作表，依分頁由右到左排列（通常最右邊是最新建立的） */
function getArchiveSheets_(currentSheet) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const currentName = currentSheet.getName();
  return ss.getSheets()
    .filter(function (s) { return s.getName() !== currentName && isRecordSheet_(s); })
    .reverse();
}

function hasArchiveSheets_() {
  return getArchiveSheets_(getRecordSheet_()).length > 0;
}

/**
 * 要掃描哪些工作表。
 * @returns {{sheets: Sheet[], skipped: number}} sheets[0] 一定是目前使用中的工作表；skipped = 因超過上限而沒掃描的張數
 */
function getRecordSheets_(includeArchives) {
  const current = getRecordSheet_();
  if (!includeArchives) return { sheets: [current], skipped: 0 };
  const all = [current].concat(getArchiveSheets_(current));
  const max = Math.max(1, CONFIG.HISTORY_MAX_SHEETS || 10);
  return { sheets: all.slice(0, max), skipped: Math.max(0, all.length - max) };
}

// ------------------------------------------------------------
// 讀取
// ------------------------------------------------------------

/** 讀出某張工作表的所有紀錄（相容舊版 15 欄的表），回傳物件陣列 */
function readSheetRecords_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const n = SHEET_HEADERS.length;
  const width = Math.max(1, Math.min(n, sheet.getLastColumn()));
  const values = sheet.getRange(2, 1, lastRow - 1, width).getValues();
  const sheetName = sheet.getName();

  return values.map(function (row) {
    while (row.length < n) row.push('');
    return {
      sheetName: sheetName,
      timestamp: row[0],
      sourceId: String(row[1] || '').trim(),
      date: row[3],
      dateKey: normalizeDateForCompare_(row[3]),
      product: String(row[4] || '').trim(),
      productRaw: String(row[5] || '').trim(),
      unitType: row[6],
      normalizedUnit: row[7],
      quantity: row[8],
      normalizedUnitPrice: row[9],
      location: String(row[12] || '').trim(),
      category: String(row[15] || '').trim(),
    };
  });
}

/** 新到舊：先比消費日期，同一天再比寫入時間 */
function compareRecordsNewestFirst_(a, b) {
  if (a.dateKey !== b.dateKey) return a.dateKey < b.dateKey ? 1 : -1;
  const ta = a.timestamp ? new Date(a.timestamp).getTime() || 0 : 0;
  const tb = b.timestamp ? new Date(b.timestamp).getTime() || 0 : 0;
  return tb - ta;
}

/**
 * 模糊搜尋：商品(標準) 或 商品(原始) 只要符合任一查詢詞（含同義詞）就算（規則見 Search.js）。
 * @param {string[]} terms 查詢詞
 * @param {string} sourceId 限定來源（群組/個人）；空字串代表不限
 * @param {boolean} includeArchives true = 一併搜尋其他歷史工作表
 * @returns {{records: Object[], sheetsScanned: number, sheetsSkipped: number}} records 已依新到舊排序
 */
function searchRecords_(terms, sourceId, includeArchives) {
  const matcher = buildNameMatcher_(terms);
  const set = getRecordSheets_(includeArchives);
  const matched = [];

  set.sheets.forEach(function (sheet) {
    readSheetRecords_(sheet).forEach(function (rec) {
      if (!rec.product) return;
      if (sourceId && rec.sourceId !== sourceId) return;
      if (matcher(rec.product) || matcher(rec.productRaw)) matched.push(rec);
    });
  });

  matched.sort(compareRecordsNewestFirst_);
  return { records: matched, sheetsScanned: set.sheets.length, sheetsSkipped: set.skipped };
}

/**
 * 「記錄」時附帶的歷史價格：只看標準名稱「完全相同」的紀錄（不做模糊，避免把不同型號混在一起），
 * 但會跨所有工作表，這樣舊表封存後，「第一次記錄」的判斷也不會失準。
 * 注意：請在「寫入這次新紀錄之前」呼叫，才不會把這次自己剛寫入的資料也算進歷史。
 */
function getRecordsByCanonical_(productCanonical, sourceId, limit) {
  const want = normalizeText_(productCanonical);
  if (!want) return [];
  const set = getRecordSheets_(true);
  const matched = [];

  set.sheets.forEach(function (sheet) {
    readSheetRecords_(sheet).forEach(function (rec) {
      if (sourceId && rec.sourceId !== sourceId) return;
      if (normalizeText_(rec.product) === want) matched.push(rec);
    });
  });

  matched.sort(compareRecordsNewestFirst_);
  return matched.slice(0, limit);
}

// ------------------------------------------------------------
// 寫入
// ------------------------------------------------------------

/**
 * 寫入一筆紀錄。若同一來源、同一天、同商品、同地點已有紀錄，則覆蓋該列（取時間最新那一筆），
 * 避免同一天在同一家店重複記價長出多列。回傳 { overwritten: boolean }。
 */
function upsertRecord_(record) {
  const sheet = getRecordSheet_();
  const rowData = [
    new Date(),
    record.sourceId || '',
    record.rawMessage || '',
    record.date || '',
    record.productCanonical || '',
    record.productRaw || '',
    record.unitType || '',
    record.normalizedUnit || '',
    record.quantity != null ? record.quantity : '',
    record.normalizedUnitPrice != null ? record.normalizedUnitPrice : '',
    record.rawUnit || '',
    record.rawPrice != null ? record.rawPrice : '',
    record.location || '',
    record.confidence != null ? record.confidence : '',
    record.notes || '',
    record.category || '',
  ];

  const matchRow = findMatchingRecordRow_(
    record.sourceId || '',
    record.date || '',
    record.productCanonical || '',
    record.location || ''
  );

  let overwritten = false;
  if (matchRow > 0) {
    sheet.getRange(matchRow, 1, 1, SHEET_HEADERS.length).setValues([rowData]);
    overwritten = true;
  } else {
    sheet.appendRow(rowData);
  }

  invalidateVocabularyCache_();
  return { overwritten: overwritten };
}

/**
 * 找出「來源 + 日期 + 商品(標準) + 地點」完全相符的列號（1-based，只看目前使用中的工作表）。
 * 若有多筆（功能上線前累積的重複資料），回傳時間戳記最新的那一列。
 */
function findMatchingRecordRow_(sourceId, dateStr, productCanonical, location) {
  const sheet = getRecordSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;

  const wantDate = normalizeDateForCompare_(dateStr);
  const wantSource = String(sourceId || '').trim();
  const wantProduct = String(productCanonical || '').trim();
  const wantLocation = String(location || '').trim();
  if (!wantDate || !wantProduct) return -1;

  const values = sheet.getRange(2, 1, lastRow - 1, SHEET_HEADERS.length).getValues();
  let bestRow = -1;
  let bestTime = -1;

  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const rowSource = String(row[1] || '').trim();
    const rowDate = normalizeDateForCompare_(row[3]);
    const rowProduct = String(row[4] || '').trim();
    const rowLocation = String(row[12] || '').trim();

    if (rowSource !== wantSource || rowDate !== wantDate ||
        rowProduct !== wantProduct || rowLocation !== wantLocation) {
      continue;
    }

    const ts = row[0] ? new Date(row[0]).getTime() : 0;
    if (ts >= bestTime) {
      bestTime = ts;
      bestRow = i + 2; // 標題列佔第 1 列
    }
  }

  return bestRow;
}

/** 把試算表裡可能是 Date / 字串的日期欄統一成 yyyy-MM-dd，方便比對 */
function normalizeDateForCompare_(value) {
  if (value == null || value === '') return '';
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  }
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  }
  return s;
}

// ------------------------------------------------------------
// 已知商品 / 地點清單（給 Gemini 做名稱統一用）
// ------------------------------------------------------------

/**
 * 取得「最近用過」的標準商品（連同它過去出現過的別名）與地點清單。
 * 跨所有工作表統計，所以舊表封存後名稱仍然會延續使用；結果會快取一小段時間，有新紀錄就立刻清掉快取。
 * @returns {{products: {name: string, aliases: string[]}[], locations: string[]}}
 */
function getKnownVocabulary_() {
  const cache = CacheService.getScriptCache();
  try {
    const cached = cache.get(VOCAB_CACHE_KEY);
    if (cached) return JSON.parse(cached);
  } catch (err) {
    Logger.log('讀取名稱清單快取失敗，改為重新計算: ' + err);
  }

  const vocab = buildKnownVocabulary_();
  try {
    cache.put(VOCAB_CACHE_KEY, JSON.stringify(vocab), CONFIG.VOCAB_CACHE_SECONDS);
  } catch (err) {
    Logger.log('寫入名稱清單快取失敗（資料太大？）: ' + err);
  }
  return vocab;
}

function invalidateVocabularyCache_() {
  try {
    CacheService.getScriptCache().remove(VOCAB_CACHE_KEY);
  } catch (err) {
    Logger.log('清除名稱清單快取失敗: ' + err);
  }
}

function buildKnownVocabulary_() {
  const set = getRecordSheets_(true);
  const sheetsOldestFirst = set.sheets.slice().reverse(); // 目前使用中的最後處理，讓它的「最近」權重最高

  const products = Object.create(null); // name -> { seq, aliases: { alias: seq } }
  const locations = Object.create(null); // location -> seq
  let seq = 0;

  sheetsOldestFirst.forEach(function (sheet) {
    readSheetRecords_(sheet).forEach(function (rec) {
      seq++;
      if (rec.product) {
        const entry = products[rec.product] || (products[rec.product] = { seq: 0, aliases: Object.create(null) });
        entry.seq = seq;
        const raw = rec.productRaw;
        // 只收「看起來像單純商品名」的別名；舊資料裡可能夾帶數量價格的長字串就略過
        if (raw && raw.length <= 15 && !/\d/.test(raw) &&
            normalizeText_(raw) !== normalizeText_(rec.product)) {
          entry.aliases[raw] = seq;
        }
      }
      if (rec.location) locations[rec.location] = seq;
    });
  });

  const productList = Object.keys(products)
    .sort(function (a, b) { return products[b].seq - products[a].seq; })
    .slice(0, CONFIG.MAX_VOCAB_PRODUCTS)
    .map(function (name) {
      const aliasMap = products[name].aliases;
      const aliases = Object.keys(aliasMap)
        .sort(function (a, b) { return aliasMap[b] - aliasMap[a]; })
        .slice(0, CONFIG.MAX_ALIASES_PER_PRODUCT);
      return { name: name, aliases: aliases };
    });

  const locationList = Object.keys(locations)
    .sort(function (a, b) { return locations[b] - locations[a]; })
    .slice(0, CONFIG.MAX_VOCAB_LOCATIONS);

  return { products: productList, locations: locationList };
}

/**
 * 程式端的保險：Gemini 若給了一個「新名稱」，但這個名稱其實等同某個已知商品的標準名稱或別名，
 * 就直接歸併到那個已知商品，避免同一個東西被拆成多個名稱。
 * 一個別名同時屬於多個商品時（有歧義）就不歸併。
 */
function snapToKnownProduct_(canonical, raw, vocab) {
  const name = String(canonical || '').trim();
  if (!name || !vocab || !vocab.products) return name;

  const byName = Object.create(null);
  const byAlias = Object.create(null); // 正規化別名 -> 標準名稱；歧義的標成 null
  vocab.products.forEach(function (p) {
    byName[normalizeText_(p.name)] = p.name;
    (p.aliases || []).forEach(function (a) {
      const k = normalizeText_(a);
      if (!k) return;
      if (byAlias[k] === undefined) byAlias[k] = p.name;
      else if (byAlias[k] !== p.name) byAlias[k] = null;
    });
  });

  const keys = [normalizeText_(name), normalizeText_(raw)];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (!k) continue;
    if (byName[k]) return byName[k];
    if (byAlias[k]) return byAlias[k];
  }
  return name;
}
