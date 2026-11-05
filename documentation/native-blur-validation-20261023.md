# Native Blur 單機驗證紀錄 — 2026-10-23

> 後續更新：本報告發現的關閉計時問題已另行小幅修正並完成 10 輪回歸，
> 見 [時間軸修正紀錄](native-blur-close-timing-fix-20261023.md)。下文保留當時
> 的失敗與量測，GPU 數據沒有因前端修正而被重新標成修正後測得。

## 結論

已取得真實執行中 Seelen／DWM 的開關對照數據，而不只是 CPU 提交 benchmark。
單一 Toolbar 18px 原生模糊在本機增加了可觀察到的 DWM 3D 引擎使用率。
這是功能提案／Draft PR 的初步證據，不是跨 GPU 相容性認證或效能驗收。

另外，關閉動畫回歸發現可間歇重現的提早隱藏：85ms CSS transition 在一次
hide 呼叫時仍停在約 80.959ms、opacity 0.0475412。產品程式這次沒有修改；
正式投稿前應處理時間軸同步，不得聲稱動畫測試全部通過。

## 環境與方法

- Windows 11，版本 10.0.26200／Build 26200。
- NVIDIA RTX 5070 Ti，驅動 32.0.16.1742；系統另裝 DeskIn Virtual Display Adapter。
- Win32_VideoController 回報實體顯示模式 2560×1440、210Hz；DPI／HDR 未量測。
- AMD Ryzen 5 7500F，12 logical processors。
- WebView2 155.0.4283.62，設定 hardwareAcceleration=true，未觀察到 disable-gpu 參數。
- 使用原本正在運行的未最佳化 debug 執行檔，未重啟／重建產品程式；二進位
  SHA-256 與基底 commit 見 JSON。來源有未提交修改，不等同該 commit 的乾淨版本。
- 使用者同意測試時暫停操作；其他背景程式／桌布未關閉或凍結。電源與 GPU
  時脈沒有鎖定，仍可能有背景及頻率干擾。
- 使用同一 Aurora 主題的 API 快照製作兩個臨時資源，ID／設定相同。兩組都關閉
  所有 CSS backdrop-filter 與其他 native blur，只在 on 組對既有 `.ft-bar`
  啟用 18 CSS px 模糊。前景保留，Toolbar 背景色兩組固定相同。
- 控制 CSS 使用高優先序 selector；這是限定的測試 preset，不代表未修改主題
  的全部負荷，也不是「框架完全未啟用」的零成本測試。實際可見幾何面積未取回。
- 順序 off/on、on/off、off/on；每輪暖機 15 秒、採樣約 60 秒，共 210 個採樣輪。
  每輪查詢 process tree、GPU engine 與 GPU process memory 計數器，再等待 1 秒；
  實際採樣間隔約 1.7 秒，計數器查詢本身也有成本。
- 相同實體 GPU engine 內累計追蹤程序的歸屬數值，**不把不同 GPU engine 百分比相加**。
  CPU 為整個 Seelen 子程序樹，除以 12 logical processors 正規化。

## 真實 GPU／CPU 結果

下表是各輪的算術平均，不是 GPU frame time。

| 配對 | 關閉：DWM 3D | 開啟：DWM 3D | 增加（百分點） | Seelen CPU 關閉／開啟 |
| --- | ---: | ---: | ---: | ---: |
| 1 | 0.343% | 1.229% | +0.886 | 6.355% / 6.485% |
| 2 | 0.486% | 1.200% | +0.714 | 6.340% / 6.272% |
| 3 | 0.314% | 1.314% | +1.000 | 6.061% / 6.073% |
| 三輪平均 | 0.381% | 1.248% | +0.867 | 6.252% / 6.277% |

- 引擎為 `phys_0 / eng_0 / 3D`。DWM 是共用桌面程序，包含其他程式的合成，
  不是只服務 Seelen。三次配對方向一致，但不能把全部 DWM 工作歸因於模糊。
- Seelen tree 的 GPU engine 整數採樣沒有讀到非零值，**不表示模糊沒有 GPU 成本**。
- CPU 差異 +0.130／-0.068／+0.012 百分點，沒有一致上升方向。不能據此宣稱
  CPU 零成本；約 6.2% 的整棵程序樹負荷也不是模糊框架本身的 CPU 使用率。
- 記憶體受 WebView2 回收與背景活動影響。Seelen private bytes 的配對平均差異
  為 +53.258／-12.456／+30.155 MiB，不能當成每個模糊區域的配置量或洩漏量。
- DWM 的 GPU memory 歸屬計數約 16.6 GiB，不能當成實際常駐 VRAM；本報告
  不以此判定實體 VRAM 成本。原始摘要保留歸屬計數並附限制。
- 量測時段 11:09:22–11:17:05（台灣時間），查詢到的相關 Application WER
  （Event 1001）事件為 0；不代表查證了所有類型的錯誤或長時間穩定性。

WPR GPU profile 啟動失敗：`0xc5585011 — Failed to enable the policy to profile
system performance`。沒有修改系統權限，也沒有留下執行中的 WPR session。
因此本次**沒有 ETW GPU 執行時間、逐幀延遲或掉幀率數據**。

## 原生資源回歸（與上述桌面量測分開執行）

每組有 4 層裁切、40 次更新，共跑 5 次。以下是 40 次更新的 CPU 提交總時間
中位數，不是單幀 GPU 時間：

| 區域數 | CPU 提交中位數 | 範圍 | Brush 建立數／每次測試 |
| --- | ---: | ---: | ---: |
| 1 | 0.188 ms | 0.182–0.309 ms | 1 |
| 8 | 1.619 ms | 1.390–1.983 ms | 8 |
| 32 | 7.188 ms | 5.466–9.010 ms | 32 |

500 次隱藏測試 HWND 生命週期：region 建立 4,000、釋放 4,000。
第 20／100／300／500 次 private bytes 分別為
2,703,360／2,596,864／2,822,144／2,891,776。
**最後值高於早期值，不能宣稱沒有洩漏**；計數配對只證明測試內的 region Drop
都有執行，不等同所有驅動／COM／GPU allocation 都已回收。
Rust native blur 一般測試 8 通過、2 個 benchmark 預設忽略；兩項 benchmark
已另行明確執行。這不是 30–60 分鐘的常駐 Widget 測試。

## 關閉動畫測試發現

第一次未加診斷的執行：前 3 項通過，`content-animation` 失敗，後 2 項未執行。
之後只增加測試診斷及失敗保存，不放寬斷言、不改產品程式，連續重跑 3 次：

- 第 1 次：5 通過、1 失敗。失敗時 CSS transition 仍 running，currentTime
  80.959ms／endTime 85ms、opacity 0.0475412。
- 第 2 次：6 通過。
- 第 3 次：6 通過。

這表示關閉 timeout 與 CSS 動畫時間軸可能有幾毫秒差異，不能稱作「完全沒播放
淡出」，也不能視為 UI 殘留的確定根因。它仍是一個正式 PR 前應定位的邊界問題。
其餘 stalled IPC、舊 close 晚到、截止不復活、快速重開與未啟用 native 主題的
測試都是 mock platform IPC，不能替代實際畫面及 GPU 測試。

## 未驗證與投稿界線

- computer-use 工具初始化失敗，無法判讀這次真實畫面的裁切、殘留幀與透明度。
- 沒有真實 Popup 100 次開關、30 分鐘長測、休眠恢復、GPU device-lost 復原測試。
- 沒有多區域真實 GPU、不同面積／半徑、動態背景控制、多螢幕混合 DPI 測試。
- 沒有 Intel／AMD／其他 NVIDIA、HDR 或真正 WebView2 hardware acceleration A/B。
- 沒有 release／最佳化 build 的可比較數據；不把 debug 成績宣稱為正式版效能。

建議先附這份 pilot 數據詢問官方是否接受架構，再處理動畫計時問題。若方向獲
接受，可用 Draft PR 持續補上 ETW 與他機結果；目前不應宣稱功能已完整驗收。

## 檔案與重跑

- `native-blur-runtime-ab-20261023.json`：不含使用者路徑／日誌的 GPU/CPU/記憶體摘要。
- `native-blur-native-20261023.json`、`native-blur-soak-20261023.json`：原生資源原始結果。
- `native-blur-close-20261023-{1,2,3}.json`：包含失敗的關閉測試結果。
- `scripts/Measure-NativeBlurAB.ps1`：本機 pilot；預設僅接受 default + Aurora 啟用順序，
  並依目前資源建立測試 preset，不是通用 benchmark 或預定上游產品功能。
- `scripts/Summarize-NativeBlurAB.mjs`：歸屬計數彙整，不把不同 GPU engine 相加。

```powershell
# 會暫時切換主題並於 finally 還原，先確定可以中斷桌面使用。
./scripts/Measure-NativeBlurAB.ps1 -OutputDirectory <private-output-directory> `
  -CliPath <debug-slu.exe> -Seconds 60 -Warmup 15 -Pairs 3 -TraceFirstPair
node scripts/Summarize-NativeBlurAB.mjs <private-output-directory>/runtime-ab.json <public-summary.json>
```

完整 process/log 原始資料及兩份生成的 Aurora fixture 保留在本機 D 槽量測目錄，
不應原樣上傳 GitHub。投稿只附已檢查的摘要與必要測試，避免把主題程式碼、
個人路徑、日誌與其他背景程式資訊一起公開。

## 可放進英文提案的摘要

On one RTX 5070 Ti system (Windows build 26200, driver 32.0.16.1742), I ran three
paired on/off trials using the same debug binary and an existing Toolbar background
with an 18 CSS px native blur. Other native and CSS backdrop blur was disabled in
both arms. Each trial had a 15-second warm-up and approximately 60 seconds of sampling.

The tracked DWM 3D engine averaged 0.381% with blur off and 1.248% with blur on;
paired increases ranged from 0.714 to 1.000 percentage points. These are sampled
shared-compositor utilization counters, not GPU frame times or blur-only measurements.
CPU and memory differences were not consistent enough to establish per-effect costs.

Native resource tests balanced 4,000 region creations and drops across 500 lifecycle
cycles. This does not establish long-term leak freedom. A frontend regression also
found an intermittent close-animation timing boundary, which remains to be resolved.
ETW frame timing, visual acceptance, optimized-build and cross-vendor validation are
still outstanding. I would like feedback on the architecture before expanding the work.
