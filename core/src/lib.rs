//! The app's 3D view: ThreeRT's live path tracer and the scene's script (scene/, bundled by the sidecar), drawn on a
//! CAMetalLayer the app owns. The SwiftUI app calls in through the C ABI at the end of this file (macos/App/Core.h).
//!
//! Everything runs on one thread of its own: the GPU device, the script runtime, the physics and the present. Calls
//! from the app are commands in a channel; what the scene posts (its HUD, its own messages), its console lines and
//! the renderer's statistics wait in a queue the app polls. A frame that takes long never holds the app's main thread.
//!
//! Messages the core sends the scene (besides the app's own, `rt_send`): `launch {params: {width, height}}` once
//! after setup, `view {width, height}` when the view's size changes, and `input` every frame.
//!
//! Messages the core itself posts (besides the scene's own `host.post`s):
//!   {"t":"rt.ready","bundle","adapter","hwrt","width","height"}   the view is up, running `bundle`
//!   {"t":"rt.fatal","message"}                            it could not start (no GPU with what the engine needs)
//!   {"t":"rt.error","where","message","bundle"?}          a frame, a message or a reload failed; the view goes on
//!                                                         (`bundle`: the build a "reload" error is about)
//!   {"t":"rt.reloaded","bundle"}                          a new build of the scene runs
//! Reloads asked for while a setup runs are not all run: only the newest of those waiting, so an agent saving file
//! after file does not queue a setup for each save. The skipped builds get no message (a newer one answers for them).
//!   {"t":"rt.stats","fps","gpuMs","scale","spp","bounces","scriptMs","shown","width","height"}   once a second
//!   {"t":"rt.snapshot","path","width","height"}           a snapshot was written
//!   {"t":"log","level","text"}                            a console line of the scene

use anyhow::{anyhow, Context, Result};
use std::collections::HashMap;
use std::ffi::{c_char, c_void, CStr, CString};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use threert_render::host::{launch_message_with_caps, InputTracker};
use threert_render::live::{next_spp, save_bgra, LiveCore};
use threert_render::script::{set_log_sink, GameSession};
use threert_render::{audio::Audio, gpu};

/// The room name the scene's runtime gets (`setup(room, seed)`); one view, one room.
const ROOM: &str = "app";

enum Cmd {
    Resize(u32, u32, f32),
    Pointer(f32, f32),
    Button(u8, bool),
    Wheel(f32),
    Key(String, String, bool),
    /// Host-channel messages for the scene.
    Send(Vec<serde_json::Value>),
    Snapshot(PathBuf),
    Reload(PathBuf),
    Quality { fps: u32, scale: f32, bounces: u32 },
    Quit,
}

struct Frame {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

#[derive(Default)]
struct Shared {
    /// What the scene posted and what the renderer reports, as JSON texts, oldest first.
    posts: Mutex<Vec<String>>,
    /// The newest picture of each stream texture that has not been uploaded yet.
    streams: Mutex<HashMap<String, Frame>>,
    quit: AtomicBool,
}

impl Shared {
    fn post(&self, v: serde_json::Value) {
        let mut q = self.posts.lock().unwrap();
        // (An app that stopped polling does not grow the queue without bound.)
        if q.len() > 4096 {
            q.drain(..2048);
        }
        q.push(v.to_string());
    }
}

/// The scene's console lines (the engine's log sink is a plain function: one per process).
static LOGS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

fn log_sink(level: &str, text: &str) {
    let mut logs = LOGS.lock().unwrap();
    if logs.len() < 2048 {
        logs.push((level.to_string(), text.to_string()));
    }
}

pub struct RtView {
    tx: mpsc::Sender<Cmd>,
    shared: Arc<Shared>,
    thread: Option<std::thread::JoinHandle<()>>,
}

struct Args {
    layer: usize,
    width: u32,
    height: u32,
    scale: f32,
    bundle: PathBuf,
    assets: PathBuf,
    presets: PathBuf,
}

struct State {
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    core: LiveCore,
    game: GameSession,
    input: InputTracker,
    audio: Audio,
    blit: wgpu::RenderPipeline,
    blit_layout: wgpu::BindGroupLayout,
    blit_size: wgpu::Buffer,
    blit_bg: wgpu::BindGroup,
    /// The size the app last asked for, pixels.
    want: (u32, u32),
    shown: bool,
    spp: u32,
    fps: u32,
    max_bounces: u32,
    last: Instant,
    frames: u32,
    stats_t: Instant,
    snapshot: Option<PathBuf>,
    assets: PathBuf,
}

fn init(a: &Args) -> Result<State> {
    let g = gpu::Gpu::new()?;
    // The layer is the app's, alive until `rt_destroy` joined this thread.
    let surface = unsafe { g.instance.create_surface_unsafe(wgpu::SurfaceTargetUnsafe::CoreAnimationLayer(a.layer as *mut c_void)) }.context("surface on the layer")?;
    let caps = surface.get_capabilities(&g.adapter);
    // The renderer outputs sRGB-encoded bytes already: present through a non-sRGB format.
    let format = caps.formats.iter().copied().find(|f| !f.is_srgb()).unwrap_or(caps.formats[0]);
    let config = wgpu::SurfaceConfiguration {
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        format,
        width: a.width.max(1),
        height: a.height.max(1),
        present_mode: wgpu::PresentMode::Fifo,
        desired_maximum_frame_latency: 2,
        alpha_mode: caps.alpha_modes[0],
        view_formats: vec![],
        color_space: Default::default(),
    };
    surface.configure(&g.device, &config);
    let (mut game, mut core) = GameSession::start(&a.bundle, ROOM, &a.assets, g, &a.presets, config.width, config.height)?;
    if let Err(e) = game.host_messages(&mut core, &[launch(config.width, config.height)]) {
        eprintln!("app-core: launch: {e:#}");
    }
    core.bounces = 4;
    core.set_scale(0.0);
    core.set_display_scale(a.scale);
    let d = &core.g.device;
    let module = d.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("blit"), source: wgpu::ShaderSource::Wgsl(BLIT.into()) });
    let buffer = |binding, ty| wgpu::BindGroupLayoutEntry { binding, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Buffer { ty, has_dynamic_offset: false, min_binding_size: None }, count: None };
    let layout = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: None, entries: &[buffer(0, wgpu::BufferBindingType::Storage { read_only: true }), buffer(1, wgpu::BufferBindingType::Uniform)] });
    let pl = d.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(&layout)], immediate_size: 0 });
    let blit = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("blit"),
        layout: Some(&pl),
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
        fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs"), targets: &[Some(format.into())], compilation_options: Default::default() }),
        primitive: Default::default(),
        depth_stencil: None,
        multisample: Default::default(),
        multiview_mask: None,
        cache: None,
    });
    let blit_size = d.create_buffer(&wgpu::BufferDescriptor { label: Some("blit size"), size: 16, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    core.g.queue.write_buffer(&blit_size, 0, bytemuck::cast_slice(&[core.w as f32, core.h as f32, config.width as f32, config.height as f32]));
    let blit_bg = blit_bind_group(d, &layout, &core.targets.out, &blit_size);
    let mut audio = Audio::new();
    audio.open(&a.assets);
    Ok(State {
        want: (config.width, config.height),
        surface,
        config,
        core,
        game,
        input: InputTracker::new(),
        audio,
        blit,
        blit_layout: layout,
        blit_size,
        blit_bg,
        shown: false,
        spp: 1,
        fps: 60,
        max_bounces: 4,
        last: Instant::now(),
        frames: 0,
        stats_t: Instant::now(),
        snapshot: None,
        assets: a.assets.clone(),
    })
}

/// The launch message: the view's size in its params, for a scene that casts rays through the pointer (the aspect).
fn launch(width: u32, height: u32) -> serde_json::Value {
    launch_message_with_caps(Some(&serde_json::json!({ "width": width, "height": height })), &[])
}

fn blit_bind_group(d: &wgpu::Device, layout: &wgpu::BindGroupLayout, out: &wgpu::Buffer, size: &wgpu::Buffer) -> wgpu::BindGroup {
    d.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("blit"), layout, entries: &[wgpu::BindGroupEntry { binding: 0, resource: out.as_entire_binding() }, wgpu::BindGroupEntry { binding: 1, resource: size.as_entire_binding() }] })
}

/// The surface and the view at the size the app asked for.
fn fit(s: &mut State) -> bool {
    let (w, h) = s.want;
    if w == 0 || h == 0 || (w, h) == (s.config.width, s.config.height) {
        return false;
    }
    (s.config.width, s.config.height) = (w, h);
    s.surface.configure(&s.core.g.device, &s.config);
    let before = (s.core.w, s.core.h);
    if let Err(e) = s.core.resize(w, h) {
        eprintln!("app-core: {e:#}");
    }
    s.core.g.queue.write_buffer(&s.blit_size, 0, bytemuck::cast_slice(&[s.core.w as f32, s.core.h as f32, w as f32, h as f32]));
    s.blit_bg = blit_bind_group(&s.core.g.device, &s.blit_layout, &s.core.targets.out, &s.blit_size);
    (s.core.w, s.core.h) != before
}

fn acquire(s: &mut State) -> Result<Option<wgpu::SurfaceTexture>> {
    use wgpu::CurrentSurfaceTexture as T;
    let tex = match s.surface.get_current_texture() {
        T::Success(t) | T::Suboptimal(t) => Some(t),
        T::Timeout | T::Occluded => None,
        T::Outdated | T::Lost => {
            s.surface.configure(&s.core.g.device, &s.config);
            None
        }
        T::Validation => return Err(anyhow!("surface: a validation error")),
    };
    s.shown = tex.is_some();
    Ok(tex)
}

fn pass(e: &mut wgpu::CommandEncoder, view: &wgpu::TextureView, blit: &wgpu::RenderPipeline, bg: &wgpu::BindGroup) {
    let mut rp = e.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("blit"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment { view, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } })],
        depth_stencil_attachment: None,
        timestamp_writes: None,
        occlusion_query_set: None,
        multiview_mask: None,
    });
    rp.set_pipeline(blit);
    rp.set_bind_group(0, bg, &[]);
    rp.draw(0..3, 0..1);
}

/// Between content frames: the last picture again, so the window keeps its display's rate.
fn reshow(s: &mut State) -> Result<()> {
    let Some(tex) = acquire(s)? else {
        std::thread::sleep(Duration::from_millis(4));
        return Ok(());
    };
    let view = tex.texture.create_view(&Default::default());
    let mut e = s.core.g.device.create_command_encoder(&Default::default());
    pass(&mut e, &view, &s.blit, &s.blit_bg);
    s.core.g.queue.submit([e.finish()]);
    s.core.g.queue.present(tex);
    Ok(())
}

fn frame(s: &mut State, shared: &Shared) -> Result<()> {
    let resized = fit(s);
    if resized {
        // The scene hears the new shape: `host.on("view", ...)`.
        let view = serde_json::json!({ "t": "view", "width": s.config.width, "height": s.config.height });
        if let Err(e) = s.game.host_messages(&mut s.core, &[view]) {
            shared.post(serde_json::json!({ "t": "rt.error", "where": "message", "message": format!("{e:#}") }));
        }
    }
    let period = Duration::from_secs_f64(1.0 / s.fps as f64);
    if !resized && s.last.elapsed() + Duration::from_millis(2) < period {
        return reshow(s);
    }
    let dt = s.last.elapsed().as_secs_f32().min(0.1);
    s.last = Instant::now();
    // Stream textures' newest pictures, into their places in the texture pages.
    let frames: Vec<(String, Frame)> = shared.streams.lock().unwrap().drain().collect();
    for (name, f) in frames {
        if let Err(e) = s.core.write_stream(&name, f.width, f.height, &f.rgba) {
            eprintln!("app-core: stream {name}: {e:#}");
        }
    }
    s.core.advance_time(dt);
    // The input of this frame (the scene reads it as `f.input` when it says `pointer: "free"` or `"look"`).
    let messages = [s.input.message()];
    if let Err(e) = s.game.host_messages(&mut s.core, &messages) {
        shared.post(serde_json::json!({ "t": "rt.error", "where": "input", "message": format!("{e:#}") }));
    }
    if let Err(e) = s.game.frame(&mut s.core, dt) {
        shared.post(serde_json::json!({ "t": "rt.error", "where": "frame", "message": format!("{e:#}") }));
    }
    for p in s.game.take_posts() {
        if s.audio.post(&p) {
            continue;
        }
        shared.post(p);
    }
    let c = s.core.cam;
    s.audio.listener(c.pos, c.fwd, c.right);
    for (level, text) in s.audio.take_log() {
        eprintln!("app-core: audio: {level}: {text}");
    }

    // Nothing to draw on (the window is covered, the display sleeps): the scene is traced all the same, at a lower
    // rate, so a snapshot of it is still taken and the scene's clock runs.
    let tex = acquire(s)?;
    if tex.is_none() {
        std::thread::sleep(Duration::from_millis(16));
    }
    let view = tex.as_ref().map(|t| t.texture.create_view(&Default::default()));
    let (blit, bg) = (&s.blit, &s.blit_bg);
    let snap = s.snapshot.take().map(|p| {
        let buf = s.core.g.device.create_buffer(&wgpu::BufferDescriptor { label: None, size: (s.core.w * s.core.h * 4) as u64, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        (p, buf)
    });
    s.core.render(s.spp, |e, out| {
        if let Some(view) = &view {
            pass(e, view, blit, bg);
        }
        if let Some((_, buf)) = &snap {
            e.copy_buffer_to_buffer(out, 0, buf, 0, buf.size());
        }
    });
    if let Some(tex) = tex {
        s.core.g.queue.present(tex);
    }
    if let Some((path, buf)) = snap {
        buf.slice(..).map_async(wgpu::MapMode::Read, |_| {});
        s.core.g.device.poll(wgpu::PollType::wait_indefinitely())?;
        let px = buf.slice(..).get_mapped_range()?.to_vec();
        save_bgra(&path, &px, s.core.w, s.core.h);
        shared.post(serde_json::json!({ "t": "rt.snapshot", "path": path, "width": s.core.w, "height": s.core.h }));
    }
    // The frame governor of the engine's own window (view.rs): render scale first, then samples, then bounces.
    s.core.govern_resolution(s.fps);
    s.spp = if s.core.render_scale < 1.0 { 1 } else { next_spp(s.spp, s.core.gpu_ms, s.fps).min(8) };
    if s.core.frame % 30 == 1 {
        let budget = 1000.0 / s.fps as f32;
        let lowest = !s.core.dynamic_res || s.core.render_scale <= s.core.min_scale;
        if s.spp == 1 && lowest && s.core.gpu_ms > budget * 0.92 && s.core.bounces > 2 {
            s.core.bounces -= 1;
        } else if s.core.gpu_ms < budget * 0.55 && s.core.bounces < s.max_bounces {
            s.core.bounces += 1;
        }
    }
    s.frames += 1;
    if s.stats_t.elapsed() >= Duration::from_millis(1000) {
        let fps = s.frames as f32 / s.stats_t.elapsed().as_secs_f32();
        s.frames = 0;
        s.stats_t = Instant::now();
        shared.post(serde_json::json!({
            "t": "rt.stats", "fps": fps, "gpuMs": s.core.gpu_ms, "scale": s.core.render_scale, "spp": s.spp, "bounces": s.core.bounces,
            "scriptMs": s.game.frame_ms, "shown": s.shown, "width": s.core.w, "height": s.core.h,
        }));
    }
    Ok(())
}

fn run(a: Args, rx: mpsc::Receiver<Cmd>, shared: Arc<Shared>) {
    let mut s = match init(&a) {
        Ok(s) => s,
        Err(e) => {
            shared.post(serde_json::json!({ "t": "rt.fatal", "message": format!("{e:#}") }));
            return;
        }
    };
    shared.post(serde_json::json!({ "t": "rt.ready", "bundle": a.bundle, "adapter": s.core.g.adapter_info.name, "hwrt": s.core.g.hwrt, "width": s.core.w, "height": s.core.h }));
    while !shared.quit.load(Ordering::Relaxed) {
        let mut cmds: Vec<Cmd> = rx.try_iter().collect();
        // Only the newest reload of those waiting runs (each is a whole setup).
        if let Some(last) = cmds.iter().rposition(|c| matches!(c, Cmd::Reload(_))) {
            cmds = cmds.into_iter().enumerate().filter(|(i, c)| *i == last || !matches!(c, Cmd::Reload(_))).map(|(_, c)| c).collect();
        }
        for c in cmds {
            match c {
                Cmd::Resize(w, h, scale) => {
                    s.want = (w.max(1), h.max(1));
                    s.core.set_display_scale(scale);
                }
                Cmd::Pointer(u, v) => s.input.pointer(u, v),
                Cmd::Button(n, down) => s.input.button(n, down),
                Cmd::Wheel(d) => s.input.wheel(d),
                Cmd::Key(code, name, down) => s.input.key(&code, &name, down),
                Cmd::Send(messages) => {
                    if let Err(e) = s.game.host_messages(&mut s.core, &messages) {
                        shared.post(serde_json::json!({ "t": "rt.error", "where": "message", "message": format!("{e:#}") }));
                    }
                }
                Cmd::Snapshot(p) => s.snapshot = Some(p),
                // A new build of the scene: its setup runs in a fresh runtime on the same view. When it fails, the
                // scene that ran goes on and the error says why.
                Cmd::Reload(bundle) => match GameSession::open(&bundle, ROOM, &s.assets, &mut s.core) {
                    Ok(mut game) => {
                        let _ = game.host_messages(&mut s.core, &[launch(s.config.width, s.config.height)]);
                        s.game = game;
                        s.input = InputTracker::new();
                        shared.post(serde_json::json!({ "t": "rt.reloaded", "bundle": bundle }));
                    }
                    Err(e) => shared.post(serde_json::json!({ "t": "rt.error", "where": "reload", "message": format!("{e:#}"), "bundle": bundle })),
                },
                Cmd::Quality { fps, scale, bounces } => {
                    s.fps = fps.clamp(15, 120);
                    s.core.set_scale(scale);
                    s.max_bounces = bounces.clamp(1, 8);
                    s.core.bounces = s.max_bounces;
                }
                Cmd::Quit => return,
            }
        }
        if let Err(e) = frame(&mut s, &shared) {
            shared.post(serde_json::json!({ "t": "rt.error", "where": "render", "message": format!("{e:#}") }));
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

/// Scales the traced picture (the view's size, often under the window's) to the surface, bilinear.
const BLIT: &str = r#"
struct Size { view: vec2<f32>, surface: vec2<f32> }
@group(0) @binding(0) var<storage, read> px: array<u32>;
@group(0) @binding(1) var<uniform> size: Size;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

fn texel(x: i32, y: i32) -> vec4<f32> {
    let c = px[u32(clamp(y, 0, i32(size.view.y) - 1)) * u32(size.view.x) + u32(clamp(x, 0, i32(size.view.x) - 1))];
    return vec4<f32>(f32((c >> 16u) & 255u), f32((c >> 8u) & 255u), f32(c & 255u), 255.0) / 255.0;
}

@fragment fn fs(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let q = p.xy / size.surface * size.view - 0.5;
    let f = fract(q);
    let i = vec2<i32>(floor(q));
    let a = mix(texel(i.x, i.y), texel(i.x + 1, i.y), f.x);
    let b = mix(texel(i.x, i.y + 1), texel(i.x + 1, i.y + 1), f.x);
    return mix(a, b, f.y);
}
"#;

// ----- the C ABI (macos/App/Core.h) -----

unsafe fn text(p: *const c_char) -> String {
    if p.is_null() {
        String::new()
    } else {
        CStr::from_ptr(p).to_string_lossy().into_owned()
    }
}

/// Starts the view on `metal_layer` (a CAMetalLayer the caller keeps alive until `rt_destroy`), `width` x `height`
/// pixels, `scale` pixels a point. `bundle` is the scene's bundle, `assets` the root its asset paths resolve against,
/// `presets` the engine's presets directory. Returns at once; `rt.ready` or `rt.fatal` arrives in `rt_poll`.
#[no_mangle]
pub unsafe extern "C" fn rt_create(metal_layer: *mut c_void, width: u32, height: u32, scale: f32, bundle: *const c_char, assets: *const c_char, presets: *const c_char) -> *mut RtView {
    set_log_sink(Some(log_sink));
    let args = Args { layer: metal_layer as usize, width, height, scale, bundle: PathBuf::from(text(bundle)), assets: PathBuf::from(text(assets)), presets: PathBuf::from(text(presets)) };
    let (tx, rx) = mpsc::channel();
    let shared = Arc::new(Shared::default());
    let theirs = shared.clone();
    let thread = std::thread::Builder::new().name("rt-render".into()).stack_size(64 << 20).spawn(move || run(args, rx, theirs)).ok();
    Box::into_raw(Box::new(RtView { tx, shared, thread }))
}

unsafe fn send(h: *mut RtView, c: Cmd) {
    if let Some(h) = h.as_ref() {
        let _ = h.tx.send(c);
    }
}

#[no_mangle]
pub unsafe extern "C" fn rt_resize(h: *mut RtView, width: u32, height: u32, scale: f32) {
    send(h, Cmd::Resize(width, height, scale));
}

/// The pointer's place in the view, 0..1 from its top left.
#[no_mangle]
pub unsafe extern "C" fn rt_pointer(h: *mut RtView, u: f32, v: f32) {
    send(h, Cmd::Pointer(u, v));
}

/// A pointer button (0 left, 1 middle, 2 right) went down or up.
#[no_mangle]
pub unsafe extern "C" fn rt_button(h: *mut RtView, button: u8, down: bool) {
    send(h, Cmd::Button(button, down));
}

/// Wheel notches, away from the user positive.
#[no_mangle]
pub unsafe extern "C" fn rt_wheel(h: *mut RtView, notches: f32) {
    send(h, Cmd::Wheel(notches));
}

/// A key by its place on the keyboard (`code`: "KeyW") and the name scene code reads ("W").
#[no_mangle]
pub unsafe extern "C" fn rt_key(h: *mut RtView, code: *const c_char, name: *const c_char, down: bool) {
    send(h, Cmd::Key(text(code), text(name), down));
}

/// Host-channel messages for the scene: a JSON object, or an array of them (`host.on(t, ...)` in scene code).
#[no_mangle]
pub unsafe extern "C" fn rt_send(h: *mut RtView, json: *const c_char) {
    let messages = match serde_json::from_str::<serde_json::Value>(&text(json)) {
        Ok(serde_json::Value::Array(a)) => a,
        Ok(v) => vec![v],
        Err(_) => return,
    };
    send(h, Cmd::Send(messages));
}

/// What the scene posted, its console lines and what the renderer reports since the last call: a JSON array, or
/// null when there is nothing. Free it with `rt_free`.
#[no_mangle]
pub unsafe extern "C" fn rt_poll(h: *mut RtView) -> *mut c_char {
    let Some(h) = h.as_ref() else { return std::ptr::null_mut() };
    let mut posts = std::mem::take(&mut *h.shared.posts.lock().unwrap());
    for (level, text) in std::mem::take(&mut *LOGS.lock().unwrap()) {
        posts.push(serde_json::json!({ "t": "log", "level": level, "text": text }).to_string());
    }
    if posts.is_empty() {
        return std::ptr::null_mut();
    }
    CString::new(format!("[{}]", posts.join(","))).map_or(std::ptr::null_mut(), CString::into_raw)
}

#[no_mangle]
pub unsafe extern "C" fn rt_free(s: *mut c_char) {
    if !s.is_null() {
        drop(CString::from_raw(s));
    }
}

/// The next picture of the stream texture `name` (a `StreamTexture` in the scene): `width` x `height` RGBA8 pixels,
/// copied before the call returns. Only the newest picture of a stream is kept until the renderer takes it.
#[no_mangle]
pub unsafe extern "C" fn rt_stream(h: *mut RtView, name: *const c_char, width: u32, height: u32, rgba: *const u8, len: usize) {
    let Some(h) = h.as_ref() else { return };
    if rgba.is_null() || len != width as usize * height as usize * 4 {
        return;
    }
    let frame = Frame { width, height, rgba: std::slice::from_raw_parts(rgba, len).to_vec() };
    h.shared.streams.lock().unwrap().insert(text(name), frame);
}

/// Saves the next traced frame as a PNG; `rt.snapshot` in `rt_poll` says when it is written.
#[no_mangle]
pub unsafe extern "C" fn rt_snapshot(h: *mut RtView, path: *const c_char) {
    send(h, Cmd::Snapshot(PathBuf::from(text(path))));
}

/// Runs another build of the scene's bundle in the same view (`rt.reloaded`, or `rt.error` and the old one goes on).
#[no_mangle]
pub unsafe extern "C" fn rt_reload(h: *mut RtView, bundle: *const c_char) {
    send(h, Cmd::Reload(PathBuf::from(text(bundle))));
}

/// Content frames a second, render scale (0: dynamic) and the most bounces.
#[no_mangle]
pub unsafe extern "C" fn rt_quality(h: *mut RtView, fps: u32, scale: f32, bounces: u32) {
    send(h, Cmd::Quality { fps, scale, bounces });
}

#[no_mangle]
pub unsafe extern "C" fn rt_destroy(h: *mut RtView) {
    if h.is_null() {
        return;
    }
    let mut h = Box::from_raw(h);
    h.shared.quit.store(true, Ordering::Relaxed);
    let _ = h.tx.send(Cmd::Quit);
    // The render thread stops between frames; a scene's setup in progress can take long: wait two seconds at most
    // (the app is quitting; what is left of the thread goes with the process).
    if let Some(t) = h.thread.take() {
        let until = Instant::now() + Duration::from_secs(2);
        while !t.is_finished() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(10));
        }
        if t.is_finished() {
            let _ = t.join();
        }
    }
}
