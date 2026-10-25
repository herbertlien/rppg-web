# 14 天放鬆練習：第一階段開發與測試手冊

> 2026-10-25。只在 `pilot-two-digital-products-20261025` 開發；未部署、無收款。這份文件不授權修改正式 LINE Webhook、Rich Menu、Supabase 或會員資料。任何影響正式 Deerly 的操作須另得使用者確認。

## 聊天室流程

1. 白名單受邀者輸入「放鬆測試」，收到奶油底／森林綠的 Flex 歡迎卡；可先查閱「完整資料說明」。不同意不建立問卷或會員。
2. 明確同意後，用 Quick Reply 一次回答一題，共五題：時段、每天分鐘、持續障礙、引導形式、提醒偏好。
3. 可上一題、先暫停。輸入「放鬆測試」選「繼續」恢復，也可明確重做。保健品舊進度不變；原生 Rich Menu 保持原狀，放鬆題請用各題訊息上的 Quick Reply。
4. 完成後收到心率選用卡。選「略過」直接取得相同的個人化預覽；選量測才開啟原有 rPPG LIFF 相機頁，另依量測頁的獨立同意保存數字。
5. 放鬆專用 LIFF 連結帶本次 `relaxPilot` ID。成功保存且品質合格時傳送「放鬆量測完成 <本次 ID>」，按「回聊天室」接續。相機拒絕、光線不足、未登入、拒絕保存、網路失敗或無訊息權限時，都能回聊天室略過；自動訊息失敗可手動點「我量好了」。一般量測原有「我量好了」訊息保持不變。
6. 結果卡說明個人化依據與偏好；意願卡展示 Day 1–2 短文字任務及 NT$1,290 測試價。語音／動畫、完整課程、購買及通知均未提供，不能當作已交付。
7. 點興趣只記錄時間，不產生訂單或付款。輸入「刪除放鬆測試資料」或按卡片刪除，只移除放鬆問卷、同意及意願，不刪原心率、保健品或會員。

## 程式與資料隔離

- `pilot/relax-flex.js`：四種可重用 Flex 卡片、完整揭露；繁中 altText、文字換行、最多一個主 CTA。使用 Deerly 原色，深綠按鈕配白字，文字對比至少 WCAG AA 4.5:1。
- `pilot/products.js`：原有五題與規則預覽；不由心率決定方案。本輪不修改第二款商品。
- `backend/linebot/handler.ts`：`rlx|` 專用路由，預設關閉、白名單限制、分次同意、暫停、恢復、刪除。
- `flow_id` 和 `revision` 綁定按鈕；資料庫 compare-and-set 防止舊卡片、連點或跨 instance 併發推進兩次。重複同意不清進度；重複意願不改首次時間。刪除後舊流程按鈕不可改新流程。
- `pilot/relax-liff.js`、根目錄 `index.html`：擴充既有量測頁的返回與通知，不新增影像上傳、不改正式 API URL 或預設登入流程。
- `backend/schema-digital-relax-pilot.sql`：只建／擴充獨立測試表，外鍵沿用 `users(id)`，RLS 開啟，僅 `service_role` 存取。五題答案與同意時間存於這張表，不寫 `quiz_sessions`、`intakes`、`packs`、原保健品 `consents`。
- 只有同意量測後才讀取原 `scans`。只呈現本次選量測之後、15 分鐘內、非未來、品質 ≥ 0.35、有限且 30–220 bpm 的紀錄；未合格可略過。心率不複製到放鬆表。
- 同意起最多保留 30 天，作答不延長。到期讀取會刪除；無活動資料須在**獨立測試資料庫**每日執行 `backend/cleanup-digital-relax-pilot.sql`。未建立清理排程前不得邀請測試者。上線前仍須正式隱私審查。

## 本機驗證（全合成資料，無正式 API）

需 Node.js 24（測試使用內建 TypeScript stripping，可能顯示實驗性警告），由 repo 根目錄執行：

```bash
node pilot/test.mjs
node backend/linebot/build.mjs
node --test engine/engine.test.mjs pilot/linebot.test.mjs pilot/flex-and-liff.test.mjs
node pilot/export-flex.mjs
```

Webhook 測試執行**打包後的 index.ts**，模擬 Supabase、LINE API，驗證 HMAC 簽章；不讀取網路或正式會員。涵蓋五題、拒絕、錯誤選項、上一題、暫停／恢復、白名單、關閉開關、資料庫故障、過期紀錄、舊卡片、重送／連點、跨 instance 併發、心率新鮮度與品質、意願、刪除，以及舊保健品作答恢復。會員 LIFF 入口是靜態回歸檢查，真實會員頁登入仍待手機驗證。

四個 `pilot/flex-samples/*.json` 使用虛構 flow ID 與範例偏好，不含會員資料。將各檔的 **`contents` 物件**貼到 LINE Flex Message Simulator 可預覽；完整 JSON 可供 API 審查。這是有效結構的本機測試，尚未向 LINE API 做官方驗證，也未取得 LINE App 截圖。

可選的真實 PostgreSQL 語義測試（WASM 記憶體資料庫，不使用資料庫連線字串）：

```bash
npm install --cache /tmp/rppg-npm-cache --prefix /tmp/rppg-sql-check --ignore-scripts --no-audit --no-fund @electric-sql/pglite@0.3.14
PGLITE_MODULE=file:///tmp/rppg-sql-check/node_modules/@electric-sql/pglite/dist/index.js node pilot/sql-check.mjs
```

驗證 migration 重跑、舊表升級、RLS／角色權限、保留期限清理、回退重跑及原表資料保持。PGlite 不代表正式 Supabase 整合驗證。

## 測試環境準備與回退（本輪不執行部署）

1. 先取得後續測試環境使用範圍的確認。必須是獨立非正式 Supabase、合成測試帳號及可隔離的 LINE／LIFF 測試設定；現有 LIFF 原始碼仍含正式 scan URL，**不得直接用此網址測試正式會員**。手機整合前須另行準備測試 API endpoint 和對應 LIFF 設定，不在本輪動正式設定。
2. 在該測試資料庫套用 `schema-digital-relax-pilot.sql`。先檢查既有 `users(id uuid)` 與 Supabase 角色，再重跑驗證；不可對正式資料庫執行。安排每日清理。
3. 測試 Function 需 `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`；僅在安全設定提供測試值。`RELAX_PILOT_ENABLED` 預設不是 `1`，測試時才開；`RELAX_PILOT_LINE_SUBS` 放測試 ID，`ADMIN_LINE_SUBS` 管理員亦可參與。不要啟用 `TEST_APPROVE`。
4. 保存上一版測試 Function bundle，測試整合須明確指向測試環境。本輪不部署、不呼叫 `setup`、不新增或覆蓋任何 Rich Menu、不接金流。
5. 回退：停用測試開關，回復上一版**測試** Function；必要時在測試資料庫執行 `rollback-digital-relax-pilot.sql`，只移除獨立測試表、不用 CASCADE，可重跑。這會刪除試驗資料，須確認用途；不是正式環境回退操作授權。

## iOS／Android 手機驗收（全部尚未執行）

兩個平台各自記錄 OS、LINE 版本與截圖；390px、360px 寬度、文字放大、深色模式都要確認：

- [ ] 四張 Flex 卡無文字／按鈕截斷，altText、朗讀順序可理解；原生聊天背景／Quick Reply 依 LINE 外觀。
- [ ] 歡迎→完整說明→拒絕不建紀錄；同意→五題→上一題→暫停→恢復；連點不跳題。
- [ ] 相機拒絕、弱光、未登入、未同意保存、網路中斷皆可回聊天室略過。
- [ ] 量測正常保存後，自動通知／無 sendMessages 權限手動接續皆可；舊紀錄不出現。
- [ ] 關閉 LIFF 後回正確聊天室；過期連結與重做不混用本次紀錄。
- [ ] 結果個人化有依據，兩天任務明確標為預覽，興趣不是付款、不開啟提醒。
- [ ] 保健品問卷填到一半再做放鬆問卷，原選單不被替換；返回原題、我的組合、我的 Deerly／會員入口正常。
- [ ] 刪除只刪放鬆資料；確認 30 天清理已在測試環境運作。

**目前可審查程式碼與本機模擬結果，尚不能進入受邀用戶實測。** 仍待獨立測試服務／LIFF 設定、官方 Flex 驗證、兩平台手機驗收、隱私與保留期限確認；不需要也未取得正式上線授權。
