# Aurora 翻開動畫的原生模糊輪廓擬合

日期：2026-11-07。使用者已授權同時修改 Seelen 本體與 Aurora 主題；範圍為入場與一般退場，失焦／切換仍優先清除。維持 Windowed WebView2 Hosting，不修改 Wry，不發布 Marketplace。

## 啟用與效果

Aurora `shared/index.scss` 只在九種本體工具列 popover 設定：

```css
--slu-native-blur-projection: flip;
--slu-native-blur-close: animate;
```

包含使用者、網路、藍牙、行事曆、媒體、通知、快速設定、語言及托盤面板。Classic 的原生模糊仍不會因此被啟用；目前預覽保留使用者保存的 Frost 材質。既有 220ms 入場、180ms 退場、115/85ms opacity 及 hinge origin 沒有改動。

入場不必等整個 rotateX 結束才送出模糊區域。控制器將自身的單平面 perspective/rotateX 圓角邊界投影成凸多邊形，再讓原生背景依該輪廓裁切。它沒有旋轉桌面背景貼圖，也沒有改為 Visual Hosting。

一般退場只有在主題同時明確啟用 projection=flip 與 close=animate 時，才沿用有限 deadline 的關閉路徑：繼續送幾何及 opacity curve，Compositor 的 root gate 到期歸零，HTML 完成後清理 Host。現在 Widget 的關閉預算上限為 200ms，hide 不等模糊 ACK，快速新 show 仍以新 epoch 取消舊 close。

失焦時原生 root 仍立即隱藏；其後即使收到主題的動畫 close，也會將 native remaining 強制為零，避免 arm_hide 重新把 root 設成 1。工具列切換依然先清理舊 Host，再啟動新面板。因此這兩條路徑刻意不保留出場模糊動畫，優先維持已改善的殘留行為。

## 實作與相容性

- `libs/core/src/state/theme/nativeBlurProjection.ts`：正面 X 軸單平面投影、perspective divide、角落取樣及瀏覽器 bounds 對齊；最多 36 個取樣點。
- `nativeBlurGeometry.ts`：只有主題明確 opt-in 的元素本身可走投影路徑。祖先仍限制為可支援的正向、軸對齊變形；保留 overflow、viewport 及原本圓角裁切。
- `native_blur.rs`（SDK DTO）：NativeBlurShape 增加可省略的 polygon，座標為 viewport CSS pixels。舊 payload 缺少此欄位仍可反序列化，舊形狀仍走原本圓角路徑。
- `src/background/widgets/native_blur.rs`：DPI 縮放 polygon，D2D 路徑交給既有 Composition geometric clip。驗證有限值、bounds、凸性、方向、面積與最多 64 點；只接受第一個元素輪廓的 polygon。維持面積／regions 預算與資源重用。
- `nativeBlur.ts`：主題 opt-in 的一般關閉繼續幾何與 opacity bridge；其他主題保持預設 early exit。
- Aurora 僅修改 `shared/index.scss` 的 opt-in 區塊，沒有重寫既有未提交樣式。

不支援的變形會回到原本不提供原生輪廓的行為，不會以外接矩形強行模糊。第一版不支援任意 rotateY／shear、祖先 3D、透視相機穿越、背面、非零 z-origin 或個別 transform longhand 的投影擬合。減少動態效果繼續使用原本的 2D 路徑。

## 驗證

- SDK 經 `tools/sdk.mjs rebuild` 隔離生成與替換，Rust bindings 83 項通過，型別檢查／npm SDK 建置通過，fresh 檢查通過；未手動編輯生成檔或製造 stamp。
- Deno 18 項通過：投影、圓角、opacity bridge、lane、診斷、hide/watchdog。
- Rust native 19 項通過，2 個既有壓力／基準測試維持 ignored。新增舊 DTO 相容、真實 Composition 路徑建立及無效 polygon 拒絕案例；既有 focus／switch 保護仍通過。
- 新增真實 Aurora CSS 瀏覽器測試 8 個情境：上／下展開、150% DPI、快速重開、永不回應 control、降低動態、未啟用功能、不支援的祖先變形。
- 既有關閉 7 個與穩定性 14 個瀏覽器情境通過。
- Debug 建置通過，背景前端 ready；已載入 `@aurora/glass` 預覽並保留 Frost，線上版未修改。

測試資料、binary hash、runtime 與輪廓對照圖在 `.dev/blur-flip-20261107/`。`projected-contour.png` 是實際 CSS 翻轉面板與所算輪廓的對照，不是 Windows 原生背景截圖。

## 限制與驗收

輪廓每個圓角以 8 段近似，沿用控制器最多約 30Hz 的動畫幾何更新；不承諾像素級或逐幀完全同步。Compositor opacity curve 可自行運行，但幾何更新仍受 renderer、IPC、UI 執行緒與 DWM 排程影響。新增路徑／brush 工作的 GPU、VRAM、功耗與高負載效能未量測；不能以 headless／API 測試結果代替。

使用者目前鎖定電腦，已依要求正常退出舊主程式及服務後完成更新，再啟動新開發版供解鎖後測試。尚待實際確認：入場邊緣與圓角有無溢出、一般關閉是否自然、快速重開恢復，以及失焦／切換殘留是否維持改善。未確認前不寫成視覺已驗收，也不更新 Aurora DEV_CHANGELOG。

如需撤回動畫擬合，只移除 Aurora 上述兩個 opt-in 屬性即可恢復先前行為；本體的失焦與切換修正仍保留。不能只把 close=animate 單獨加給未知動畫，而省略 projection opt-in。
