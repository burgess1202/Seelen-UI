# 工具列 popup 切換時優先清除原生模糊

2026-11-06。本次維持 Windowed Hosting，不修改 Wry、Aurora 動畫、SDK schema 或工具列前端。不增加固定 sleep，不讓 Widget.hide 等待原生 ACK。

## 問題與證據

使用者在左側使用者面板切到一段時間未開啟的藍牙／網路面板時，HTML 已消失，原生背景仍存留到下一個面板將開啟。舊記錄有 close 晚到約 1061ms；診斷重現有約 333–353ms 的清除 API 耗時，其中 301–332ms 發生在舊版 receive 記錄點之前。較快樣本約 21ms。

舊 receive 點位於 webview.hwnd() 之後。鎖定的 Tauri 2.12.0 會透過 UI event loop 同步取得 HWND，所以該段包含 IPC 與 HWND 查詢，不能把整段稱為網路或 GPU 延遲。WebView 初始化與慢 close 重疊，但當時的 Creating/Mounting 記錄只有秒級精度。

原先的 early-exit 已先送 visibility(false)，卻不能保證實際清除在冷建立之前執行。調查資料：`.dev/popup-switch-diagnostic-20261106/`；不將其模型或 API 時間當成 GPU present。

## 修改

### 工具列切換順序

僅 `__seelenToolbarToggle=true` 且資源 preset 為 Popup 的 TriggerWidget 走新順序：

1. 檢查資源啟用，取得遞增的 toolbar switch generation。
2. 在 Tauri UI 執行緒先清理其他 Popup 的 NativeBlurHost，target 本身保留，以維持再次點擊關閉行為。
3. 清理嘗試完成後，才排入背景工作執行原有 trigger／lazy WebView 建立。沒有在 deployment 鎖內同步等待，也沒有等待 HTML hide。
4. 延遲工作與待 Ready 的 trigger 在派送前確認 generation。pending map 在同一個短鎖內檢查並替換，避免舊工作蓋掉同一個面板的新請求。

清理 API 失敗仍取出／drop Host，記錄警告後繼續開啟目標。非 popup Widget 與 target 的 Host 不清除。沒有為每個關閉建立新的 IPC，也不預載所有面板。

### 原生切換抑制

Visibility 的 switch_suppressed 讓舊 geometry 與延遲 open 都不能重新建立原生背景。只有後端收到新的該 popup 開啟請求，才解除抑制；解除後仍遵守原有 epoch 規則，新 show 需要新 epoch，舊 close／cleanup 不可作用於新世代。session、sequence 檢查保留。

非工具列的後端 TriggerWidget（例如快捷鍵／命令中心）也會解除目標抑制，不需要透過工具列才能恢復。

限制：被工具列切換抑制過的第三方 Popup 若完全繞過後端 trigger、只自行呼叫 Widget.show()，不會自動解除這個原生 gate。現行本體工具列 popup 使用後端 trigger；後續擴展第三方場景需設計明確的重新開啟協定，不能讓舊 geometry 任意解鎖。

## 修改檔案

- `src/background/widgets/mod.rs`：工具列 generation、UI 清除後再 trigger、過期待 Ready 請求保護。
- `src/background/widgets/native_blur.rs`：原生切換清理、目標解鎖、receive／HWND 分開記錄、建立時間軸。
- `src/background/widgets/native_blur_visibility.rs`：switch gate 與快速重開測試。
- `src/background/widgets/native_blur_diagnostics.rs`：popup-switch 關聯 ID。
- `src/background/widgets/loader.rs`：可選的 WebView create begin/end/error 時間。
- `src/background/widgets/native_blur_performance.rs`：真實隱藏 HWND／Composition 資源測試。

## 驗證與實機驗收

相關測試檢查：舊／跨 epoch 幾何與延遲 open 被抑制、新 trigger 後恢復、500 次切換、舊 close 無效、過期 toolbar generation、真實 Host 清理先於後續步驟、target／非 Popup 不受影響、清理 API 失敗仍繼續。

建置及測試的最終結果記錄於 `.dev/popup-switch-diagnostic-20261106/verification.json`。診斷預設關閉，沿用 SLU_NATIVE_BLUR_TRACE=1 才會寫細部事件。這次只有 app Rust 改動，不需要 SDK／前端重建。

實機應比較冷切換、暖切換、連續快速切換、切走後重開、再次點擊同一項關閉。檢查 `popup.switch.ui.end` 是否先於目標 `webview.create.begin`，以及舊 frame 不再建立 Host。API 順序正確不代表 DWM 已呈現；未取得 GPU／DWM 量測前，不宣稱殘留時長或效能已改善。已開始執行的既有 HTML 事件不會被 generation 回溯取消，這也不是整體 popup 排程器重寫。
