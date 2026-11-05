# Native Blur 效能檢查與小幅優化（2026-10-20）

> 本報告為前一輪效能基準。後續已移除關閉流程的 150 ms 模糊清理等待，
> 加入獨立可見性截止與競態保護，見 [關閉生命週期修正](native-blur-close-lifecycle.md)。

## 結論與證據範圍

這次改善的是可確認的 CPU／配置工作，不更動模糊強度、取樣來源、
Gaussian blur 的品質／邊界設定、圓角或 WebView2 合成架構。
沒有修改 Aurora，也沒有切換執行中 Seelen 的設定或重新啟動它。

已實測：真實 Chromium DOM 的同步操作量、模擬 IPC 背壓、原生 Composition
物件建立／更新、裁切樹重建、短期反覆建立與移除。
**未實測：優化前後正式 Widget 的 GPU frame time、VRAM 差異、WebView2 關閉
硬體加速後的實際模糊畫面，以及數小時使用的記憶體趨勢。**
下面的改善百分比不能當成 GPU 使用率或整個 Seelen 的效能改善幅度。

## 環境與測試方法

- Windows，NVIDIA GeForce RTX 5070 Ti，驅動 32.0.15.9571；另有 DeskIn 虛擬顯示介面。
- 執行中的 WebView2：155.0.4283.62；未觀察到 `--disable-gpu`。
- 隔離 DOM 測試：Edge 155.0.4283.62、headless、1000×800 viewport，非使用者瀏覽器設定檔。
- DOM 測試直接 bundle 真正的 Controller／Geometry／Animation 程式碼，
  僅將 `invoke` 換成 10 ms 回應的測試替身；背壓情境為 100 ms。
  因此 IPC **次數／序列限制**有測到，但真實 Tauri 往返時間沒有測到。
- 1／8／32 個區域，測試靜止、40 次位移、暫停、document hidden、元素移除、
  CSS 停用、淡出／淡入、50 次樣式 refresh、100 次建立／移除，以及慢速 IPC。
- 所有情境另外以 `--disable-gpu --disable-gpu-compositing` 重跑；
  這是 Chromium 前端測試，不是完整 WebView2／原生模糊硬體加速 A/B。
- 原生測試為未最佳化 debug：每區域 4 個裁切、40 次變更第一個裁切，
  1／8／32 區域各重複 5 次，報告 CPU 提交時間中位數。
  它不等待 GPU 畫面完成，也不測顯示幀率。
- 測試用資源計數器均以 `cfg(test)` 包住，正常執行版沒有這些計數成本。

## 優化前後比較

### 前端：32 區域，僅其中一個位移 40 次

| 指標 | 修改前 | 修改後 | 解讀 |
| --- | ---: | ---: | --- |
| `getComputedStyle` 呼叫 | 12,800 | 2,680 | 減少 79.1% |
| `getBoundingClientRect` 呼叫 | 3,840 | 2,560 | 減少 33.3% |
| 重寫 `ready` 屬性 | 1,280 | 0 | 既有狀態不再反覆寫入；首次設置仍保留 |
| IPC 更新 | 40 | 40 | 原本已有整批去重，不虛稱 IPC 降低 |
| payload 字元數 | 383,832 | 383,832 | 保持相同資料格式與輸出 |

Widget 暫停後，100 次背景 DOM 變更造成的選取掃描從 **93 次降到 0 次**；
document hidden 情境從 **99 次降到 0 次**。恢復後重新探索，8 個區域正確回復。
計時器排程會影響掃描次數，這是保存的那一輪數據，不是固定常數。

靜止一秒的穩定狀態前後都是 **0 掃描／0 幾何讀取／0 IPC**。
移除最後元素與 CSS 停用前後都是 **1 次空區域 IPC**，最終活動區域為 0。
模擬慢 IPC 時，前後最多都只有 **1 個請求在途**；保留最新 pending frame。

預設與停用 Chromium GPU 的兩組測試，12 種情境的最終區域資料 SHA-256
皆與各自修改前一致（共 24 組），包含強度、透明度、座標與圓角。
這證明測試情境的輸出資料未改變，**不是 GPU 像素級畫質驗證**。

### 原生：每個區域都變動，4 個裁切中只改一個

| 區域數 | 路徑更新：前 → 後 | CPU 提交中位數：前 → 後 |
| ---: | ---: | ---: |
| 1 | 160 → 40 | 0.843 → 0.241 ms |
| 8 | 1,280 → 320 | 5.634 → 1.885 ms |
| 32 | 5,120 → 1,280 | 23.787 → 8.437 ms |

路徑更新減少 **75%**。32 區域的 CPU 提交時間減少約 **64.5%**，
但這是 40 輪的總提交時間，不是每幀 GPU 時間。
時間仍會受這台電腦的背景負載、debug 設定及時脈影響；固定操作次數的減少
比單一環境的耗時百分比更能直接支持這次優化。
更新期間 Brush／EffectFactory 建立數前後皆只對應初次的 1／8／32 個區域，
幾何改變沒有重新建立效果。

## 逐項檢查結果

### 1. Effect／Brush／Visual 重複建立及釋放

- 每個區域 id 對應一個 `RegionVisual`；一般位置、尺寸、透明度變動重用它。
- `create_blur_brush` 每次確實會建立 EffectFactory、EffectBrush 及 BackdropBrush，
  但正常更新只在新區域或實際 blur amount 改變時呼叫，不是每幀建立。
- 同強度的不同區域仍各有 Factory。這有初次建立成本，但數量受 32 區域上限限制。
  這次沒有加入共用 brush 或永久 factory cache，避免取樣語意／跨 Compositor
  相容性改變及新增無界快取。未實測前不宣稱共用會更快。
- 這次僅重建有變動的 D2D／CompositionPath，其餘裁切與 Brush 保持同一物件。
- 回歸測試重現原有裁切層數改變時的 `0x80000013`：拆掉舊祖先容器後，
  重掛 Sprite 會遇到已關閉物件。已改為先從舊父容器卸下 Sprite，再拆裁切樹。
  增加及減少裁切層數均通過測試。

### 2. 隱藏／停用／元素移除

- 原有空區域更新會釋放 host；導航與 Widget 銷毀會清除 session／host。
  host 解除 target root 並關閉 DesktopWindowTarget。這些路徑仍保留。
- 原有 Widget hide 會清空原生區域，並設有 150 ms IPC 保險；若 IPC 卡住，
  HWND 隱藏本身也會隱藏它的原生合成內容。
- 修正暫停／隱藏後仍受 DOM 事件驅動而掃描的問題：取消排程，
  隱藏變更只標記 dirty，恢復可見後統一更新。document hidden 仍主動送清空。
- 目前 observer 及 Widget DOM 並非全部銷毀；它們要偵測恢復與主題變更。
  隱藏期間移除的元素可能仍由 Controller 的既有觀察集合保留到重新探索或頁面銷毀。
  這是暫時保留，不是已證明的無界洩漏；未新增另一套視窗系統。
- 第三方 Widget 若直接呼叫底層視窗 API、不經共同 hide 流程，而且 WebView2
  又沒有回報 `visibilitychange`，可能只靠 HWND 隱藏而保留 host。尚未全面實測
  每個第三方 Widget；不能把共同 Widget 路徑的結果當成全部覆蓋。

### 3. 實際渲染區域

- Sprite 大小是元素的 border box，不是整個 WebView；祖先圓角／overflow／viewport
  以裁切鏈限制輸出。區域完整離開可見交集時，前端不送該區域。
- 部分被裁切的大元素，Sprite 的矩形大小仍可能大於最後可見部分。
  圓角裁切也不代表 Gaussian kernel 只計算可見像素；Composition／驅動的中間
  surface 與取樣範圍不能由幾何面積精確推定。
- 未直接縮小 Sprite 或刪除 blur kernel 所需的鄰近取樣。這可能改變邊緣品質，
  在沒有 GPU trace／像素對照前不做此類「省 GPU」改動。
- 未合併重疊／巢狀區域；它們原本可能疊加模糊，合併會改變視覺結果。

### 4. CSS／Geometry／IPC

- 保留 30 Hz 一般幾何批次、動畫邊界立即更新、整個 frame 去重、
  一個在途 IPC 及一個最新 pending frame。不提高輪詢頻率。
- 同一個同步讀取內快取 computed style，避免每個區域反覆讀同一批祖先；
  快取不跨 frame，也不長期保留 CSSStyleDeclaration。
- 重用已取得的元素 border box，不重讀同一個 rect。
- 只有 `ready` 真正變動時才寫入，減少 MutationObserver 連鎖工作。
- 仍保留主題選取重新探索；不能任意忽略 class／style 變更，否則會破壞
  `:has()`、屬性 selector 等既有 CSS opt-in 行為。

### 5. 多區域、切換主題及記憶體

- 1／8／32 區域測試通過；50 次不影響幾何的樣式 refresh 沒有多餘 IPC。
- 100 次前端建立／移除結束後原生活動集合為 0。
- 隱藏 HWND 的 500 次 host 建立／清空／釋放，4,000 個 RegionVisual wrapper
  建立與 drop 計數相符，原生 root 的 Children 也確實歸零。
  測試程序 private bytes 在第 20／100／300／500 次為
  2,768,896／3,039,232／3,043,328／3,104,768 bytes。
  這不是 Seelen 常駐記憶體，也不是 GPU 資源 refcount／VRAM 的直接證明。
- 前端 100 次生命週期後，GC 後 heap 增量約 185 KiB（前）／193 KiB（後）。
  這次沒有測出 retained heap 改善；不能宣稱記憶體洩漏已解決。
- 對尚未重啟的實際版本另做背景採樣：40 輪實際耗時約 91.1 秒，
  Seelen 程序樹 private memory 約 1,890.8 → 2,140.7 MiB。
  PID 51952 已確認為 WebView2 **gpu-process**，約 299.2 → 456.6 MiB；
  Rust 主程序約增加 11.0 MiB。不是已定位到特定 Widget renderer。
  採樣混有使用者操作、測試與其他 Widget，原本每 30 秒還有 memory pressure
  模擬，因此這是待查異常，不是 blur-only A/B 或洩漏歸因。
  第一版採樣器是 40 輪；現在腳本已改為以實際秒數限制，並記錄 process role。

### 6. WebView2 硬體加速

- Seelen 的開關控制 WebView2 browser args；Widget 的
  `force_hardware_acceleration` 可能覆蓋全域關閉值，A/B 必須確認實際 args。
- Rust Windows Composition 與 WebView2 是不同渲染路徑，關掉後者不代表
  前者變成 CPU 模糊；DWM／原生 Composition 仍可能使用 GPU。
- 隔離 Chromium 預設／停用 GPU 兩組的同步與清理回歸皆通過。
  尚未操作使用者設定測試真正 WebView2 的透明背景、原生模糊畫面及 GPU 差異。
  沒有為了得到較低數值而關閉硬體加速或改用低品質模糊。

## 重跑方式

從 `source/community-nightly` 開啟 PowerShell，沿用 E 槽快取：

```powershell
$env:CARGO_TARGET_DIR = 'E:\SeelenUI-Cache\community-nightly\cargo-target'
$env:SLU_PLAYWRIGHT_PATH = 'C:\Users\jacky\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright\index.js'
node scripts/native-blur-perf.mjs documentation/native-blur-perf-rerun.json
node scripts/native-blur-perf.mjs documentation/native-blur-perf-software-rerun.json --disable-gpu
node scripts/native-blur-native-perf.mjs documentation/native-blur-native-rerun.json
node scripts/native-blur-native-perf.mjs documentation/native-blur-lifecycle-rerun.json --lifecycle-only
cargo test -p seelen-ui --bin seelen-ui native_blur -- --test-threads=1
```

Playwright 路徑是這台電腦的既有工具；其他電腦請指定既有 Playwright 安裝，
或讓 Node 能解析 `playwright`。需要已安裝 Edge；不會自動下載瀏覽器。

真實畫面／GPU／長時間驗證仍需分階段：固定桌布及測試 Widget、區域數、DPI、
視窗位置、電源狀態；測試期間避免其他測試／播放影片。每組暖機 30 秒，
固定操作腳本採樣至少 60 秒，交替重複五輪；另外在相同情境記錄 30–60 分鐘。
若切換 WebView2 GPU，須重啟並確認 browser args；不要混用強制 GPU 的 Widget。
每輪只改一個變因（blur 開／關，或 WebView2 GPU 開／關），兩者不要一起改。

```powershell
.\scripts\Measure-NativeBlurRuntime.ps1 -Seconds 60 -OutputPath .\documentation\runtime-run.json
# 人工固定情境後，才做長時間紀錄：
.\scripts\Measure-NativeBlurRuntime.ps1 -Seconds 1800 -OutputPath .\documentation\runtime-soak.json
```

採樣器只讀取程序／效能計數器，不會切換主題、重啟程式或操作 UI。
CIM 有成本，低頻採樣本身也可能干擾結果；DWM 數值含其他應用程式，
GPU engine 使用率不可直接相加當成總 GPU 百分比。
要證明實際 GPU frame time／取樣面積降低，仍需 ETW／GPUView／WPA trace，
這次沒有取得該證據。

## 修改檔案及原始數據

- `libs/core/src/state/theme/nativeBlur.ts`：隱藏排程、單次 style cache、狀態屬性去重。
- `nativeBlurGeometry.ts`、`nativeBlurAnimation.ts`：接受單次讀取的 style reader；rect 重用。
- `src/background/widgets/native_blur.rs`：只更新改變的裁切，安全卸載 Sprite。
- `native_blur_effect.rs`：僅新增 `cfg(test)` Brush 建立計數，不改效果。
- `native_blur_performance.rs`：原生資源、生命週期及裁切重建回歸。
- `scripts/native-blur-*.mjs`、`scripts/Measure-NativeBlurRuntime.ps1`：可重跑測試／採樣。
- 同目錄 `native-blur-perf-{before,after}*.json`、`native-blur-native-{before,after}.json`、
  `native-blur-lifecycle-after.json`、`native-blur-runtime-context.json` 保留原始數據。

參考：[Composition brushes](https://learn.microsoft.com/en-us/windows/uwp/composition/composition-brushes)、
[WebView2 performance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/performance)、
[Compositor.Close](https://learn.microsoft.com/en-us/uwp/api/windows.ui.composition.compositor.close)。
