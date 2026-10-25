# 第一階段審查摘要

2026-10-25，Issue #32；分支 `pilot-two-digital-products-20261025`。僅程式開發，不部署、不合併 main、不改 Webhook／Rich Menu、不接金流、不使用正式會員資料。

## 本次變更

| 範圍 | 結果 |
| --- | --- |
| `pilot/relax-flex.js`、`flex-samples/`、`export-flex.mjs` | 歡迎、選用心率、個人化結果、價格意願四卡；奶油白／森林綠，完整 altText 與可讀取完整資料說明 |
| `backend/linebot/handler.ts`、`build.mjs`、`index.ts` | 五題 Quick Reply、上一題、暫停／恢復、重做、刪除；本次 ID 與 revision 防止舊卡片／連點／跨 instance 重複寫入；獨立白名單與同意 |
| `index.html`、`pilot/relax-liff.js` | 使用既有 rPPG 頁，增加放鬆專用通知與返回／略過入口；保留一般量測流程與 API URL |
| `backend/*digital-relax-pilot.sql` | 獨立表的可重跑升級、30 天清理與回退腳本；僅測試資料庫使用 |
| 測試與 `LINE-CHATBOT.md` | 全合成資料測試、Simulator JSON、測試服務設定需求與 iOS／Android 清單 |

## 已執行結果

- `node pilot/test.mjs`：兩商品原有規則檢查通過。
- `node backend/linebot/build.mjs`：成功；再次打包內容一致。
- `node --test engine/engine.test.mjs pilot/linebot.test.mjs pilot/flex-and-liff.test.mjs`：**57 passed，0 failed，0 skipped**（原引擎 39、Webhook 12、Flex／LIFF 6）。
- 其中遍歷放鬆問卷全部 **432 種**回答組合；文字／按鈕色彩組合符合 WCAG AA 4.5:1。
- `node pilot/export-flex.mjs`：產生四份合成 Simulator JSON。
- `pilot/sql-check.mjs` 搭配 PGlite 0.3.14：隔離的 PostgreSQL/WASM 驗證 migration 重跑、舊表升級、RLS 與角色、清理／回退重跑，原有資料保持。無外部資料庫連線。
- `git diff --check`：通過。

Webhook 測試使用打包後的 Function 與 HMAC 簽章，所有 LINE／Supabase 呼叫都由記憶體模擬取代。保健品恢復及作答、我的組合路由已模擬驗證；會員 LIFF 入口僅靜態檢查，未宣稱會員全流程已實機測試。

## 仍待驗證／不包含

- 尚無真正 LINE iOS／Android 截圖、Flex 官方 API 驗證或手機相機測試。已交付 Simulator 可用 JSON，而非實機截圖。
- 需測 360／390px、放大字體、深色模式、相機拒絕與弱光、LIFF sendMessages 權限不足、關閉頁面回正確聊天室。
- 既有 Rich Menu 保持原狀；與保健品進度同時存在時，兩平台實際操作是否清楚仍待驗收。
- 需另外準備非正式 Supabase／LINE／LIFF 測試服務；現有 LIFF scan URL 仍指向正式專案，不可用來做本輪整合測試。設定變更須另確認。
- 30 天清理腳本已測，但未替任何環境設定排程；未執行任何正式 SQL／部署。受邀測試前仍需隱私審查與測試環境清理排程。
- 沒有收款、訂單、每日推播、語音／動畫或完整 14 天內容交付；僅展示前兩天短文字任務、記錄意願。

結論：可進行程式／設計審查，尚不能直接邀請使用者或正式上線。詳細操作與回退見 [LINE-CHATBOT.md](LINE-CHATBOT.md)。
