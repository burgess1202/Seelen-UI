//! Resource/CPU microbenchmark, no visible window. Not GPU timing or a leak proof.
use super::super::native_blur_effect::TEST_BRUSH_CREATIONS;
use super::*;
use std::time::Instant;

fn model(id: u32) -> NativeBlurRegion {
    let shape = NativeBlurShape {
        x: 20.0,
        y: 20.0,
        width: 320.0,
        height: 200.0,
        radii: [[18.0, 18.0]; 4],
        polygon: None,
    };
    NativeBlurRegion {
        id,
        amount: 18.0,
        opacity: 1.0,
        opacity_animation: None,
        clips: vec![shape.clone(), shape.clone(), shape.clone(), shape],
    }
}

#[test]
#[ignore = "Explicit reproducible resource benchmark; run with --ignored --nocapture --test-threads=1"]
fn resource_baseline() {
    ensure_dispatcher().unwrap();
    for count in [1, 8, 32] {
        PERF_COUNTS.with_borrow_mut(|counts| *counts = PerfCounts::default());
        TEST_BRUSH_CREATIONS.with(|value| value.set(0));
        let compositor = Compositor::new().unwrap();
        let factory: ID2D1Factory =
            unsafe { D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None).unwrap() };
        let start = Instant::now();
        let mut visuals: Vec<_> = (0..count)
            .map(|id| RegionVisual::new(&compositor, &factory, model(id)).unwrap())
            .collect();
        let create_us = start.elapsed().as_micros();
        PERF_COUNTS.with_borrow_mut(|counts| counts.paths = 0);
        let start = Instant::now();
        for step in 0..40 {
            for (id, visual) in visuals.iter_mut().enumerate() {
                let mut region = model(id as u32);
                region.clips[0].x += step as f32 + 1.0;
                visual.update(&compositor, &factory, region).unwrap();
            }
        }
        let update_us = start.elapsed().as_micros();
        let paths = PERF_COUNTS.with_borrow(|counts| counts.paths);
        let brushes = TEST_BRUSH_CREATIONS.with(|value| value.get());
        assert_eq!(
            brushes, count as usize,
            "Geometry changes must reuse effect brushes"
        );
        drop(visuals);
        let counts = PERF_COUNTS.with_borrow(|counts| *counts);
        assert_eq!(counts.region_created, counts.region_dropped);
        println!(
            "NATIVE_BLUR_PERF {{\"regions\":{count},\"updates\":40,\"clips\":4,\"createUs\":{create_us},\"updateUs\":{update_us},\"paths\":{paths},\"brushes\":{brushes},\"created\":{},\"dropped\":{}}}",
            counts.region_created, counts.region_dropped
        );
    }
}

fn private_bytes() -> usize {
    use windows::Win32::System::{
        ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX},
        Threading::GetCurrentProcess,
    };
    let mut counters = PROCESS_MEMORY_COUNTERS_EX::default();
    unsafe {
        GetProcessMemoryInfo(
            GetCurrentProcess(),
            std::ptr::from_mut(&mut counters).cast(),
            std::mem::size_of_val(&counters) as u32,
        )
        .unwrap();
    }
    counters.PrivateUsage
}

fn drain_dispatcher() {
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, MSG, PM_REMOVE, PeekMessageW, TranslateMessage,
    };
    for _ in 0..10 {
        let mut message = MSG::default();
        unsafe {
            while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

#[test]
#[ignore = "Hidden HWND lifecycle stress; run explicitly, not a visible GPU benchmark"]
fn lifecycle_stress() {
    use windows::{
        Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, WS_POPUP},
        core::w,
    };
    ensure_dispatcher().unwrap();
    let hwnd = unsafe {
        CreateWindowExW(
            Default::default(),
            w!("STATIC"),
            w!("Seelen native blur resource test"),
            WS_POPUP,
            0,
            0,
            320,
            200,
            None,
            None,
            None,
            None,
        )
        .unwrap()
    };
    struct HiddenWindow(HWND);
    impl Drop for HiddenWindow {
        fn drop(&mut self) {
            let _ = unsafe { DestroyWindow(self.0) };
        }
    }
    let _window = HiddenWindow(hwnd);
    PERF_COUNTS.with_borrow_mut(|counts| *counts = PerfCounts::default());
    let mut samples = Vec::new();
    for cycle in 1..=500 {
        let mut host = NativeBlurHost::new(hwnd.0 as isize).unwrap();
        host.update((0..8).map(model).collect(), 1.0).unwrap();
        assert_eq!(host.regions.len(), 8);
        assert_eq!(host.root.Children().unwrap().Count().unwrap(), 8);
        host.update(Vec::new(), 1.0).unwrap();
        assert!(host.regions.is_empty());
        assert_eq!(host.root.Children().unwrap().Count().unwrap(), 0);
        drop(host);
        if cycle % 20 == 0 {
            drain_dispatcher();
        }
        if [20, 100, 300, 500].contains(&cycle) {
            samples.push(serde_json::json!({ "cycle": cycle, "privateBytes": private_bytes() }));
        }
    }
    let counts = PERF_COUNTS.with_borrow(|counts| *counts);
    assert_eq!(counts.region_created, 4000);
    assert_eq!(counts.region_created, counts.region_dropped);
    println!(
        "NATIVE_BLUR_LIFECYCLE {}",
        serde_json::json!({ "cycles": 500,
        "created": counts.region_created, "dropped": counts.region_dropped,
        "samples": samples, "note": "Hidden HWND, private process memory; not VRAM or a long-term leak proof" })
    );
}

#[test]
fn unchanged_clips_keep_paths_and_brush_identity() {
    ensure_dispatcher().unwrap();
    let compositor = Compositor::new().unwrap();
    let factory: ID2D1Factory =
        unsafe { D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None).unwrap() };
    let mut region = model(0);
    let mut visual = RegionVisual::new(&compositor, &factory, region.clone()).unwrap();
    let original: Vec<_> = visual
        .clips
        .iter()
        .map(|clip| clip.Path().unwrap())
        .collect();
    let brush = visual._brush.clone();
    region.clips[0].x += 1.0;
    visual
        .update(&compositor, &factory, region.clone())
        .unwrap();
    assert_ne!(visual.clips[0].Path().unwrap(), original[0]);
    assert_eq!(visual.clips[1].Path().unwrap(), original[1]);
    assert_eq!(visual._brush, brush);
    region.clips.push(region.clips[0].clone());
    visual
        .update(&compositor, &factory, region.clone())
        .unwrap();
    assert_eq!(visual.clips.len(), 5);
    for clip in &visual.clips {
        assert!(clip.Path().is_ok());
    }
    region.clips.truncate(2);
    visual.update(&compositor, &factory, region).unwrap();
    assert_eq!(visual.clips.len(), 2);
    assert_eq!(visual._brush, brush);
}

#[test]
fn native_visibility_gate_cannot_be_undone_by_geometry_updates() {
    use windows::{
        Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, WS_POPUP},
        core::w,
    };
    ensure_dispatcher().unwrap();
    let hwnd = unsafe {
        CreateWindowExW(
            Default::default(),
            w!("STATIC"),
            w!("Native blur gate test"),
            WS_POPUP,
            0,
            0,
            320,
            200,
            None,
            None,
            None,
            None,
        )
        .unwrap()
    };
    struct HiddenWindow(HWND);
    impl Drop for HiddenWindow {
        fn drop(&mut self) {
            let _ = unsafe { DestroyWindow(self.0) };
        }
    }
    let _window = HiddenWindow(hwnd);
    let mut host = NativeBlurHost::new(hwnd.0 as isize).unwrap();
    host.update(vec![model(0)], 1.0).unwrap();
    host.arm_hide(std::time::Duration::from_millis(80)).unwrap();
    host.arm_hide(std::time::Duration::ZERO).unwrap();
    assert_eq!(host.root.Opacity().unwrap(), 0.0);
    let mut region = model(0);
    region.clips[0].x += 5.0;
    host.update(vec![region], 1.0).unwrap();
    assert_eq!(host.root.Opacity().unwrap(), 0.0);
}

#[test]
fn immediate_exit_releases_host_even_when_the_visual_api_fails() {
    use windows::{
        Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, WS_POPUP},
        core::w,
    };
    ensure_dispatcher().unwrap();
    let hwnd = unsafe {
        CreateWindowExW(
            Default::default(),
            w!("STATIC"),
            w!("Native blur immediate-exit test"),
            WS_POPUP,
            0,
            0,
            320,
            200,
            None,
            None,
            None,
            None,
        )
        .unwrap()
    };
    struct HiddenWindow(HWND);
    impl Drop for HiddenWindow {
        fn drop(&mut self) {
            let _ = unsafe { DestroyWindow(self.0) };
        }
    }
    let _window = HiddenWindow(hwnd);
    let mut host = NativeBlurHost::new(hwnd.0 as isize).unwrap();
    host.update(vec![model(0)], 1.0).unwrap();
    host.hide_immediately().unwrap();
    assert_eq!(host.root.Opacity().unwrap(), 0.0);
    host.update(vec![model(0)], 1.0).unwrap();
    assert_eq!(host.root.Opacity().unwrap(), 0.0);
    // An explicitly closed Visual deterministically injects an abnormal cleanup path.
    host.root.Close().unwrap();
    let mut slot = Some(host);
    assert!(
        NativeBlurHost::release_immediately(
            &mut slot,
            diagnostics::Request::visibility(77, 1, false, 0.0)
        )
        .is_err()
    );
    assert!(slot.is_none());
    NativeBlurHost::release_immediately(&mut slot, None).unwrap();
}

#[test]
fn popup_switch_cleans_old_composition_host_before_continuation_but_keeps_target_and_non_popup() {
    use seelen_core::{
        resource::WidgetId,
        state::{Widget, WidgetPreset},
    };
    use std::sync::Arc;
    use windows::{
        Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, WS_POPUP},
        core::w,
    };
    ensure_dispatcher().unwrap();
    let ids = [
        "@test/popup-switch-old",
        "@test/popup-switch-target",
        "@test/popup-switch-desktop",
    ]
    .map(|id| WidgetId::from(id.to_owned()));
    struct Cleanup {
        ids: [WidgetId; 3],
        handles: Vec<HWND>,
    }
    impl Drop for Cleanup {
        fn drop(&mut self) {
            for id in &self.ids {
                let label = super::super::webview::WidgetWebviewLabel::new(id, None, None);
                WINDOWS.with_borrow_mut(|windows| {
                    windows.remove(&label.raw);
                });
                crate::resources::RESOURCES.widgets.remove_sync(id);
            }
            for hwnd in &self.handles {
                let _ = unsafe { DestroyWindow(*hwnd) };
            }
        }
    }
    let mut cleanup = Cleanup {
        ids: ids.clone(),
        handles: Vec::new(),
    };
    let mut labels = Vec::new();
    let mut roots = Vec::new();
    for (index, id) in ids.iter().enumerate() {
        let preset = if index == 2 {
            WidgetPreset::Desktop
        } else {
            WidgetPreset::Popup
        };
        crate::resources::RESOURCES
            .widgets
            .insert_sync(
                id.clone(),
                Arc::new(Widget {
                    id: id.clone(),
                    preset,
                    ..Default::default()
                }),
            )
            .unwrap();
        let hwnd = unsafe {
            CreateWindowExW(
                Default::default(),
                w!("STATIC"),
                w!("Blur popup-switch regression"),
                WS_POPUP,
                0,
                0,
                320,
                200,
                None,
                None,
                None,
                None,
            )
            .unwrap()
        };
        cleanup.handles.push(hwnd);
        let mut host = NativeBlurHost::new(hwnd.0 as isize).unwrap();
        host.update(vec![model(0)], 1.0).unwrap();
        roots.push(host.root.clone());
        let label = super::super::webview::WidgetWebviewLabel::new(id, None, None);
        let mut visibility = visibility::Visibility::default();
        visibility.open(4);
        WINDOWS.with_borrow_mut(|windows| {
            windows.insert(
                label.raw.clone(),
                WindowState {
                    hwnd: hwnd.0 as isize,
                    session: 101 + index as u32,
                    sequence: 7,
                    visibility,
                    host: Some(host),
                    focus: focus::PopupFocus::default(),
                    animate_close: false,
                },
            );
        });
        labels.push(label.raw);
    }
    WINDOWS.with_borrow_mut(|windows| windows.get_mut(&labels[0]).unwrap().animate_close = true);
    prepare_popup_switch(&ids[1], 1);
    assert_eq!(roots[0].Opacity().unwrap(), 1.0);
    WINDOWS.with_borrow_mut(|windows| {
        let outgoing = windows.get_mut(&labels[0]).unwrap();
        assert!(outgoing.host.is_some());
        assert!(outgoing.visibility.may_restore_focus_visual());
        outgoing.animate_close = false;
    });
    prepare_popup_switch(&ids[1], 1);
    // This is the point at which the production callback schedules the next WebView.
    assert_eq!(roots[0].Opacity().unwrap(), 0.0);
    WINDOWS.with_borrow_mut(|windows| {
        let old = windows.get_mut(&labels[0]).unwrap();
        assert!(old.host.is_none());
        assert!(!old.visibility.accept_frame(5, Instant::now()));
        assert!(!old.visibility.open(6));
        old.visibility.allow_popup_trigger();
        assert!(old.visibility.open(6));
        assert!(old.visibility.close(5, Instant::now()).is_none());
        assert!(windows[&labels[1]].host.is_some());
        assert!(windows[&labels[2]].host.is_some());
    });
    assert_eq!(roots[1].Opacity().unwrap(), 1.0);
    assert_eq!(roots[2].Opacity().unwrap(), 1.0);
    // A broken old Visual must still be removed and must not abort the switch.
    roots[1].Close().unwrap();
    prepare_popup_switch(&ids[0], 2);
    WINDOWS.with_borrow_mut(|windows| {
        assert!(windows[&labels[1]].host.is_none());
        assert!(windows[&labels[2]].host.is_some());
        let reopened = windows.get_mut(&labels[0]).unwrap();
        assert!(reopened.visibility.open(7));
        assert!(reopened.visibility.accept_frame(7, Instant::now()));
    });
}

#[test]
fn blur_focus_native_gate_hides_before_html_close_and_restores_owned_focus_safely() {
    use seelen_core::{
        resource::WidgetId,
        state::{Widget, WidgetPreset},
    };
    use std::sync::Arc;
    use windows::{
        Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, WS_POPUP},
        core::w,
    };
    ensure_dispatcher().unwrap();
    let id = WidgetId::from("@seelen/native-blur-focus-test".to_owned());
    let label = super::super::webview::WidgetWebviewLabel::new(&id, None, None);
    let hwnd = unsafe {
        CreateWindowExW(
            Default::default(),
            w!("STATIC"),
            w!("Native blur focus regression"),
            WS_POPUP,
            0,
            0,
            320,
            200,
            None,
            None,
            None,
            None,
        )
        .unwrap()
    };
    struct Cleanup {
        id: WidgetId,
        label: String,
        hwnd: HWND,
    }
    impl Drop for Cleanup {
        fn drop(&mut self) {
            WINDOWS.with_borrow_mut(|windows| {
                windows.remove(&self.label);
            });
            crate::resources::RESOURCES.widgets.remove_sync(&self.id);
            let _ = unsafe { DestroyWindow(self.hwnd) };
        }
    }
    let _cleanup = Cleanup {
        id: id.clone(),
        label: label.raw.clone(),
        hwnd,
    };
    crate::resources::RESOURCES
        .widgets
        .insert_sync(
            id.clone(),
            Arc::new(Widget {
                id,
                preset: WidgetPreset::Popup,
                ..Default::default()
            }),
        )
        .unwrap();
    let mut host = NativeBlurHost::new(hwnd.0 as isize).unwrap();
    host.update(vec![model(0)], 1.0).unwrap();
    let root = host.root.clone();
    let mut visibility = visibility::Visibility::default();
    visibility.open(4);
    WINDOWS.with_borrow_mut(|windows| {
        windows.insert(
            label.raw.clone(),
            WindowState {
                hwnd: hwnd.0 as isize,
                session: 5001,
                sequence: 7,
                visibility,
                host: Some(host),
                focus: focus::PopupFocus::new(hwnd.0 as isize, hwnd.0 as isize, 0),
                animate_close: true,
            },
        );
    });
    apply_popup_focus(1, 0, None);
    assert_eq!(root.Opacity().unwrap(), 1.0);
    apply_popup_focus(hwnd.0 as isize, 0, None);
    WINDOWS.with_borrow_mut(|windows| windows.get_mut(&label.raw).unwrap().animate_close = false);
    // An owned child matches the existing frontend rule and must not hide the parent.
    apply_popup_focus(1, hwnd.0 as isize, None);
    assert_eq!(root.Opacity().unwrap(), 1.0);
    apply_popup_focus(1, 0, None);
    assert_eq!(root.Opacity().unwrap(), 0.0);
    WINDOWS.with_borrow_mut(|windows| {
        let state = windows.get_mut(&label.raw).unwrap();
        assert_eq!(state.visibility.epoch, 4);
        assert_eq!(state.sequence, 7);
        assert!(state.visibility.deadline.is_none());
        assert!(state.host.is_some());
        state
            .host
            .as_mut()
            .unwrap()
            .update(vec![model(0)], 1.0)
            .unwrap();
    });
    assert_eq!(root.Opacity().unwrap(), 0.0);
    // Focus returns before the frontend debounce fired: no new epoch or IPC needed.
    apply_popup_focus(hwnd.0 as isize, 0, None);
    assert_eq!(root.Opacity().unwrap(), 1.0);
    apply_popup_focus(1, 0, None);
    WINDOWS.with_borrow_mut(|windows| {
        windows
            .get_mut(&label.raw)
            .unwrap()
            .visibility
            .close(5, Instant::now());
    });
    apply_popup_focus(hwnd.0 as isize, 0, None);
    assert_eq!(root.Opacity().unwrap(), 0.0); // A real close wins over a late focus return.
}
