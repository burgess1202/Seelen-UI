# Popup 關閉時間軸修正 — 2026-10-23

## 原因與小幅修正

前次隔離測試發現：85ms CSS 淡出在約 80.959ms、opacity 0.0475412 時，
Widget 已呼叫 window.hide。`hideAnimationBudget` 原先以 CSS 剩餘時間設定
setTimeout；CSS／文件時間軸與 wall-clock timer 不是相同的完成訊號，兩者競速
會讓計時器先贏。這證明了提早隱藏，但不是實際 GPU 畫面殘留的完整根因證明。

現在只將原有 200ms 上限作為 watchdog，正常情況等待選定動畫的 `finished`
Promise（取消以 allSettled 處理）。沒有動畫時仍立即結束；既有無關內容動畫
仍不列入等待。沒有加固定延遲，也沒有每次強迫等滿 200ms。

Native Blur 的 begin-close 原本就使用同一個 budget，現在因此改用 200ms 安全
期限，而不是以推算的 85ms 硬切 root。正常結束仍立即 finish-close／隱藏 HWND，
不等待模糊 IPC。CSS opacity 橋接、過期 epoch 保護及 Rust 渲染程式未修改。
原生 watchdog 仍需控制 IPC 先送達，仍不是 WebView2／Composition 原子提交。

修改產品檔案：

- `libs/core/src/state/widget/abstractions/hideAnimations.ts`：簡化 budget 為安全上限。
- 同目錄 `4_visibility.ts`：說明完成訊號與 watchdog 的不同職責。
- 同目錄 `hideAnimations.test.ts`：補上時間軸落後及永不完成的單元測試。

## 驗證

- 5 項單元測試通過；相關 3 個檔案 lint 通過。
- 獨立 headless Edge 連續 10 輪、每輪 7 情境，70／70 通過。
- 原本失敗的 85ms 淡出，在 10 輪 hide 呼叫當下 opacity 均為 0。
- 新增 1000ms 長淡出測試，確認仍會由 watchdog 提前隱藏，不永久等待動畫。
- 同時保留 stalled IPC、舊 close 晚到、截止後不得復活、快速重開、未使用
  native blur 的主題等回歸。結果見 `native-blur-close-timing-fix-20261023-summary.json`
  及 `native-blur-close-fixed-ready-20261023-{1..10}.json`。

第一批修正後測試曾在固定等待 150ms 的初始化流程中遇到一次
`Close never entered control lane`：當時尚未建立模糊 session 就開始模擬 IPC 阻塞。
測試改為等待 mock active=1 才開始，沒有放寬斷言。前批失敗結果保留在
`native-blur-close-fixed-20261023-*.json`，未以成功重跑覆蓋。

這些測試使用真實前端 Controller／Widget 程式，平台 IPC／視窗是 mock；
不能據此宣稱實際 GPU 殘留、多顯卡或所有主題動畫已驗證。測試 elapsedMs
包含情境設置／等待，不當作真實點擊到畫面的延遲數據。

本次只需重建共用套件與前端，Rust 二進位不變，也未自動重啟使用者程式。
前次 GPU 開／關基準是此修正前測得，不冒充修正後重新量測的結果。
