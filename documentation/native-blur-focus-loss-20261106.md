# 本體 popup 失焦時提前隱藏原生模糊

日期：2026-11-06。接續工具列切換修正；不修改 Aurora、Wry、Windowed Hosting、SDK schema 或前端的 100ms debounce／HTML 關閉動畫。

## 問題

工具列 TriggerWidget 已先清理舊模糊，但點擊桌面／其他程式使 popup 失焦，仍走 GlobalFocusChanged → 前端 100ms debounce → Widget.hide → visibility IPC → HWND 查詢／UI 執行緒。使用者回報這條路徑的殘留機率與持續時間較高。

上述程式順序已確認；100ms 不是全部殘留的量測值，也不能用它推定所有剩餘時間皆為 Composition 延遲。這次先避開失焦清除對前端 debounce／IPC 的依賴，實際改善仍須重測。

## 方式

- Windows 的 SystemForeground 事件經既有 hook 收到時，先排入本體原生 focus gate，再發原本的 GlobalFocusChanged。
- UI 回呼檢查最新 focus generation 與實際 GetForegroundWindow，避免排隊的舊失焦事件隱藏已回焦的 popup。
- 僅處理 `@seelen/` 且 `preset: Popup` 的本體視窗；第三方可能選擇 hideOnFocusLoss=false，不套用此原生策略。
- 與既有前端相同：焦點在自身 HWND 或直接 owned 子視窗時，視為保有焦點。只有曾持有焦點而後失去時，才將原生 root opacity 設為 0。
- 這是可逆的 opacity gate，暫時保留 Host，不推進 session／sequence／visibilityEpoch。geometry 更新不能把被隱藏的 root 恢復成 1。
- 若前端 debounce 尚未開始真正關閉，焦點返回時直接恢復 root；若已開始 close、已被 toolbar switch 抑制，則不能因回焦而恢復。正常 hide／deadline／destroy 仍負責資源釋放。
- 新 session 以目前 foreground／owner 初始化，避免 popup 在 session 建立前已取得焦點，導致漏認下一次失焦。
- API 失敗記錄警告並釋放 Host；不阻止原本 Widget.hide，不新增 fixed delay、IPC 或等待前端 ACK。

## 修改範圍

- `src/background/hook.rs`：既有 foreground 通知前加入原生 focus gate。
- `src/background/widgets/mod.rs`：模組入口。
- `src/background/widgets/native_blur.rs`：原生事件排程、root 隱藏／恢復、geometry 維持隱藏、session 初始化。
- `native_blur_focus.rs`：可逆 focus 狀態機與 owned-child／回焦測試。
- `native_blur_visibility.rs`：真正 close／switch 的恢復優先規則。
- `native_blur_diagnostics.rs`：focus generation 關聯時間軸。
- `native_blur_performance.rs`：真實 Composition API 驗證。

## 驗證

測試包括：失焦→回焦、owned child、重複事件、未曾取得焦點、暫時空 foreground、root=0 不被幾何更新恢復、回焦無須新 epoch、真正 close／toolbar switch 優先。真實隱藏測試 HWND 與 Composition root 的 opacity 可讀回，不等同 GPU／DWM present。

建置／測試與實機結果記錄於 `.dev/popup-switch-diagnostic-20261106/focus-verification.json`。不把程式通過測試當作使用者桌面殘留已驗收。

2026-11-06 使用者完成新版失焦情境重測，回覆「有改善，還改善蠻多的」。記錄為已測情境的主觀明顯改善；未量測改善百分比或 GPU／DWM 時間，也不代表所有 popup、多螢幕及長時間負載情境都已驗收。使用者尚未逐項確認誤關與重新開啟恢復的完整測試矩陣。

## 限制與取捨

原生 UI 執行緒或 hook 本身繁忙仍可能延遲執行；此修改不能保證硬即時清除，也沒有 GPU／DWM 呈現量測。Windows focus 事件不是滑鼠按下的同義詞。

HTML 在 100ms debounce 及退場期間可能短暫保留內容但沒有原生模糊；這是優先避免背景殘留的取捨。資源暫留是為支援取消失焦，不是跳過後續清理。owner 只遵循既有一層 owner 規則，沒有擴張成整個 process 或任意 owner chain。

診斷模式仍預設關閉；SLU_NATIVE_BLUR_TRACE=1 時會有 focus.receive、focus.ui.begin/end、focus.visual.request/applied.api，攜帶 session、epoch 及 native window，API 事件不代表畫面已呈現。
