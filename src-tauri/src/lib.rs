#[cfg(not(debug_assertions))]
use std::net::TcpListener;
use std::sync::Mutex;

#[cfg(not(debug_assertions))]
use std::fs::{self, File, OpenOptions};
#[cfg(not(debug_assertions))]
use std::io::{Read, Seek, SeekFrom, Write};
#[cfg(not(debug_assertions))]
use std::path::PathBuf;

#[cfg(not(debug_assertions))]
use tauri_plugin_shell::ShellExt;

use rand::Rng;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_window_state::StateFlags;

fn window_state_flags() -> StateFlags {
    // Save all state except decorations (we manage those ourselves)
    StateFlags::all() - StateFlags::DECORATIONS
}

// State to hold the server port, secret, and process
struct ServerState {
    port: u16,
    secret: String,
    process: Option<CommandChild>,
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
        #[cfg(target_os = "macos")]
        {
            use tauri::ActivationPolicy;
            let _ = app.set_activation_policy(ActivationPolicy::Regular);
        }
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn hide_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
        #[cfg(target_os = "macos")]
        {
            use tauri::ActivationPolicy;
            let _ = app.set_activation_policy(ActivationPolicy::Accessory);
        }
    }
}

fn toggle_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        // Check if window is visible and focused
        let is_visible = window.is_visible().unwrap_or(false);
        let is_focused = window.is_focused().unwrap_or(false);

        if is_visible && is_focused {
            // Window is visible and focused, hide it
            hide_window(app);
        } else {
            // Window is hidden or not focused, show and focus it
            show_window(app);
        }
    }
}

#[cfg(not(debug_assertions))]
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
fn get_log_file_path() -> Result<PathBuf, String> {
    // Try XDG_STATE_HOME first, fallback to XDG_DATA_HOME, then ~/.local/state
    let state_dir = dirs::state_dir()
        .or_else(|| dirs::data_dir())
        .ok_or_else(|| "Could not determine state directory".to_string())?;

    let log_dir = state_dir.join("discobot").join("logs");

    // Create the directory if it doesn't exist
    fs::create_dir_all(&log_dir).map_err(|e| format!("Failed to create log directory: {}", e))?;

    Ok(log_dir.join("server.log"))
}

#[cfg(not(debug_assertions))]
fn truncate_log_file(log_path: &PathBuf) -> Result<(), String> {
    const MAX_SIZE: u64 = 1_048_576; // 1 MB
    const KEEP_SIZE: u64 = 10_240; // 10 KB

    // Check if file exists and get its size
    let metadata = match fs::metadata(log_path) {
        Ok(m) => m,
        Err(_) => return Ok(()), // File doesn't exist, nothing to truncate
    };

    let file_size = metadata.len();
    if file_size <= MAX_SIZE {
        return Ok(()); // File is small enough, no need to truncate
    }

    // Read the last KEEP_SIZE bytes
    let mut file =
        File::open(log_path).map_err(|e| format!("Failed to open log file for reading: {}", e))?;

    let seek_pos = if file_size > KEEP_SIZE {
        file_size - KEEP_SIZE
    } else {
        0
    };

    file.seek(SeekFrom::Start(seek_pos))
        .map_err(|e| format!("Failed to seek in log file: {}", e))?;

    let mut last_bytes = Vec::new();
    file.read_to_end(&mut last_bytes)
        .map_err(|e| format!("Failed to read log file: {}", e))?;

    drop(file); // Close the file before rewriting

    // Rewrite the file with truncation message and last bytes
    let mut file =
        File::create(log_path).map_err(|e| format!("Failed to create new log file: {}", e))?;

    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    let message = format!(
        "=== Log truncated at {} (was {} bytes, keeping last {} bytes) ===\n",
        timestamp,
        file_size,
        last_bytes.len()
    );

    file.write_all(message.as_bytes())
        .map_err(|e| format!("Failed to write truncation message: {}", e))?;

    file.write_all(&last_bytes)
        .map_err(|e| format!("Failed to write log data: {}", e))?;

    Ok(())
}

#[cfg(not(debug_assertions))]
fn start_server(
    app: &tauri::AppHandle,
    port: u16,
    ssh_port: u16,
    secret: &str,
) -> Result<CommandChild, String> {
    use tauri_plugin_shell::process::CommandEvent;

    let log_path = get_log_file_path()?;

    // Truncate log file if it's too large
    truncate_log_file(&log_path)?;

    #[allow(unused_mut)]
    let mut sidecar = app
        .shell()
        .sidecar("discobot-server")
        .map_err(|e| format!("Failed to create sidecar command: {}", e))?
        .env("PORT", port.to_string())
        .env("SSH_PORT", ssh_port.to_string())
        .env("CORS_ORIGINS", "http://tauri.localhost,tauri://localhost")
        .env("DISCOBOT_SECRET", secret)
        .env("TAURI", "true")
        .env("SUGGESTIONS_ENABLED", "true");

    // Check for bundled VZ resources (macOS only)
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        if let Ok(resource_dir) = app.path().resource_dir() {
            let vz_dir = resource_dir.join("vz");
            let kernel_path = vz_dir.join("vmlinux");
            let rootfs_path = vz_dir.join("discobot-rootfs.squashfs");

            // Check if both files exist
            if kernel_path.exists() && rootfs_path.exists() {
                println!("Found bundled VZ resources:");
                println!("  Kernel: {}", kernel_path.display());
                println!("  Rootfs: {}", rootfs_path.display());

                sidecar = sidecar
                    .env("VZ_KERNEL_PATH", kernel_path.to_string_lossy().to_string())
                    .env(
                        "VZ_BASE_DISK_PATH",
                        rootfs_path.to_string_lossy().to_string(),
                    );
            } else {
                println!("No bundled VZ resources found, will download from registry");
            }
        }
    }

    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;

    // Spawn a task to handle the server output and write to log file
    tauri::async_runtime::spawn(async move {
        // Open log file for appending
        let mut log_file = match OpenOptions::new().create(true).append(true).open(&log_path) {
            Ok(file) => file,
            Err(e) => {
                eprintln!("Failed to open log file {:?}: {}", log_path, e);
                return;
            }
        };

        // Write a separator to indicate new server start
        let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
        let separator = format!("\n\n=== Server started at {} ===\n", timestamp);
        if let Err(e) = log_file.write_all(separator.as_bytes()) {
            eprintln!("Failed to write to log file: {}", e);
        }

        // Process events from the server
        while let Some(event) = rx.recv().await {
            let output = match event {
                CommandEvent::Stdout(line) => {
                    let text = String::from_utf8_lossy(&line);
                    let trimmed = text.trim_end_matches('\n').trim_end_matches('\r');
                    format!("[stdout] {}\n", trimmed)
                }
                CommandEvent::Stderr(line) => {
                    let text = String::from_utf8_lossy(&line);
                    let trimmed = text.trim_end_matches('\n').trim_end_matches('\r');
                    format!("[stderr] {}\n", trimmed)
                }
                CommandEvent::Error(e) => format!("[error] {}\n", e),
                CommandEvent::Terminated(payload) => {
                    format!(
                        "[terminated] code: {:?}, signal: {:?}\n",
                        payload.code, payload.signal
                    )
                }
                _ => continue,
            };

            if let Err(e) = log_file.write_all(output.as_bytes()) {
                eprintln!("Failed to write to log file: {}", e);
            }

            // Flush to ensure logs are written immediately
            let _ = log_file.flush();
        }
    });

    Ok(child)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Find available ports and generate secret before starting Tauri
    #[cfg(debug_assertions)]
    let port = 3001_u16; // Use fixed port in dev mode for easier debugging
    #[cfg(debug_assertions)]
    let ssh_port = 3333_u16; // Use fixed SSH port in dev mode

    #[cfg(not(debug_assertions))]
    let port = find_available_port();
    #[cfg(not(debug_assertions))]
    let ssh_port = if TcpListener::bind("127.0.0.1:3333").is_ok() {
        3333
    } else {
        find_available_port()
    };

    let secret = generate_secret();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_window(app);
        }))
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(window_state_flags())
                .build(),
        )
        .manage(Mutex::new(ServerState {
            port,
            secret: secret.clone(),
            process: None,
        }))
        .setup(move |app| {
            // On macOS, set activation policy based on window visibility
            #[cfg(target_os = "macos")]
            {
                use tauri::ActivationPolicy;
                // Check if main window is visible
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = app.set_activation_policy(ActivationPolicy::Regular);
                    } else {
                        let _ = app.set_activation_policy(ActivationPolicy::Accessory);
                    }
                } else {
                    let _ = app.set_activation_policy(ActivationPolicy::Accessory);
                }
            }

            // Only start the Go server in release mode
            // In dev mode, run it separately via `pnpm dev:api`
            #[cfg(not(debug_assertions))]
            {
                // Show log file location
                if let Ok(log_path) = get_log_file_path() {
                    println!("Server logs will be written to: {}", log_path.display());
                }

                match start_server(app.handle(), port, ssh_port, &secret) {
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
                let _ = (port, ssh_port, &secret); // suppress unused warnings
            }

            // Create tray menu
            let show_item = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            // Create tray icon with monochrome template image for macOS light/dark mode
            let tray_icon = tauri::image::Image::from_bytes(include_bytes!(
                "../icons/tray-icon@2x.png"
            ))?;
            TrayIconBuilder::new()
                .icon(tray_icon)
                .icon_as_template(true)
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
                        toggle_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                hide_window(window.app_handle());
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![get_server_port, get_server_secret])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
