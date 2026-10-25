# 已填公開測試設定的產物

僅測試使用，尚未部署、未驗證 LINE／Supabase 實際連通。正式 Deerly 不動。

- 測試 Supabase：`https://rswcmlujwcwxvsffzise.supabase.co`
- 測試網站：`https://glittery-longma-b8be7c.netlify.app`
- 測試 LINE Login Channel：`2012194363`
- 測試 LIFF：`2012194363-LYirSkEL`

`deerly-pilot-test-site.zip` 只含前端檔案，可手動上傳到上述 Netlify **既有測試網站**的 Deploys 區。不連 GitHub、不更新正式網站；ZIP 根目錄為 index.html。不包含 SQL、後端原始碼或 Secrets。

`functions/` 是測試 Supabase 三支 Function 的部署候選原始碼；僅在上述測試專案逐支建立 scan、intake、linebot，不能貼到正式專案。每支會檢查 RELAX_ISOLATED_TEST=1 及 Supabase URL；linebot 禁止選單管理。不需要修改已手動建立完成的四份測試資料表。

前端上傳完成不代表後端已連通，須完成測試 Function 的部署、Secrets、測試帳號白名單、測試 Webhook 與資料清理，才可驗證完整流程。敏感值只放測試 Supabase Secrets，不放聊天、Git 或前端。

設定步驟及安全限制見 ../README.md。manifest.json 的 deployed:false 表示本次準備時未部署；之後手動部署結果需另行確認，不以 manifest 作為即時狀態來源。
