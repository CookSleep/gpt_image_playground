//! 保存文件：保存对话框和目录选择都在 Rust 侧弹出，前端只能写入用户刚在对话框中选择的位置，
//! 不开放写任意路径的命令。默认保存地址同样只能经 Rust 侧的目录选择框更改，前端只能读取用于显示；
//! 更改后可把原地址中的内容迁移到新地址，原地址由 Rust 侧记下，前端不能指定。
//! 文件内容以二进制 IPC 请求体分块传输：先在目标目录中创建临时文件，逐块追加，写完后改名为目标文件。
//! 整个文件一次传输时，WebView2 浏览器进程会为几百 MB 的请求体占用数 GB 内存
use std::collections::HashMap;
use std::fs;
use std::io::{self, ErrorKind, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, Runtime, State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tempfile::NamedTempFile;

use crate::data_dir;
use crate::migrate::{self, MoveReport};
use crate::storage::{self, Storage, StorageState};

/// 本次运行中用户选择过的保存目录，前端凭序号写入，无法借此写入其他目录
#[derive(Default)]
pub struct SaveDirs(Mutex<Vec<PathBuf>>);

#[derive(Serialize)]
pub struct SaveDir {
    token: usize,
    path: String,
}

pub(crate) fn header<'a>(request: &'a Request<'_>, name: &str) -> &'a str {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
}

fn body<'a>(request: &'a Request<'_>) -> Result<&'a [u8], String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes),
        _ => Err("请求体必须是二进制".into()),
    }
}

const RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// 只接受单个合法的 Windows 文件名：防止借 ../、盘符或绝对路径写到所选位置之外，
/// 也避免写入 NUL 等设备，或因尾随点、空格被系统悄悄改名。“.”和“..”由尾随点规则排除
fn is_plain_file_name(name: &str) -> bool {
    // 保留名带扩展名同样无效，例如 nul.txt；主名末尾的空格会被系统忽略
    let stem = name.split('.').next().unwrap_or_default().trim_end();
    !name.is_empty()
        && name.chars().count() <= 255
        && !name.ends_with(['.', ' '])
        && !name.contains(|c: char| c.is_control() || r#"<>:"/\|?*"#.contains(c))
        && !RESERVED_NAMES.iter().any(|r| r.eq_ignore_ascii_case(stem))
}

fn check_name(name: &str) -> Result<(), String> {
    if !is_plain_file_name(name) {
        return Err(format!("文件名不合法：{name}"));
    }
    Ok(())
}

const IN_DATA_DIR: &str = "不能选择应用数据目录。";

/// 目录可能尚不存在：规范化最近的已存在上级，再接上其余部分
pub(crate) fn normalize(path: &Path) -> PathBuf {
    let mut existing = path;
    let mut rest = Vec::new();
    loop {
        if let Ok(real) = existing.canonicalize() {
            return rest.iter().rev().fold(real, |acc, name| acc.join(name));
        }
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name);
                existing = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}

/// 保存位置不能落在数据目录内，否则可能覆盖 data.db 或混入孤儿清理的范围。
/// 无法消解的“..”一律视为在数据目录内
fn in_data_dir(path: &Path, data_dir: &Path) -> bool {
    let path = normalize(path);
    path.components().any(|c| c == Component::ParentDir) || path.starts_with(normalize(data_dir))
}

/// 存储不可用时仍按约定位置判断，保证保存命令不会写进数据目录
fn data_root(state: &State<'_, StorageState>) -> Option<PathBuf> {
    match &state.0 {
        Ok(storage) => Some(storage.root().to_path_buf()),
        Err(_) => storage::data_dir().ok(),
    }
}

fn check_outside(path: &Path, data_dir: Option<&Path>) -> Result<(), String> {
    match data_dir {
        Some(dir) if in_data_dir(path, dir) => Err(IN_DATA_DIR.into()),
        _ => Ok(()),
    }
}

fn into_path(picked: Option<FilePath>) -> Result<Option<PathBuf>, String> {
    picked
        .map(|p| {
            p.into_path()
                .map_err(|err| format!("无法识别所选路径：{err}"))
        })
        .transpose()
}

/// 写入完成后的去向
enum Target {
    /// 保存对话框选中的路径，对话框已确认覆盖
    Replace(PathBuf),
    /// 登记目录中的文件名，已有同名文件时加序号
    Unique(PathBuf, String),
}

struct PendingWrite {
    tmp: NamedTempFile,
    target: Target,
}

/// 进行中的分块写入。临时文件建在目标目录中，提交时同卷改名；记录被丢弃时临时文件随之删除，
/// 页面重载和应用退出时全部丢弃，前端中途出错或重载不会留下临时文件
#[derive(Default)]
pub struct Writes(Mutex<(u32, HashMap<u32, PendingWrite>)>);

impl Writes {
    fn lock(&self) -> MutexGuard<'_, (u32, HashMap<u32, PendingWrite>)> {
        self.0.lock().unwrap_or_else(|err| err.into_inner())
    }

    /// 在 dir 中创建临时文件，返回前端凭以追加和提交的序号
    fn begin(&self, dir: &Path, target: Target) -> io::Result<u32> {
        let tmp = tempfile::Builder::new()
            .prefix(".gpt-image-playground-")
            .suffix(".tmp")
            .tempfile_in(dir)?;
        let mut guard = self.lock();
        guard.0 = guard.0.wrapping_add(1);
        let id = guard.0;
        guard.1.insert(id, PendingWrite { tmp, target });
        Ok(id)
    }

    /// 追加一块；写入失败时丢弃整个记录
    fn write(&self, id: u32, bytes: &[u8]) -> Result<(), String> {
        let mut guard = self.lock();
        let pending = guard.1.get_mut(&id).ok_or(WRITE_GONE)?;
        if let Err(err) = pending.tmp.write_all(bytes) {
            guard.1.remove(&id);
            return Err(format!("写入失败：{err}"));
        }
        Ok(())
    }

    /// 把临时文件改名为目标文件，返回实际写入的路径；失败时临时文件随之删除，用户原有的同名文件不受影响
    fn commit(&self, id: u32) -> Result<PathBuf, String> {
        let pending = self.lock().1.remove(&id).ok_or(WRITE_GONE)?;
        match pending.target {
            Target::Replace(path) => match pending.tmp.persist(&path) {
                Ok(_) => Ok(path),
                Err(err) => Err(format!("写入 {} 失败：{}", path.display(), err.error)),
            },
            Target::Unique(dir, name) => persist_unique(pending.tmp, &dir, &name)
                .map_err(|err| format!("写入 {name} 失败：{err}")),
        }
    }

    fn abort(&self, id: u32) {
        self.lock().1.remove(&id);
    }

    /// 页面重载和应用退出时调用：丢弃全部未提交的写入，删除临时文件
    pub fn clear(&self) {
        self.lock().1.clear();
    }
}

const WRITE_GONE: &str = "保存已中断，请重试";

/// 目录中已有同名文件时依次改用“名称 (2).扩展名”“名称 (3).扩展名”……，不覆盖用户已有的文件。
/// 改名本身拒绝覆盖，挑选名称与写入之间不会被其他程序抢先
fn persist_unique(mut tmp: NamedTempFile, dir: &Path, name: &str) -> io::Result<PathBuf> {
    let base = Path::new(name);
    let stem = base.file_stem().and_then(|s| s.to_str()).unwrap_or(name);
    let ext = base.extension().and_then(|s| s.to_str());
    for n in 1..=999 {
        let candidate = match (n, ext) {
            (1, _) => name.to_string(),
            (_, Some(ext)) => format!("{stem} ({n}).{ext}"),
            (_, None) => format!("{stem} ({n})"),
        };
        let path = dir.join(candidate);
        match tmp.persist_noclobber(&path) {
            Ok(_) => return Ok(path),
            Err(err) if err.error.kind() == ErrorKind::AlreadyExists => tmp = err.file,
            Err(err) => return Err(err.error),
        }
    }
    Err(io::Error::new(ErrorKind::AlreadyExists, "同名文件过多"))
}

/// 弹出保存对话框，在所选位置开始一次分块写入，返回写入序号；用户取消时返回 None。对话框自带覆盖确认
#[tauri::command]
pub async fn save_file(
    window: WebviewWindow,
    state: State<'_, StorageState>,
    writes: State<'_, Writes>,
    name: String,
) -> Result<Option<u32>, String> {
    check_name(&name)?;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let ext = Path::new(&name)
            .extension()
            .and_then(|s| s.to_str())
            .map(str::to_string);
        let dialog = window
            .dialog()
            .file()
            .set_parent(&window)
            .set_file_name(&name);
        match ext {
            Some(ext) => dialog.add_filter(format!("{} 文件", ext.to_uppercase()), &[&ext]),
            None => dialog,
        }
        .blocking_save_file()
    })
    .await
    .map_err(|err| format!("保存对话框异常结束：{err}"))?;
    let Some(path) = into_path(picked)? else {
        return Ok(None);
    };
    let data_dir = data_root(&state);
    let dir = path.parent().unwrap_or(Path::new(".")).to_path_buf();
    tokio::task::block_in_place(|| {
        check_outside(&dir, data_dir.as_deref())?;
        writes
            .begin(&dir, Target::Replace(path))
            .map_err(|err| format!("无法在 {} 中创建临时文件：{err}", dir.display()))
    })
    .map(Some)
}

pub(crate) fn pick_folder(
    window: WebviewWindow,
    start: Option<PathBuf>,
) -> Result<Option<PathBuf>, String> {
    let dialog = window.dialog().file().set_parent(&window);
    let picked = match start {
        Some(dir) => dialog.set_directory(dir),
        None => dialog,
    }
    .blocking_pick_folder();
    into_path(picked)
}

/// 记下目录供 save_dir_begin 使用，返回前端凭以写入的序号；同一目录复用已有序号，列表不会随保存次数增长
fn register_dir(dirs: &SaveDirs, path: PathBuf) -> Result<SaveDir, String> {
    let mut list = dirs
        .0
        .lock()
        .map_err(|_| "保存目录列表不可用".to_string())?;
    let token = match list.iter().position(|p| *p == path) {
        Some(idx) => idx,
        None => {
            list.push(path.clone());
            list.len() - 1
        }
    };
    Ok(SaveDir {
        token,
        path: path.display().to_string(),
    })
}

/// 弹出目录选择框，记下所选目录供 save_dir_begin 使用；用户取消时返回 None
#[tauri::command]
pub async fn save_dir_pick(
    window: WebviewWindow,
    state: State<'_, StorageState>,
    dirs: State<'_, SaveDirs>,
) -> Result<Option<SaveDir>, String> {
    let picked = tauri::async_runtime::spawn_blocking(move || pick_folder(window, None))
        .await
        .map_err(|err| format!("目录选择框异常结束：{err}"))??;
    let Some(path) = picked else {
        return Ok(None);
    };
    let data_dir = data_root(&state);
    tokio::task::block_in_place(|| check_outside(&path, data_dir.as_deref()))?;
    register_dir(&dirs, path).map(Some)
}

/// 在 save_dir_pick 或 download_dir_use 登记的目录中开始一次分块写入，返回写入序号；
/// 提交时已有同名文件则加序号
#[tauri::command]
pub async fn save_dir_begin(
    dirs: State<'_, SaveDirs>,
    writes: State<'_, Writes>,
    token: usize,
    name: String,
) -> Result<u32, String> {
    check_name(&name)?;
    let dir = dirs
        .0
        .lock()
        .ok()
        .and_then(|list| list.get(token).cloned())
        .ok_or_else(|| "保存目录无效".to_string())?;
    tokio::task::block_in_place(|| {
        writes
            .begin(&dir, Target::Unique(dir.clone(), name.clone()))
            .map_err(|err| format!("创建 {name} 失败：{err}"))
    })
}

/// 把请求体追加到写入序号（x-id 头）对应的临时文件
#[tauri::command]
pub async fn save_write(writes: State<'_, Writes>, request: Request<'_>) -> Result<(), String> {
    let bytes = body(&request)?;
    let id = header(&request, "x-id")
        .parse::<u32>()
        .map_err(|_| WRITE_GONE.to_string())?;
    // 请求体借用自 IPC 消息，block_in_place 原地写入，不必再复制一份
    tokio::task::block_in_place(|| writes.write(id, bytes))
}

/// 写完全部分块后调用，返回实际写入的完整路径
#[tauri::command]
pub async fn save_commit(writes: State<'_, Writes>, id: u32) -> Result<String, String> {
    tokio::task::block_in_place(|| writes.commit(id)).map(|path| path.display().to_string())
}

/// 前端出错时调用，删除临时文件；序号不存在时什么也不做
#[tauri::command]
pub async fn save_abort(writes: State<'_, Writes>, id: u32) -> Result<(), String> {
    tokio::task::block_in_place(|| writes.abort(id));
    Ok(())
}

const DOWNLOAD_DIR_KEY: &str = "download_dir";

/// 用户未在设置中更改时的默认保存地址：优先使用安装程序写入 <数据目录>/download-dir.txt 的目录
/// （一行绝对路径，UTF-8；相对路径或位于数据目录内时忽略），否则为安装目录下的 downloads/，不随数据目录的位置变化。
/// 开发版改用 src-tauri/ 下已被 git 忽略的 dev-downloads/
fn initial_download_dir(data_dir: &Path, base: &Path) -> PathBuf {
    let from_installer = fs::read_to_string(data_dir.join("download-dir.txt"))
        .ok()
        .map(|text| {
            let line = text.trim_start_matches('\u{feff}').lines().next();
            PathBuf::from(line.unwrap_or_default().trim())
        })
        .filter(|path| path.is_absolute() && !in_data_dir(path, data_dir));
    if let Some(dir) = from_installer {
        return dir;
    }
    let name = if cfg!(debug_assertions) {
        "dev-downloads"
    } else {
        "downloads"
    };
    base.join(name)
}

fn storage<'a>(state: &'a State<'_, StorageState>) -> Result<&'a Storage, String> {
    state.0.as_deref().map_err(|err| err.message.clone())
}

/// 默认保存地址保存在 meta 表中，前端没有写 meta 的命令，只能经 download_dir_pick 的目录选择框更改。
/// 会访问数据库和磁盘，调用方需放在 block_in_place 中
fn download_dir(storage: &Storage) -> Result<PathBuf, String> {
    let saved = storage
        .meta_get(DOWNLOAD_DIR_KEY)
        .map_err(|err| err.message)?;
    if let Some(dir) = saved {
        return Ok(PathBuf::from(dir));
    }
    let base = data_dir::base_dir().map_err(|err| format!("无法定位安装目录：{err}"))?;
    Ok(initial_download_dir(storage.root(), &base))
}

/// 不存在时创建，并实际创建临时文件探测权限，提前发现目录不可写或所在磁盘已移除
fn ensure_writable(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    tempfile::tempfile_in(dir)?;
    Ok(())
}

#[tauri::command]
pub async fn download_dir_get(state: State<'_, StorageState>) -> Result<String, String> {
    let storage = storage(&state)?;
    let dir = tokio::task::block_in_place(|| download_dir(storage))?;
    Ok(dir.display().to_string())
}

/// 更改默认保存地址后待迁移的原目录，由 download_dir_pick 记下，前端无法指定其他目录
#[derive(Default)]
pub struct MigrateSource(Mutex<Option<PathBuf>>);

const NESTED: &str = "新旧地址不能互相包含。";
const CONTAINS_DATA: &str = "原地址里有应用数据或程序文件。";
const SYSTEM_DIR: &str = "原地址是磁盘根目录、用户文件夹或系统文件夹。";

/// 已规范化的系统目录：protected（用户主目录、AppData 下的 Roaming 和 Local）及其上级不能迁移；
/// 已知文件夹（下载、图片等）可以迁移内容，但保留文件夹本身，包含已知文件夹的上级目录不能迁移；
/// system（Windows、Program Files、ProgramData、临时文件夹）和 cloud（OneDrive）只用于限制数据目录的位置
#[derive(Default)]
pub(crate) struct SystemDirs {
    pub protected: Vec<PathBuf>,
    pub known: Vec<PathBuf>,
    pub system: Vec<PathBuf>,
    pub cloud: Vec<PathBuf>,
}

fn env_paths(names: &[&str]) -> Vec<PathBuf> {
    names
        .iter()
        .filter_map(std::env::var_os)
        .filter(|value| !value.is_empty())
        .map(|value| normalize(Path::new(&value)))
        .collect()
}

/// 只靠环境变量就能确定的系统目录，启动时（还没有 AppHandle）也能使用；不含已知文件夹
pub(crate) fn env_dirs() -> SystemDirs {
    let mut system = env_paths(&[
        "SystemRoot",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
        "ProgramData",
    ]);
    system.push(normalize(&std::env::temp_dir()));
    SystemDirs {
        protected: env_paths(&["USERPROFILE", "APPDATA", "LOCALAPPDATA"]),
        known: Vec::new(),
        system,
        cloud: env_paths(&["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]),
    }
}

pub(crate) fn system_dirs<R: Runtime>(app: &AppHandle<R>) -> SystemDirs {
    let path = app.path();
    let mut dirs = env_dirs();
    dirs.known = [
        path.download_dir(),
        path.picture_dir(),
        path.desktop_dir(),
        path.document_dir(),
        path.video_dir(),
        path.audio_dir(),
        path.public_dir(),
    ]
    .into_iter()
    .flatten()
    .map(|dir| normalize(&dir))
    .collect();
    dirs.protected.extend(
        [path.home_dir(), path.data_dir(), path.local_data_dir()]
            .into_iter()
            .flatten()
            .map(|dir| normalize(&dir)),
    );
    dirs
}

/// 不能迁移的原因，参数均已规范化；数据目录只按包含关系判断（原地址在数据目录内另由 check_outside 拦截）
fn migration_block(
    from: &Path,
    to: &Path,
    data_dir: &Path,
    dirs: &SystemDirs,
) -> Option<&'static str> {
    if from.parent().is_none()
        || dirs.protected.iter().any(|dir| dir.starts_with(from))
        || dirs
            .known
            .iter()
            .any(|dir| dir != from && dir.starts_with(from))
    {
        return Some(SYSTEM_DIR);
    }
    if migrate::is_nested(from, data_dir) {
        return Some(CONTAINS_DATA);
    }
    if migrate::is_nested(from, to) {
        return Some(NESTED);
    }
    None
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviousDir {
    path: String,
    files: u64,
    bytes: u64,
    /// 不能迁移的原因
    blocked: Option<&'static str>,
    /// 原地址是系统已知文件夹，迁移后保留文件夹本身
    keep_source: bool,
}

#[derive(Serialize)]
pub struct DirChange {
    path: String,
    /// 原地址中有文件时返回，供前端询问是否迁移
    previous: Option<PreviousDir>,
}

/// 原地址存在且有文件时返回其统计；与新地址相同或位于数据目录内时返回 None。会遍历原目录，调用方需放在 block_in_place 中
fn previous_dir(old: &Path, new: &Path, data_dir: &Path, dirs: &SystemDirs) -> Option<PreviousDir> {
    let (old_real, new_real) = (normalize(old), normalize(new));
    if old_real == new_real || !old.is_dir() || in_data_dir(old, data_dir) {
        return None;
    }
    let blocked = migration_block(&old_real, &new_real, &normalize(data_dir), dirs);
    let keep_source = dirs.known.contains(&old_real);
    // 不能迁移时不遍历（可能是整个磁盘），只告知原因
    let stats = match blocked {
        Some(_) => migrate::DirStats::default(),
        None => migrate::dir_stats(old, keep_source),
    };
    if blocked.is_none() && stats.files == 0 {
        return None;
    }
    Some(PreviousDir {
        path: old.display().to_string(),
        files: stats.files,
        bytes: stats.bytes,
        blocked,
        keep_source,
    })
}

/// 迁移前再次确认可以迁移，返回是否保留原文件夹本身
fn check_migration(
    from: &Path,
    to: &Path,
    data_dir: &Path,
    dirs: &SystemDirs,
) -> Result<bool, String> {
    check_outside(from, Some(data_dir))?;
    check_outside(to, Some(data_dir))?;
    let from_real = normalize(from);
    if let Some(reason) = migration_block(&from_real, &normalize(to), &normalize(data_dir), dirs) {
        return Err(reason.into());
    }
    Ok(dirs.known.contains(&from_real))
}

/// 弹出目录选择框更改默认保存地址，返回新地址，原地址中有文件时附上其统计；用户取消时返回 None
#[tauri::command]
pub async fn download_dir_pick(
    window: WebviewWindow,
    state: State<'_, StorageState>,
    source: State<'_, MigrateSource>,
) -> Result<Option<DirChange>, String> {
    // 之前记下的待迁移地址一律作废，取消选择或出错时也不能再迁移
    source
        .0
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .take();
    let storage = storage(&state)?;
    let dirs = system_dirs(window.app_handle());
    let old = tokio::task::block_in_place(|| download_dir(storage))?;
    // 从当前地址开始选择；目录不存在时由系统决定起始位置
    let start = Some(old.clone()).filter(|d| d.is_dir());
    let picked = tauri::async_runtime::spawn_blocking(move || pick_folder(window, start))
        .await
        .map_err(|err| format!("目录选择框异常结束：{err}"))??;
    let Some(path) = picked else {
        return Ok(None);
    };
    let previous = tokio::task::block_in_place(|| {
        check_outside(&path, Some(storage.root()))?;
        storage
            .meta_set(DOWNLOAD_DIR_KEY, &path.display().to_string())
            .map_err(|err| format!("保存默认保存地址失败：{}", err.message))?;
        Ok::<_, String>(previous_dir(&old, &path, storage.root(), &dirs))
    })?;
    *source.0.lock().unwrap_or_else(|err| err.into_inner()) = previous
        .as_ref()
        .filter(|p| p.blocked.is_none())
        .map(|_| old);
    Ok(Some(DirChange {
        path: path.display().to_string(),
        previous,
    }))
}

/// 把上次更改前的原地址中的全部内容移动到当前默认保存地址，移空后删除原目录本身（系统已知文件夹除外）
#[tauri::command]
pub async fn download_dir_migrate(
    app: AppHandle,
    state: State<'_, StorageState>,
    source: State<'_, MigrateSource>,
) -> Result<MoveReport, String> {
    let storage = storage(&state)?;
    let from = source
        .0
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .take()
        .ok_or("没有待迁移的原地址，请重新更改默认保存地址")?;
    let dirs = system_dirs(&app);
    let (to, keep_source) = tokio::task::block_in_place(|| {
        let to = download_dir(storage)?;
        let keep = check_migration(&from, &to, storage.root(), &dirs)?;
        Ok::<_, String>((to, keep))
    })?;
    tauri::async_runtime::spawn_blocking(move || migrate::move_contents(&from, &to, keep_source))
        .await
        .map_err(|err| format!("迁移异常结束：{err}"))?
        .map_err(|err| format!("迁移失败：{err}"))
}

/// “默认地址”模式下保存前调用：确认默认保存地址可写，并像 save_dir_pick 一样登记，之后用 save_dir_begin 写入
#[tauri::command]
pub async fn download_dir_use(
    state: State<'_, StorageState>,
    dirs: State<'_, SaveDirs>,
) -> Result<SaveDir, String> {
    let storage = storage(&state)?;
    let dir = tokio::task::block_in_place(|| {
        let dir = download_dir(storage)?;
        // 纵深防御：meta 中的值只能经 download_dir_pick 写入，写入前仍再确认不在数据目录内
        check_outside(&dir, Some(storage.root()))?;
        ensure_writable(&dir).map_err(|err| {
            log::warn!("默认保存地址不可用（{}）：{err}", dir.display());
            format!(
                "默认保存地址不可用：{}。请在「设置 → 习惯配置」中重新选择，或改为“每次询问”。",
                dir.display()
            )
        })?;
        Ok::<_, String>(dir)
    })?;
    register_dir(&dirs, dir)
}

/// 只打开默认保存地址本身，不存在时先创建
#[tauri::command]
pub async fn download_dir_open(state: State<'_, StorageState>) -> Result<(), String> {
    let storage = storage(&state)?;
    let dir = tokio::task::block_in_place(|| {
        let dir = download_dir(storage)?;
        fs::create_dir_all(&dir).map_err(|err| format!("无法创建 {}：{err}", dir.display()))?;
        Ok::<_, String>(dir)
    })?;
    tauri_plugin_opener::open_path(&dir, None::<&str>)
        .map_err(|err| format!("打开默认保存地址失败：{err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_paths_in_file_name() {
        assert!(is_plain_file_name("backup_2026-10-09.zip"));
        assert!(is_plain_file_name("收藏 图片.png"));
        assert!(is_plain_file_name("console.png"));
        assert!(is_plain_file_name("com10.png"));
        assert!(is_plain_file_name(&"图".repeat(255)));
        let long = "a".repeat(256);
        for name in [
            "a?.png",
            "a\u{1}.png",
            "a\tb.png",
            "con",
            "NUL.txt",
            "Com1.tar.gz",
            "lpt9",
            "aux .png",
            "a.zip.",
            "a.zip ",
            &long,
            "",
            ".",
            "..",
            "../a.zip",
            "a/b.zip",
            "a\\b.zip",
            "C:a.zip",
            "C:\\a.zip",
        ] {
            assert!(!is_plain_file_name(name), "{name}");
        }
    }

    fn entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn chunked_write_replaces_existing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.zip");
        fs::write(&path, b"old").unwrap();
        let writes = Writes::default();
        let id = writes
            .begin(dir.path(), Target::Replace(path.clone()))
            .unwrap();
        writes.write(id, b"ne").unwrap();
        // 提交前原有文件不变，临时文件在同一目录中
        assert_eq!(fs::read(&path).unwrap(), b"old");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
        writes.write(id, b"w").unwrap();
        assert_eq!(writes.commit(id).unwrap(), path);
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert_eq!(entries(dir.path()), ["a.zip"]);
        // 提交后序号失效
        assert_eq!(writes.write(id, b"x").unwrap_err(), WRITE_GONE);
        assert_eq!(writes.commit(id).unwrap_err(), WRITE_GONE);
    }

    #[test]
    fn abort_and_clear_remove_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let writes = Writes::default();
        let target = || Target::Unique(dir.path().to_path_buf(), "a.zip".into());
        let a = writes.begin(dir.path(), target()).unwrap();
        let b = writes.begin(dir.path(), target()).unwrap();
        let c = writes.begin(dir.path(), target()).unwrap();
        assert_ne!(a, b);
        writes.write(a, b"x").unwrap();
        writes.abort(a);
        writes.abort(a);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
        writes.clear();
        assert!(entries(dir.path()).is_empty());
        assert_eq!(writes.commit(b).unwrap_err(), WRITE_GONE);
        assert_eq!(writes.write(c, b"x").unwrap_err(), WRITE_GONE);
    }

    #[test]
    fn commit_failure_keeps_target_and_removes_temp() {
        let dir = tempfile::tempdir().unwrap();
        // 目标路径被目录占用，改名失败
        let path = dir.path().join("a.zip");
        fs::create_dir(&path).unwrap();
        let writes = Writes::default();
        let id = writes
            .begin(dir.path(), Target::Replace(path.clone()))
            .unwrap();
        writes.write(id, b"x").unwrap();
        assert!(writes.commit(id).is_err());
        assert!(path.is_dir());
        assert_eq!(entries(dir.path()), ["a.zip"]);
    }

    #[test]
    fn initial_download_dir_prefers_installer_file() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        fs::create_dir_all(&data).unwrap();
        let fallback = dir.path().join(if cfg!(debug_assertions) {
            "dev-downloads"
        } else {
            "downloads"
        });
        assert_eq!(initial_download_dir(&data, dir.path()), fallback);
        // 相对路径不可信，忽略
        fs::write(data.join("download-dir.txt"), "downloads").unwrap();
        assert_eq!(initial_download_dir(&data, dir.path()), fallback);
        // 指向数据目录内（含尚不存在的子目录）时忽略
        for inside in [data.clone(), data.join("images"), data.join("x").join("y")] {
            fs::write(data.join("download-dir.txt"), inside.display().to_string()).unwrap();
            assert_eq!(
                initial_download_dir(&data, dir.path()),
                fallback,
                "{}",
                inside.display()
            );
        }
        let picked = dir.path().join("图片 下载");
        fs::write(
            data.join("download-dir.txt"),
            format!("\u{feff}{}\r\nignored", picked.display()),
        )
        .unwrap();
        assert_eq!(initial_download_dir(&data, dir.path()), picked);
    }

    #[test]
    fn detects_paths_in_data_dir() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        fs::create_dir_all(data.join("images")).unwrap();
        assert!(in_data_dir(&data, &data));
        assert!(in_data_dir(&data.join("images"), &data));
        assert!(in_data_dir(&data.join("new").join("sub"), &data));
        // 经“..”绕回数据目录
        assert!(in_data_dir(
            &dir.path().join("other").join("..").join("data"),
            &data
        ));
        assert!(!in_data_dir(&dir.path().join("downloads"), &data));
        assert!(!in_data_dir(dir.path(), &data));
        // 仅名称前缀相同不算
        assert!(!in_data_dir(&dir.path().join("data2"), &data));
        assert_eq!(
            check_outside(&data.join("images"), Some(&data)).unwrap_err(),
            IN_DATA_DIR
        );
        assert!(check_outside(&data, None).is_ok());
    }

    #[test]
    fn previous_dir_and_migration_checks() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let old = root.path().join("old");
        let new = root.path().join("new");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(old.join("empty")).unwrap();
        fs::create_dir_all(&new).unwrap();
        let dirs = SystemDirs::default();
        // 没有文件、不存在、与新地址相同时不询问
        assert!(previous_dir(&old, &new, &data, &dirs).is_none());
        assert!(previous_dir(&root.path().join("missing"), &new, &data, &dirs).is_none());
        fs::write(old.join("a.png"), b"abc").unwrap();
        assert!(previous_dir(&old, &old, &data, &dirs).is_none());
        let prev = previous_dir(&old, &new, &data, &dirs).unwrap();
        assert_eq!(
            (prev.files, prev.bytes, prev.blocked, prev.keep_source),
            (1, 3, None, false)
        );
        assert_eq!(check_migration(&old, &new, &data, &dirs), Ok(false));
        // 新地址在原地址内，或原地址在新地址内，都拒绝迁移
        let inner = old.join("inner");
        fs::create_dir_all(&inner).unwrap();
        let outer = root.path().join("outer");
        let old2 = outer.join("old2");
        fs::create_dir_all(&old2).unwrap();
        fs::write(old2.join("b.png"), b"b").unwrap();
        assert_eq!(
            previous_dir(&old, &inner, &data, &dirs).unwrap().blocked,
            Some(NESTED)
        );
        assert_eq!(
            previous_dir(&old2, &outer, &data, &dirs).unwrap().blocked,
            Some(NESTED)
        );
        assert_eq!(
            check_migration(&old, &inner, &data, &dirs).unwrap_err(),
            NESTED
        );
        assert_eq!(
            check_migration(&old2, &outer, &data, &dirs).unwrap_err(),
            NESTED
        );
        assert_eq!(
            check_migration(&old, &old, &data, &dirs).unwrap_err(),
            NESTED
        );
        // 原地址是数据目录的上级（例如安装目录）：拒绝，且不遍历统计
        let prev = previous_dir(root.path(), &new, &data, &dirs).unwrap();
        assert_eq!((prev.blocked, prev.files), (Some(CONTAINS_DATA), 0));
        assert_eq!(
            check_migration(root.path(), &new, &data, &dirs).unwrap_err(),
            CONTAINS_DATA
        );
        // 数据目录内的位置不参与迁移
        assert_eq!(
            check_migration(&old, &data.join("images"), &data, &dirs).unwrap_err(),
            IN_DATA_DIR
        );
        fs::write(data.join("x.png"), b"x").unwrap();
        assert!(previous_dir(&data, &new, &data, &dirs).is_none());
        // 用户主目录及其上级拒绝；已知文件夹可以迁移，但保留文件夹本身
        let sys = SystemDirs {
            protected: vec![normalize(&old)],
            known: vec![normalize(&old2)],
            system: vec![],
            cloud: vec![],
        };
        assert_eq!(
            previous_dir(&old, &new, &data, &sys).unwrap().blocked,
            Some(SYSTEM_DIR)
        );
        assert_eq!(
            check_migration(&old, &new, &data, &sys).unwrap_err(),
            SYSTEM_DIR
        );
        let prev = previous_dir(&old2, &new, &data, &sys).unwrap();
        assert_eq!((prev.blocked, prev.keep_source), (None, true));
        assert_eq!(check_migration(&old2, &new, &data, &sys), Ok(true));
    }

    #[cfg(windows)]
    #[test]
    fn blocks_drive_roots_and_home_ancestors() {
        let dirs = SystemDirs {
            protected: vec![
                PathBuf::from(r"C:\Users\me"),
                PathBuf::from(r"C:\Users\me\AppData\Roaming"),
                PathBuf::from(r"C:\Users\me\AppData\Local"),
            ],
            known: vec![PathBuf::from(r"D:\Shell\Pictures")],
            system: vec![],
            cloud: vec![],
        };
        let data = Path::new(r"D:\Apps\GIP\data");
        let to = Path::new(r"E:\新地址");
        for from in [
            r"C:\",
            r"D:\",
            r"\\?\C:\",
            r"C:\Users",
            r"C:\Users\me",
            r"C:\Users\me\AppData",
            r"C:\Users\me\AppData\Local",
            r"D:\Shell",
        ] {
            assert_eq!(
                migration_block(Path::new(from), to, data, &dirs),
                Some(SYSTEM_DIR),
                "{from}"
            );
        }
        for from in [r"D:\Apps", r"D:\Apps\GIP"] {
            assert_eq!(
                migration_block(Path::new(from), to, data, &dirs),
                Some(CONTAINS_DATA),
                "{from}"
            );
        }
        for from in [
            r"C:\Users\me\Pictures",
            r"D:\Apps\GIP\downloads",
            r"D:\图片",
            r"D:\Shell\Pictures",
            r"C:\Users\me\AppData\Local\Temp\x",
        ] {
            assert_eq!(
                migration_block(Path::new(from), to, data, &dirs),
                None,
                "{from}"
            );
        }
    }

    #[test]
    fn register_dir_reuses_token() {
        let dirs = SaveDirs::default();
        let a = register_dir(&dirs, PathBuf::from("C:\\a")).unwrap();
        let b = register_dir(&dirs, PathBuf::from("C:\\b")).unwrap();
        let again = register_dir(&dirs, PathBuf::from("C:\\a")).unwrap();
        assert_eq!((a.token, b.token, again.token), (0, 1, 0));
        assert_eq!(dirs.0.lock().unwrap().len(), 2);
    }

    #[test]
    fn ensure_writable_creates_missing_dir() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("a").join("b");
        ensure_writable(&target).unwrap();
        // 探测用的临时文件不留在目录中
        assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
        // 路径被普通文件占用时报错
        let blocked = dir.path().join("file");
        fs::write(&blocked, b"").unwrap();
        assert!(ensure_writable(&blocked).is_err());
    }

    #[test]
    fn numbers_duplicate_names() {
        let dir = tempfile::tempdir().unwrap();
        let writes = Writes::default();
        let save = |name: &str, bytes: &[u8]| {
            let target = Target::Unique(dir.path().to_path_buf(), name.into());
            let id = writes.begin(dir.path(), target).unwrap();
            writes.write(id, bytes).unwrap();
            let path = writes.commit(id).unwrap();
            path.file_name().unwrap().to_string_lossy().into_owned()
        };
        let names: Vec<_> = (0..3u8).map(|i| save("a.zip", &[i])).collect();
        assert_eq!(names, ["a.zip", "a (2).zip", "a (3).zip"]);
        // 已有文件不被覆盖
        assert_eq!(fs::read(dir.path().join("a.zip")).unwrap(), [0]);
        assert_eq!(fs::read(dir.path().join("a (3).zip")).unwrap(), [2]);
        assert_eq!(save("noext", b""), "noext");
        assert_eq!(save("noext", b""), "noext (2)");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 5);
    }
}
