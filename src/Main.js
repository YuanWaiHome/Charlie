/**
 * ============================================================
 * 主流程：接收 LINE Webhook → 解析 → 記錄或查詢 → 回覆
 * ============================================================
 */

function doGet(e) {
  return ContentService.createTextOutput('OK - LINE 價格記錄機器人運作中');
}

function doPost(e) {
  try {
    // 簡易防護：Worker 轉發時會帶上 token，沒帶對就不處理，避免被亂打的請求觸發（見 LineClient.js 說明）
    const expectedToken = getWebhookToken_();
    if (!e.parameter || e.parameter.token !== expectedToken) {
      Logger.log('收到 token 不符的請求，已忽略');
      return ContentService.createTextOutput('forbidden');
    }

    const body = e.postData.contents;
    const json = JSON.parse(body);
    const events = json.events || [];

    events.forEach(function (event) {
      try {
        handleEvent_(event);
      } catch (err) {
        Logger.log('處理單一事件時發生錯誤: ' + err + '\n' + (err && err.stack));
      }
    });
  } catch (err) {
    Logger.log('doPost 發生錯誤: ' + err + '\n' + (err && err.stack));
  }
  return ContentService.createTextOutput('OK');
}

function handleEvent_(event) {
  if (event.type !== 'message') return;

  const text = extractMentionedText_(event);
  if (text === null || text.trim() === '') return; // 沒tag到機器人，或不是文字訊息，忽略

  const sourceId = (event.source && (event.source.groupId || event.source.roomId || event.source.userId)) || 'unknown';
  const today = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const wantsHistory = text.indexOf(CONFIG.HISTORY_KEYWORD) !== -1; // 提到「歷史」→ 查詢時要搜尋所有工作表
  const vocab = getKnownVocabulary_();

  let parsed;
  try {
    parsed = parseMessageWithGemini_(text, vocab, today);
  } catch (err) {
    Logger.log('Gemini 解析失敗: ' + err);
    // Gemini 暫時掛掉時，如果訊息看起來像純查詢，就直接用文字去搜尋，不要讓使用者白等
    const fallback = buildFallbackQuery_(text);
    if (fallback) {
      handleQuery_(event, fallback, sourceId, wantsHistory);
      return;
    }
    replyToLine_(event.replyToken, [{
      type: 'text',
      text: '糟糕，我剛剛分析訊息時出了點問題，可以再傳一次看看嗎？🙏',
    }]);
    return;
  }

  const intent = (parsed && parsed.intent) || 'unknown';

  if (!parsed || parsed.unparsed || intent === 'unknown' || !parsed.items || parsed.items.length === 0) {
    replyToLine_(event.replyToken, [{
      type: 'text',
      text: '不好意思，我沒有抓到商品資訊耶 🥲\n' +
        '記錄可以這樣說：\n「豬梅花 一斤 205 竹圍漁港」\n「洗衣精 2公升 189 好市多」\n' +
        '查詢可以這樣說：\n「梅花肉」或「豬梅花多少錢」\n' +
        '想連舊 Sheet 的資料一起查，加上「' + CONFIG.HISTORY_KEYWORD + '」：\n「豬梅花 ' + CONFIG.HISTORY_KEYWORD + '」',
    }]);
    return;
  }

  if (intent === 'query') {
    handleQuery_(event, parsed, sourceId, wantsHistory);
    return;
  }

  handleRecord_(event, parsed, text, sourceId, today, vocab);
}

/**
 * Gemini 失敗時的備案：訊息裡沒有任何數字（不像在報價），就把整句話（去掉常見問句用語）當成查詢詞。
 * 靠 Search.js 的模糊比對，像「豬梅花多少錢」也能搜到「豬梅花」。
 */
function buildFallbackQuery_(text) {
  if (/\d/.test(text)) return null;
  const term = text
    .split(CONFIG.HISTORY_KEYWORD).join(' ')
    .replace(/多少錢|多少|價格|價錢|最近|查詢|幾錢|請問|查/g, ' ')
    .trim();
  if (!term) return null;
  return {
    intent: 'query',
    fallbackNote: 'ℹ️ AI 暫時無法使用，改用文字直接搜尋：',
    items: [{ product_canonical: term, product_raw: term }],
  };
}

/**
 * 查詢：不寫入試算表。
 * - 一般查詢：只查「目前使用中」的工作表，最多顯示最近 CONFIG.QUERY_LOOKBACK_COUNT 筆
 * - 帶「歷史」：搜尋所有工作表（最多 CONFIG.HISTORY_MAX_SHEETS 張），每個項目最多顯示 CONFIG.HISTORY_MAX_RECORDS 筆
 */
function handleQuery_(event, parsed, sourceId, wantsHistory) {
  const limit = wantsHistory ? CONFIG.HISTORY_MAX_RECORDS : CONFIG.QUERY_LOOKBACK_COUNT;
  const historyWord = normalizeText_(CONFIG.HISTORY_KEYWORD);

  // 避免 Gemini 把「歷史」二字誤當成商品名稱
  const usable = (parsed.items || []).filter(function (item) {
    const name = normalizeText_(item.product_canonical || item.product_raw || '');
    return name && name !== historyWord;
  });

  if (usable.length === 0) {
    replyToLine_(event.replyToken, [{
      type: 'text',
      text: '要查哪個商品呢？請加上商品名稱，例如：「豬梅花 ' + CONFIG.HISTORY_KEYWORD + '」',
    }]);
    return;
  }

  const items = usable.slice(0, CONFIG.MAX_QUERY_ITEMS);
  const hasArchive = hasArchiveSheets_();
  const blocks = [];
  if (parsed.fallbackNote) blocks.push(parsed.fallbackNote);

  items.forEach(function (item) {
    const label = item.product_canonical || item.product_raw || '';
    const result = searchRecords_(buildSearchTerms_(item), sourceId, wantsHistory);
    blocks.push(formatQueryReplyBlock_(label, result, wantsHistory, limit, hasArchive));
  });

  if (usable.length > items.length) {
    blocks.push('⚠️ 一次最多查 ' + CONFIG.MAX_QUERY_ITEMS + ' 項，其餘 ' + (usable.length - items.length) + ' 項請分開問。');
  }

  replyToLine_(event.replyToken, buildTextMessages_(blocks));
}

/** 記錄：寫入試算表，並附帶近期價格 */
function handleRecord_(event, parsed, text, sourceId, today, vocab) {
  const messageDate = (parsed.date && parsed.date.trim()) ? parsed.date.trim() : today;
  const sharedLocation = (parsed.location && parsed.location.trim()) ? parsed.location.trim() : '';
  const replyBlocks = [];

  parsed.items.forEach(function (item) {
    const price = Number(item.price);
    if (!item.product_canonical || !(price > 0)) {
      replyBlocks.push('⚠️ ' + (item.product_raw || '這項商品') + '：我沒抓到價格，這筆先沒記。若要查詢，直接說商品名即可。');
      return;
    }

    // 程式端保險：新名稱若其實等同某個已知商品的名稱/別名，就歸併過去，讓同商品永遠同一個標準名稱
    const canonical = snapToKnownProduct_(item.product_canonical, item.product_raw, vocab);
    const location = (item.item_location && item.item_location.trim()) || sharedLocation;
    const quantity = item.quantity != null && item.quantity !== '' ? item.quantity : 1;
    const unitRaw = item.unit_raw || '份';
    const category = item.category || '';
    const norm = computeNormalizedPrice_(quantity, unitRaw, price, category);

    // 查歷史要在「寫入這筆新紀錄之前」做，才不會把自己剛寫的也算進去。
    // 同一天同地點即將被覆寫的那筆也不列入「近期」，避免回覆裡還看到舊價。
    const rawHistory = getRecordsByCanonical_(canonical, sourceId, CONFIG.HISTORY_LOOKBACK_COUNT + 1);
    const history = rawHistory.filter(function (h) {
      return h.dateKey !== normalizeDateForCompare_(messageDate) ||
        String(h.location || '').trim() !== String(location || '').trim();
    }).slice(0, CONFIG.HISTORY_LOOKBACK_COUNT);

    const result = upsertRecord_({
      sourceId: sourceId,
      rawMessage: text,
      date: messageDate,
      productCanonical: canonical,
      productRaw: item.product_raw,
      unitType: norm.type,
      normalizedUnit: norm.normalizedUnit,
      quantity: quantity,
      normalizedUnitPrice: norm.normalizedUnitPrice,
      rawUnit: unitRaw,
      rawPrice: price,
      location: location,
      confidence: item.confidence,
      notes: item.notes || '',
      category: category,
    });

    replyBlocks.push(formatReplyBlock_(item, canonical, norm, location, history, result.overwritten));
  });

  replyToLine_(event.replyToken, buildTextMessages_(replyBlocks));
}

function formatQueryReplyBlock_(label, result, wantsHistory, limit, hasArchive) {
  const all = result.records;

  if (all.length === 0) {
    let msg = '🔎 ' + label + '\n   目前還沒有找到這項商品的紀錄。';
    if (!wantsHistory && hasArchive) {
      msg += '\n   💡 舊資料如果在其他 Sheet，加上「' + CONFIG.HISTORY_KEYWORD + '」可以一起查：「' + label + ' ' + CONFIG.HISTORY_KEYWORD + '」';
    } else {
      msg += '\n   要記錄的話可以說：「' + label + ' 205」';
    }
    return msg;
  }

  const total = all.length;
  const shown = all.slice(0, limit);

  // 符合的紀錄裡有幾種不同的標準名稱？多種的話，每一行都標出商品名，免得分不清
  const distinct = {};
  const names = [];
  all.forEach(function (r) {
    const k = normalizeText_(r.product);
    if (!distinct[k]) {
      distinct[k] = true;
      names.push(r.product);
    }
  });
  const multi = names.length > 1;

  const kind = wantsHistory ? '歷史' : '近期';
  let header = '🔎 ' + (multi ? label : names[0]) + '　' + kind + (multi ? '相關紀錄' : '價格');
  if (total > limit) {
    header += '（共 ' + total + ' 筆，僅顯示最近 ' + limit + ' 筆）';
  } else if (wantsHistory) {
    header += '（共 ' + total + ' 筆）';
  }
  header += '：';

  const lines = shown.map(function (h) {
    let seg = formatDateLabel_(h.dateKey);
    if (multi) seg += ' ' + h.product;
    seg += ' 每' + h.normalizedUnit + ' $' + h.normalizedUnitPrice;
    if (h.location) seg += '(' + h.location + ')';
    return '・' + seg;
  });

  let out = header + '\n' + lines.join('\n');

  if (total > limit) {
    if (!wantsHistory) {
      out += '\n👉 想看更多（含其他 Sheet 的舊資料，最多 ' + CONFIG.HISTORY_MAX_RECORDS + ' 筆）請加上「' +
        CONFIG.HISTORY_KEYWORD + '」：「' + label + ' ' + CONFIG.HISTORY_KEYWORD + '」';
    } else {
      out += '\n⚠️ 符合的紀錄太多，只顯示最近 ' + limit + ' 筆，可以把商品名稱說得更明確來縮小範圍。';
    }
  }
  if (wantsHistory && result.sheetsSkipped > 0) {
    out += '\n⚠️ Sheet 數量較多，只搜尋了最近的 ' + result.sheetsScanned + ' 張（還有 ' + result.sheetsSkipped + ' 張沒搜尋）。';
  }
  return out;
}

function formatReplyBlock_(item, canonical, norm, location, history, overwritten) {
  const prefix = overwritten ? '🔄' : '✅';
  let line = prefix + ' ' + canonical + '　每' + norm.normalizedUnit + ' $' + norm.normalizedUnitPrice;
  if (location) line += '（' + location + '）';
  if (overwritten) line += '\n   ✏️ 同一天同地點已有紀錄，已用新價格覆蓋';

  if (history.length > 0) {
    const histText = history.map(function (h) {
      let seg = formatDateLabel_(h.dateKey) + ' 每' + h.normalizedUnit + ' $' + h.normalizedUnitPrice;
      if (h.location) seg += '(' + h.location + ')';
      return seg;
    }).join('、');
    line += '\n   📋 近期：' + histText;
  } else if (!overwritten) {
    line += '\n   🆕 這是第一次記錄這項商品';
  }

  if (item.confidence != null && item.confidence < 0.6) {
    line += '\n   ⚠️ 這筆我不太確定有沒有抓對，有空可以確認一下';
  }
  if (item.notes) {
    line += '\n   💬 ' + item.notes;
  }

  return line;
}

/** yyyy-MM-dd → 今年顯示 MM/dd，其他年份顯示 yyyy/MM/dd（歷史查詢會跨年） */
function formatDateLabel_(dateKey) {
  if (!dateKey) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey));
  if (!m) return String(dateKey);
  const thisYear = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy');
  return m[1] === thisYear ? m[2] + '/' + m[3] : m[1] + '/' + m[2] + '/' + m[3];
}
