# 放鬆問卷 Rich Menu

2026-10-25，使用者明確同意：只在測試官方帳號 Channel `2012194250`、基本 ID `@607idvzb` 建立／切換放鬆選單。正式 Deerly 維持禁止修改。

五張 2500×1686 PNG，使用 Deerly 奶油底、森林綠、大字選項、題數、上一題與暫停。以 360px 寬縮放時，主要字級約 21.6px，所有點擊區域高度 ≥44px。圖片每張 <1MB。瀏覽 `preview.html` 可看 390px 版型；這是瀏覽器設計預覽，不是 LINE App 截圖，仍須 iOS／Android 實機驗收。

## 更新測試環境（不改正式服務）

1. 將 `pilot/isolated-test/prepared/deerly-pilot-test-site.zip` 手動上傳到既有 Netlify 測試網站，等待 Published。新圖片在 `/pilot/relax-menus/`，不變更 LIFF 網址。
2. 只在 `deerly-pilot-test` SQL Editor 執行 `backend/schema-digital-relax-menu.sql`；可重跑，只加三個選單恢復欄位，不重跑原四份 SQL。
3. 將既有測試 `linebot` Function 的 index.ts 全部換成 `pilot/isolated-test/prepared/functions/linebot/index.ts` 並 Deploy；保留 Verify JWT OFF。不用重新部署 scan／intake，不更改 Webhook。
4. 在測試 Supabase Secrets 加 `RELAX_PILOT_RICH_MENU_ENABLED=1`。原有 `RELAX_ISOLATED_TEST=1`、`RELAX_PILOT_ENABLED=1`、測試 LINE Token／Secret 與白名單都保留。
5. 傳送「放鬆測試」，若有舊進度選「重新開始」，閱讀同意後回答。第一次開啟可能稍慢，程式才會在測試帳號建立、上傳並連結該題選單。若 LINE 把選單收起，點下方「放鬆練習・點這裡作答」。不需呼叫 setup，也不需去後台逐張建立圖文選單。

## 保護與恢復

- 只在指定測試 Supabase、測試 LIFF、隔離標記與 Rich Menu 開關均正確時啟用；每個 Function instance 第一次操作前向 LINE 讀取 bot info，必須比對 `@607idvzb`。帳號不符就不送出選單變更。
- 按鈕綁 flow ID、revision 與題號；過期按鈕不能改新進度。圖片共用，選單 action 按本次問卷產生，避免共享選單導致重送跳題。
- 只替白名單測試者建立「個人」選單連結，從不更改官方帳號預設選單，也不操作既有保健品 `rich_menus` 設定。
- 開始時保存原本的個人選單 ID。完成第五題、暫停、刪除、重做時恢復；若原本沒有個人選單，就解除測試者的臨時連結，讓帳號預設選單重新顯示。
- 若另一流程已經換了選單，不強制蓋回舊的；只刪除名稱含本次 flow ID 的自建問卷選單。不刪任何原選單。
- 圖片、上傳、連結或帳號核對失敗時，以 Quick Reply 備援，不清問卷進度。仍需觀察 LINE API 延遲、實機展開與文字可讀性。
- 測試者隨時輸入「收起放鬆選單」可恢復並暫停；將 Rich Menu 開關設 0 只阻止新建立，之後恢復／作答時會嘗試還原。停測前請每位測試者先執行「收起放鬆選單」，再關閉 flag／Webhook；不能只關 flag 就假設遠端選單自動恢復。
- 刪除問卷前會先恢復選單；若恢復失敗會保留恢復資訊並回覆重試指引。批次清理／回退 SQL 不會呼叫 LINE API，**請先恢復使用中的臨時選單再執行批次刪除**，避免遺失原選單對照。

## 驗證

```bash
node backend/linebot/build.mjs
node --test engine/engine.test.mjs pilot/linebot.test.mjs pilot/flex-and-liff.test.mjs pilot/isolated-test/prepare.test.mjs pilot/rich-menu.test.mjs
```

68 passed、0 failed、0 skipped。包含實際隔離打包產物的五題建立／連結／恢復模擬，錯誤帳號拒絕、LINE API 故障備援、舊按鈕、暫停／刪除、保留原選單及禁止修改全帳號預設選單。PostgreSQL/WASM 另驗證第五份 migration 與新增欄位。沒有使用實際 LINE Token 或會員資料做自動化測試，程式完成不代表測試帳號已更新。

重新產圖需安裝 Chromium 與 Playwright Core：

```bash
npm install --cache /tmp/rppg-npm-cache --prefix /tmp/rppg-menu-render --ignore-scripts --no-audit --no-fund playwright-core@1.56.1
PLAYWRIGHT_MODULE=file:///tmp/rppg-menu-render/node_modules/playwright-core/index.mjs node pilot/relax-menugen.mjs
```

產圖時禁止網路請求、等待本機中文字型載入，並檢查文字不溢位。原本保健品 menus/ 與 menugen.mjs 不變。

## 選單未出現的診斷版

`relax-menu-diagnostics-v2` 新增「選單診斷」聊天室指令（僅受邀測試者）：只核對環境旗標、bot 身分、資料欄位與第一題圖片，不建立、上傳或連結選單。不回傳 Token、Secret、使用者 ID 或問卷答案。一般第一題備援回覆會顯示 `MENU_SWITCH_OFF`、`MENU_IMAGE_HTTP_404`、`MENU_CREATE_HTTP_400`、`MENU_UPLOAD_HTTP_...`、`MENU_LINK_HTTP_...` 或資料庫錯誤代碼，便於定位。GET linebot 亦回傳 build 與兩個開關布林值，供確認部署版本；不執行外部 API 操作。

這是診斷補強，不代表尚未取得日誌的實際故障已修復。只需更新測試 linebot，不用再上傳網站或重跑 SQL。70 項本機測試通過；真實故障須依測試帳號回傳的狀態確認。

測試入口修正：受邀測試者在指定測試帳號輸入文字「繼續」或「繼續放鬆測試」時，現在會恢復五題流程，不再落入舊保健品問卷的一般文字分支。正式環境路由保持原狀。新增雙問卷共存與正式範圍不變的回歸測試。需更新測試 Function 後生效；原有「選單診斷」指令可先用來確認旗標及圖片存取狀態。

## 單一作答區調整（relax-menu-focused-v3）

依手機回饋移除重複操作介面：Rich Menu 成功連結時不再附帶 Quick Reply，第一題只留一行鍵盤／選單提示，第 2–5 題只保留題號與題目；只有選單失敗時才顯示小按鈕備援及診斷碼。新增五題逐題訊息結構及備援測試。只需更新測試 linebot，不改 SQL、網站圖檔、Secrets 或 Webhook。LINE 原生鍵盤的收起／選單展開仍由使用者操作，不能保證以 API 強制收鍵盤。
