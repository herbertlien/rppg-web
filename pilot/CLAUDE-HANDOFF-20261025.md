# 給 Claude：Deerly 放鬆測試驗證交接（2026-10-25，台北時間）

## 先讀這段：使用者現在要你做什麼

使用者覺得接手後的小問題太多，原本在 Claude 的開發測試體驗較順，因此**把目前測試驗證交回 Claude**，允許沿用原本 Claude 的開發測試環境。請先接管與定位問題，不要要求他再從頭建立帳號、重跑 SQL、重建網站或重做整個環境。

目標不是「測試都綠燈」就算完成，而是手機 LINE 真正順暢：歡迎／獨立同意 → 五題大字 Rich Menu 作答 → 可選 LIFF 心率量測／略過 → 回聊天室的個人化預覽 → 價格意願，不接金流。

目前**尚不能宣稱完整手機流程驗收完成**。有 Rich Menu 實機成功的證據，也有版本、設定與操作體驗問題；下面逐一區分。

## 1. 授權與不能碰的範圍

- Repository：`herbertlien/rppg-web`。
- **只在 `pilot-two-digital-products-20261025` 開發。禁止合併 main。**
- 原始規格：[Issue #32](https://github.com/herbertlien/rppg-web/issues/32)。既有 [Draft PR #31](https://github.com/herbertlien/rppg-web/pull/31) 隨測試分支推送更新，沒有 merge。
- 禁止部署正式 Supabase、修改正式資料庫、使用正式會員資料測試、修改正式 LINE Webhook／圖文選單。任何會影響正式 Deerly 的操作，須先得到使用者明確確認。
- 使用者後來**明確授權例外**：只對新建測試官方帳號 Messaging API Channel `2012194250`、基本 ID `@607idvzb` 建立／切換放鬆問卷 Rich Menu。此例外不包含正式帳號。現行實作只做個人選單連結，不直接覆蓋測試帳號的全帳號預設選單。
- 可沿用原 Claude 環境的工具、容器、模擬服務與測試設定。**若原環境其實連到正式 Deerly，不能把「沿用環境」解讀成允許正式寫入。** 先核對目標與既有驗證成果，保留原 Claude 的檔案與未提交修改。
- 不需要另建 Git worktree。先 `git status`、讀取本環境 AGENTS.md；不要 reset --hard 或用整個 checkout 覆蓋原 Claude 工作。
- 不把任何 Token、Secret、密碼或會員資料寫進交接文件／Git／聊天。

## 2. 版本基準與部署落差（最先查這件事）

交接前最新**程式碼** commit：

`df70ec5d501a85b69d17ef408cbf08f1ba8c7bbc`

本交接文件是隨後的文件提交，不新增產品功能。以分支上後續 HEAD 讀取完整文件，以以上 SHA 對照最後一次產品程式碼修改。

| Commit | 內容 | 手機／部署證據 |
| --- | --- | --- |
| `f4f94c6` | 使用者先前已建立的設計與 Codex 工作 Brief | Codex 開發起點 |
| `22fcd59` | Flex、五題防護、LIFF 返回、模擬測試 | 後續逐步手動測試 |
| `11cfc90`、`d8c0dfb` | 隔離產物生成器與填好公開測試設定的網站／Function | 使用者手動建環境與部署 |
| `38ca3d0` | 五題大字 Rich Menu、測試帳號鎖定、選單恢復 | 後來手機第 2 題可見大字選單 |
| `13e95e2` | `relax-menu-diagnostics-v2`，診斷指令及錯誤分段 | 使用者實際回傳過這個版本的診斷結果 |
| `8a183a5` | 測試帳號文字「繼續」應接五題，不落入保健品 | 後續有第 1→2 題進展，但沒有獨立完整部署版本核對 |
| `df70ec5` | `relax-menu-focused-v3`：Rich Menu 成功時移除小 Quick Reply，第 2–5 題不重複操作說明 | **已提交及提供更新指令，但使用者尚未回覆更新完成／新畫面** |

**不要假設 Supabase 已跑最新 HEAD。** 之前確實發生「檔案在 GitHub 已更新，但測試 Function 還是舊程式」；使用者在 Code 搜尋 `RELAX_PILOT_RICH_MENU_ENABLED` 找不到，更新後才進入新版錯誤診斷。

目前的 `pilot/isolated-test/prepared/manifest.json` 是歷史產物記錄，仍含舊 `sourceCommit`、`deployed:false`。這不代表現在沒有部署，也不代表它可證明已部署哪個版本。`prepared/README.md` 與其他文件也保留分階段的「尚未部署」敘述；**依本文件的使用者實測記錄及實際服務核對，不要按歷史文字重建環境**。

## 3. 已建立的獨立測試資源（公開識別，非密鑰）

| 資源 | 值 |
| --- | --- |
| Supabase project name | `deerly-pilot-test` |
| Supabase project URL | `https://rswcmlujwcwxvsffzise.supabase.co` |
| Supabase project ref | `rswcmlujwcwxvsffzise` |
| LINE Provider | `Deerly Pilot Test` |
| 測試 Messaging API Channel ID | `2012194250` |
| 測試官方帳號基本 ID | `@607idvzb` |
| 測試 LINE Login Channel ID | `2012194363`（不要與 Messaging API Channel 混用） |
| LINE Login Channel 名稱 | `DeerlyPilotTestLogin` |
| 測試 LIFF ID | `2012194363-LYirSkEL` |
| LIFF 入口 | `https://liff.line.me/2012194363-LYirSkEL` |
| 獨立 Netlify 網站 | `https://glittery-longma-b8be7c.netlify.app` |
| 測試 Webhook | `https://rswcmlujwcwxvsffzise.supabase.co/functions/v1/linebot` |
| 設計預覽 | `https://glittery-longma-b8be7c.netlify.app/pilot/relax-menus/preview.html` |
| 第一題 PNG | `https://glittery-longma-b8be7c.netlify.app/pilot/relax-menus/goal.png` |

使用者表示 Login Channel 已連結測試官方帳號。LINE Login 曾顯示 Developing；是否後續變更／測試者角色權限，沒有最後實機確認。LIFF Endpoint 指向上述 Netlify 測試網站；openid／profile 的建議已提供，但完整相機／登入／訊息權限未完成驗收。

Supabase 頂部顯示 `main / PRODUCTION` 是這個**新測試專案**自身的預設 DB 分支，與 GitHub main 或正式 Deerly 不同，不要僅憑此標籤判定進錯專案。

### Secrets／設定（只列名稱與已知狀態）

使用者在測試 Supabase Function Secrets 手動設定，值不在這個 Codex 環境，也不在 Git：

- `RELAX_ISOLATED_TEST=1`
- `RELAX_PILOT_ENABLED=1`
- `RELAX_PILOT_LINE_SUBS`：使用者從同 Provider 的 Your user ID 貼入白名單；不收錄實際值。
- `RELAX_PILOT_RICH_MENU_ENABLED=1`：**原本根本沒有建立**，後來使用者新增；最後診斷確認已開。
- `LINE_CHANNEL_SECRET`：測試 Messaging API Channel 的值。
- `LINE_CHANNEL_ACCESS_TOKEN`：測試 Messaging API Channel 的 long-lived token。
- `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY` 預期由測試 Supabase Functions 的內建環境注入，不要搬到前端或要求使用者貼出。
- 不要設 TEST_APPROVE 作為測試捷徑。

曾有一張早期截圖露出**測試** Channel Secret。已指示使用者重新發行，但沒有明確回覆確認已輪替；接手後在安全介面確認即可，不要把舊值／截圖複製到其他地方。

## 4. 使用者已完成的設定（不要盲目重做）

### 資料庫

使用者在獨立測試 SQL Editor 依序執行，每份都回覆 `Success. No rows returned`：

1. `backend/schema.sql`：users、consents、scans。
2. `backend/schema-intake.sql`：intakes、packs。
3. `backend/schema-linebot.sql`：quiz_sessions、rich_menus。
4. `backend/schema-digital-relax-pilot.sql`：digital_relax_pilot_sessions。
5. `backend/schema-digital-relax-menu.sql`：追加 current_rich_menu_id、previous_rich_menu_id、rich_menu_captured 三個欄位。

不要再次對這個已建立的測試 DB 跑完整 bootstrap；前兩份不是一般意義的可任意重跑 SQL。生成器第一份 migration 也刻意拒絕既有 users 表。需要變更請用新增／已驗證可重跑 migration。

### Functions 與 LINE

- scan、intake、linebot 都由使用者在 Supabase Editor 建立／部署過，設定 Verify JWT with legacy secret OFF。這三支自行驗證 LINE ID token 或 Webhook HMAC，不代表允許跳過應用程式驗證。
- linebot Verify 曾 timeout，後來使用者回報成功；當時原因未確診，不能寫成已證明是冷啟動。
- 使用者依指示打開測試 Use webhook，後續有真正聊天室回覆，故已有實際連通證據。不要改正式 Webhook。
- Netlify 用手動上傳，不連 GitHub 自動部署；使用者對初始網站包與之後含 Rich Menu 圖片的 ZIP 均回覆 Published。
- 網站圖片曾 HTTP 401，後續診斷已是 HTTP 200／有效 PNG；使用者到底更改哪個 Netlify 保護選項未提供，不要猜測當前設定。
- LINE 測試帳號另有預設自動回覆：「感謝您的訊息！…本帳號無法個別回覆…」，曾插在每次文字輸入後。已建議只關閉測試帳號的自動回應訊息、保留 Webhook，但**尚無完成確認**。

## 5. 手機實測到哪裡：觀察與假設分開

### 有直接證據

- 使用者收到五題歡迎 Flex，按「同意，開始五題」可到第 1 題。
- 舊版本輸入純文字「繼續」會落到保健品 `(1/19) 先確認一下，你的年齡是？`。這是真正路由缺漏，不是使用者操作錯；`8a183a5` 已在測試帳號範圍修正，正式環境路由維持原狀。
- 診斷最早：測試環境／帳號／DB 欄位通過，但 Rich Menu 開關未開、圖片 HTTP401。
- 後續最終診斷：**測試環境通過、Rich Menu 已開、帳號通過、欄位通過、第一題 HTTP200／PNG 正確**。
- 後來手機截圖：第 1 題回答「工作中間，短暫休息」後，第 2 題顯示底部大型奶油／森林綠 Rich Menu，含 3／5／10 分鐘、上一題、暫停、底部選單列。
- 該第 1 題回答文字與原 Quick Reply label 相符，不能憑這張圖證明當時是用第 1 題 Rich Menu 作答。
- 使用者說「除了第一題其他都 OK」，但沒有每一題、上一題、刪除、結果、相機等完整證據，不能當成所有功能驗收。
- 最新手機回饋：「流程看起來還是怪怪的。」截圖同時顯示 Rich Menu、上方小 Quick Reply，以及每題一整段重複操作說明。為此提交 v3：成功時只有 Rich Menu，第 2–5 題只保留題數與題目；未收到 v3 手機驗收。

### 未證實，請勿當結論

- 第一題初次是否沒有正確連結，或只是手動輸入後鍵盤仍開著遮住選單？尚未區分。LINE 原生鍵盤／選單展開無法保證用 Messaging API 強制切換；不要承諾可自動關鍵盤。
- 沒有完整的 iOS／Android、字體放大、所有進度恢復／返回／退出實機驗收。
- 沒有完成 LIFF 相機允許／拒絕、低光、另行同意保存、有效新心率回聊天室的完整 E2E。
- 沒有完整 LINE 官方 Flex API 驗證紀錄。圖片尺寸及布局是本機渲染／結構檢查。
- 每日清理排程、測試資料保存／隱私正式審查尚未完成；目前只應限開發者本人測試，不宜擴大邀請。

## 6. 檔案地圖與源碼／產物差異

優先閱讀：

- `pilot/DESIGN-AND-CODEX-BRIEF.md`、`pilot/LINE-CHATBOT.md`：原需求。後者有歷史段落，Rich Menu 例外見本文件及 `pilot/relax-menus/README.md`。
- `pilot/products.js`：relax 的 5 題、規則式 14 天預覽。stage 是原本第二款商品，本輪不要擴大處理。
- `pilot/relax-flex.js`：歡迎、心率選用、結果、前兩天／價格意願四卡，獨立資料處理說明。
- `backend/linebot/handler.ts`：LINE Webhook／文字／postback、relax 狀態機、既有保健品邏輯。
- `backend/linebot/relax-menu.ts`：本次新增的測試專用動態個人 Rich Menu adapter。
- `pilot/relax-rich-menu.js`：五題圖片幾何、大字 label、帶 flow_id/revision 的 action。
- `pilot/relax-menugen.mjs`、`pilot/relax-menus/`：產圖工具、5 張 PNG、manifest 與設計預覽。
- `backend/linebot/build.mjs` → `backend/linebot/index.ts`：打包引擎、題庫、Flex、Rich Menu helper。
- `pilot/relax-liff.js`、根 `index.html`：沿用相機頁，加 relaxPilot flow 及完成通知／回聊天室。
- `pilot/isolated-test/prepare.mjs`：在 checkout 外生成隔離網站／Functions／SQL；不部署。
- **實際給使用者貼到測試 Supabase 的是** `pilot/isolated-test/prepared/functions/{scan,intake,linebot}/index.ts`，不是根 backend/linebot/index.ts。
- `pilot/isolated-test/prepared/deerly-pilot-test-site.zip`：只含前端、vendor 與圖片，不含 Secrets／SQL／Functions。GitHub 可直接下載；本平台 sandbox 檔案下載曾失敗，所以改用 GitHub。
- `pilot/flex-samples/*.json`：合成資料範例，貼 contents 物件到 Flex Simulator，非手機截圖。

**重要**：原始碼／根 bundle 仍保留原 Deerly 的固定連線設定；生成器才把測試 Supabase、LINE Login／LIFF、網站 CORS 與 assets 替換到隔離產物。不要把 root index.html、engine/api.js 或 backend bundle 直接當作測試版部署，否則會混用正式識別。反過來也不要把測試產物覆蓋正式功能。

生成器阻擋已知正式 Supabase ref、正式 LINE Login ID、正式 Pages 網址；但這不是對所有未知正式環境的完整保證。仍需核對帳號與目標。

### 目前產物的校驗值（交接時本機檔案，不是遠端部署證明）

SHA-256：

- `prepared/functions/linebot/index.ts`：`37b7ad82b56b3f9a7940ee33e011ae0af979505562a6fea20129c0c6468effb6`
- `prepared/deerly-pilot-test-site.zip`：`0f3531e81b106371beeedf2bd3d4b104fc469ae8578685cbe9fe8a6d8398d221`

前端 ZIP 在 v2/v3 只改後端時沒有重做，這是合理的；五張圖與網站設定沒變，不需要每次叫使用者重新上傳 Netlify。

## 7. 實作重點與請特別審查的風險

### 現有設計

- 狀態表獨立，answers、step、status(quiz/scan/preview)、paused、flow_id、revision、獨立 consent version、interest_clicked_at。
- 文字入口「放鬆測試」、postback 前綴 `rlx|`，callbacks 附 `~flow_id~revision`；DB compare-and-set 防舊按鈕與重複事件，同 instance 另有 per-user Promise queue。
- 只有 `RELAX_PILOT_ENABLED=1` 且 admins／測試白名單才進入放鬆流程。
- `relax-menu.ts` 另鎖指定測試 Supabase、隔離 flag、測試 LIFF；Rich Menu 開關另需 1。首次操作核對 `/v2/bot/info` 的 basicId 必須為 `@607idvzb`，Token 不符就拒絕變更。
- 圖片靜態共用；選單 action 按每位使用者的 flow/revision 產生。每題建立／上傳／個人連結後，清理前一個自建 menu；不呼叫全帳號預設選單設定。
- 保存原個人選單指標；完成、暫停、重做、刪除時恢復，無原個人選單就解除 link 顯示帳號原 default。不要刪原選單／覆蓋其他流程新選單。
- 隔離生成器仍阻擋舊 setupMenus／line() 的 Rich Menu 管理；新測試 adapter 用獨立身分鎖定路徑。這也表示**這個隔離包沒有提供原保健品題目選單的一整套實機回歸環境**，不能拿純文字舊流程就宣稱保健品壞了或正常。
- 可選量測僅顯示本次選擇量測之後、15 分鐘內、品質 ≥0.35、有效30–220 bpm紀錄，不由心率決定方案，也不複製到新問卷。
- 測試 LIFF 成功保存合格值後送出 `放鬆量測完成 <flow_id>`，無權限時可手動「我量好了」，不同意保存或失敗可略過。還需要實機驗證。

### 仍需審查，不能因 mock 綠燈忽略

- 每題多個 LINE API 請求都在 Webhook 處理內等待，真實延遲、首次顯示、reply token時效、重送及 API限額沒有負載測試。
- per-user動態選單的建立／上傳／DB記錄／link／cleanup不是單一分散式交易。已有失敗回滾與 compare-and-set，但需審查跨instance／遠端部分成功時的殘留、競態與恢復；不能把 mock 測試當作已嚴格證明 exactly-once。
- 暫停／完成時若還原失敗目前多為 log 後繼續，嚴格刪除則先還原；需評估使用者是否得到清楚回饋。
- 原 scan／intake 的 delete 可能刪 users 並 cascade；請檢查與新問卷／仍連結中的遠端 Rich Menu 的影響，尚未完成實機驗證。
- `cleanup-digital-relax-pilot.sql` 和 rollback SQL **不會呼叫 LINE API**；直接刪 session 會失去原選單對照。清理前應恢復使用中選單，若要正式排程需先做可靠程序；不要直接對現有session批次刪除。
- 30天固定保存規則與「還原失敗保留恢復資訊」可能衝突，需設計可執行且不遺失恢復資訊的清理方式；現階段未安排排程。
- v3成功時去除Quick Reply，若鍵盤仍開著或Rich Menu UI未展開，仍可能有可發現性問題；請看手機，不只看API成功。
- 全部文案、預覽、格式偏好不可讓人誤以為語音／動畫、完整14天交付、每日提醒或付款已存在；目前都沒有。

## 8. 現有自動化測試與重現方法

本交接時，在程式碼 `df70ec5` 上重新執行：**72 tests，72 pass，0 fail，0 skipped**。

```bash
node --test engine/engine.test.mjs \
  pilot/linebot.test.mjs \
  pilot/flex-and-liff.test.mjs \
  pilot/isolated-test/prepare.test.mjs \
  pilot/rich-menu.test.mjs
node pilot/test.mjs
```

Node.js 24，TypeScript stripping 可能有 experimental warning。`pilot/test.mjs` 是獨立斷言程式，不算在上述72個test裡。

- 原引擎39、Flex／LIFF6、Webhook12、產物工具2、Rich Menu13。
- Webhook測試跑實際打包source，HMAC、DB、LINE API都是mock；**沒有真實Token或正式資料**。fixture在 `pilot/linebot-test-fixture.mjs`。
- 包含432種relax答案組合、顏色對比、圖片大小／點擊範圍、舊callback、部分故障、原選單保留與還原、文字繼續路由、v3不重複選項。
- fixture的LINE圖片API是模擬，不等於LINE服務端圖片驗證；本機PNG另外做真圖檔與瀏覽器渲染檢查。
- 未跑真正LINE／Supabase整合、Deno正式runtime完整驗證、Android實機或負載測試。

可沿用 Claude 的既有工具；以下是 Codex 用過的可選離線／隔離方法，不要求重建相同工具鏈。

```bash
# 依原始碼重新打包（先保留原環境修改，勿忽略 generated diff）
node backend/linebot/build.mjs
# 隔離產物：config只含公開識別，輸出必須是checkout外、不存在的新目錄
node pilot/isolated-test/prepare.mjs /path/to/public-test-config.json /path/to/new-output
```

公開config內容：

```json
{
  "isolatedTest": true,
  "supabaseUrl": "https://rswcmlujwcwxvsffzise.supabase.co",
  "siteUrl": "https://glittery-longma-b8be7c.netlify.app",
  "liffId": "2012194363-LYirSkEL",
  "lineChannelId": "2012194363"
}
```

生成器不部署，也不執行SQL。如果沿用原Claude測試服務的其他網址／ID，**先確認真的是非正式資源並調整對應身分鎖定及測試**；不要直接拔掉護欄或混用正式Token。

隔離PostgreSQL/WASM驗證（先前已成功，無外部DB）：

```bash
npm install --cache /tmp/rppg-npm-cache --prefix /tmp/rppg-sql-check --ignore-scripts --no-audit --no-fund @electric-sql/pglite@0.3.14
PGLITE_MODULE=file:///tmp/rppg-sql-check/node_modules/@electric-sql/pglite/dist/index.js \
  node pilot/isolated-test/schema-check.mjs /path/to/output
```

產圖（若原Claude已有Playwright／Chrome，優先沿用）：

```bash
npm install --cache /tmp/rppg-npm-cache --prefix /tmp/rppg-menu-render --ignore-scripts --no-audit --no-fund playwright-core@1.56.1
PLAYWRIGHT_MODULE=file:///tmp/rppg-menu-render/node_modules/playwright-core/index.mjs \
  node pilot/relax-menugen.mjs
```

72項Node測試不用額外安裝套件；上述外部套件都只裝在臨時目錄，不改root package manifest。PNG 2500×1686、每張<1MB、主要字級縮至360px約21.6px、點擊區域高度≥44px；仍需LINE字體與實機操作驗收。

## 9. 建議你接手後的順序

1. **接管原 Claude 環境與使用者原本成功的測試路徑**，先看既有改動／工具／連線，別讓使用者重做準備。取得測試分支並比對以上commit，保留未提交內容。
2. 只讀核對實際部署版本：測試linebot GET回應會有build及兩個開關布林值；目前源碼應是 `relax-menu-focused-v3`。在有安全存取的環境取得目前測試Function源碼／logs，與prepared候選比對。只讀核對，不為了驗證而先重新部署。
3. 檢查測試OA自動回應是否還開著，確認原Claude的完整手機畫面與目前雙入口問題。將最新手機畫面對應部署版本，別把舊截圖當作新回歸失敗。
4. 用受邀測試者重現「首次同意→第一題」「輸入繼續」「上一題回第一題」「暫停後恢復」；記錄API建立／上傳／link的真實結果及UI展開行為。先定位，才提出最小修正。
5. 以原Deerly的底部大字Rich Menu作為主要介面。不要又導到外部問卷、堆Quick Reply／冗長提示，或要求使用者反覆手動更新多個元件。
6. 五題先走**略過量測**的完整結果與意願／刪除路徑，再驗證LIFF。心率沒有也必須得到同一套方案。
7. 最後才處理完整iOS／Android、斷線、重送、資料清理、原選單與原保健品隔離。每次報告分清「已修改、mock通過、測試服務已更新、手機已驗收」四種狀態。

Codex 此環境沒有LINE／Supabase管理連接工具，亦未注入上述測試credentials；公開測試網址的curl曾被此環境egress proxy以CONNECT403阻擋。這不是遠端服務必然403，也不是需要使用者再給Token的證據。Claude若原環境已有正常存取，請沿用，先確認所需操作是否真的可執行，再要求缺少的權限。不要把密鑰貼進聊天。

## 10. 使用者期待的交付

- 一條真的能操作、設計延續Deerly的大字問卷流程，而非只有程式碼／綠色測試。
- 盡量你自行檢查與整合，不要再讓使用者成為逐檔複製部署的測試員。
- 有限制就說清楚；不要把「已給部署指令」寫成「已部署」，也不要把「有一張第2題截圖」寫成全流程完成。
- 最後用繁體中文說明驗證結果、未解問題與必要手機操作。維持原測試分支，提供可審查變更，不上正式、不merge、不接金流。
