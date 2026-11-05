# 本機開發版修改與功能

更新：2026-11-05。唯一開發入口為 `seelen-core/`，分支 `dev/aurora`。

官方基底：v2.8.9，`507378aa01190617c18ee2c70ecc66b316169437`。這次保留原 nightly 所有本機修改，沒有升級到 v2.8.10，也沒有套入全部舊版補丁。

## 現行本機功能

| 功能 | 使用者可感知的行為／範圍 | 主要來源 | 限制與驗證狀態 |
| --- | --- | --- | --- |
| 主題可選原生背景模糊 | 主題以現有元素的 CSS 屬性指定原生模糊，支援區域、圓角、裁切、透明度及可見性同步 | `libs/core/src/state/theme/nativeBlur*.ts`、`native_blur.rs`；`src/background/widgets/native_blur*.rs`；MainSetup／theme bootstrap | Aurora 有使用接口；不是新增一個已驗收的通用設定開關。硬體、長時間使用、各動畫情境仍需實機確認 |
| 模糊顯示／關閉生命週期 | 避免關閉動畫、重開與舊清理作業互相競速；原生資源跟隨可見性釋放 | widget `4_visibility.ts`、`hideAnimations.ts`、native blur visibility | 原工作區保留既有測試與效能紀錄；本次只做遷移與建置，不重跑完整 GPU／生命週期驗收 |
| 模糊效能優化 | 合併幾何更新、去重、限制在途請求、重用 brush／clip；暫停／hidden 時降低工作 | native blur controller／effect／performance | 詳見 `native-blur-performance.md`；既有 CPU 提交數據不能當作整體 GPU 使用率改善 |
| 工具列重複點擊開關修正 | 同一 toolbar popup 再點一次明確關閉，並避免同一 toggle 重入 | `libs/core/src/state/widget/mod.ts`、toolbar `components/Evaluated/actionEvaluator.ts` | 與舊 toolbar PR 的兩個修改檔一致；這是小範圍修補，不是舊 Community 的完整動畫狀態機 |
| 跟隨 Windows 靜態桌布 | 新 `WallpaperKind.Native` 與「目前的 Windows 桌布」資源；React／Svelte 可顯示目前 Windows 桌布，檔案被原地覆寫也可刷新 | `state/wallpaper/mod.rs`、resources、state infrastructure、React／Svelte NativeWallpaper | 跟隨靜態影像／快照，不是直接播放 Wallpaper Engine 動畫。Svelte 共用來源有使用者時每 2.5 秒更新；待實機確認選用入口與更新效果 |
| 原生服務不顯示主控台 | Windows 的 debug／release slu-service 均以無主控台模式執行；不再輸出到 stdout，Trace 與錯誤繼續寫檔 | `src/service/main.rs`、`src/service/logger.rs` | 使用者要求於 2026-11-05 新增；檔案記錄仍在 LocalAppData/com.seelen.seelen-ui/logs/SLU Service.log，保留原本輪替及 panic 記錄 |

原生服務無主控台變更已通過 `cargo check --locked --offline -p seelen-ui --bin slu-service` 與同範圍 Debug build；新 `slu-service.exe` 的 PE Subsystem 核對為 2（Windows GUI），原本為 3（Console）。使用者正常退出後已替換執行檔，未擅自重啟桌面；從原有開發版捷徑開啟即可使用。此變更只針對服務，不變更主程式、前端常駐或 CLI 的顯示模式。

命令包括 BeginNativeBlurSession、SyncNativeBlurRegions、SetNativeBlurVisibility、GetNativeShellWallpaperSnapshot。具體 API 以此 checkout 的宣告為準，不用官方參考碼較新的檔案代替。

## 本次整理新增的開發能力

- 獨立 Git repository 與固定路徑，不依賴舊 2.8.2 的 `.git`；原有歷史 refs 已保存。
- 獨立本機 SDK junction，前端不借用舊來源。
- 新專屬編譯快取 `E:/SeelenUI-Cache/seelen-core/cargo-target/`，避免沿用舊 D 槽 metadata。
- 根目錄 `seelen-dev.cmd`／`tools/seelen-dev.ps1`：狀態、前端監看、Rust 檢查、Debug 建置、啟動、記錄及官方版本唯讀查詢。
- 啟動前核對前端監看確實來自此專案、HTML 已回應；已有其他主程式或無法辨識的服務時拒絕啟動，不強制殺程序。
- 一份乾淨的官方 v2.8.10 參考碼，與開發版分開更新；更新與相容性流程已寫入工作區文件。

這次除了快取路徑與本機操作／文件，沒有改動本體功能程式碼。原 nightly 的 2,545 個來源檔在新增本機整理前逐檔一致。

## 未包含的舊功能

Apps Menu 額外載入框架、Dock plugin 高解析倍率、舊版遊戲模式增強修補、Bubbles 空白穿透、Community popup 完整六階段動畫與品牌／發布流程未移入。使用者已決定清除這些舊專案副本；Community 啟動／記錄／Ready 參考也依後續指示刪除，不移植其流程。詳見 `../../docs/UNUSED_REVIEW.md`。

核心原有的官方功能並不列為本機新增；官方完整能力見 `FEATURES.md`。不能因舊補丁未移植，就宣稱整個遊戲模式或所有 popup 都沒有功能。

## 指定開發流程改進（原清單第 4、7 項）

| 原項目 | 改進 | 實作與驗證 |
| --- | --- | --- |
| 4 | SDK 過期檢查與可靠重建 | 來源、工具、版本、API 與產物 SHA256；隔離生成、失敗不發布、替換失敗回復。SDKCheck／SDKRebuild；前端自動 ensure、Start 拒絕過期。實際 Rust 生成 83 項測試、Deno check、npm 生成通過 |
| 7 | 官方更新檢查與補丁狀態 | 官方 release、PR 狀態及合併是否進入正式版；本機來源雜湊與驗證證據。UpstreamCheck 產生工作區 docs/UPSTREAM_STATUS.md；每週一上午 10 點查核，有實質變化才通知，不合併或安裝 |

補丁與驗證來源定義在 `local-patches.json`；來源變動會讓既有驗證標為待重跑，沒有 PR 的項目仍標為待確認。詳見 `../../docs/SDK_WORKFLOW.md` 與 `../../docs/UPSTREAM_SYNC.md`。工具機制測試共 9 項通過。

使用者未選擇其餘改善建議，因此不列為本輪或後續預設待辦。現有兩步啟動及基本路徑／HTTP 檢查延續使用。

後續使用者另行要求前端登入常駐，已實作獨立 Node 管理程序、使用者安裝與登入入口。UI 捷徑重用該前端，SDK 工具可協調暫停／恢復 worker，不將前端生命週期綁在 UI 或 PowerShell 視窗。管理與解除安裝見 `../../docs/FRONTEND_SERVICE.md`。

## 本次驗證與限制

前端所有入口與離線 Debug 建置通過；前端 HTTP 200 與來源程序辨識通過。桌面未重新啟動、服務與 Widget Ready 未驗收；未宣稱通過 GPU 畫面、效能、完整型別檢查或全新電腦初始化。

本體 identifiers、資源 IDs、Windows 設定及 Marketplace 均未變更；原未提交工作仍保留為未提交狀態，未擅自提交。
