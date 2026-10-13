# LINE 商品價格記錄機器人

用 LINE 群組 tag 機器人，自動把「商品、單位、價格、地點、日期」解析存檔，
並回覆同商品近期記錄過的價格。商品不限買菜，日用品、家電、服飾等一般購物也能記。使用 **Google Sheets 當資料庫 + Google Apps Script 當後端 + Gemini API 做語意解析**，整體完全免費、不需要信用卡、不需要另外租主機。

> 補充：中間多了一層 **Cloudflare Worker** 轉接，原因是 Google Apps Script 的網頁應用程式網址天生會回 302 轉址，LINE 的 Webhook 機制不會跟著轉址走，所以沒辦法直接把 Apps Script 網址設成 LINE 的 Webhook URL，需要一個小轉接層。這層一樣是免費方案、不用信用卡。

## 架構

```
LINE 使用者 @tag 機器人
      │
      ▼
LINE Webhook ──→ Cloudflare Worker（轉接層，驗證官方簽章、自帶 HTTPS 網址）
                        │
                        ▼
                  Google Apps Script（網頁應用程式）
                        │
                        ├─ 呼叫 Gemini API 解析文字
                        │   → 拆解成 {日期, 商品(標準化), 單位, 數量, 價格, 地點}
                        │
                        ├─ 用 Units.js 的規則換算成統一單位（重量類一律換算成「斤」）
                        │
                        ├─ 讀寫 Google Sheet（當資料庫，存紀錄 + 查歷史價格）
                        │
                        └─ 呼叫 LINE Reply API 回覆「已記錄 + 近期歷史價格」
```

## 專案檔案說明

| 檔案 | 用途 |
|---|---|
| `src/appsscript.json` | Apps Script 專案設定檔（manifest） |
| `src/Config.js` | 全域設定、讀取機密的指令碼屬性 |
| `src/Units.js` | 單位換算邏輯（重量類統一換算成「斤」、容量類統一換算成「公升」，計數類統一用字）、商品類別清單 |
| `src/Search.js` | 文字正規化與模糊比對（查詢時讓「梅花肉」也能找到「豬梅花」） |
| `src/GeminiClient.js` | 呼叫 Gemini API，把口語文字拆解成結構化 JSON |
| `src/SheetStore.js` | 讀寫 Google Sheet（寫入紀錄、跨多張工作表搜尋、取得已知商品/別名清單） |
| `src/LineClient.js` | LINE 訊息回覆、判斷是否「tag了機器人」 |
| `src/Main.js` | `doPost`/`doGet` 進入點，串起整個流程 |
| `worker/relay.js` | Cloudflare Worker 轉接層：驗證 LINE 簽章、轉發給 Apps Script |

## 設定步驟

### 1. 建立 Google Sheet 並開啟 Apps Script

1. 到 Google Drive 新增一個 Google 試算表，命名隨意（例如「家用食材價格記錄」）。
2. 選單「擴充功能 → Apps Script」，會開啟一個跟這份試算表綁定的程式編輯器。

### 2. 貼上程式碼

在 Apps Script 編輯器左側檔案列表：

1. 把預設的 `Code.gs` 內容整個刪掉，貼上 `src/Main.js` 的內容（檔名可以留 `Code.gs`，或改名叫 `Main`，Apps Script 會自動補 `.gs`）。
2. 用左側「＋ → 指令碼」依序新增檔案，分別貼上：`Config.js`、`Units.js`、`Search.js`、`GeminiClient.js`、`SheetStore.js`、`LineClient.js` 的內容（檔名不用加 `.gs`，系統會自動加）。
3. 左側齒輪圖示「專案設定」→ 勾選「在編輯器中顯示 appsscript.json 資訊清單檔案」，回到編輯器會多一個 `appsscript.json`，把內容換成 `src/appsscript.json` 的內容存檔。

完成後左側應該有 7 個 `.gs` 檔 + 1 個 `appsscript.json`。

> 從舊版升級：把上述檔案內容全部覆蓋更新（記得新增 `Search.js`），再「部署 → 管理部署作業 → 編輯 → 新版本」。舊的「價格記錄」工作表不用動，第一次記錄時程式會自動補上第 16 欄「類別」的標題。

### 3. 設定機密資訊（指令碼屬性）

左側齒輪圖示「專案設定」→ 往下捲到「指令碼屬性」→「新增指令碼屬性」，新增以下 3 筆：

| 屬性名稱 | 值 | 從哪裡拿 |
|---|---|---|
| `GEMINI_API_KEY` | 你的 Gemini Key | [aistudio.google.com](https://aistudio.google.com/) → Get API key |
| `LINE_CHANNEL_ACCESS_TOKEN` | 你的 Channel Access Token | LINE Developers Console → 你的 Messaging API Channel → Messaging API 分頁 → 發行 Channel access token |
| `WEBHOOK_TOKEN` | 自己想一組亂數字串 | 可以回到編輯器頂端下拉選單選 `generateWebhookToken`，按執行，再去「執行項目」/「執行記錄」複製產生的字串。這組字串等一下設定 Cloudflare Worker 時還會再用到一次，兩邊要填「一模一樣」的值 |

### 4. 部署成網頁應用程式

1. 編輯器右上角「部署 → 新增部署作業」。
2. 類型選「網頁應用程式」。
3. 「執行身份」選「我」；「誰可以存取」選「任何人」。
4. 按「部署」，第一次會要求你授權（因為程式要讀寫試算表、呼叫外部 API），照指示允許即可。
5. 複製產生的網址，格式類似：`https://script.google.com/macros/s/AKfyxxxxx/exec`

> ⚠️ 之後如果有改程式碼，要記得「部署 → 管理部署作業 → 編輯（鉛筆圖示）→ 版本選新版本 → 部署」，網址才會套用新程式碼。

### 5. 建立 Cloudflare Worker 轉接層

因為 LINE 不會跟著 Apps Script 網址的 302 轉址走，所以需要這一層小轉接。到 [dash.cloudflare.com](https://dash.cloudflare.com/)（免費註冊、不用信用卡）：

1. 左側選單「**Compute**」→ 進去找 **Workers**（新版介面把 Workers 收在 Compute 底下）。
2. 「Create」→ 選建立 **Worker**（不是 Pages），取個名字（例如 `line-price-bot-relay`），系統會自動配一個網址，格式像：
   `https://line-price-bot-relay.你的帳號子網域.workers.dev`
3. 建立後會先給你一個預設範例程式，進到這個 Worker 的編輯畫面（通常是「Edit code」或類似按鈕），把裡面的程式**整個刪掉**，貼上 `worker/relay.js` 的內容，存檔並部署（Save and deploy / Deploy）。
4. 回到這個 Worker 的總覽頁，找「**Settings → Variables and Secrets**」（環境變數），新增 3 筆：

   | 名稱 | 類型 | 值 |
   |---|---|---|
   | `LINE_CHANNEL_SECRET` | Secret（加密） | LINE Developers Console → 你的 Channel →「**Basic settings**」分頁 → Channel secret（就是你之前截圖看到的那個） |
   | `APPS_SCRIPT_URL` | 一般文字 | 步驟4複製的 Apps Script 網址，**不要**加任何 `?` 參數，例如 `https://script.google.com/macros/s/AKfyxxxxx/exec` |
   | `WEBHOOK_TOKEN` | Secret（加密） | 跟步驟3設定的 `WEBHOOK_TOKEN` 填**一模一樣**的值 |

5. 存檔後重新部署一次（有些版面存變數會自動重新部署；不確定就手動按一次 Deploy），確保變數生效。
6. 複製這個 Worker 的網址備用（下一步會用到）。

### 6. 到 LINE Developers Console 設定 Webhook

1. 回到 [developers.line.biz/console](https://developers.line.biz/console/)，進入你的 Messaging API Channel。
2. 「Messaging API」分頁：
   - Webhook URL 直接填 **Cloudflare Worker 的網址**（不用加任何 `?token=...`，因為現在驗證是用官方的簽章機制，在 Worker 裡完成），例如：
     `https://line-price-bot-relay.你的帳號子網域.workers.dev`
   - 按「Verify」測試，這次應該會顯示成功（200）。
   - 把「Use webhook」打開。
   - 把「Auto-reply messages」「Greeting messages」都關掉（避免機器人自己也回一些罐頭訊息造成干擾）。
3. 把這個官方帳號加為好友（Console 頁面有 QR code），邀請進你的家庭群組。

### 7. 測試

- 先在 Apps Script 編輯器，頂端下拉選單選 `testParse`，按執行，去「執行記錄」確認 Gemini 有正確回傳解析結果（這一步不需要 LINE，純測試 Gemini Key 是否正常）。
- 接著在家庭群組裡，用 LINE 的 @ 功能實際 tag 機器人（輸入 `@` 後從建議清單點選機器人名稱，不要只是手打文字），加上內容，例如：
  ```
  @機器人 豬梅花一斤205、活草蝦一斤750 竹圍漁港
  ```
  語序也可以顛倒，例如「`200元一斤豬梅花`」或「`一斤豬梅花 200`」，會記成同一種結構。
- 應該會收到類似：
  ```
  ✅ 豬梅花　每斤 $205（竹圍漁港）
     🆕 這是第一次記錄這項商品

  ✅ 活草蝦　每斤 $750（竹圍漁港）
     🆕 這是第一次記錄這項商品
  ```
- 之後同樣商品再記一次，就會在下面看到「📋 近期：...」列出前幾次的價格。
- **同一天、同地點、同商品再記一次會覆蓋**：不會多長一列，回覆會顯示 `🔄` 並提示已用新價格覆蓋。不同日期或不同地點仍會各自留一筆。
- **純查詢**（不會寫入新紀錄）：只 tag 商品名，或問「多少錢」即可，例如：
  ```
  @機器人 梅花肉
  @機器人 豬梅花多少錢
  ```
  會回類似：
  ```
  🔎 豬梅花　近期價格：
  ・10/13 每斤 $205(竹圍漁港)
  ・10/10 每斤 $198(市場)
  ```
  也可以一次查多項（一則訊息最多 5 項）：`@機器人 梅花肉 草蝦`
- **查得到同一商品的不同說法**：查詢時不要求名稱完全一樣。程式會同時比對「標準名稱」和「你過去實際打過的說法（商品(原始) 欄）」，再加上 AI 想到的同義詞與模糊比對，所以查「梅花肉」也能找到記成「豬梅花」的紀錄，查「蝦」會列出所有名稱含「蝦」的商品。符合的商品有多種時，每一行會標出商品名稱。
  - 模糊比對寧可多找一點，偶爾會多帶出名稱相近但其實不同的商品（例如「牛小排」和「小排骨」），看商品名稱即可分辨。若兩邊都有數字且不同（例如 iPhone 15 與 iPhone 16），會視為不同型號、不互相命中。
- **一般查詢最多顯示最近 10 筆**（只查目前使用中的「價格記錄」工作表），超過時會提示「共 N 筆，僅顯示最近 10 筆」。
- **查「歷史」**：訊息中只要有「歷史」二字，就會一併搜尋所有 Sheet（見下一節），例如：
  ```
  @機器人 梅花肉 歷史
  ```
  為避免畫面與系統負擔過大：每個商品最多顯示最近 **30** 筆、最多掃描 **10** 張 Sheet、一則訊息最多查 5 項、回覆自動分段（LINE 單則上限 5000 字），都可以在 `Config.js` 調整（`HISTORY_MAX_RECORDS`、`HISTORY_MAX_SHEETS`、`MAX_QUERY_ITEMS`）。
- **記錄一般購物**：不限生鮮，例如：
  ```
  @機器人 洗衣精 2公升 189 好市多
  @機器人 電鍋一台 1980 好市多
  ```
  單位除了斤／兩／公斤，也支援公升／毫升（換算成每公升的價格），以及件、瓶、組、雙、箱、袋...等計數單位。AI 會自動判斷「類別」並寫入試算表第 16 欄。「台」在買菜是「台斤」，但在家電類別就是「一台」，會依類別自動判斷。

### 8. 查看/修正資料

所有記錄都在試算表的「價格記錄」工作表裡，一列一筆，欄位包含標準化後的商品名稱、單位、單價等。如果 AI 偶爾判斷錯誤（例如商品名稱正規化錯誤、單位抓錯），可以直接在試算表裡手動修正那一格，完全不用改程式。

同一來源（同一個群組）、同一天、同商品、同地點再送一次，程式會**覆蓋**那一列而不是新增；若要保留兩筆不同價格，請改記不同地點，或手動在試算表複製一列後再改。

**想讓同一個商品的紀錄更統一**：如果發現同一個東西被記成兩個名稱，直接在試算表把「商品(標準)」欄改成同一個名稱即可，下次記錄時 AI 會參考新的名稱（名稱清單有最長 10 分鐘的快取；有新紀錄時會立刻更新）。「商品(原始)」欄會被當成這個商品的「別名」，保留它有助於之後的比對。

### 9. 資料太多時開新的 Sheet

1. 把目前的「價格記錄」工作表**改名**（例如「價格記錄_2026」），不要刪欄位、不要動第一列標題。
2. 下一次有人記錄時，程式會自動重新建立一張全新的「價格記錄」，之後新紀錄都寫在這張新表。
3. 一般查詢（沒有「歷史」二字）只查新的「價格記錄」；查詢時加上「歷史」，才會把所有舊 Sheet 一起搜尋。
4. 程式是用「第 1 列標題是 時間戳記 … 商品(標準)」來判斷哪些 Sheet 算歷史資料，所以改成什麼名字都可以；不是這個格式的工作表（例如你自己做的統計表）會被忽略。
5. 歷史 Sheet 超過 10 張時，只會搜尋分頁最右邊（通常是最新建立的）那 10 張，並在回覆中提醒。
6. 即使舊表封存了，AI 在統一商品/地點名稱時仍會參考所有 Sheet 裡用過的名稱，不會因為換新表就重新亂取名。

## 已知限制 / 未來可以升級的方向

- **Webhook 安全性**：已經用 Cloudflare Worker 讀取 `X-Line-Signature` header，做官方建議的 HMAC-SHA256 簽章驗證，確認請求真的是 LINE 平台送來的，不是用猜測亂數 token 的簡易做法。Worker 轉發給 Apps Script 時仍額外帶一組 `WEBHOOK_TOKEN` 當第二層防護（就算有人挖到 Apps Script 的網址，沒有這組 token 也打不通）。
- **回覆逾時備援**：LINE 的 reply token 大約只有 30 秒有效。Worker 會先立刻回 200 再轉發 Apps Script；若解析／寫入較慢導致 reply 失敗，程式會改用 Push API 把同一則結果補送回「同一個對話」（群組就推回群組），避免「做完了但訊息石沉大海」。
- **Gemini 失敗可讀**：呼叫失敗時會標出階段（連線／API Key／配額／模型／內容過濾／解析結果等）。若訊息看起來像純查詢，會改用文字直接搜尋，並在回覆裡附上失敗原因。
- **語序自由**：記錄時「豬梅花一斤200」與「200元一斤豬梅花」視為同一筆；順序不影響解析。
- **查詢範圍**：目前查詢是以「同一個 LINE 來源（同一個群組/同一個人）」為範圍查詢。如果你同時在多個群組使用這個機器人，各群組的記錄會分開，不會互通。
- **Google Sheets 當資料庫**：資料量在幾千筆以內完全沒問題，家庭用途預期可以用非常久；真的量很大以後要換成正式資料庫，再重寫 `SheetStore.js` 這一層即可，其他程式不用動。
- **模型名稱**：`Config.js` 裡的 `GEMINI_MODEL` 若未來該型號被停用，到 [ai.google.dev/gemini-api/docs/models](https://ai.google.dev/gemini-api/docs/models) 查目前可用的模型名稱替換即可。
