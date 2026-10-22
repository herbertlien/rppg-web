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
