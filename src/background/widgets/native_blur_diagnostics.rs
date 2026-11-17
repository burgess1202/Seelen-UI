//! Opt-in API timeline. No event here is a GPU/DWM presentation fence.
use std::{
    fmt::Arguments,
    sync::LazyLock,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

pub(super) fn enabled() -> bool {
    static ENABLED: LazyLock<bool> =
        LazyLock::new(|| std::env::var("SLU_NATIVE_BLUR_TRACE").is_ok_and(|v| v == "1"));
    *ENABLED
}

#[derive(Clone)]
pub(super) struct Request {
    id: String,
    received: Instant,
}

impl Request {
    pub fn focus(generation: u64) -> Option<Self> {
        enabled().then(|| Self {
            id: format!("focus:{generation}"),
            received: Instant::now(),
        })
    }
    pub fn popup_switch(generation: u64) -> Option<Self> {
        enabled().then(|| Self {
            id: format!("popup-switch:{generation}"),
            received: Instant::now(),
        })
    }
    pub fn session(session: u32) -> Option<Self> {
        enabled().then(|| Self {
            id: format!("{session}:session"),
            received: Instant::now(),
        })
    }
    pub fn geometry(session: u32, sequence: u32, epoch: u32) -> Option<Self> {
        enabled().then(|| Self {
            id: format!("{session}:geometry:{sequence}:{epoch}"),
            received: Instant::now(),
        })
    }

    pub fn visibility(session: u32, epoch: u32, visible: bool, deadline: f64) -> Option<Self> {
        enabled().then(|| Self {
            id: format!(
                "{session}:visibility:{epoch}:{}:{deadline:.0}",
                if visible { "open" } else { "close" }
            ),
            received: Instant::now(),
        })
    }

    pub fn event(&self, stage: &str, detail: Arguments<'_>) {
        let wall_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64()
            * 1000.0;
        log::info!(target: "native_blur_timeline", "stage={stage} request={} wall_ms={wall_ms:.3} elapsed_us={} api_only=true {detail}", self.id, self.received.elapsed().as_micros());
    }
}
