# Deerly 規則引擎（驗證期骨架）

問卷答案 → 待審配方。純函式、不碰 AI，同樣的答案永遠得到同樣的配方。

- `engine.js`：引擎本體（瀏覽器與 Supabase Edge Function 共用）。
- `data/items.json`：品項、每顆成分、每日顆數、互斥群組、禁用條件、對應需求。`status` 不是 `confirmed` 的品項都不能出貨。
- `data/limits.json`：成分名稱、單位與每日上限（南都 UL 表）。
- `data/questions.json`：題目、選項、加分、拒收與個人旗標。
- `data/claims.json`：拒收訊息與禁用詞（AI 輸出過濾用）。
- `index.html`：對話式問卷預覽，不儲存任何資料。
- 測試：`node --test engine/engine.test.mjs`

南都資料到了以後，只要改 `data/items.json`（每顆成分、`dailyCapsules`、`status: "confirmed"`），藥師核定後把 `pharmacistApproved` 改成 `true`。

相關頁面：`quiz/`（客人填問卷，需從 LINE 開啟）、`review/`（審核頁，只有 ADMIN_LINE_SUBS 裡的帳號能用）。後端見 `backend/README.md`。

**改了網頁或資料檔之後一定要執行 `node engine/stamp.mjs`**：更新版本號。LINE 內建瀏覽器會快取舊檔，頁面發現版本號不同時會自動重新載入新版。後端也會比對題目版本，不同就請客人重開，避免用錯題目算配方。
