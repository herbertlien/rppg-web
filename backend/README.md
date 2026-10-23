# Deerly 後端（Supabase deerly-prod）

| 檔案 | 用途 |
| --- | --- |
| `schema.sql` | 掃描資料表（users、consents、scans），已上線 |
| `scan-function.ts` | Edge Function `scan`，已上線 |
| `schema-intake.sql` | 問卷與待審配方（intakes、packs），在 SQL Editor 執行一次 |
| `intake/handler.ts` | Edge Function `intake` 的原始碼 |
| `intake/build.mjs` | 把規則引擎與資料檔併進 handler，產生 `intake/index.ts` |
| `intake/index.ts` | 自動產生，貼進 Supabase 的就是這個檔 |

改了 `engine/` 或 `handler.ts` 之後：`node backend/intake/build.mjs`，再把新的 `index.ts` 貼到 Supabase 重新部署。
網頁上的預覽與問卷讀的是 GitHub 上的資料檔，後端算配方用的是部署當下併進去的資料；每份配方都記錄了引擎與資料版本。

`intake` 函式需要的設定：
- 關閉「Verify JWT」（跟 `scan` 一樣，改由函式自己向 LINE 驗證身分）。
- Secret `ADMIN_LINE_SUBS`：審核者的 LINE 使用者 ID，多個用逗號分隔。打開審核頁會顯示自己的 ID。

動作：`whoami`、`consent`、`mine`、`submit`、`delete`（客人）；`review_list`、`review_check`、`review_decide`（審核者）。
不接單的回答不保存；配方核准前客人只看到「整理中」；含未確認品項或藥師未核定時無法核准。

## LINE 聊天室問卷（linebot）

在官方帳號聊天室用下方選單圖一題一題作答，答完走和網頁問卷同一套規則引擎，進同一個審核頁。

- 資料表：`schema-linebot.sql`（`quiz_sessions` 作答進度、`rich_menus` 題目對應的選單 ID）。
- 函式：`linebot/handler.ts` → `node backend/linebot/build.mjs` 產生 `linebot/index.ts`，貼進 Supabase Edge Function `linebot`（Verify JWT 要關）。
- Secrets：`LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`（Messaging API 頻道的），`ADMIN_LINE_SUBS`（和 intake 共用的同一個值也要設在這支函式）。
- 選單圖：`node engine/menugen.mjs`（需要 playwright）讀題目產生 `menus/*.png` 與 `menus/areas.json`，推上 GitHub Pages 後，審核者呼叫 `setup` 動作建立選單。題目改了要重新產圖、重新 `setup`。
- Webhook URL：`https://<project>.supabase.co/functions/v1/linebot`，在 LINE Developers 的 Messaging API 頁設定並開啟「Use webhook」。
- 單選題用選單圖；複選題用快速回覆（可即時打勾）；每題有「上一題」。
- 測試：本機 Postgres + PostgREST，LINE API 用模擬回應（見 PR 說明）。

### 測試用核准（TEST_APPROVE）

南都的資料還沒確認、藥師還沒核定時，審核頁的「核准」會被擋住。內部測試時，在 Supabase 的 `intake` 函式加一個秘密 `TEST_APPROVE`，值填 `1`，就會略過這兩項檢查（劑量與禁忌的錯誤仍會擋），審核頁會顯示「【測試模式】」，核准的備註會自動加上「[測試模式核准]」。**上線給真實客人前必須刪掉這個秘密。**
