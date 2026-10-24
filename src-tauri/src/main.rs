// Lizzie: Elizabeth line eve dönüş widget'ının Windows kabuğu.
// Pencere, tepsi simgesi, bildirim ve otomatik başlatma burada; asıl mantık src/ altındaki JS'te.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewWindow, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_notification::NotificationExt;

// JS'in Rust üzerinden gidebileceği adresler (TfL ve Lime'ın açık bisiklet akışı).
const ALLOWED: [&str; 2] = ["https://api.tfl.gov.uk/", "https://data.lime.bike/"];

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

// Hapın ekrandaki yeri. Panel açıkken pencere yukarı uzayabildiği için yalnızca
// kapalıyken (hap hâlindeyken) kaydedilir; birkaç saniyede bir diske yazılır.
#[derive(Default)]
struct Placement {
    pos: Mutex<Option<(i32, i32)>>,
    dirty: AtomicBool,
    expanded: AtomicBool,
    restored: AtomicBool,
    // Panel ekrana sığsın diye pencereyi ne kadar ittik; kapanınca geri alınır ki hap kaymasın.
    nudge: Mutex<(i32, i32)>,
}

fn placement_file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("position.txt"))
}

fn read_placement(app: &AppHandle) -> Option<(i32, i32)> {
    let text = std::fs::read_to_string(placement_file(app)?).ok()?;
    let mut parts = text.split_whitespace().map(|n| n.parse::<i32>().ok());
    Some((parts.next()??, parts.next()??))
}

fn save_placement_loop(app: AppHandle) {
    loop {
        std::thread::sleep(Duration::from_secs(2));
        let placement = app.state::<Placement>();
        if !placement.dirty.swap(false, Ordering::SeqCst) {
            continue;
        }
        let pos = *placement.pos.lock().unwrap();
        if let (Some(file), Some((x, y))) = (placement_file(&app), pos) {
            if let Some(dir) = file.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(file, format!("{x} {y}"));
        }
    }
}

fn allowed(url: &str) -> bool {
    ALLOWED.iter().any(|prefix| url.starts_with(prefix))
}

// Webview'den fetch başarısız olursa (CORS, kurumsal proxy vb.) buradan gidilir.
// allow300: TfL rota planlayıcısının "şunlardan hangisi?" listesi istenen veriyse.
#[tauri::command]
async fn http_get(url: String, allow300: Option<bool>) -> Result<String, String> {
    if !allowed(&url) {
        return Err("izin verilmeyen adres".into());
    }
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    let client = CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent("Lizzie/0.1")
            // Yönlendirmeler de yalnızca izinli adreslere gidebilir.
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() < 5 && allowed(attempt.url().as_str()) {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .build()
            .expect("http istemcisi")
    });
    let res = client.get(&url).send().await.map_err(err)?;
    let status = res.status();
    let body = res.text().await.map_err(err)?;
    if status.is_success() || (allow300.unwrap_or(false) && status.as_u16() == 300) {
        Ok(body)
    } else {
        Err(format!("HTTP {}", status.as_u16()))
    }
}

// Windows konum servisinden [enlem, boylam, doğruluk (m)]. Wi-Fi'li bir dizüstünde
// Londra'da genelde birkaç on metre şaşar. Hata metni "denied" ise konum kapalıdır.
#[tauri::command]
async fn locate() -> Result<[f64; 3], String> {
    tauri::async_runtime::spawn_blocking(locate_now)
        .await
        .map_err(err)?
}

#[cfg(windows)]
fn locate_now() -> Result<[f64; 3], String> {
    use windows::Devices::Geolocation::{GeolocationAccessStatus, Geolocator};
    use windows::Foundation::TimeSpan;

    let geo_err = |e: windows::core::Error| {
        if e.code().0 as u32 == 0x8007_0005 {
            "denied".to_string() // E_ACCESSDENIED
        } else {
            e.to_string()
        }
    };
    if let Ok(status) = Geolocator::RequestAccessAsync().and_then(|op| op.join()) {
        if status == GeolocationAccessStatus::Denied {
            return Err("denied".into());
        }
    }
    let locator = Geolocator::new().map_err(geo_err)?;
    let max_age = TimeSpan::from(Duration::from_secs(120));
    let timeout = TimeSpan::from(Duration::from_secs(15));
    let position = locator
        .GetGeopositionAsyncWithAgeAndTimeout(max_age, timeout)
        .and_then(|op| op.join())
        .map_err(geo_err)?;
    let coord = position.Coordinate().map_err(geo_err)?;
    let point = coord.Point().and_then(|p| p.Position()).map_err(geo_err)?;
    let accuracy = coord.Accuracy().unwrap_or(-1.0);
    Ok([point.Latitude, point.Longitude, accuracy])
}

#[cfg(not(windows))]
fn locate_now() -> Result<[f64; 3], String> {
    Err("unsupported".into())
}

// Adım adım tarif için Citymapper'ı varsayılan tarayıcıda açar (yalnızca citymapper.com).
#[tauri::command]
fn open_citymapper(url: String) -> Result<(), String> {
    if !url.starts_with("https://citymapper.com/") {
        return Err("yalnızca citymapper.com".into());
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(err)
}

#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(err)
}

// enable verilmezse yalnızca mevcut durumu döndürür.
#[tauri::command]
fn autostart(app: AppHandle, enable: Option<bool>) -> Result<bool, String> {
    let launcher = app.autolaunch();
    match enable {
        Some(true) => launcher.enable().map_err(err)?,
        Some(false) => launcher.disable().map_err(err)?,
        None => {}
    }
    launcher.is_enabled().map_err(err)
}

#[tauri::command]
fn set_tooltip(app: AppHandle, text: String) {
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(text));
    }
}

// Pencereyi içeriğe göre boyutlar. grow_up / grow_left: alt / sağ kenar sabit kalsın
// (hap ekranın o köşesindeyse panel ekrana doğru açılır, kapanınca aynı köşeye döner).
#[tauri::command]
fn resize(
    window: WebviewWindow,
    width: f64,
    height: f64,
    grow_up: bool,
    grow_left: bool,
) -> Result<(), String> {
    let placement = window.state::<Placement>();
    let expanding = height > 120.0;
    let was_expanded = placement.expanded.swap(expanding, Ordering::SeqCst);
    let scale = window.scale_factor().map_err(err)?;
    let pos = window.outer_position().map_err(err)?;
    let size = window.outer_size().map_err(err)?;
    let (old_w, old_h) = (size.width as i32, size.height as i32);
    let new_w = (width * scale).round() as i32;
    let new_h = (height * scale).round() as i32;

    let mut x = if grow_left {
        pos.x + old_w - new_w
    } else {
        pos.x
    };
    let mut y = if grow_up {
        pos.y + old_h - new_h
    } else {
        pos.y
    };
    // Kapanırken açılışta yaptığımız itmeyi geri al: hap tam eski yerine dönsün.
    let mut nudge = placement.nudge.lock().unwrap();
    if was_expanded && !expanding {
        x -= nudge.0;
        y -= nudge.1;
        *nudge = (0, 0);
    }
    let (want_x, want_y) = (x, y);
    if let Some(a) = window
        .current_monitor()
        .map_err(err)?
        .map(|m| *m.work_area())
    {
        x = x
            .min(a.position.x + a.size.width as i32 - new_w)
            .max(a.position.x);
        y = y
            .min(a.position.y + a.size.height as i32 - new_h)
            .max(a.position.y);
    }
    if expanding {
        nudge.0 += x - want_x;
        nudge.1 += y - want_y;
    }
    drop(nudge);
    let new_pos = PhysicalPosition::new(x, y);
    let new_size = LogicalSize::new(width, height);
    // Büyürken önce taşı, küçülürken önce boyutla: pencere bir an bile ekrandan taşmasın.
    if new_w > old_w || new_h > old_h {
        window.set_position(new_pos).map_err(err)?;
        window.set_size(new_size).map_err(err)?;
    } else {
        window.set_size(new_size).map_err(err)?;
        window.set_position(new_pos).map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
fn start_drag(window: WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(err)
}

#[tauri::command]
fn hide(window: WebviewWindow) {
    let _ = window.hide();
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

// Arayüz çizildi: kayıtlı yer yoksa ya da pencere hiçbir ekranda görünmüyorsa sağ
// alta yerleştir, sonra göster (beyaz pencere parlaması olmasın diye gizli başlıyoruz).
#[tauri::command]
fn ready(window: WebviewWindow) -> Result<(), String> {
    if !window.state::<Placement>().restored.load(Ordering::SeqCst) || !on_screen(&window) {
        park_bottom_right(&window);
    }
    window.show().map_err(err)
}

fn on_screen(window: &WebviewWindow) -> bool {
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return false;
    };
    let cx = pos.x + size.width as i32 / 2;
    let cy = pos.y + size.height as i32 / 2;
    window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .any(|m| {
            let a = m.work_area();
            cx >= a.position.x
                && cx < a.position.x + a.size.width as i32
                && cy >= a.position.y
                && cy < a.position.y + a.size.height as i32
        })
}

fn park_bottom_right(window: &WebviewWindow) {
    let Ok(Some(monitor)) = window.primary_monitor() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let a = monitor.work_area();
    let margin = (12.0 * monitor.scale_factor()) as i32;
    let x = a.position.x + a.size.width as i32 - size.width as i32 - margin;
    let y = a.position.y + a.size.height as i32 - size.height as i32 - margin;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

fn show(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn toggle(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            show(app);
        }
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let toggle_item = MenuItem::with_id(app, "toggle", "Göster / Gizle", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Ayarlar", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Çıkış", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&toggle_item, &settings, &separator, &quit_item])?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Lizzie · Elizabeth line")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => toggle(app),
            "settings" => {
                show(app);
                let _ = app.emit("open-settings", ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show(app)
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let placement = Placement::default();
            if let (Some((x, y)), Some(w)) =
                (read_placement(app.handle()), app.get_webview_window("main"))
            {
                let _ = w.set_position(PhysicalPosition::new(x, y));
                placement.restored.store(true, Ordering::SeqCst);
            }
            app.manage(placement);
            let handle = app.handle().clone();
            std::thread::spawn(move || save_placement_loop(handle));
            build_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Alt+F4 uygulamayı kapatmasın, yalnızca tepsiye gizlesin.
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }
            WindowEvent::Moved(pos) => {
                let placement = window.state::<Placement>();
                if !placement.expanded.load(Ordering::SeqCst) {
                    *placement.pos.lock().unwrap() = Some((pos.x, pos.y));
                    placement.dirty.store(true, Ordering::SeqCst);
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            http_get,
            locate,
            open_citymapper,
            notify,
            autostart,
            set_tooltip,
            resize,
            start_drag,
            hide,
            quit,
            ready
        ])
        .run(tauri::generate_context!())
        .expect("Lizzie başlatılamadı");
}
