mod close_watch;
mod data_dir;
mod diagnostics;
mod files;
mod http;
mod mcp;
mod migrate;
mod proxy;
mod storage;
mod update;

use tauri::Manager;

pub fn run() {
    // 日志、存储和 WebView2 都使用数据目录，需最先确定；有待迁移的更改时在此完成迁移
    data_dir::prepare();
    // API 请求和更新插件的 reqwest 都不带加密实现，使用进程默认的 ring（更新插件检查时也会按需安装同一个）
    let _ = rustls::crypto::ring::default_provider().install_default();
    tauri::Builder::default()
        // single-instance 需最先注册，第二个实例启动时把已有主窗口带到前台后退出。
        // 开启 deep-link feature 后，第二个实例收到的 deep link 会先转交 deep-link 插件，由前端监听导入
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let Some(win) = app.get_webview_window("main") else {
                return;
            };
            let _ = win.unminimize();
            let _ = win.show();
            let _ = win.set_focus();
        }))
        // 紧随 single-instance 注册：第二个实例在此之前已退出，不会与已有实例同时写日志文件
        .plugin(diagnostics::plugin())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // 只供 Rust 侧的保存命令弹出对话框，不向前端开放插件命令
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        // 插件的初始化脚本会替换 window.Notification，前端沿用 Web Notification 的调用即可发出系统通知
        .plugin(tauri_plugin_notification::init())
        // 只供 Rust 侧的更新命令使用，不向前端开放插件命令
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            storage::commands::tasks_get_all,
            storage::commands::task_put,
            storage::commands::task_delete,
            storage::commands::tasks_clear,
            storage::commands::tasks_commit_deletion,
            storage::commands::conversations_get_all,
            storage::commands::conversation_put,
            storage::commands::conversations_clear,
            storage::commands::conversations_replace,
            storage::commands::image_get,
            storage::commands::image_put,
            storage::commands::image_delete,
            storage::commands::images_clear,
            storage::commands::image_ids,
            storage::commands::image_stats,
            storage::commands::thumbnail_get,
            storage::commands::thumbnail_put,
            storage::commands::kv_get_all,
            storage::commands::kv_set,
            storage::commands::kv_remove,
            storage::commands::storage_info,
            storage::commands::storage_open_dir,
            data_dir::data_dir_notice,
            data_dir::data_dir_pick,
            data_dir::data_dir_change,
            diagnostics::log_set_enabled,
            diagnostics::log_open_dir,
            files::save_file,
            files::save_dir_pick,
            files::save_dir_begin,
            files::save_write,
            files::save_commit,
            files::save_abort,
            files::download_dir_get,
            files::download_dir_pick,
            files::download_dir_use,
            files::download_dir_open,
            files::download_dir_migrate,
            http::http_send,
            http::http_read,
            http::http_cancel,
            proxy::proxy_get,
            proxy::proxy_set,
            update::update_ready,
            update::update_download,
            update::update_install,
            close_watch::close_ack,
            mcp::mcp_get,
            mcp::mcp_set,
            mcp::mcp_respond,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                close_watch::on_close_requested(window);
            }
        })
        .manage(files::SaveDirs::default())
        .manage(files::Writes::default())
        .manage(files::MigrateSource::default())
        .manage(data_dir::PickedDir::default())
        .manage(http::Requests::default())
        .manage(mcp::Mcp::default())
        // 页面重载（含开发时的热重载）后旧页面的请求已无人读取，立即断开；未提交的保存也无人继续，删除临时文件
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                webview.state::<http::Requests>().clear();
                webview.state::<files::Writes>().clear();
            }
        })
        .setup(|app| {
            data_dir::log_notice();
            // 安装版由 NSIS 注册协议。开发版只在设置了 GPT_IMAGE_PLAYGROUND_REGISTER_DEEP_LINK 时才注册，
            // 注册会把 HKCU 下的协议改为指向当前开发版程序，覆盖安装版的注册；
            // 之后需重装正式版，或删除 HKCU\Software\Classes\gpt-image-playground，才能恢复
            #[cfg(all(debug_assertions, windows))]
            if std::env::var_os("GPT_IMAGE_PLAYGROUND_REGISTER_DEEP_LINK").is_some() {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(err) = app.deep_link().register_all() {
                    log::error!("注册 deep link 协议失败：{err}");
                }
            }
            // 存储需在主窗口创建前就绪，前端加载后立即会读取任务和图片
            let state = storage::init();
            // WebView2 数据放在数据目录的 webview/ 下，随数据目录走；数据目录不可用时用默认位置，不影响窗口创建
            let webview_dir = state
                .0
                .as_ref()
                .ok()
                .map(|s| s.root().join("webview"))
                .filter(|dir| match std::fs::create_dir_all(dir) {
                    Ok(()) => true,
                    Err(err) => {
                        log::warn!("无法创建 WebView 数据目录，改用默认位置：{err}");
                        false
                    }
                });
            // 代理设置需在主窗口创建前生效，前端加载后立即可能发出请求
            app.manage(proxy::Proxy::load(&state));
            app.manage(state);
            // 默认关闭；用户在设置里开启过则按保存的端口和 token 恢复
            mcp::start_saved(app.handle());
            let info = app.package_info().clone();
            tauri::async_runtime::spawn_blocking(move || update::cleanup(&info.name, &info.version));
            // WebView2 在页面加载出来之前是白色背景，深色模式下启动会白闪。页面只跟随系统主题，
            // 创建窗口时就按系统主题设为 body 的背景色（bg-gray-50 / dark:bg-gray-950）；窗口建好后再设置为时已晚。
            // 读取失败时按浅色处理
            #[cfg(windows)]
            let dark = windows_registry::CURRENT_USER
                .open(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
                .and_then(|key| key.get_u32("AppsUseLightTheme"))
                .is_ok_and(|light| light == 0);
            #[cfg(not(windows))]
            let dark = false;
            let bg = if dark {
                tauri::window::Color(3, 7, 18, 255)
            } else {
                tauri::window::Color(249, 250, 251, 255)
            };
            // 主窗口在 tauri.conf.json 中设为 create: false，改由代码创建以便拦截新窗口。
            // 外部链接由前端转给系统浏览器，其余 target="_blank" 和 window.open 一律拒绝，避免出现不受管理的 WebView2 弹窗
            let builder = tauri::WebviewWindowBuilder::from_config(
                app.handle(),
                &app.config().app.windows[0],
            )?
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .background_color(bg);
            match webview_dir {
                Some(dir) => builder.data_directory(dir).build()?,
                None => builder.build()?,
            };
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("启动应用失败")
        // 退出时不会析构托管状态，保存中途关闭窗口需在此删除临时文件
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<files::Writes>().clear();
            }
        })
}
