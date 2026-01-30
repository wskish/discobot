use std::net::TcpListener;
use std::sync::Mutex;

use rand::Rng;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

// State to hold the server port, secret, and process
struct ServerState {
    port: u16,
    secret: String,
    process: Option<CommandChild>,
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn get_server_port(state: tauri::State<'_, Mutex<ServerState>>) -> u16 {
    state.lock().unwrap().port
}

#[tauri::command]
fn get_server_secret(state: tauri::State<'_, Mutex<ServerState>>) -> String {
    state.lock().unwrap().secret.clone()
}

fn show_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn find_available_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("Failed to bind to find available port")
        .local_addr()
        .expect("Failed to get local address")
        .port()
}

fn generate_secret() -> String {
    const CHARSET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let mut rng = rand::rng();
    (0..32)
        .map(|_| {
            let idx = rng.random_range(0..CHARSET.len());
            CHARSET[idx] as char
        })
        .collect()
}

#[cfg(not(debug_assertions))]
fn start_server(app: &tauri::AppHandle, port: u16, secret: &str) -> Result<CommandChild, String> {
    let sidecar = app
        .shell()
        .sidecar("binaries/discobot-server")
        .map_err(|e| format!("Failed to create sidecar command: {}", e))?
        .env("PORT", port.to_string())
        .env("DISCOBOT_SECRET", secret)
        .env("TAURI", "true")
        .env("SUGGESTIONS_ENABLED", "true");

    let (_, child) = sidecar
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;

    Ok(child)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Find available port and generate secret before starting Tauri
    let port = find_available_port();
    let secret = generate_secret();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_window(app);
        }))
        .manage(Mutex::new(ServerState {
            port,
            secret: secret.clone(),
            process: None,
        }))
        .setup(move |app| {
            // Only start the Go server in release mode
            // In dev mode, run it separately via `pnpm dev:api`
            #[cfg(not(debug_assertions))]
            {
                match start_server(app.handle(), port, &secret) {
                    Ok(child) => {
                        let state = app.state::<Mutex<ServerState>>();
                        state.lock().unwrap().process = Some(child);
                        println!("Server started on port {}", port);
                    }
                    Err(e) => {
                        eprintln!("Failed to start server: {}", e);
                    }
                }
            }

            #[cfg(debug_assertions)]
            {
                println!("Dev mode: skipping sidecar, run Go server separately");
                let _ = (port, &secret); // suppress unused warnings
            }

            // Create tray menu
            let show_item = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            // Create tray icon
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_window(app),
                    "quit" => {
                        // Kill server process before exiting
                        if let Some(state) = app.try_state::<Mutex<ServerState>>() {
                            if let Ok(mut state) = state.lock() {
                                if let Some(child) = state.process.take() {
                                    let _ = child.kill();
                                }
                            }
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                window.hide().unwrap();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![greet, get_server_port, get_server_secret])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
