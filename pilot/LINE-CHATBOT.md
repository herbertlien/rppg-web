# 14 天放鬆計畫：LINE Chatbot 測試操作手冊

> 截至 2026-10-25：程式已寫在測試分支，**沒有部署、沒有正式收款**。此手冊是部署前檢查表，不代表官方帳號目前已能使用「放鬆測試」。

## 用戶體驗：只用原有 LINE 官方帳號

1. 受邀測試者對原本 Deerly 官方帳號傳送「放鬆測試」。
2. Chatbot 先顯示專屬同意說明（與保健品問卷分開）。
3. 同意後，Chatbot 用 **Quick Replies** 逐題詢問 5 題，無須跳到外部問卷網站。
4. 問完後可選「同意，量測心率」或「略過，看我的方案」。
5. 選量測者由 LINE 快速回覆開啟原本的 rPPG **LIFF** 頁；影像分析仍發生在手機上的 LIFF 頁面。原頁保存與刪除說明獨立生效。
6. 原 LIFF 成功保存量測後，在聊天室送出「我量好了」；Bot 只取本次開始後、訊號品質足夠的新紀錄，以參考數值附在預覽中。若無新紀錄，可略過。
7. Bot 在聊天室顯示個人化原因、前兩天練習任務及 NT$1,290 測試價格，詢問「有興趣嗎？」。按鈕只記錄意願，**不扣款**。
8. 使用者可輸入「刪除放鬆測試資料」刪除放鬆問卷和意願紀錄，不會刪除原本保健品或心率紀錄。

**關鍵：LINE 是入口、問卷與交付介面；原有 GitHub Pages 只託管 LIFF 相機頁和圖片；Supabase 接收 LINE Webhook、存放問卷與回傳結果。此流程不需要 Cloudflare。**

## 源碼

- `backend/linebot/handler.ts`：新增以 `rlx|` 開頭的事件處理、對話、心率完成訊息及興趣記錄。
- `pilot/products.js`：沿用可配置的五題問卷和規則式 14 天預覽產生器。
- `backend/linebot/build.mjs`：把上述設定連同既有規則打包到 Edge Function。
- `backend/linebot/index.ts`：重新產生的完整部署候選檔；尚未發布。
- `backend/schema-digital-relax-pilot.sql`：獨立存放放鬆測試的 Supabase 資料表。

## 在原本官方帳號進行限定測試：部署前必做

1. 確認可回復至上一版 `linebot` Edge Function 的方式，先備份現行已部署版本。
2. 在 Supabase SQL Editor 執行 `backend/schema-digital-relax-pilot.sql`，確認只新增 `digital_relax_pilot_sessions`，不改 `quiz_sessions`、`intakes`、`packs`。
3. 在既有 `linebot` Function 設置以下 Secrets：
   - `RELAX_PILOT_ENABLED=1`：僅啟用限定測試路由；未設定時不會啟動。
   - `RELAX_PILOT_LINE_SUBS=<一個或多個受邀 LINE userId，以逗號分隔>`；既有 `ADMIN_LINE_SUBS` 裡的管理員也可測。
4. 本機從 repo 根目錄跑 `node backend/linebot/build.mjs`，確認生成的 `backend/linebot/index.ts` 已包含放鬆流程，且原本保健品流程未變。
5. 部署新 `backend/linebot/index.ts` 到**目前 LINE Messaging API Webhook 指向的原 Supabase `linebot` Function**。不必修改 LINE 官方帳號 webhook URL，不必新建 LINE 帳號，也不要先更動既有 Rich Menu。
6. 用在白名單內的 LINE 使用者傳送「放鬆測試」。沒有列入白名單的使用者，即使輸入相同指令也只會看到未開放訊息。
7. 用兩支不同手機的 LINE App（建議 iOS 和 Android）分別測：同意、5 題、返回上題、量測、跳過、結果、意願、刪除資料；另外確認「開始問卷」「今日電量」「我的組合」原有入口仍正常。
8. 測試結束後將 `RELAX_PILOT_ENABLED` 改為 `0`，或回復先前的 Function 版本。

**提醒**：程式碼已完成基本規則檢查，但尚未在真實 LINE App、Supabase 和金流環境測試，因此不能視為可直接營運的完成品。

## 需要檢查的邊界情境

- 未在白名單的人不應能填寫試驗問卷。
- 使用者拒絕同意時不能建立試驗資料。
- 同一人同時有舊保健品問卷進度，不應因測試而覆寫舊進度；若 Rich Menu 正處於舊問卷狀態，介面可能有干擾，需做實機 UI 測試。
- 開相機拒絕權限、弱光、未保存、訊號品質不足時，必須能略過。
- 舊心率紀錄不能被當作本次新量測。
- LIFF 的 `liff.sendMessages` 僅在支援條件下可用；若沒有傳送訊息，使用者可回聊天室手動輸入「我量好了」。
- 「有興趣」只能記錄為 `interest_clicked_at`；沒有付款成功事件，不可當作成交。
- 本測試用戶的資料保留期限、刪除、隱私文字與定價須經正式審查才能公測。

## 首輪觀察

- 先用 5–10 位受邀測試者，人工記錄能否不靠教學完成 LINE 問卷、LIFF 量測和回到聊天室。
- 測試「你願不願意以 NT$1,290 購買完整 14 天方案」並記錄反對理由。
- 下一步再增加真正付款、可計算分母的訪客／體驗漏斗和完整 14 天交付。
