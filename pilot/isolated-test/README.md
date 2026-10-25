# 隔離測試環境準備

只在 `pilot-two-digital-products-20261025` 開發。正式 Deerly 的 Supabase、LINE 官方帳號、Webhook、圖文選單、會員與 GitHub Pages 一律不動。本工具**僅產生檔案，不部署、不呼叫服務、不開資料庫連線**。

## 已備妥與目前限制

- 準備工具會在 checkout 以外的新目錄產生 `site/`、三個 Supabase Functions、四份新測試資料庫 migrations、清理與回退腳本。
- 原始碼不改正式連線設定；**只在產物中**替換為指定的測試 Supabase、LINE Login Channel／LIFF、網站網址。
- 產物中不能殘留已知正式專案、LINE ID 或正式網站識別；Function 必須有 `RELAX_ISOLATED_TEST=1` 且 `SUPABASE_URL` 完全符合設定，否則在建立 DB client 前拒絕啟動。
- 產物的 LINE Rich Menu 管理入口已封鎖，既有選單切換呼叫亦不對外送出。沒有金流設定或部署指令。
- 因禁止 Rich Menu 管理，此新測試包不建立保健品題目選單；不可把它當成已完成保健品手機操作回歸。原測試分支的引擎／Webhook 模擬測試仍用於驗證資料隔離，正式功能沒有被改寫。
- 範例配置使用 `.invalid` 及虛構 ID；產物標示 `template-not-connectable`，**不可當成已連通手機的測試環境**。尚未建立外部帳號或託管網址、未部署、未安排清理排程。
- 此環境沒有 Supabase／LINE 管理連接工具，也沒有可用測試 credentials；需由使用者在各服務後台建立／提供公開識別，再進行連通驗證。

## 先建立的測試資源

1. **獨立 Supabase 專案**：建議名稱 `deerly-pilot-test`，不要選正式專案；不從正式資料庫複製任何資料。記下 Project URL 與 project ref。建立前依方案確認可能的費用。
2. **獨立 LINE 測試官方帳號**：在該帳號的 Official Account Manager 啟用 Messaging API。不要在正式 Deerly 操作。記下所屬 Provider，後續只在測試帳號設定 Webhook。
3. **測試 LINE Login Channel 與 LIFF**：在與該測試 Messaging API Channel 相同的 Provider 下建立；這樣測試者身分才可對應。Login Channel ID 與 Messaging API Channel ID 是不同用途；本工具的 `lineChannelId` 指 **LINE Login Channel ID**，必須與 LIFF ID 的數字前綴一致。
4. **獨立 HTTPS 靜態測試網址**：用來放產物 `site/`（含 vendor 模型與 WASM），不要更新原正式 GitHub Pages，也不要把整個產物目錄當靜態網站公開。此步需選擇可用的獨立靜態託管服務，不能把 localhost 當作手機 LIFF endpoint。
5. 在測試 LIFF 設定該測試網址，需 `openid`，視既有使用頁需求開 `profile`；若可用且需自動通知，再設 `chat_message.write`。沒有訊息權限仍能手動回聊天室。將測試 LINE Login 連結至測試官方帳號，並安排測試者／Channel 開發者權限；不改正式 Channel。

**可以在聊天提供的公開資訊**：測試 Supabase Project URL、LINE Login Channel ID、LIFF ID、HTTPS 測試網站 URL，以及測試官方帳號是否已建立。測試者的 LINE userId 可於安全設定填入，不必在公開 PR 提供。

**不要在聊天或 Git 提供**：Channel Secret、Channel Access Token、Supabase service-role key、資料庫密碼或管理平台 access token。LINE 值只在測試 Supabase Function 的 Secrets 設定；service-role key 使用測試 Supabase 的內建 Function 環境，不能放到前端。資料庫密碼只在服務的安全操作流程使用。

## 產生產物

從 repo 根目錄操作，不需要 npm 安裝：

```bash
# 不可使用正式分支；若分支不符先停止
git branch --show-current
# 複製公開設定範例到 checkout 外，填入「測試」值；不能填 secrets
cp pilot/isolated-test/config.example.json /workspace/rppg-isolated-public.json
# 每次使用新輸出路徑；工具不覆寫既有目錄
node pilot/isolated-test/prepare.mjs /workspace/rppg-isolated-public.json /workspace/rppg-isolated-build-01
node --test pilot/isolated-test/prepare.test.mjs
```

已知正式 ID、非 HTTPS、帶密碼 URL、不同 Channel 的 LIFF，以及任何未定義的設定欄位都會拒絕。`.invalid` 是不連通的範例；換成真實測試資料後狀態為 `configured-not-deployed`，仍不代表已部署。工具重新打包的 intake 含原引擎最新內容，僅位於隔離產物，不修改原 tracked bundle。

## 後續測試部署所需設定（本次沒有執行）

在**確認後的測試專案**：

- Functions：`scan`、`intake`、`linebot`。產物 `supabase/config.toml` 對這三者關閉平台 JWT 驗證，因程式自行驗證 LINE ID token 或 Webhook HMAC；這不等於略過應用程式驗證。
- `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`：測試專案 Function 的內建環境值，前者必須等於公開設定。
- 自訂設定：`RELAX_ISOLATED_TEST=1`、`RELAX_PILOT_ENABLED=1`、`RELAX_PILOT_LINE_SUBS` 僅含受邀測試 ID。先不要放正式管理員 ID，非必要不設 `ADMIN_LINE_SUBS`。
- 自訂 Secrets：測試官方帳號的 `LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`；核對 Messaging API Channel 確實屬於測試官方帳號。
- `supabase/migrations/` 只用於新建的空白測試資料庫；第一份會在既有 users 表存在時拒絕。不得對正式專案執行，也不匯入正式會員。先在本機的隔離 PostgreSQL/WASM 跑 `schema-check.mjs`。
- 測試網站只發布 `site/`，不發布後端／SQL／Secrets。網站 URL 必須與 config 一致；產物已改寫 CORS origin。
- 部署前核對 CLI 選取的 project ref、Function 環境、網站及測試官方帳號；資料庫 bootstrap guard 不足以識別「另一個空白正式專案」，因此核對目標仍是必要步驟。
- 只有測試官方帳號可以連到 `<測試 Project URL>/functions/v1/linebot`；不要開啟任何正式 Webhook，不呼叫 setup／Rich Menu API。
- 每日執行產物 `operations/cleanup-digital-relax-pilot.sql` 的**測試專案**排程仍待建立。無排程、隱私審查及手機驗收前不邀請外部用戶。

## 已驗證與試用順序

自動化：正式設定拒絕、產物正式識別掃描、三個 Function 啟動 guard、Rich Menu 呼叫封鎖、原五題／Flex／LIFF 回歸測試。完整 schema 的八張表與 RLS 已在記憶體 PostgreSQL/WASM 驗證，使用合成 LINE 身分；未連外部資料庫。

```bash
node --test engine/engine.test.mjs pilot/linebot.test.mjs pilot/flex-and-liff.test.mjs pilot/isolated-test/prepare.test.mjs
# 可選：使用既有 PGlite 臨時安裝（安裝方式見 ../LINE-CHATBOT.md）
PGLITE_MODULE=file:///tmp/rppg-sql-check/node_modules/@electric-sql/pglite/dist/index.js node pilot/isolated-test/schema-check.mjs /workspace/rppg-isolated-build-01
```

當外部測試服務連通後，先由一位測試者：加測試帳號好友→「放鬆測試」→完整說明／同意→五題→**先略過量測**→結果／意願→刪除。這條通過後，再測獨立 LIFF 的相機與回聊天室，最後做 iOS／Android 清單（見 `pilot/LINE-CHATBOT.md`）。所有資料僅限測試者授權新產生的測試紀錄，不使用正式會員歷史資料。

回退只針對測試：停用測試 flag、停用測試 Webhook、保留產物以便恢復；資料刪除只用 `operations/rollback-digital-relax-pilot.sql` 移除試驗表。既有 users/scans/intakes 等屬獨立測試專案，整體測試專案的刪除不由這個腳本執行。
