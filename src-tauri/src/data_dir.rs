//! 数据目录的位置：默认为安装目录下的 data/（开发版为 src-tauri/dev-data/），可在设置中更改。
//! 更改后的位置写在安装目录的 data-dir 文件中：一行路径，UTF-8；
//! 安装在可移动设备上且与安装目录同盘时省略盘符（以 \ 开头），U 盘换了盘符也能找到；其他情况写完整路径。
//! 更改流程：设置页选好新目录并确认后，写入 data-dir.pending 并重启；下次启动时在初始化日志、存储和窗口之前，
//! 把原目录完整复制到新目录、逐个核对大小并写入磁盘，全部成功后才改写 data-dir、删除原目录。
//! WebView2 的数据目录只能在创建时指定，运行中 SQLite 和 WebView2 也锁着各自的文件，所以只在启动时迁移。
//! 任何一步失败都删除新目录中本次复制的内容、继续使用原目录，并在启动后提示原因
use std::fs;
use std::io::{self, ErrorKind, Write};
use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, State, WebviewWindow};

use crate::files::{self, SystemDirs};
use crate::migrate;

const POINTER: &str = "data-dir";
/// 已确认、待下次启动迁移：原目录、新目录、发起更改的进程号、迁移完成后要写入的指向文件内容
/// （新目录是默认位置时为空行，表示删除指向文件），各占一行
const PENDING: &str = "data-dir.pending";
/// 迁移开始前由 PENDING 改名而来，迁移结束后删除；启动时仍存在说明上次迁移中途程序意外退出
const RUNNING: &str = "data-dir.migrating";
/// 迁移期间独占打开，防止同时启动的第二个实例也去迁移
const LOCK: &str = "data-dir.lock";

const NETWORK: &str = "不支持网络位置。";
const ROOT: &str = "不能使用磁盘根目录。";
const PROTECTED: &str = "不能使用用户文件夹或 AppData。";
const KNOWN: &str = "不能直接使用下载、图片、文档等系统文件夹，可以在里面新建一个。";
const SYSTEM: &str = "不能使用 Windows、Program Files 等系统位置。";
const CLOUD: &str = "不能使用 OneDrive 等云同步文件夹。";
const IN_INSTALL: &str = "不能使用安装目录，卸载时可能被删除。";
const SAME: &str = "与当前数据目录相同。";
const NESTED: &str = "不能与当前数据目录互相包含。";
const NOT_EMPTY: &str = "请选择一个空文件夹。";
const CANCELLED: &str = "已取消";

/// Progress::cancel 的取值：0 进行中，1 已取消，2 已开始切换、不能再取消
const COMMITTED: i32 = 2;

static CURRENT: OnceLock<PathBuf> = OnceLock::new();
static CUSTOM: AtomicBool = AtomicBool::new(false);
static NOTICES: Mutex<Vec<Notice>> = Mutex::new(Vec::new());

/// 启动时确定数据目录的结果，前端加载后取走并提示。kind 为 success 或 warning；
/// message 是一句话结论（可含 **加粗**），paths 为 [标签, 路径]，details 为原因或补充说明，每项一段
#[derive(Debug, Clone, Serialize)]
pub struct Notice {
    kind: &'static str,
    title: String,
    message: String,
    paths: Vec<(String, String)>,
    details: Vec<String>,
}

fn notice(
    kind: &'static str,
    title: &str,
    message: &str,
    paths: &[(&str, &Path)],
    details: Vec<String>,
) -> Option<Notice> {
    Some(Notice {
        kind,
        title: title.into(),
        message: message.into(),
        paths: paths
            .iter()
            .map(|(label, path)| (label.to_string(), path.display().to_string()))
            .collect(),
        details,
    })
}

/// 发布版为 exe 所在目录；debug 构建（含 tauri dev）为 src-tauri/
pub fn base_dir() -> io::Result<PathBuf> {
    if cfg!(debug_assertions) {
        return Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    }
    let exe = std::env::current_exe()?;
    exe.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| io::Error::other("无法确定程序所在目录"))
}

fn default_dir(base: &Path) -> PathBuf {
    base.join(if cfg!(debug_assertions) {
        "dev-data"
    } else {
        "data"
    })
}

/// 本次运行使用的数据目录：prepare 之后固定不变；之前（或单元测试中）为默认位置
pub fn current() -> io::Result<PathBuf> {
    if let Some(dir) = CURRENT.get() {
        return Ok(dir.clone());
    }
    base_dir().map(|base| default_dir(&base))
}

fn disk(path: &Path) -> Option<u8> {
    match path.components().next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => {
                Some(letter.to_ascii_uppercase())
            }
            _ => None,
        },
        _ => None,
    }
}

/// UNC 路径、映射的网络驱动器等网络位置：SQLite 在网络文件系统上容易损坏
fn is_network(path: &Path) -> bool {
    let Some(Component::Prefix(prefix)) = path.components().next() else {
        return false;
    };
    match prefix.kind() {
        Prefix::UNC(..) | Prefix::VerbatimUNC(..) | Prefix::DeviceNS(_) => true,
        Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => is_remote_drive(letter),
        Prefix::Verbatim(_) => false,
    }
}

#[cfg(windows)]
fn is_remote_drive(letter: u8) -> bool {
    use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;
    let root = migrate::wide(Path::new(&format!("{}:\\", letter as char)));
    // DRIVE_REMOTE
    unsafe { GetDriveTypeW(root.as_ptr()) == 4 }
}

#[cfg(not(windows))]
fn is_remote_drive(_letter: u8) -> bool {
    false
}

/// 规范化后忽略大小写比较完整路径
fn same_path(a: &Path, b: &Path) -> bool {
    let full = |path: &Path| files::normalize(path).to_string_lossy().to_lowercase();
    full(a) == full(b)
}

/// 盘符对应的设备是否为可移动设备：GetDriveTypeW 为 DRIVE_REMOVABLE（U 盘），或者总线类型为 USB
/// （报告为固定磁盘的 USB 移动硬盘、移动固态硬盘）。查询失败一律按不可移动处理
#[cfg(windows)]
fn is_removable_drive(letter: u8) -> bool {
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        BusTypeUsb, CreateFileW, GetDriveTypeW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Ioctl::{
        PropertyStandardQuery, StorageDeviceProperty, IOCTL_STORAGE_QUERY_PROPERTY,
        STORAGE_DEVICE_DESCRIPTOR, STORAGE_PROPERTY_QUERY,
    };
    use windows_sys::Win32::System::IO::DeviceIoControl;

    let root = migrate::wide(Path::new(&format!("{}:\\", letter as char)));
    // DRIVE_REMOVABLE
    if unsafe { GetDriveTypeW(root.as_ptr()) } == 2 {
        return true;
    }
    // 打开卷设备只为查询属性，不需要读写权限
    let volume = migrate::wide(Path::new(&format!("\\\\.\\{}:", letter as char)));
    let handle = unsafe {
        CreateFileW(
            volume.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return false;
    }
    let query = STORAGE_PROPERTY_QUERY {
        PropertyId: StorageDeviceProperty,
        QueryType: PropertyStandardQuery,
        AdditionalParameters: [0],
    };
    // 描述符后面跟着厂商、型号等字符串，留足空间；这里只读取固定部分的 BusType
    #[repr(C)]
    struct Output {
        desc: STORAGE_DEVICE_DESCRIPTOR,
        extra: [u8; 1024],
    }
    let mut out: Output = unsafe { std::mem::zeroed() };
    let mut returned = 0u32;
    let ok = unsafe {
        DeviceIoControl(
            handle,
            IOCTL_STORAGE_QUERY_PROPERTY,
            &query as *const STORAGE_PROPERTY_QUERY as *const c_void,
            size_of::<STORAGE_PROPERTY_QUERY>() as u32,
            &mut out as *mut Output as *mut c_void,
            size_of::<Output>() as u32,
            &mut returned,
            std::ptr::null_mut(),
        )
    };
    unsafe { CloseHandle(handle) };
    let filled = std::mem::offset_of!(STORAGE_DEVICE_DESCRIPTOR, BusType) + 4;
    ok != 0 && returned as usize >= filled && out.desc.BusType == BusTypeUsb
}

#[cfg(not(windows))]
fn is_removable_drive(_letter: u8) -> bool {
    false
}

/// 安装目录是否在可移动设备上
fn removable_base(base: &Path) -> bool {
    disk(base).is_some_and(is_removable_drive)
}

/// 指向文件中记录的文本：新目录是默认位置时为 None（删除指向文件）。
/// 只有安装在可移动设备上、且新目录与安装目录同盘时才省略盘符，U 盘换了盘符也能找到；
/// 普通安装写完整路径，整个安装文件夹挪到别的盘后数据目录仍然有效
fn pointer_text(base: &Path, to: &Path, removable: bool) -> Option<String> {
    if files::normalize(to) == files::normalize(&default_dir(base)) {
        return None;
    }
    let text = to.display().to_string();
    match (disk(base), disk(to)) {
        (Some(a), Some(b)) if removable && a == b && text.as_bytes().get(1) == Some(&b':') => {
            Some(text[2..].to_string())
        }
        _ => Some(text),
    }
}

/// 省略了盘符的路径补上安装目录的盘符
fn parse_pointer(base: &Path, line: &str) -> PathBuf {
    if line.starts_with('\\') && !line.starts_with("\\\\") {
        if let Some(Component::Prefix(prefix)) = base.components().next() {
            let mut path = prefix.as_os_str().to_owned();
            path.push(line);
            return PathBuf::from(path);
        }
    }
    PathBuf::from(line)
}

/// 指向文件的第一行；不存在时为 None
fn read_pointer(base: &Path) -> io::Result<Option<String>> {
    match fs::read_to_string(base.join(POINTER)) {
        Ok(text) => Ok(Some(
            text.trim_start_matches('\u{feff}')
                .lines()
                .next()
                .unwrap_or_default()
                .trim()
                .to_string(),
        )),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err),
    }
}

/// 指向文件指向的目录无法使用的原因
#[derive(Debug, PartialEq)]
enum Problem {
    /// 目录不存在或无法访问，例如存储设备未连接
    Missing(PathBuf),
    /// 指向文件损坏，或指向的位置不能用作数据目录；label、path 说明涉及的文件或目录
    Invalid {
        reason: String,
        label: &'static str,
        path: PathBuf,
    },
}

/// 读取 data-dir 确定数据目录；不存在时为默认位置
fn resolve(base: &Path, dirs: &SystemDirs) -> Result<PathBuf, Problem> {
    let pointer = base.join(POINTER);
    let invalid = |reason: String, label, path: &Path| Problem::Invalid {
        reason,
        label,
        path: path.to_path_buf(),
    };
    let line = match read_pointer(base) {
        Ok(None) => return Ok(default_dir(base)),
        Ok(Some(line)) => line,
        Err(err) => {
            return Err(invalid(
                format!("无法读取数据目录设置：{err}"),
                "设置文件",
                &pointer,
            ))
        }
    };
    let dir = parse_pointer(base, &line);
    if !dir.is_absolute() {
        return Err(invalid(
            "数据目录设置中记录的不是有效的文件夹路径。".into(),
            "设置文件",
            &pointer,
        ));
    }
    if is_network(&dir) {
        return Err(invalid(
            "数据目录位于网络位置，不支持。".into(),
            "数据目录",
            &dir,
        ));
    }
    if !dir.is_dir() {
        return Err(Problem::Missing(dir));
    }
    let real = files::normalize(&dir);
    if let Some(reason) = location_block(&real, &files::normalize(base), dirs) {
        return Err(invalid(
            format!("数据目录位于不支持的位置。{reason}"),
            "数据目录",
            &dir,
        ));
    }
    Ok(dir)
}

/// 写入并落盘后再改名，避免断电留下损坏或空的文件
fn write_atomic(path: &Path, text: &str) -> io::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let mut file = fs::File::create(&tmp)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()?;
    drop(file);
    fs::rename(&tmp, path)
}

/// 写入指向文件；text 为 None 时删除（新目录是默认位置）
fn write_pointer(base: &Path, text: Option<&str>) -> io::Result<()> {
    let pointer = base.join(POINTER);
    match text {
        Some(text) => write_atomic(&pointer, text),
        None => match fs::remove_file(&pointer) {
            Err(err) if err.kind() == ErrorKind::NotFound => Ok(()),
            other => other,
        },
    }
}

/// 位置本身不能作为数据目录的原因，参数均已规范化；不检查是否为空，也不涉及当前数据目录
fn location_block(dir: &Path, base: &Path, dirs: &SystemDirs) -> Option<&'static str> {
    if is_network(dir) {
        return Some(NETWORK);
    }
    if dir.parent().is_none() {
        return Some(ROOT);
    }
    if dirs.protected.iter().any(|d| d.starts_with(dir)) {
        return Some(PROTECTED);
    }
    if dirs.known.iter().any(|d| d.starts_with(dir)) {
        return Some(KNOWN);
    }
    if dirs.system.iter().any(|d| migrate::is_nested(d, dir)) {
        return Some(SYSTEM);
    }
    if dirs.cloud.iter().any(|d| migrate::is_nested(d, dir)) {
        return Some(CLOUD);
    }
    if migrate::is_nested(dir, base) && dir != default_dir(base) {
        return Some(IN_INSTALL);
    }
    None
}

/// 不能作为新数据目录的原因，参数均已规范化
fn target_block(to: &Path, current: &Path, base: &Path, dirs: &SystemDirs) -> Option<&'static str> {
    if to == current {
        return Some(SAME);
    }
    // 当前数据目录可能在安装目录下（默认位置），这时优先说明包含关系
    match location_block(to, base, dirs) {
        Some(IN_INSTALL) | None if migrate::is_nested(to, current) => Some(NESTED),
        other => other,
    }
}

/// 新数据目录必须是绝对路径、为空或不存在，且不违反 target_block 中的规则
fn check_target(to: &Path, current: &Path, base: &Path, dirs: &SystemDirs) -> Result<(), String> {
    let real = files::normalize(to);
    if !to.is_absolute() || real.components().any(|c| c == Component::ParentDir) {
        return Err("请选择一个文件夹。".into());
    }
    if is_network(to) {
        return Err(NETWORK.into());
    }
    let base = files::normalize(base);
    if let Some(reason) = target_block(&real, &files::normalize(current), &base, dirs) {
        return Err(reason.into());
    }
    if to.exists() && !to.is_dir() {
        return Err("请选择一个文件夹。".into());
    }
    match fs::read_dir(to).map(|mut entries| entries.next().is_none()) {
        Ok(true) => Ok(()),
        Ok(false) => Err(NOT_EMPTY.into()),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("无法读取所选文件夹：{err}")),
    }
}

#[derive(Default)]
struct Progress {
    done: AtomicU64,
    total: AtomicU64,
    /// Windows 的 BOOL，直接交给 CopyFileExW 轮询，大文件复制到一半也能取消；取值见 COMMITTED
    cancel: AtomicI32,
    finished: AtomicBool,
}

impl Progress {
    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed) == 1
    }
}

fn cancelled() -> io::Error {
    io::Error::new(ErrorKind::Interrupted, CANCELLED)
}

/// 提示中去掉规范化带来的 \\?\ 前缀，便于用户查找
pub(crate) fn shown(path: &Path) -> String {
    let raw = path.display().to_string();
    match raw.strip_prefix(r"\\?\UNC\") {
        Some(rest) => format!(r"\\{rest}"),
        None => raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_string(),
    }
}

/// 复制单个文件，目标已存在时报错；复制过程中按字节更新进度，单个大文件也不会长时间停在同一进度
#[cfg(windows)]
fn copy_file(src: &Path, dst: &Path, progress: &Progress) -> io::Result<()> {
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::{
        CopyFileExW, COPYPROGRESSROUTINE_PROGRESS, COPY_FILE_FAIL_IF_EXISTS,
        LPPROGRESS_ROUTINE_CALLBACK_REASON, PROGRESS_CONTINUE,
    };

    struct Ctx<'a> {
        progress: &'a Progress,
        start: u64,
    }

    unsafe extern "system" fn report(
        _total: i64,
        transferred: i64,
        _stream_size: i64,
        _stream_transferred: i64,
        _stream: u32,
        _reason: LPPROGRESS_ROUTINE_CALLBACK_REASON,
        _src: HANDLE,
        _dst: HANDLE,
        data: *const c_void,
    ) -> COPYPROGRESSROUTINE_PROGRESS {
        let ctx = unsafe { &*(data as *const Ctx) };
        ctx.progress
            .done
            .store(ctx.start + transferred as u64, Ordering::Relaxed);
        PROGRESS_CONTINUE
    }

    let ctx = Ctx {
        progress,
        start: progress.done.load(Ordering::Relaxed),
    };
    let ok = unsafe {
        CopyFileExW(
            migrate::wide(src).as_ptr(),
            migrate::wide(dst).as_ptr(),
            Some(report),
            &ctx as *const Ctx as *const c_void,
            progress.cancel.as_ptr(),
            COPY_FILE_FAIL_IF_EXISTS,
        )
    };
    if ok != 0 {
        return Ok(());
    }
    let err = io::Error::last_os_error();
    // ERROR_REQUEST_ABORTED：已取消，CopyFileExW 会删除未复制完的目标文件
    if err.raw_os_error() == Some(1235) {
        return Err(cancelled());
    }
    Err(err)
}

#[cfg(not(windows))]
fn copy_file(src: &Path, dst: &Path, _progress: &Progress) -> io::Result<()> {
    migrate::copy_file(src, dst)
}

/// 把文件内容写入磁盘（FlushFileBuffers 需要写权限）；只读文件临时去掉只读属性
fn sync_file(path: &Path) -> io::Result<()> {
    let err = match fs::OpenOptions::new().write(true).open(path) {
        Ok(file) => return file.sync_all(),
        Err(err) => err,
    };
    let mut perms = fs::metadata(path)?.permissions();
    if err.kind() != ErrorKind::PermissionDenied || !perms.readonly() {
        return Err(err);
    }
    #[allow(clippy::permissions_set_readonly_false)]
    perms.set_readonly(false);
    fs::set_permissions(path, perms.clone())?;
    let result = fs::OpenOptions::new()
        .write(true)
        .open(path)
        .and_then(|file| file.sync_all());
    perms.set_readonly(true);
    fs::set_permissions(path, perms)?;
    result
}

/// 逐个复制文件、核对大小并写入磁盘；遇到链接、复制失败或用户取消时立即返回错误
fn copy_tree(from: &Path, to: &Path, progress: &Progress) -> io::Result<()> {
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        if progress.cancelled() {
            return Err(cancelled());
        }
        let (src, dst) = (entry.path(), to.join(entry.file_name()));
        let meta = fs::symlink_metadata(&src)?;
        if meta.file_type().is_symlink() {
            return Err(io::Error::other(format!(
                "数据目录中有符号链接，无法复制：{}",
                shown(&src)
            )));
        }
        if meta.is_dir() {
            fs::create_dir(&dst)?;
            copy_tree(&src, &dst, progress)?;
            continue;
        }
        let start = progress.done.load(Ordering::Relaxed);
        copy_file(&src, &dst, progress).map_err(|err| match err.kind() {
            ErrorKind::Interrupted => err,
            kind => io::Error::new(kind, format!("复制 {} 失败：{err}", shown(&src))),
        })?;
        if fs::metadata(&dst)?.len() != meta.len() {
            return Err(io::Error::other(format!(
                "{} 复制后大小不一致",
                shown(&src)
            )));
        }
        sync_file(&dst).map_err(|err| {
            io::Error::new(err.kind(), format!("{} 写入磁盘失败：{err}", shown(&dst)))
        })?;
        progress.done.store(start + meta.len(), Ordering::Relaxed);
    }
    Ok(())
}

/// 删除新目录中本次复制的内容。created 为本次新建的目录（由深到浅，第一个是新目录本身），为空表示新目录原本就有：
/// 本次新建的整个删除，上级只删空目录；原本就有的空目录只清空。删不干净时返回给用户的说明
fn discard(to: &Path, created: &[PathBuf]) -> Option<String> {
    let result = if created.is_empty() {
        fs::read_dir(to).and_then(|entries| {
            entries
                .flatten()
                .try_for_each(|entry| migrate::remove_any(&entry.path()))
        })
    } else {
        fs::remove_dir_all(to)
    };
    for dir in created.iter().skip(1) {
        let _ = fs::remove_dir(dir);
    }
    result.err().map(|err| {
        log::warn!("新目录中未复制完的文件未能删除：{err}");
        "新目录中有未复制完的文件，可以删除。".to_string()
    })
}

/// 迁移失败：reason 为 None 表示用户取消；leftover 为新目录中未能删除的副本的说明
#[derive(Debug, PartialEq)]
struct Failure {
    reason: Option<String>,
    leftover: Option<String>,
}

impl Failure {
    fn new(reason: impl Into<String>) -> Self {
        Self {
            reason: Some(reason.into()),
            leftover: None,
        }
    }

    fn cancelled() -> Self {
        Self {
            reason: None,
            leftover: None,
        }
    }

    fn discarding(mut self, to: &Path, created: &[PathBuf]) -> Self {
        self.leftover = discard(to, created);
        self
    }
}

/// 复制并校验，返回本次新建的目录；失败时已删除本次复制的内容
fn copy_verified(
    from: &Path,
    to: &Path,
    base: &Path,
    progress: &Progress,
) -> Result<Vec<PathBuf>, Failure> {
    check_target(to, from, base, &SystemDirs::default()).map_err(Failure::new)?;
    let stats = migrate::dir_stats(from, false);
    progress.total.store(stats.bytes, Ordering::Relaxed);
    let created: Vec<PathBuf> = to
        .ancestors()
        .take_while(|dir| !dir.exists())
        .map(Path::to_path_buf)
        .collect();
    if let Err(err) = fs::create_dir_all(to) {
        return Err(Failure::new(format!("无法创建新目录：{err}")).discarding(to, &created));
    }
    // 规范化为带 \\?\ 前缀的绝对路径，支持超过 260 个字符的长路径
    let result = from.canonicalize().and_then(|src| {
        copy_tree(&src, &to.canonicalize()?, progress)?;
        if migrate::dir_stats(to, false) != stats {
            return Err(io::Error::other("复制结果与原目录不一致"));
        }
        Ok(())
    });
    match result {
        Ok(()) => Ok(created),
        Err(err) if err.kind() == ErrorKind::Interrupted => {
            Err(Failure::cancelled().discarding(to, &created))
        }
        Err(err) => Err(Failure::new(err.to_string()).discarding(to, &created)),
    }
}

/// 复制、校验、写入指向文件（内容为确认时记下的 pointer，保证与标记第 4 行一致），最后删除原目录。
/// 返回原目录未能完全删除时的说明
fn change(
    base: &Path,
    from: &Path,
    to: &Path,
    pointer: Option<&str>,
    progress: &Progress,
) -> Result<Option<String>, Failure> {
    let created = copy_verified(from, to, base, progress)?;
    // 之后不能再取消；取消标志已设置时按取消处理，保证进度框显示的状态与结果一致
    if progress
        .cancel
        .compare_exchange(0, COMMITTED, Ordering::AcqRel, Ordering::Relaxed)
        .is_err()
    {
        return Err(Failure::cancelled().discarding(to, &created));
    }
    if let Err(err) = write_pointer(base, pointer) {
        let failure = Failure::new(format!("无法写入数据目录设置：{err}"));
        return Err(failure.discarding(to, &created));
    }
    Ok(fs::remove_dir_all(from).err().map(|err| err.to_string()))
}

/// 等待发起更改的旧进程退出，以及 WebView2 的浏览器进程释放 lockfile（它们在主程序退出后才陆续退出）
#[cfg(windows)]
fn wait_previous(pid: Option<u32>, from: &Path, progress: &Progress) -> Result<(), Failure> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };

    // 打不开说明进程已经退出
    let handle = pid.map_or(std::ptr::null_mut(), |pid| unsafe {
        OpenProcess(PROCESS_SYNCHRONIZE, 0, pid)
    });
    if !handle.is_null() {
        let mut exited = false;
        for _ in 0..300 {
            if unsafe { WaitForSingleObject(handle, 100) } == WAIT_OBJECT_0 {
                exited = true;
                break;
            }
            if progress.cancelled() {
                break;
            }
        }
        unsafe { CloseHandle(handle) };
        if progress.cancelled() {
            return Err(Failure::cancelled());
        }
        if !exited {
            log::warn!("原来的客户端进程 30 秒内没有退出");
            return Err(Failure::new("客户端未能及时退出"));
        }
    }
    let lockfile = from.join("webview").join("EBWebView").join("lockfile");
    for _ in 0..150 {
        if progress.cancelled() {
            return Err(Failure::cancelled());
        }
        match fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&lockfile)
        {
            // ERROR_SHARING_VIOLATION
            Err(err) if err.raw_os_error() == Some(32) => {
                std::thread::sleep(Duration::from_millis(100))
            }
            _ => return Ok(()),
        }
    }
    log::warn!("WebView2 15 秒内没有释放原数据目录");
    Err(Failure::new("原数据目录仍被占用"))
}

#[cfg(not(windows))]
fn wait_previous(_pid: Option<u32>, _from: &Path, _progress: &Progress) -> Result<(), Failure> {
    Ok(())
}

/// 在后台线程迁移；超过半秒未完成时在主线程显示进度框（此时还没有创建任何窗口）
fn with_progress(
    progress: &Progress,
    work: impl FnOnce() -> Result<Option<String>, Failure> + Send,
) -> Result<Option<String>, Failure> {
    std::thread::scope(|scope| {
        let worker = scope.spawn(|| {
            let result = work();
            progress.finished.store(true, Ordering::Release);
            result
        });
        for _ in 0..10 {
            if worker.is_finished() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        #[cfg(windows)]
        if !worker.is_finished() {
            dialog::progress(progress);
        }
        worker
            .join()
            .unwrap_or_else(|_| Err(Failure::new("迁移线程异常结束")))
    })
}

fn run_pending(base: &Path, current: &Path) -> (PathBuf, Option<Notice>) {
    let failed = |failure: Failure, to: &Path| {
        let (title, mut details) = match failure.reason {
            None => ("已取消更改数据目录", vec![]),
            Some(reason) => ("更改数据目录失败", vec![format!("原因：{reason}")]),
        };
        details.extend(failure.leftover);
        let mut rows = vec![("原目录", current)];
        if !to.as_os_str().is_empty() {
            rows.push(("新目录", to));
        }
        let notice = notice("warning", title, "数据仍在原目录。", &rows, details);
        (current.to_path_buf(), notice)
    };
    let (pending, running) = (base.join(PENDING), base.join(RUNNING));
    // 先改名再迁移：中途程序意外退出时，下次启动不会重复迁移，而是提示上次未完成
    if let Err(err) = fs::rename(&pending, &running) {
        let _ = fs::remove_file(&pending);
        return failed(Failure::new(err.to_string()), Path::new(""));
    }
    let text = fs::read_to_string(&running).unwrap_or_default();
    // 用 split 而不是 lines：第 4 行为空（迁到默认目录）时也要读出来
    let mut lines = text.split('\n').map(|line| line.trim_end_matches('\r'));
    let from = PathBuf::from(lines.next().unwrap_or_default());
    let to = PathBuf::from(lines.next().unwrap_or_default());
    let pid = lines.next().and_then(|line| line.trim().parse().ok());
    // 第 4 行是确认时算好的指向文件内容（空行表示删除）；旧格式没有这一行时现算
    // 空行只在新目录确实是默认目录时才表示删除；3 行旧格式以换行结尾时 split 也会读出空的第 4 行
    let pointer = match lines.next() {
        Some(line) if !line.is_empty() || same_path(&to, &default_dir(base)) => {
            (!line.is_empty()).then(|| line.to_string())
        }
        _ => pointer_text(base, &to, removable_base(base)),
    };
    let result = if from.as_os_str().is_empty()
        || to.as_os_str().is_empty()
        || files::normalize(&from) != files::normalize(current)
    {
        Err(Failure::new("数据目录在确认更改后发生了变化"))
    } else {
        let progress = Progress::default();
        with_progress(&progress, || {
            wait_previous(pid, &from, &progress)?;
            change(base, &from, &to, pointer.as_deref(), &progress)
        })
    };
    let _ = fs::remove_file(&running);
    match result {
        Ok(None) => {
            let notice = notice("success", "数据目录已更改", "数据目录已更改", &[], vec![]);
            (to, notice)
        }
        Ok(Some(detail)) => {
            log::warn!("原数据目录未能完全删除：{detail}");
            let notice = notice(
                "warning",
                "数据目录已更改",
                "原目录未能清理完成，可以手动删除。",
                &[("新目录", &to), ("原目录", &from)],
                vec![],
            );
            (to, notice)
        }
        Err(failure) => failed(failure, &to),
    }
}

/// 上次迁移中途意外退出时的提示。写指向文件是最后一步：启动时读到的指向文件原始内容（询问“改用默认目录”之前记下）
/// 与标记第 4 行完全相同，才说明已经写好；不能按路径推断，同名换盘、省略盘符时都无法区分原目录和新目录
fn interrupted(
    base: &Path,
    dir: &Path,
    pointer: &io::Result<Option<String>>,
    text: &str,
) -> Option<Notice> {
    // 用 split 而不是 lines：第 4 行为空（迁到默认目录）时也要读出来，与没有第 4 行的旧格式区分
    let mut lines = text.split('\n').map(|line| line.trim_end_matches('\r'));
    let from = Path::new(lines.next().unwrap_or_default());
    let to = Path::new(lines.next().unwrap_or_default());
    let expected = lines.nth(1);
    let rows = [("原目录", from), ("新目录", to)];
    let title = "上次更改数据目录未完成";
    let (Some(expected), Ok(raw)) = (expected, pointer) else {
        return notice(
            "warning",
            title,
            "无法确定是否已复制完成。请比较两个目录中的文件，确认新目录完整后再删除原目录。",
            &rows,
            vec![],
        );
    };
    let written = match raw {
        None => expected.is_empty() && same_path(to, &default_dir(base)),
        Some(line) => !expected.is_empty() && line == expected,
    };
    if !written {
        return notice(
            "warning",
            title,
            "数据仍在原目录，新目录可以删除。",
            &rows,
            vec![],
        );
    }
    // 已写好：本次实际用上了指向文件记录的目录，才能提示原目录可以删除（唯一的入口）
    let recorded = match raw {
        None => default_dir(base),
        Some(line) => parse_pointer(base, line),
    };
    if same_path(dir, &recorded) {
        return notice(
            "warning",
            "数据目录已更改",
            "已切换到新目录，原目录可以删除。",
            &rows,
            vec![],
        );
    }
    notice(
        "warning",
        title,
        "数据已复制到新目录，但新目录现在无法访问。请勿删除原目录。",
        &rows,
        vec![],
    )
}

/// 指向的目录无法使用时的选择
#[derive(Debug, Clone, Copy, PartialEq)]
enum Choice {
    Retry,
    /// 删除指向文件，改用默认目录
    UseDefault,
    /// 无法弹出对话框时：本次使用默认目录，指向文件保持不动
    Skip,
    Exit,
}

/// 迁移期间独占打开锁文件，关闭时自动删除
fn lock(base: &Path) -> io::Result<fs::File> {
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_DELETE_ON_CLOSE
        opts.share_mode(0).custom_flags(0x0400_0000);
    }
    opts.open(base.join(LOCK))
}

/// 确定数据目录，有待迁移的更改时先完成迁移。指向的目录无法使用时由 ask 询问用户
fn startup(
    base: &Path,
    dirs: &SystemDirs,
    ask: &mut dyn FnMut(&Problem) -> Choice,
) -> (PathBuf, Vec<Notice>) {
    // 询问中可能删除指向文件，先记下原始内容供判断上次中断的迁移
    let pointer = read_pointer(base);
    let default = default_dir(base);
    let mut notices = Vec::new();
    // 原来指向的目录，改用默认目录后写进提示，方便用户找回
    let recorded = match &pointer {
        Ok(Some(line)) => parse_pointer(base, line),
        _ => PathBuf::new(),
    };
    let rows: Vec<(&str, &Path)> = [
        ("原数据目录", recorded.as_path()),
        ("默认目录", default.as_path()),
    ]
    .into_iter()
    .filter(|(_, path)| !path.as_os_str().is_empty())
    .collect();
    let mut dir = loop {
        match resolve(base, dirs) {
            Ok(dir) => break dir,
            Err(problem) => match ask(&problem) {
                Choice::Retry => continue,
                Choice::UseDefault => {
                    let _ = fs::remove_file(base.join(POINTER));
                    notices.extend(notice(
                        "warning",
                        "已改用默认数据目录",
                        "原目录中的图片和设置不会转移。",
                        &rows,
                        vec![],
                    ));
                    break default.clone();
                }
                Choice::Skip => {
                    notices.extend(notice(
                        "warning",
                        "本次使用默认数据目录",
                        match problem {
                            Problem::Missing(_) => {
                                "找不到原数据目录，本次使用默认目录。重新连接存储设备后，重启即可恢复。"
                            }
                            Problem::Invalid { .. } => "原数据目录设置无效，本次使用默认目录。",
                        },
                        &rows,
                        vec![],
                    ));
                    break default.clone();
                }
                Choice::Exit => std::process::exit(0),
            },
        }
    };
    let running = base.join(RUNNING);
    if !base.join(PENDING).exists() && !running.exists() {
        return (dir, notices);
    }
    match lock(base) {
        // ERROR_SHARING_VIOLATION：同时启动的另一个实例正在迁移并显示进度，本实例直接退出
        Err(err) if err.raw_os_error() == Some(32) => std::process::exit(0),
        Err(err) => {
            let _ = fs::remove_file(base.join(PENDING));
            notices.extend(notice(
                "warning",
                "更改数据目录失败",
                "数据仍在原目录。",
                &[("原目录", &dir)],
                vec![format!("原因：无法写入安装目录（{err}）")],
            ));
        }
        Ok(_lock) => {
            if let Ok(text) = fs::read_to_string(&running) {
                notices.extend(interrupted(base, &dir, &pointer, &text));
                let _ = fs::remove_file(&running);
            }
            if base.join(PENDING).exists() {
                let (next, result) = run_pending(base, &dir);
                dir = next;
                notices.extend(result);
            }
        }
    }
    (dir, notices)
}

/// 启动时最先调用
pub fn prepare() {
    let Ok(base) = base_dir() else {
        return;
    };
    let default = default_dir(&base);
    #[cfg(windows)]
    let mut ask = |problem: &Problem| dialog::ask(problem, &default);
    #[cfg(not(windows))]
    let mut ask = |_: &Problem| Choice::Skip;
    let (dir, notices) = startup(&base, &files::env_dirs(), &mut ask);
    CUSTOM.store(
        files::normalize(&dir) != files::normalize(&default),
        Ordering::Relaxed,
    );
    let _ = CURRENT.set(dir);
    for notice in &notices {
        eprintln!("[data-dir] {} {}", notice.message, notice.details.join(" "));
    }
    *NOTICES.lock().unwrap_or_else(|err| err.into_inner()) = notices;
}

/// 启动后记入日志（prepare 时日志尚未初始化）
pub fn log_notice() {
    for notice in NOTICES.lock().unwrap_or_else(|err| err.into_inner()).iter() {
        if notice.kind == "warning" {
            log::warn!(
                "{}：{} {}",
                notice.title,
                notice.message,
                notice.details.join(" ")
            );
        }
    }
}

#[derive(Serialize)]
pub struct Startup {
    notices: Vec<Notice>,
    /// 数据目录不是默认位置：存储不可用时前端只建议更改数据目录，不建议重装
    custom: bool,
}

/// 启动时确定数据目录的提示，只返回一次
#[tauri::command]
pub fn data_dir_notice() -> Startup {
    Startup {
        notices: std::mem::take(&mut *NOTICES.lock().unwrap_or_else(|err| err.into_inner())),
        custom: CUSTOM.load(Ordering::Relaxed),
    }
}

/// 已选择、待确认的新数据目录，前端无法指定其他目录
#[derive(Default)]
pub struct PickedDir(Mutex<Option<PathBuf>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDirChange {
    from: String,
    to: String,
    files: u64,
    bytes: u64,
    /// 不能使用所选目录的原因
    blocked: Option<String>,
}

/// 弹出目录选择框选择新数据目录，校验通过后返回原目录、新目录与数据大小；用户取消时返回 None
#[tauri::command]
pub async fn data_dir_pick(
    window: WebviewWindow,
    picked: State<'_, PickedDir>,
) -> Result<Option<DataDirChange>, String> {
    picked
        .0
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .take();
    let base = base_dir().map_err(|err| format!("无法定位安装目录：{err}"))?;
    let from = current().map_err(|err| format!("无法定位数据目录：{err}"))?;
    let dirs = files::system_dirs(window.app_handle());
    let start = from.parent().map(Path::to_path_buf);
    let chosen = tauri::async_runtime::spawn_blocking(move || files::pick_folder(window, start))
        .await
        .map_err(|err| format!("目录选择框异常结束：{err}"))??;
    let Some(to) = chosen else {
        return Ok(None);
    };
    let checked = tokio::task::block_in_place(|| {
        check_target(&to, &from, &base, &dirs).map(|()| migrate::dir_stats(&from, false))
    });
    let (stats, blocked) = match checked {
        Ok(stats) => {
            *picked.0.lock().unwrap_or_else(|err| err.into_inner()) = Some(to.clone());
            (stats, None)
        }
        Err(reason) => (migrate::DirStats::default(), Some(reason)),
    };
    Ok(Some(DataDirChange {
        from: from.display().to_string(),
        to: to.display().to_string(),
        files: stats.files,
        bytes: stats.bytes,
        blocked,
    }))
}

/// 确认更改：记下待迁移的新目录并重启，由下次启动完成迁移
#[tauri::command]
pub async fn data_dir_change(app: AppHandle, picked: State<'_, PickedDir>) -> Result<(), String> {
    let to = picked
        .0
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .take()
        .ok_or("没有待确认的新数据目录，请重新选择。")?;
    let base = base_dir().map_err(|err| format!("无法定位安装目录：{err}"))?;
    let from = current().map_err(|err| format!("无法定位数据目录：{err}"))?;
    let dirs = files::system_dirs(&app);
    tokio::task::block_in_place(|| {
        check_target(&to, &from, &base, &dirs)?;
        let text = format!(
            "{}\n{}\n{}\n{}",
            from.display(),
            to.display(),
            std::process::id(),
            pointer_text(&base, &to, removable_base(&base)).unwrap_or_default()
        );
        write_atomic(&base.join(PENDING), &text)
            .map_err(|err| format!("无法开始更改数据目录，请确认安装目录可以写入后重试。（{err}）"))
    })?;
    // 触发正常退出流程（单实例锁、未完成的保存等在 Exit 事件中清理），随后启动新进程
    app.request_restart();
    Ok(())
}

/// 启动时（还没有窗口）使用的系统 TaskDialog
#[cfg(windows)]
mod dialog {
    use std::path::Path;
    use std::sync::atomic::Ordering;

    use windows_sys::core::HRESULT;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, S_FALSE, S_OK, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
    use windows_sys::Win32::UI::Controls::{
        TASKDIALOGCONFIG, TASKDIALOG_BUTTON, TDCBF_CANCEL_BUTTON, TDE_CONTENT, TDF_CALLBACK_TIMER,
        TDF_SHOW_PROGRESS_BAR, TDM_CLICK_BUTTON, TDM_ENABLE_BUTTON, TDM_SET_PROGRESS_BAR_POS,
        TDM_SET_PROGRESS_BAR_RANGE, TDM_UPDATE_ELEMENT_TEXT, TDN_BUTTON_CLICKED, TDN_CREATED,
        TDN_TIMER, TD_WARNING_ICON,
    };
    use windows_sys::Win32::UI::HiDpi::{
        SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{PostMessageW, SendMessageW, IDCANCEL};

    use super::{Choice, Problem, Progress, COMMITTED};

    const TITLE: &str = "GPT Image Playground";

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }

    fn size(bytes: u64) -> String {
        let mb = bytes as f64 / 1024.0 / 1024.0;
        if mb >= 1024.0 {
            return format!("{:.2} GB", mb / 1024.0);
        }
        format!("{mb:.1} MB")
    }

    type TaskDialogIndirect = unsafe extern "system" fn(
        *const TASKDIALOGCONFIG,
        *mut i32,
        *mut i32,
        *mut windows_sys::core::BOOL,
    ) -> HRESULT;

    /// TaskDialogIndirect 只在 6.0 版通用控件中提供（应用的清单已声明），动态查找：
    /// 静态导入时，没有清单的程序（例如单元测试）会因找不到入口点而无法启动
    fn task_dialog() -> Option<TaskDialogIndirect> {
        let proc = unsafe {
            let lib = LoadLibraryW(wide("comctl32.dll").as_ptr());
            if lib.is_null() {
                return None;
            }
            GetProcAddress(lib, c"TaskDialogIndirect".as_ptr().cast())
        }?;
        // 窗口尚未创建，tao 还没设置 DPI 感知；先设置，避免对话框在高 DPI 屏幕上模糊
        unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
        Some(unsafe {
            std::mem::transmute::<unsafe extern "system" fn() -> isize, TaskDialogIndirect>(proc)
        })
    }

    fn set_content(hwnd: HWND, text: &str) {
        let text = wide(text);
        unsafe {
            SendMessageW(
                hwnd,
                TDM_UPDATE_ELEMENT_TEXT as u32,
                TDE_CONTENT as usize,
                text.as_ptr() as isize,
            )
        };
    }

    unsafe extern "system" fn callback(
        hwnd: HWND,
        msg: u32,
        _wparam: WPARAM,
        _lparam: LPARAM,
        data: isize,
    ) -> HRESULT {
        let progress = unsafe { &*(data as *const Progress) };
        match msg as i32 {
            // 进度按千分比显示
            TDN_CREATED => unsafe {
                SendMessageW(hwnd, TDM_SET_PROGRESS_BAR_RANGE as u32, 0, 1000 << 16);
            },
            TDN_TIMER => {
                if progress.finished.load(Ordering::Acquire) {
                    unsafe { PostMessageW(hwnd, TDM_CLICK_BUTTON as u32, IDCANCEL as usize, 0) };
                    return S_OK;
                }
                let state = progress.cancel.load(Ordering::Relaxed);
                if state == COMMITTED {
                    unsafe { SendMessageW(hwnd, TDM_ENABLE_BUTTON as u32, IDCANCEL as usize, 0) };
                }
                let (done, total) = (
                    progress.done.load(Ordering::Relaxed),
                    progress.total.load(Ordering::Relaxed),
                );
                if state == 1 || total == 0 {
                    return S_OK;
                }
                let permille = (done.min(total) * 1000 / total) as usize;
                unsafe { SendMessageW(hwnd, TDM_SET_PROGRESS_BAR_POS as u32, permille, 0) };
                let text = format!(
                    "已复制 {} / {}（{}%）",
                    size(done),
                    size(total),
                    permille / 10
                );
                set_content(hwnd, &text);
            }
            TDN_BUTTON_CLICKED => {
                if progress.finished.load(Ordering::Acquire) {
                    return S_OK;
                }
                // 已开始切换时不能再取消；否则等迁移线程删除已复制的内容，结束后再关闭
                unsafe { SendMessageW(hwnd, TDM_ENABLE_BUTTON as u32, IDCANCEL as usize, 0) };
                if progress
                    .cancel
                    .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Relaxed)
                    .is_ok()
                {
                    set_content(hwnd, "正在取消…");
                }
                return S_FALSE;
            }
            _ => {}
        }
        S_OK
    }

    pub fn progress(progress: &Progress) {
        let Some(task_dialog) = task_dialog() else {
            return;
        };
        let title = wide(TITLE);
        let heading = wide("正在更改数据目录");
        let content = wide("正在准备…");
        let footer = wide("完成后自动打开。");
        let config = TASKDIALOGCONFIG {
            cbSize: size_of::<TASKDIALOGCONFIG>() as u32,
            dwFlags: TDF_SHOW_PROGRESS_BAR | TDF_CALLBACK_TIMER,
            dwCommonButtons: TDCBF_CANCEL_BUTTON,
            pszWindowTitle: title.as_ptr(),
            pszMainInstruction: heading.as_ptr(),
            pszContent: content.as_ptr(),
            pszFooter: footer.as_ptr(),
            pfCallback: Some(callback),
            lpCallbackData: progress as *const Progress as isize,
            ..Default::default()
        };
        let result = unsafe {
            task_dialog(
                &config,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if result != S_OK {
            eprintln!("[data-dir] 无法显示进度框：0x{result:08X}");
        }
    }

    /// 显示带自定义按钮的提示，返回所点按钮的序号（从 0 开始）；关闭对话框时返回 None
    fn choose(heading: &str, content: &str, footer: &str, buttons: &[&str]) -> Option<usize> {
        let task_dialog = task_dialog()?;
        let (title, heading, content, footer) =
            (wide(TITLE), wide(heading), wide(content), wide(footer));
        let labels: Vec<Vec<u16>> = buttons.iter().map(|label| wide(label)).collect();
        let items: Vec<TASKDIALOG_BUTTON> = labels
            .iter()
            .enumerate()
            .map(|(idx, label)| TASKDIALOG_BUTTON {
                nButtonID: 100 + idx as i32,
                pszButtonText: label.as_ptr(),
            })
            .collect();
        let mut config = TASKDIALOGCONFIG {
            cbSize: size_of::<TASKDIALOGCONFIG>() as u32,
            pszWindowTitle: title.as_ptr(),
            pszMainInstruction: heading.as_ptr(),
            pszContent: content.as_ptr(),
            pszFooter: footer.as_ptr(),
            cButtons: items.len() as u32,
            pButtons: items.as_ptr(),
            nDefaultButton: 100,
            ..Default::default()
        };
        config.Anonymous1.pszMainIcon = TD_WARNING_ICON;
        let mut clicked = 0;
        let result = unsafe {
            task_dialog(
                &config,
                &mut clicked,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if result != S_OK {
            return None;
        }
        usize::try_from(clicked - 100)
            .ok()
            .filter(|idx| *idx < buttons.len())
    }

    /// 指向的目录无法使用：重试、改用默认目录（再确认一次）或退出
    pub fn ask(problem: &Problem, default: &Path) -> Choice {
        let (heading, content, footer) = match problem {
            Problem::Missing(dir) => (
                "找不到数据目录",
                "存储设备可能未连接。".to_string(),
                format!("数据目录：{}", dir.display()),
            ),
            Problem::Invalid {
                reason,
                label,
                path,
            } => (
                "数据目录设置无效",
                reason.clone(),
                format!("{label}：{}", path.display()),
            ),
        };
        loop {
            match choose(
                heading,
                &content,
                &footer,
                &["重试", "改用默认目录", "退出"],
            ) {
                // 无法显示对话框：本次使用默认目录，指向文件不动
                None if task_dialog().is_none() => return Choice::Skip,
                Some(0) => return Choice::Retry,
                Some(1) => {
                    let old = match problem {
                        Problem::Missing(dir) => Some(dir),
                        Problem::Invalid {
                            label: "数据目录",
                            path,
                            ..
                        } => Some(path),
                        Problem::Invalid { .. } => None,
                    };
                    let footer = match old {
                        Some(old) => format!(
                            "原数据目录：{}\n默认目录：{}",
                            old.display(),
                            default.display()
                        ),
                        None => format!("默认目录：{}", default.display()),
                    };
                    let confirm = choose(
                        "改用默认目录？",
                        "原目录中的图片和设置不会转移。",
                        &footer,
                        &["改用默认目录", "返回"],
                    );
                    if confirm == Some(0) {
                        return Choice::UseDefault;
                    }
                }
                _ => return Choice::Exit,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_with_data() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let data = default_dir(root.path());
        fs::create_dir_all(data.join("images").join("ab")).unwrap();
        fs::write(data.join("data.db"), b"db").unwrap();
        fs::write(data.join("images").join("ab").join("x.png"), b"png").unwrap();
        (root, data)
    }

    fn none() -> SystemDirs {
        SystemDirs::default()
    }

    fn all_text(notice: &Notice) -> String {
        format!(
            "{} {} {}",
            notice.title,
            notice.message,
            notice.details.join(" ")
        )
    }

    #[test]
    fn resolves_pointer() {
        let (root, data) = base_with_data();
        let base = root.path();
        assert_eq!(resolve(base, &none()), Ok(data.clone()));
        let other = tempfile::tempdir().unwrap();
        let other = other.path().join("其他 位置");
        fs::create_dir_all(&other).unwrap();
        fs::write(
            base.join(POINTER),
            format!("\u{feff}{}\r\n", other.display()),
        )
        .unwrap();
        assert_eq!(resolve(base, &none()), Ok(other.clone()));
        // 指向的目录不存在
        let missing = other.join("missing");
        fs::write(base.join(POINTER), missing.display().to_string()).unwrap();
        assert_eq!(resolve(base, &none()), Err(Problem::Missing(missing)));
        // 损坏（相对路径、空文件、乱码）
        for text in ["relative\\dir", "", "\u{fffd}\u{fffd}"] {
            fs::write(base.join(POINTER), text).unwrap();
            assert!(
                matches!(resolve(base, &none()), Err(Problem::Invalid { .. })),
                "{text}"
            );
        }
        fs::write(base.join(POINTER), [0xff, 0xfe, 0x00]).unwrap();
        assert!(matches!(
            resolve(base, &none()),
            Err(Problem::Invalid { .. })
        ));
        // 指向安装目录中的其他位置、或云同步文件夹：不合规
        let inside = base.join("inside");
        fs::create_dir_all(&inside).unwrap();
        fs::write(base.join(POINTER), inside.display().to_string()).unwrap();
        assert!(
            matches!(resolve(base, &none()), Err(Problem::Invalid { reason, .. }) if reason.contains(IN_INSTALL))
        );
        fs::write(base.join(POINTER), other.display().to_string()).unwrap();
        let cloud = SystemDirs {
            cloud: vec![files::normalize(other.parent().unwrap())],
            ..SystemDirs::default()
        };
        assert!(
            matches!(resolve(base, &cloud), Err(Problem::Invalid { reason, .. }) if reason.contains(CLOUD))
        );
    }

    /// 与安装目录同盘时指向文件省略盘符，读取时补上安装目录的盘符
    #[cfg(windows)]
    #[test]
    fn pointer_omits_drive_on_same_disk() {
        let base = Path::new(r"E:\Apps\GIP");
        // 可移动设备：与安装目录同盘时省略盘符
        assert_eq!(
            pointer_text(base, Path::new(r"E:\GIP 数据"), true).as_deref(),
            Some(r"\GIP 数据")
        );
        assert_eq!(
            pointer_text(base, Path::new(r"D:\GIP 数据"), true).as_deref(),
            Some(r"D:\GIP 数据")
        );
        // 普通安装：一律写完整路径
        assert_eq!(
            pointer_text(base, Path::new(r"E:\GIP 数据"), false).as_deref(),
            Some(r"E:\GIP 数据")
        );
        assert_eq!(pointer_text(base, &default_dir(base), true), None);
        assert_eq!(pointer_text(base, &default_dir(base), false), None);
        // 读取时继续兼容省略盘符的写法
        assert_eq!(
            parse_pointer(Path::new(r"F:\Apps\GIP"), r"\GIP 数据"),
            PathBuf::from(r"F:\GIP 数据")
        );
        assert_eq!(
            parse_pointer(base, r"D:\GIP 数据"),
            PathBuf::from(r"D:\GIP 数据")
        );
        assert_eq!(
            parse_pointer(base, r"\\server\share"),
            PathBuf::from(r"\\server\share")
        );
        // 实际读写一遍（临时目录与测试用的安装目录在同一个盘）
        let (root, _) = base_with_data();
        let new = root.path().with_extension("同盘");
        fs::create_dir_all(&new).unwrap();
        let text = pointer_text(root.path(), &new, true);
        write_pointer(root.path(), text.as_deref()).unwrap();
        let written = fs::read_to_string(root.path().join(POINTER)).unwrap();
        assert!(
            written.starts_with('\\') && !written.starts_with(r"\\"),
            "{written}"
        );
        assert_eq!(resolve(root.path(), &none()), Ok(new.clone()));
        fs::remove_dir(&new).unwrap();
    }

    /// C、D 盘（存在时）通常是固定磁盘，判为不可移动
    #[cfg(windows)]
    #[test]
    fn local_disks_are_not_removable() {
        for letter in *b"CD" {
            if Path::new(&format!("{}:\\", letter as char)).exists() {
                assert!(!is_removable_drive(letter), "{}:", letter as char);
            }
        }
        // 不存在的盘符查询失败，按不可移动处理
        if !Path::new("Q:\\").exists() {
            assert!(!is_removable_drive(b'Q'));
        }
    }

    #[cfg(windows)]
    #[test]
    fn rejects_network_locations() {
        assert!(is_network(Path::new(r"\\server\share\gip")));
        assert!(is_network(Path::new(r"\\?\UNC\server\share\gip")));
        assert!(!is_network(Path::new(r"C:\gip")));
        let (root, data) = base_with_data();
        assert_eq!(
            check_target(
                Path::new(r"\\server\share\gip"),
                &data,
                root.path(),
                &none()
            )
            .unwrap_err(),
            NETWORK
        );
        fs::write(root.path().join(POINTER), r"\\server\share\gip").unwrap();
        assert!(matches!(
            resolve(root.path(), &none()),
            Err(Problem::Invalid { .. })
        ));
    }

    #[test]
    fn checks_target_rules() {
        let (root, data) = base_with_data();
        let base = root.path();
        let outside = tempfile::tempdir().unwrap();
        let new = outside.path().join("新数据");
        assert_eq!(check_target(&new, &data, base, &none()), Ok(()));
        fs::create_dir_all(&new).unwrap();
        assert_eq!(check_target(&new, &data, base, &none()), Ok(()));
        fs::write(new.join("a.txt"), b"a").unwrap();
        assert_eq!(
            check_target(&new, &data, base, &none()).unwrap_err(),
            NOT_EMPTY
        );
        assert_eq!(
            check_target(&new.join("a.txt"), &data, base, &none()).unwrap_err(),
            "请选择一个文件夹。"
        );
        assert!(check_target(Path::new("relative"), &data, base, &none()).is_err());
        assert_eq!(check_target(&data, &data, base, &none()).unwrap_err(), SAME);
        for nested in [data.join("images"), data.join("new")] {
            assert_eq!(
                check_target(&nested, &data, base, &none()).unwrap_err(),
                NESTED
            );
        }
        // 安装目录及其中除默认数据目录外的位置
        let other = outside.path().join("cur");
        fs::create_dir_all(&other).unwrap();
        assert_eq!(
            check_target(base, &other, base, &none()).unwrap_err(),
            IN_INSTALL
        );
        assert_eq!(
            check_target(&base.join("other"), &other, base, &none()).unwrap_err(),
            IN_INSTALL
        );
        // 当前在其他位置时可以改回默认位置（为空或不存在）
        fs::remove_dir_all(&data).unwrap();
        assert_eq!(check_target(&data, &other, base, &none()), Ok(()));
    }

    #[cfg(windows)]
    #[test]
    fn blocks_system_locations() {
        let dirs = SystemDirs {
            protected: vec![
                PathBuf::from(r"C:\Users\me"),
                PathBuf::from(r"C:\Users\me\AppData\Roaming"),
                PathBuf::from(r"C:\Users\me\AppData\Local"),
            ],
            known: vec![
                PathBuf::from(r"C:\Users\me\Pictures"),
                PathBuf::from(r"D:\Shell\图片"),
            ],
            system: vec![
                PathBuf::from(r"C:\Windows"),
                PathBuf::from(r"C:\Program Files"),
            ],
            cloud: vec![PathBuf::from(r"C:\Users\me\OneDrive")],
        };
        let current = Path::new(r"C:\Users\me\AppData\Local\GIP\data");
        let base = Path::new(r"C:\Users\me\AppData\Local\GIP");
        let cases = [
            (r"C:\", Some(ROOT)),
            (r"\\?\D:\", Some(ROOT)),
            (r"\\?\UNC\server\share\x", Some(NETWORK)),
            (r"C:\Users", Some(PROTECTED)),
            (r"C:\Users\me", Some(PROTECTED)),
            (r"C:\Users\me\AppData", Some(PROTECTED)),
            (r"C:\Users\me\AppData\Local", Some(PROTECTED)),
            (r"C:\Users\me\Pictures", Some(KNOWN)),
            (r"D:\Shell", Some(KNOWN)),
            (r"C:\Windows\x", Some(SYSTEM)),
            (r"C:\Program Files\GIP", Some(SYSTEM)),
            (r"C:\Users\me\OneDrive", Some(CLOUD)),
            (r"C:\Users\me\OneDrive\GIP", Some(CLOUD)),
            (r"C:\Users\me\AppData\Local\GIP\data", Some(SAME)),
            (r"C:\Users\me\AppData\Local\GIP\data\images", Some(NESTED)),
            (r"C:\Users\me\AppData\Local\GIP\other", Some(IN_INSTALL)),
            (r"C:\Users\me\Pictures\GIP 数据", None),
            (r"C:\Users\me\AppData\Local\其他", None),
            (r"D:\GIP 数据", None),
        ];
        for (to, expected) in cases {
            assert_eq!(
                target_block(Path::new(to), current, base, &dirs),
                expected,
                "{to}"
            );
        }
    }

    #[test]
    fn change_copies_switches_and_removes_old() {
        let (root, data) = base_with_data();
        let base = root.path();
        let outside = tempfile::tempdir().unwrap();
        let new = outside.path().join("a").join("新数据");
        let progress = Progress::default();
        let text = pointer_text(base, &new, false);
        assert_eq!(
            change(base, &data, &new, text.as_deref(), &progress),
            Ok(None)
        );
        assert!(!data.exists());
        assert_eq!(fs::read(new.join("data.db")).unwrap(), b"db");
        assert_eq!(
            fs::read(new.join("images").join("ab").join("x.png")).unwrap(),
            b"png"
        );
        assert_eq!(progress.done.load(Ordering::Relaxed), 5);
        assert_eq!(progress.cancel.load(Ordering::Relaxed), COMMITTED);
        assert_eq!(resolve(base, &none()), Ok(new.clone()));
        // 改回默认位置时删除指向文件
        assert_eq!(
            change(base, &new, &data, None, &Progress::default()),
            Ok(None)
        );
        assert!(!base.join(POINTER).exists());
        assert!(!new.exists());
        assert_eq!(resolve(base, &none()), Ok(data.clone()));
        assert_eq!(fs::read(data.join("data.db")).unwrap(), b"db");
    }

    /// 只读文件也能写入磁盘，复制后仍为只读
    #[test]
    fn syncs_readonly_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ro.bin");
        fs::write(&path, b"ro").unwrap();
        let mut perms = fs::metadata(&path).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&path, perms).unwrap();
        sync_file(&path).unwrap();
        let mut perms = fs::metadata(&path).unwrap().permissions();
        assert!(perms.readonly());
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        fs::set_permissions(&path, perms).unwrap();
        assert!(sync_file(&dir.path().join("missing")).is_err());
        // 写指向文件：落盘后改名，不留临时文件
        write_atomic(&dir.path().join("p"), "abc").unwrap();
        assert_eq!(fs::read_to_string(dir.path().join("p")).unwrap(), "abc");
        assert!(!dir.path().join("p.tmp").exists());
    }

    #[test]
    fn change_rejects_non_empty_target() {
        let (root, data) = base_with_data();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("keep.txt"), b"keep").unwrap();
        let err = change(
            root.path(),
            &data,
            outside.path(),
            Some("x"),
            &Progress::default(),
        )
        .unwrap_err();
        assert_eq!(err, Failure::new(NOT_EMPTY));
        assert_eq!(fs::read(outside.path().join("keep.txt")).unwrap(), b"keep");
        assert!(data.join("data.db").exists());
        assert!(!root.path().join(POINTER).exists());
    }

    #[test]
    fn cancel_discards_copy_and_keeps_old() {
        let (root, data) = base_with_data();
        let outside = tempfile::tempdir().unwrap();
        // 已存在的空目录只清空，不删除
        let progress = Progress::default();
        progress.cancel.store(1, Ordering::Relaxed);
        let err = change(root.path(), &data, outside.path(), Some("x"), &progress).unwrap_err();
        assert_eq!(err, Failure::cancelled());
        assert!(outside.path().is_dir());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
        assert!(data.join("images").join("ab").join("x.png").exists());
        assert!(!root.path().join(POINTER).exists());
        // 本次新建的多层目录全部删除，原本就有的上级保留
        let progress = Progress::default();
        progress.cancel.store(1, Ordering::Relaxed);
        let deep = outside.path().join("a").join("b").join("新数据");
        assert_eq!(
            change(root.path(), &data, &deep, Some("x"), &progress).unwrap_err(),
            Failure::cancelled()
        );
        assert!(!outside.path().join("a").exists());
        assert!(outside.path().is_dir());
    }

    /// 某个文件被独占打开无法读取：删除已复制的内容，原目录和指向文件保持不动
    #[cfg(windows)]
    #[test]
    fn copy_failure_keeps_old_data() {
        use std::os::windows::fs::OpenOptionsExt;

        let (root, data) = base_with_data();
        let old = root.path().join("old");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("data.db"), b"old").unwrap();
        fs::write(old.join("z.bin"), b"locked").unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(old.join("z.bin"))
            .unwrap();
        let outside = tempfile::tempdir().unwrap();
        let new = outside.path().join("新数据");
        let err = change(root.path(), &old, &new, Some("x"), &Progress::default())
            .unwrap_err()
            .reason
            .unwrap();
        drop(lock);
        assert!(err.contains("z.bin"), "{err}");
        assert!(!err.contains(r"\\?\"), "{err}");
        assert!(!new.exists());
        assert_eq!(fs::read(old.join("data.db")).unwrap(), b"old");
        assert_eq!(fs::read(old.join("z.bin")).unwrap(), b"locked");
        assert!(!root.path().join(POINTER).exists());
        assert!(data.exists());
    }

    /// 等待旧进程时取消、旧进程不存在时直接继续
    #[cfg(windows)]
    #[test]
    fn wait_previous_honors_cancel() {
        let dir = tempfile::tempdir().unwrap();
        let progress = Progress::default();
        assert_eq!(wait_previous(None, dir.path(), &progress), Ok(()));
        // 当前进程不会退出：取消后立即返回
        progress.cancel.store(1, Ordering::Relaxed);
        assert_eq!(
            wait_previous(Some(std::process::id()), dir.path(), &progress),
            Err(Failure::cancelled())
        );
        // lockfile 被占用且已取消
        use std::os::windows::fs::OpenOptionsExt;
        let lockfile = dir.path().join("webview").join("EBWebView");
        fs::create_dir_all(&lockfile).unwrap();
        let held = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .share_mode(0)
            .open(lockfile.join("lockfile"))
            .unwrap();
        assert_eq!(
            wait_previous(None, dir.path(), &progress),
            Err(Failure::cancelled())
        );
        drop(held);
        assert_eq!(
            wait_previous(None, dir.path(), &Progress::default()),
            Ok(())
        );
    }

    /// 上次迁移中途意外退出：按启动时指向文件的原始内容判断是否已完成，不重复迁移，标记清理
    #[test]
    fn startup_reports_interrupted_migration() {
        let (root, data) = base_with_data();
        let base = root.path();
        let outside = tempfile::tempdir().unwrap();
        let new = outside.path().join("新数据");
        let running = format!(
            "{}\n{}\n1\n{}",
            data.display(),
            new.display(),
            pointer_text(base, &new, false).unwrap()
        );
        let mut never = |_: &Problem| -> Choice { panic!("不应询问") };

        // 指向文件还没写：副本可以删除
        fs::write(base.join(RUNNING), &running).unwrap();
        let (dir, notices) = startup(base, &none(), &mut never);
        let notice = notices.into_iter().last();
        assert_eq!(dir, data);
        assert!(all_text(&notice.unwrap()).contains("可以删除"));
        assert!(!base.join(RUNNING).exists());

        // 指向文件已写好、新目录可用：迁移已完成
        fs::create_dir_all(&new).unwrap();
        write_pointer(base, pointer_text(base, &new, false).as_deref()).unwrap();
        fs::write(base.join(RUNNING), &running).unwrap();
        let (dir, notices) = startup(base, &none(), &mut never);
        let notice = notices.into_iter().last();
        assert_eq!(dir, new);
        assert!(all_text(&notice.unwrap()).contains("已切换到新目录"));
        assert!(data.join("data.db").exists());
        assert!(!base.join(RUNNING).exists() && !base.join(LOCK).exists());

        // 指向文件已写好但新目录无法访问：用户选择改用默认目录后，仍按原始内容判断为已完成，不能提示删除
        fs::remove_dir(&new).unwrap();
        fs::write(base.join(RUNNING), &running).unwrap();
        let mut asked = 0;
        let mut use_default = |problem: &Problem| {
            assert_eq!(*problem, Problem::Missing(new.clone()));
            asked += 1;
            if asked == 1 {
                Choice::Retry
            } else {
                Choice::UseDefault
            }
        };
        let (dir, notices) = startup(base, &none(), &mut use_default);
        assert_eq!(notices[0].title, "已改用默认数据目录");
        assert_eq!(notices[0].paths[0].1, new.display().to_string());
        let notice = notices.into_iter().last();
        assert_eq!(asked, 2);
        assert_eq!(dir, data);
        assert!(!base.join(POINTER).exists());
        let msg = all_text(&notice.unwrap());
        assert!(
            msg.contains("无法访问") && !msg.contains("可以删除"),
            "{msg}"
        );
    }

    fn interrupted_text(base: &Path, dir: &str, pointer: Option<&str>, marker: &str) -> String {
        let pointer = Ok(pointer.map(str::to_string));
        all_text(&interrupted(base, Path::new(dir), &pointer, marker).unwrap())
    }

    /// 是否已写好只看指向文件原文与标记第 4 行是否完全相同
    #[test]
    fn interrupted_compares_pointer_text() {
        // 同名换盘，原指向文件记录完整路径，复制中途崩溃
        let base = Path::new(r"C:\Apps\GIP");
        let marker = "D:\\GIP 数据\nE:\\GIP 数据\n1\nE:\\GIP 数据";
        let msg = interrupted_text(base, r"D:\GIP 数据", Some(r"D:\GIP 数据"), marker);
        assert!(
            msg.contains("数据仍在原目录") && !msg.contains("已切换到新目录"),
            "{msg}"
        );
        let msg = interrupted_text(base, r"E:\GIP 数据", Some(r"E:\GIP 数据"), marker);
        assert!(msg.contains("已切换到新目录"), "{msg}");

        // 同名换盘，原目录与安装目录同盘、指向文件省略盘符，复制中途崩溃
        let base = Path::new(r"D:\Apps\GIP");
        let msg = interrupted_text(base, r"D:\GIP 数据", Some(r"\GIP 数据"), marker);
        assert!(
            msg.contains("数据仍在原目录") && !msg.contains("已切换到新目录"),
            "{msg}"
        );

        // U 盘：迁移时是 E:，指向文件省略盘符；完成后再启动时 U 盘变成 F:
        let marker = "E:\\old\nE:\\GIP 数据\n1\n\\GIP 数据";
        let base = Path::new(r"F:\Apps\GIP");
        let msg = interrupted_text(base, r"F:\GIP 数据", Some(r"\GIP 数据"), marker);
        assert!(msg.contains("已切换到新目录"), "{msg}");
        // 已写好但这次没用上新目录（例如选了改用默认目录）：不能提示删除原目录
        let msg = interrupted_text(base, r"F:\Apps\GIP\data", Some(r"\GIP 数据"), marker);
        assert!(
            msg.contains("无法访问") && !msg.contains("可以删除"),
            "{msg}"
        );

        // 迁到默认目录：完成后指向文件已删除；未完成时指向文件仍是原目录
        let default = default_dir(base).display().to_string();
        let marker = "F:\\old\n".to_string() + &default + "\n1\n";
        let msg = interrupted_text(base, &default, None, &marker);
        assert!(msg.contains("已切换到新目录"), "{msg}");
        let msg = interrupted_text(base, r"F:\old", Some(r"\old"), &marker);
        assert!(msg.contains("数据仍在原目录"), "{msg}");

        // 旧格式（没有第 4 行）和指向文件读取失败：无法确定
        let msg = interrupted_text(base, r"F:\old", Some(r"\old"), "F:\\old\nE:\\new\n1");
        assert!(msg.contains("无法确定"), "{msg}");
        let failed: io::Result<Option<String>> = Err(io::Error::other("x"));
        let notice = interrupted(base, Path::new(r"F:\old"), &failed, &marker).unwrap();
        assert!(all_text(&notice).contains("无法确定"));
    }

    /// 指向文件读取失败时，提示中不显示空的原数据目录
    #[test]
    fn startup_hides_empty_recorded_dir() {
        let (root, data) = base_with_data();
        let base = root.path();
        fs::create_dir_all(base.join(POINTER)).unwrap();
        let (dir, notices) = startup(base, &none(), &mut |_: &Problem| Choice::Skip);
        assert_eq!(dir, data);
        assert_eq!(notices[0].paths.len(), 1);
        assert_eq!(notices[0].paths[0].0, "默认目录");
    }

    /// 指向的目录无法使用时：Skip 本次用默认目录但保留指向文件
    #[test]
    fn startup_skip_keeps_pointer() {
        let (root, data) = base_with_data();
        let base = root.path();
        fs::write(
            base.join(POINTER),
            base.join("x").join("missing").display().to_string(),
        )
        .unwrap();
        let (dir, notices) = startup(base, &none(), &mut |_: &Problem| Choice::Skip);
        assert_eq!(dir, data);
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].title, "本次使用默认数据目录");
        assert!(base.join(POINTER).exists());
    }

    /// 3 行旧格式以换行结尾：空的第 4 行不能当作删除指向文件，迁移后指向文件必须指向新目录
    #[test]
    fn run_pending_old_marker_with_trailing_newline() {
        let (root, data) = base_with_data();
        let base = root.path();
        let outside = tempfile::tempdir().unwrap();
        let new = outside.path().join("新数据");
        let marker = format!("{}\n{}\n0\n", data.display(), new.display());
        fs::write(base.join(PENDING), &marker).unwrap();
        let (dir, notice) = run_pending(base, &data);
        assert_eq!(dir, new);
        assert_eq!(notice.unwrap().kind, "success");
        assert!(base.join(POINTER).exists());
        assert_eq!(resolve(base, &none()), Ok(new.clone()));
        // 中断判断：空的第 4 行而新目录不是默认目录，指向文件不存在时不能判为已写好
        let pointer: io::Result<Option<String>> = Ok(None);
        let notice = interrupted(base, &data, &pointer, &marker).unwrap();
        assert!(all_text(&notice).contains("数据仍在原目录"));
    }

    /// 启动时执行待迁移的更改：成功后切换；原目录与标记不符时取消；标记文件都会清理
    #[test]
    fn run_pending_switches_or_keeps() {
        let (root, data) = base_with_data();
        let base = root.path();
        let outside = tempfile::tempdir().unwrap();
        let new = outside.path().join("新数据");
        let other = outside.path().join("other");
        fs::write(
            base.join(PENDING),
            format!("{}\n{}\n", other.display(), new.display()),
        )
        .unwrap();
        let (dir, notice) = run_pending(base, &data);
        assert_eq!(dir, data);
        let notice = notice.unwrap();
        assert!(all_text(&notice).contains("数据仍在原目录"));
        assert_eq!(notice.paths.len(), 2);
        assert!(!new.exists());
        assert!(!base.join(PENDING).exists() && !base.join(RUNNING).exists());

        fs::write(
            base.join(PENDING),
            format!(
                "{}\n{}\n0\n{}",
                data.display(),
                new.display(),
                pointer_text(base, &new, false).unwrap()
            ),
        )
        .unwrap();
        let (dir, notice) = run_pending(base, &data);
        assert_eq!(dir, new);
        assert_eq!(notice.unwrap().kind, "success");
        assert!(!data.exists());
        assert_eq!(resolve(base, &none()), Ok(new));
        assert!(!base.join(PENDING).exists() && !base.join(RUNNING).exists());
    }
}
