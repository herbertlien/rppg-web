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
