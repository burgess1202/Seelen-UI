# 原生桌布重啟後選取值遺失

## 已確認的現象

2026-11-06，設定頁的預設桌布顯示收藏 UUID，重新選取「目前的 Windows 桌布」後暫時正常。唯讀檢查設定檔確認：預設選取仍指向一個存在的 hidden collection，但該 collection 的 `wallpapers` 已變成空陣列。

`WallpaperCollectionSelector.tsx` 只有在 hidden collection 恰好含一張桌布時才會轉成桌布選項。空收藏無法完成對應，因此 Select 回退顯示 UUID。這不是單純補一段顯示名稱就能修正的問題。

## 原因與保護

原生項目 `@seelen/current-windows-wallpaper` 是虛擬內建桌布，不由一般桌布檔案產生。原本一般資源卸載會移除它，而收藏清理只保留當下資源表中存在的 ID。若清理時原生項目尚未登錄或正處於重載空窗，就可能把選取收藏中的 ID 刪除；一旦儲存，重啟也無法從 UUID 推回原桌布。

本次修正：

1. 收藏清理明確保留這個固定的虛擬內建 ID，不依賴暫時的資源表內容。
2. 一般桌布資源 unload／reload 保留原生項目，避免重載空窗。
3. 在掃描桌布目錄前先登錄原生項目，即使磁碟列舉失敗也不影響它。
4. 一般已刪除的檔案桌布仍照常清理，不保留所有失效 ID。

修改檔案為 `src/background/resources/mod.rs` 與 `src/background/state/application/settings.rs`，不修改桌布 renderer、模糊程式或其他使用者偏好。

這次已確認設定資料被清空及相關清理風險，沒有取得過去每次錯誤重啟的完整回呼時間軸，因此不把所有發生次數都歸因於某一個特定 watcher 事件。

## 回歸測試

`cargo test --locked --offline -p seelen-ui --bin seelen-ui native_wallpaper -- --test-threads=1`：

- 虛擬項目在 unload／reload 後仍存在，且重複登錄不新增不同 ID。
- 設定連續序列化／讀回／啟動清理三輪後，原生 ID、收藏 UUID 及 default collection 選取均保留。
- 混合收藏中保留原生及現存一般桌布，刪掉確實不存在的一般桌布；再次清理保持穩定。

三項測試通過，紀錄位於 `.dev/native-wallpaper-persistence-tests.log`。設定序列化測試不是 Windows 實際重開機測試，仍需新版執行檔重啟驗收。

## 舊資料與驗收

已經變空的收藏無法只靠 UUID 安全辨識它原先對應哪張桌布，不自動猜測或改寫全部空收藏。因此需最後重新選取一次原生桌布並儲存，讓修正版保護一份有正確 ID 的資料。

驗收時保持原有桌布 Widget 啟用開關不變，確認選取文字正確、退出後再開啟仍指向同一張原生桌布；不需要為這個修正重設桌布、清空所有收藏或重新安裝主題。

修正版已完成 Debug 建置，並於 2026-11-06 15:22（Asia/Taipei）透過既有入口重新啟動。使用者在建置前已重選並儲存正確原生 ID。自動化工具無法可靠操作此自訂 WebView 的導覽座標，未將設定頁選取文字標記為畫面已驗收；請在桌布管理器確認。
