# 原生模糊穩定性修正與驗證（2026-11-06）

此文件記錄本次通用核心修正，接續工作區的 [架構指南](../../docs/BLUR_ARCHITECTURE_AND_MAINTENANCE.md) 與 [排查報告](../../docs/BLUR_DIAGNOSTIC_20261106.md)。原文件中的「等關閉動畫後才清理」描述為修正前基準；本次預設改為原生模糊提前退出。

## 修改範圍

維持 Tauri／Wry 原有 Windowed WebView2 Hosting。沒有修改 Wry、Aurora Glass 的 CSS、特殊翻轉動畫、資源 ID、正式安裝版或 Marketplace。沒有新增固定延遲，也沒有變更既有失焦 debounce 或 HTML 關閉動畫的 200ms watchdog。

| 檔案 | 內容 |
| --- | --- |
| `libs/core/src/state/theme/nativeBlurLane.ts` | 有界、每 epoch 一個在途、只保留最新值的傳輸通道 |
| `libs/core/src/state/theme/nativeBlur.ts` | 幾何與 visibility 分離的通道、過期 ACK／錯誤隔離、提前退出及下次 show 恢復 |
| `libs/core/src/state/theme/nativeBlurDiagnostics.ts` | 預設關閉的前端時間軸與 A/B 設定讀取；診斷 sink 失敗不阻止流程 |
| `libs/core/src/state/widget/abstractions/4_visibility.ts` | CSS 關閉前先開始 native close；不等待 native ACK；記錄視窗 API、動畫與可見性查詢 |
| `libs/core/src/state/widget/abstractions/hideAnimations.ts` | 回傳正常完成／watchdog／無動畫的結果供診斷，不改等待上限 |
| `src/background/widgets/native_blur.rs` | 原生 root 即時設為 0 並 detach／close；異常也取出並釋放 Host；接收與主執行緒時間軸 |
| `src/background/widgets/native_blur_diagnostics.rs` | 預設關閉的原生 request timeline，帶 wall time 與接收後經過微秒 |
| `src/background/widgets/webview.rs` | 以 initialization script 在 SDK 啟動前注入診斷／A-B 旗標與視窗 label |
| `src/background/widgets/native_blur_performance.rs` | 真實 Composition 提前退出、異常釋放回歸 |
| `scripts/native-blur-stability-tests.mjs` | 現行 browser/controller 的隔離 A/B、慢／失敗／永不回應 IPC 及連續開關測試 |
| `nativeBlurLane.test.ts`、`nativeBlurDiagnostics.test.ts` | 通道上限、舊拒絕／finally、最新值合併與診斷開關測試 |

IPC 的既有參數沒有改動，仍使用 session、sequence、visibilityEpoch 及 deadlineMs；request ID 由這些欄位推導，不要求其他 Widget 升級命令 schema。

## 1. 跨 epoch starvation 的修復

修正前，單一 `sending` Promise 橫跨所有 show/hide 世代。舊幾何 invoke 不回來，新快照就永遠不能發送；舊請求即使會被 Rust 拒絕，也仍佔住前端等待。

現在幾何及 visibility 各有一條獨立的 `NativeBlurLane`：

- 每條通道最多兩個在途操作，每個 epoch 最多一個；同 epoch 更新只保留最新待送值。
- 一個永久等待的舊 epoch 只佔一槽，其他新 epoch 可以重用另一槽。
- advance 時丟掉舊的待送資料，但不假裝取消無法取消的 Tauri invoke。
- 舊操作的拒絕不會呼叫目前 epoch 的 fail；舊 finally 只移除自己的 ticket，不能清除新操作。
- callback 回來後，controller 仍核對 epoch、session、suspended／stopped 等狀態，才更新 ready 及已送快照。
- Rust 原有 session、sequence、visibility epoch 與清理截止保護保留。

**有界保護的限制：**若同一條通道兩個 invoke 都永久不回應，就不會再增加第三個請求。新 epoch 最新資料暫存，等任一舊操作結束再處理；在此期間保留 CSS 備援，不能宣稱在整條 IPC transport 永久失效時仍能恢復原生效果。完全失效時需調查 transport 或重建 Widget 文件，不用無限並行掩蓋問題。

每份文件的幾何、visibility 各最多兩個在途，加上共用的 session 初始化；此上限不包含原本 `window.show/hide` 等其他 Tauri API。

## 2. 預設提前退出

目前的正常關閉順序：

1. Widget 記錄 hide 意圖及既有動畫。
2. `beginNativeBlurClose(200)` 在 CSS hidden 標記前被呼叫。預設政策把 native deadline 設成現在，暫停幾何追蹤、清掉待送快照及 ready 標記。
3. 透過獨立 visibility 通道送出 close，不等待 ACK。
4. Widget 設定 `data-widget-hidden`，原 HTML 退場照常進行，正常等動畫完成，最多使用既有 watchdog。
5. Rust 接收並通過 epoch 檢查後，停止 root opacity 動畫、設 opacity=0，然後 detach root 並 close target。即使原生隱藏 API 失敗，也先從狀態取出 Host 並嘗試釋放。
6. HTML 完成後執行原本 `window.hide()` 及 finish-close。任何 native 失敗／不回應均不成為 Widget hide 的等待條件。
7. 新 show 使用新 epoch、恢復探索，晚到的舊 close／cleanup 不得改新世代。

「CSS 前呼叫 begin-close」代表**較早送出關閉意圖**，不保證非同步 native 工作一定先於 CSS 第一幀完成。沒有先 await 原生 ACK，也沒有增加固定延遲。

可以接受退場時背景模糊較早消失；HTML 本身的 CSS 備援仍由原主題規則控制。本次不修改主題去擬合背景消失的動畫。

## 3. 診斷開關與 A/B

兩個環境變數都只在啟動開發版時讀取，無須修改 Windows 全域設定：

| 旗標 | 預設 | 用途 |
| --- | --- | --- |
| `SLU_NATIVE_BLUR_TRACE=1` | 關閉 | 同時開啟共用前端與 Rust 原生時間軸 |
| `SLU_NATIVE_BLUR_EARLY_EXIT=0` | 提前退出開啟 | 只供 A/B，比較 close deadline／動畫完成清理政策（不是完整回滾舊版所有呼叫順序） |

操作方式：先正常退出開發版與服務，再從工作區根目錄的 PowerShell 用程序範圍變數啟動既有入口，例如：

```powershell
$env:SLU_NATIVE_BLUR_TRACE = '1'
$env:SLU_NATIVE_BLUR_EARLY_EXIT = '0' # 要測預設提前退出時，省略此行
powershell -NoProfile -ExecutionPolicy Bypass -File tools/seelen-dev.ps1 Start
```

結束這個 PowerShell，或移除這兩個環境變數後再正常退出／重開開發版，即回到預設；沒有設定使用者／系統環境變數。WebView 已建立後更改環境變數不會追溯改變它。診斷旗標在 SDK 執行前注入到每份新文件。

### 關聯欄位及事件

| 範圍 | request ID／事件 |
| --- | --- |
| geometry | `session:geometry:sequence:epoch`；queued、send、ack、error、obsolete ACK |
| visibility | `session:visibility:epoch:open或close:deadlineMs`；send／ack、Rust receive／ui.begin／applied／ui.end |
| session | 回傳後使用 `session:session`；初始化前尚無 session，先依文件／視窗與時間對照 |
| Widget | show/hide call／API ack、token、session／epoch、非同步 isVisible 查詢 |
| 動畫 | close requested、ready、finished／cancelled、等待結果為 finished／watchdog／none |
| 原生 | HWND 的 User32 可見性採樣、root／一個 region 的 opacity API 查詢、deadline arm、即時隱藏、Host detach／close、到期清理 |

前端輸出 `NATIVE_BLUR_TIMELINE` JSON，Rust 使用 `native_blur_timeline` target。紀錄在原有 Seelen runtime log，通常位於 `%LOCALAPPDATA%/com.seelen.seelen-ui/logs/Seelen UI.log`。

原生的 `wall_ms` 可對照前端的 `wallMs`，`elapsed_us` 用於辨識 Rust 接收後到主執行緒實際開始的等待。牆鐘可能受系統校時影響，不把不同時鐘之差當作無誤差的效能基準。

診斷關閉時沒有額外的永久輪詢、逐幀 log 或可見性查詢；診斷啟用後則有 log 與少量 API 查詢成本。JS 診斷 sink 拋錯會被忽略，不能阻止 show/hide。原生 opacity 查詢失敗只記成未取得值，不能把已成功的 cleanup 變成失敗。

所有 `api.ack`、`visual.*.api`、`host.release.api` 都只是 API／狀態觀察。Rust 明確標示 `api_only=true`／`gpu_present=unmeasured`。**沒有 DWM／GPU present fence 或畫面像素量測，不得據此認定螢幕最後一幀已消失。**

## 4. 測試與證據

### 單元與原生測試

- 前端 15 項：lane 5、diagnostic 1、geometry 2、opacity 2、hide animation 5。
- lane 包含一個永久等待舊請求後連續 98 個新世代、兩槽都卡住時的上限、最新值合併、舊拒絕／finally 隔離及目前錯誤回報。
- 原生模糊 9 項通過，2 項明確啟動型 benchmark／stress 保持 ignored。
- 新原生測試使用真實 Composition 物件，確認 root 設為 0 後不被幾何更新恢復；主動 Close Visual 製造 API 異常，仍取出並釋放 Host。這不是可見桌面上的 GPU 量測。
- 另明確啟動 `lifecycle_stress`：500 次隱藏 HWND 生命週期通過，region 建立 4,000／釋放 4,000。private bytes 在第 20／100／300／500 次約為 2.68／2.72／2.92／3.01 MB，有小幅成長；只能證明本輪計數相符，不能宣稱長期沒有記憶體洩漏或 VRAM 已驗收。原始紀錄為 `.dev/blur-stability-lifecycle-stress.log`。
- 原有 7 個 browser close 回歸仍通過。

### 新 browser 回歸與 A/B

`scripts/native-blur-stability-tests.mjs` 有 14 個場景，執行真實 Widget_4／controller／browser 動畫，原生 IPC、Host 及 HWND 則是獨立 Node 事件迴圈的模型。

包括正常提前／原有退場、快速重開、連續 30 次開關、舊 visibility ACK 永不回應、close 控制拒絕、renderer 阻塞 120／320ms、visibility 派送延遲 250ms、舊 geometry 延遲／永久不回應／拒絕，以及診斷預設關閉和啟用事件檢查。另保留 3D 翻轉案例以確認沒有偷偷改變主題能力邊界。

代表性單輪數據（模型，不是實機改善百分比）：

| 情境 | 修正前排查紀錄 | 本次模型觀察 |
| --- | --- | --- |
| 正常 close 原生背景存留 | 約 92ms | 預設提前約 2.3ms；同輪 legacy A/B 約 90.7ms |
| 舊 geometry 每次派送延遲 250ms 後快速重開 | 約 478ms 才更新新幾何 | 約 262ms；仍含新請求本身的 250ms，不再先等舊 ACK |
| 舊 geometry ACK 永不回應 | 新模糊未恢復 | 本輪約 4.1ms 取得新有效模型幾何 |
| JS renderer 阻塞 320ms | 模型 host 約 217ms 清理，window.hide 約 343ms | 模型 host 約 1.7ms 清理，window.hide 仍約 342ms |
| visibility 派送延遲 250ms | 模型背景清理約 264ms | 仍約 262ms，提前意圖不能越過卡住的原生派送 |
| Aurora 3D 入場 | 約 228ms 接上原生區域 | 仍約 228ms，本次刻意不擬合特殊動畫 |

不同輪次受機器負載影響；例如正常 HTML hide 曾量到約 88–174ms，不能宣稱提前 native 退出也讓 HTML hide 更快。正式比較應固定環境並保留分佈。

原始紀錄位於 `.dev/blur-stability-*`，由 `.gitignore` 排除；持久的實作與重現方式保存在本文件及測試來源。

```powershell
# 在 seelen-core/libs/core/ 執行（Deno 路徑依現機調整）
../../../.tools/deno/deno.exe test --frozen --cached-only --config deno.json `
  src/state/theme/nativeBlurLane.test.ts src/state/theme/nativeBlurDiagnostics.test.ts `
  src/state/theme/nativeBlurGeometry.test.ts src/state/theme/nativeBlurAnimation.test.ts `
  src/state/widget/abstractions/hideAnimations.test.ts

# 在 seelen-core/ 執行
cargo test --locked --offline -p seelen-ui --bin seelen-ui native_blur -- --test-threads=1
node scripts/native-blur-stability-tests.mjs
```

新 browser 腳本預設輸出 `.dev/blur-stability-trace/stability-timeline.json`，可傳入另一個輸出目錄保留 A/B。它使用現機的 Playwright 與 Edge channel；移機需配置對應測試依賴。沒有建立對舊 Seelen 原始碼的產品依賴。

## 5. 尚未解決的限制與實機驗收

- 兩個真正永久失效的同通道 request 仍需 transport／文件層恢復，不透過無限制增加 invoke 解決。
- JS 完全停住時，`window.hide()` 仍無法準時發出；提前 native close 只有先送達原生端，才能在這段時間協助退出。
- 原生主執行緒或 GPU／DWM 卡住仍可能延遲實際顯示結果；本次沒有 GPU frame time、VRAM、功耗或 DWM present 資料。
- 第三方 Widget 若內含舊 SDK、直接操作底層視窗，不保證會進入新版 Widget_4 的關閉流程。宿主共用 controller 仍可提供幾何同步，但不能推論所有生命週期入口都升級。
- 提前退出可能讓還在退場的 HTML 暫時失去原生背景材質，這是本次接受的取捨；沒有改動 Aurora 的動畫與 CSS 備援。
- session、sequence、epoch 仍是必要保護，不能因傳輸通道可恢復就移除。

SDK、前端與 Debug 建置完成只代表程式可產生；實際肉眼殘留、所有 Widget、多螢幕／不同 DPI 與長時間高負載使用，仍需在新版執行檔進行驗收。未經使用者確認，不標記為畫面已驗收。

本次已完成 SDK 2.8.10 隔離重建、前端建置與 `seelen-ui` Debug 建置；執行檔仍位於固定的 `E:/SeelenUI-Cache/seelen-core/cargo-target/debug/seelen-ui.exe`。背景前端恢復原管理狀態，沒有自動重新啟動桌面；可從原「Seelen UI 開發版」捷徑開啟。診斷預設關閉、提前退出預設啟用。
