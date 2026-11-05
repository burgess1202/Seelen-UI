# Native Blur 關閉生命週期修正（2026-10-20）

> 2026-10-23 後續：關閉等待改為以動畫完成訊號為主、200ms 僅作 watchdog，
> 不再使用估算 CSS 剩餘時間作硬截止。見 [修正與回歸結果](native-blur-close-timing-fix-20261023.md)。

## 問題與修改範圍

先前共用 Widget 關閉流程會等待整份文件的有限動畫，再等待模糊清空 IPC
（另有 150 ms 上限），最後才隱藏 HWND。因此無關的內容動畫、排隊中的幾何
更新及清理回應，都可能延後關閉。這是程式碼確認的風險，不代表已證實每次
畫面殘留都由同一原因造成。

這次只修改 `source/community-nightly` 的共用生命週期，沒有修改 Aurora、
預設主題、模糊半徑、效果品質或背景取樣方式，也沒有新增視窗管理系統。

## 新流程

1. 記錄關閉前的動畫，設定 `data-widget-hidden`，只等待新觸發、恢復或重新設定
   時間的有限關閉動畫；保留原有 200 ms 上限。既有內容動畫不再拖住關閉。
2. 關閉開始即透過獨立 visibility IPC 通知 Rust 截止時間，不排在幾何更新後面。
   現有區域仍可同步最後的 CSS 淡出；不會在關閉途中建立新的 native host。
3. Rust 在現有 Composition root 上設定截止門：截止前維持 1，截止時變為 0。
   這不是第二段淡出；區域本身的 CSS opacity 同步仍沿用原本流程。
4. 到期的原生工作釋放 host。前端動畫結束時也送出立即清理，但 HWND.hide
   不等待這個清理回應。重複 hide 共用同一個執行中的 Promise。
5. 每次顯示／關閉都有 visibility epoch；重新開啟後，舊幾何、舊關閉與舊截止
   工作不得清掉新畫面，截止後同一 epoch 的幾何也不得重新建立模糊。

未使用模糊的主題不建立 session、Composition host 或清理 timer。幾何仍然單一
請求在途、只保留最新快照及去重；visibility 是少量獨立控制訊息，不是逐幀 IPC。
已存在的 Effect / Brush 重用、可見範圍裁切與空區域資源釋放仍保留。

## 主要檔案

- `libs/core/src/state/widget/abstractions/4_visibility.ts`：關閉順序與重複呼叫處理。
- 同目錄 `hideAnimations.ts` / `.test.ts`：動畫辨識、剩餘時間與取消處理。
- `libs/core/src/state/theme/nativeBlur.ts`：獨立控制通道、session 共用與 epoch。
- `libs/core/src/handlers/commands.rs` / `.ts`：宣告及產生的命令綁定。
- `src/background/widgets/native_blur.rs`：原生截止門、期限清理與 host 生命週期。
- 同目錄 `native_blur_visibility.rs`：可單獨測試的可見性排序規則。
- 同目錄 `native_blur_performance.rs`：實際 Composition 與資源回歸測試。

新增命令為 `SetNativeBlurVisibility`。幾何命令的 `visibility_epoch` 為 Option，
允許舊客戶端省略；但完整的新行為需要共用套件、前端與 Rust debug 執行檔
一起更新並重啟。主題不需要改 CSS 或呼叫新 API。

## 可重現驗證與數據

前端測試使用實際 Controller／Widget 程式、headless Edge 與模擬的 IPC／視窗。
它驗證非同步競態，不是實際 GPU 畫面或原生 IPC 延遲測量。

```powershell
$env:SLU_PLAYWRIGHT_PATH = 'C:\Users\jacky\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright\index.js'
node scripts/native-blur-close-tests.mjs documentation/native-blur-close-tests.json
node scripts/native-blur-perf.mjs documentation/native-blur-perf-close-lifecycle.json
```

- 關閉回歸 6 項通過：IPC 不回應、晚到的關閉、未收到 finish 的截止、無關內容
  動畫、重複 hide／快速重開、未使用 native blur 的主題。
- 效能回歸 12 場景通過：靜止及隱藏狀態沒有持續掃描／幾何 IPC；幾何請求
  最多一個在途；32 區域、40 次更新的 style 讀取 2,680 次、rect 讀取 2,560 次，
  與上一輪優化後相同。幾何總 payload 383,832 → 384,632 bytes，增加約 0.21%
  （epoch 欄位）；控制訊息另外計算，不能宣稱總 IPC 數下降。
- Rust native blur 測試 8 項通過，另有 2 項需明確啟動的 benchmark。
  實際 Composition 測試確認截止後的 root opacity 不會被幾何更新重設為 1。
- 隱藏測試 HWND 的 500 次生命週期中，region 建立／釋放各 4,000；第 100、
  300、500 次 private bytes 為 2,842,624、2,842,624、2,715,648。
  僅能表示此短期測試沒有持續成長，不能推論整個程式沒有記憶體洩漏。
- 32 區域原生 CPU 提交中位數上一輪 8.437 ms，本輪 6.784 ms；兩次執行環境
  有變動，不把差值當成本次生命週期修改的確定效益，更不是 GPU 改善比例。

原始結果：`native-blur-close-tests.json`、`native-blur-perf-close-lifecycle.json`、
`native-blur-native-close-lifecycle.json`、`native-blur-native-close-soak.json`。
前次基準及硬體加速限制見 [效能報告](native-blur-performance.md)。

## 限制與待確認

- 原生截止門必須先收到控制訊息；若初始 IPC、原生 UI thread 或 GPU 本身卡住，
  仍不能承諾準時消失。TRACE 日誌包含 `remaining_ms` / `late_ms` 方便區分。
- 截止後 native cleanup 仍要由 UI thread 執行；已設定的 Composition 門不依賴
  前端最後一個逐幀更新，但不是跨 WebView2／Composition 的原子畫面提交。
- 維持既有 200 ms Widget 關閉上限；更長的主題動畫仍可能被截斷。
- 直接繞過共用 Widget.hide 的第三方行為不一定走這個截止協定。
- 複雜 transform、裁切與不支援的 opacity 動畫仍用原有快照同步。
- 尚未實測真實 popup 的 GPU frame time／VRAM、長時間高負荷與硬體加速 A/B。
  重啟後需人工確認淡出、快速切換、系統匣、輸入法、失焦與主題切換，才能判斷
  使用者原先觀察的長時間殘留是否已消除。
