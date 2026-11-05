//! 设置“Skill”页的命令：把随安装包附带的 Skill 安装到 AI 工具读取 Skill 的目录。
//! - 复制到 `~\.claude\skills\gpt-image-playground`（Claude Code）或 `~\.agents\skills\gpt-image-playground`
//!   （Codex 等；Cursor、VS Code、OpenCode 两处都读）。目标文件夹的 SKILL.md 不是本应用的时不覆盖、不删除。
//! - 安装包中的 Skill 在资源目录下的 `skills\gpt-image-playground`；开发版没有打包资源，直接用仓库中的。
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Skill 的文件夹名
const NAME: &str = "gpt-image-playground";

/// 启动时的自动更新与设置页的操作可能同时进行，安装和移除依次执行，避免争用同名的临时文件夹
static EDIT_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillTarget {
    /// `~\.claude\skills`，Claude Code
    Claude,
    /// `~\.agents\skills`，Codex 等
    Agents,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum State {
    /// 找不到用户文件夹
    NotFound,
    /// 还没有安装
    Absent,
    /// 已安装，与当前版本一致
    Added,
    /// 已安装，但内容与当前版本不同
    Outdated,
    /// 同名文件夹不是本应用的 Skill
    Invalid,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillStatus {
    id: SkillTarget,
    path: String,
    state: State,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    skill_dir: String,
    skills: Vec<SkillStatus>,
}

fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).filter(|v| !v.is_empty()).map(PathBuf::from)
}

fn bundled_skill(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("src-tauri 在仓库根目录下");
        return Ok(repo.join("skills").join(NAME));
    }
    let res = app.path().resource_dir().map_err(|err| {
        log::warn!("无法取得资源目录：{err}");
        "找不到 Skill 所在的目录，请重新安装 GPT Image Playground".to_string()
    })?;
    Ok(res.join("skills").join(NAME))
}

fn skill_path(target: SkillTarget) -> Option<PathBuf> {
    let parent = match target {
        SkillTarget::Claude => ".claude",
        SkillTarget::Agents => ".agents",
    };
    Some(home()?.join(parent).join("skills").join(NAME))
}

/// 文件夹中的 SKILL.md 是本应用的，才能覆盖或删除
fn is_ours(dir: &Path) -> bool {
    fs::read_to_string(dir.join("SKILL.md")).is_ok_and(|s| s.lines().any(|l| l.trim() == format!("name: {NAME}")))
}

/// 安装包中的每个文件都在目标中且内容相同
fn same_files(src: &Path, dst: &Path) -> io::Result<bool> {
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        let same = if entry.file_type()?.is_dir() {
            to.is_dir() && same_files(&entry.path(), &to)?
        } else {
            fs::read(entry.path())? == fs::read(&to).unwrap_or_default()
        };
        if !same {
            return Ok(false);
        }
    }
    Ok(true)
}

fn copy_dir(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &to)?;
        } else {
            fs::copy(entry.path(), to)?;
        }
    }
    Ok(())
}

/// 杀毒软件、索引服务等会短暂占用文件，Windows 上改名和删除遇到拒绝访问（5）、共享冲突（32）、锁定冲突（33）时
/// 从 10 ms 起加倍等待重试，总计约 1.3 秒；持续占用时仍返回错误
fn retry<T>(mut op: impl FnMut() -> io::Result<T>) -> io::Result<T> {
    let mut wait = Duration::from_millis(10);
    loop {
        match op() {
            Err(err) if cfg!(windows) && matches!(err.raw_os_error(), Some(5 | 32 | 33)) && wait < Duration::from_secs(1) => {
                std::thread::sleep(wait);
                wait *= 2;
            }
            result => return result,
        }
    }
}

/// 替换时用的临时文件夹和旧版备份。放在 skills 的上一级，避免 AI 工具把它们当成另一个同名 Skill 读取；
/// skills 可能是指向其他磁盘的链接，按真实位置取上一级，保证与 Skill 在同一磁盘、可以直接改名
fn swap_dirs(dst: &Path) -> io::Result<(PathBuf, PathBuf)> {
    let skills = fs::canonicalize(dst.parent().ok_or_else(|| io::Error::other("Skill 目录没有上级文件夹"))?)?;
    let base = skills.parent().ok_or_else(|| io::Error::other("skills 目录没有上级文件夹"))?;
    Ok((base.join(format!(".{NAME}-skill-new")), base.join(format!(".{NAME}-skill-old"))))
}

/// 先完整复制到临时文件夹再替换，任何一步失败都保留原有的 Skill
fn replace_dir(src: &Path, dst: &Path) -> io::Result<()> {
    let (new, old) = swap_dirs(dst)?;
    // 上次替换中断、只剩旧版备份时先改回原名，再清理其余临时文件夹
    if !dst.exists() && old.exists() {
        retry(|| fs::rename(&old, dst))?;
    }
    for dir in [&new, &old] {
        if dir.exists() {
            retry(|| fs::remove_dir_all(dir))?;
        }
    }
    if let Err(err) = copy_dir(src, &new) {
        let _ = retry(|| fs::remove_dir_all(&new));
        return Err(err);
    }
    if dst.exists() {
        if let Err(err) = retry(|| fs::rename(dst, &old)) {
            let _ = retry(|| fs::remove_dir_all(&new));
            return Err(err);
        }
    }
    if let Err(err) = retry(|| fs::rename(&new, dst)) {
        if old.exists() {
            let _ = retry(|| fs::rename(&old, dst));
        }
        let _ = retry(|| fs::remove_dir_all(&new));
        return Err(err);
    }
    if old.exists() {
        if let Err(err) = retry(|| fs::remove_dir_all(&old)) {
            log::warn!("无法删除旧版 Skill {}：{err}", old.display());
        }
    }
    Ok(())
}

fn skill_status(target: SkillTarget, src: &Path) -> SkillStatus {
    let Some(dst) = skill_path(target) else {
        return SkillStatus { id: target, path: String::new(), state: State::NotFound };
    };
    SkillStatus { id: target, path: dst.to_string_lossy().into_owned(), state: dir_state(src, &dst) }
}

fn dir_state(src: &Path, dst: &Path) -> State {
    if !dst.exists() {
        // 上次替换中断、只剩旧版备份时按需要更新处理，启动时的自动更新会恢复并更新它
        let interrupted = swap_dirs(dst).is_ok_and(|(_, old)| old.exists());
        return if interrupted { State::Outdated } else { State::Absent };
    }
    if !is_ours(dst) {
        return State::Invalid;
    }
    match same_files(src, dst) {
        Ok(true) => State::Added,
        Ok(false) => State::Outdated,
        Err(err) => {
            log::warn!("无法比较 Skill {}：{err}", dst.display());
            State::Outdated
        }
    }
}

fn edit_skill(target: SkillTarget, src: &Path, install: bool) -> Result<(), String> {
    let _guard = EDIT_LOCK.lock().unwrap_or_else(|err| err.into_inner());
    let dst = skill_path(target).ok_or("找不到用户文件夹，请手动复制 Skill")?;
    if dst.exists() && !is_ours(&dst) {
        return Err(format!("这个位置已有另一个名为 {NAME} 的 Skill，请先手动处理"));
    }
    let result = if install {
        fs::create_dir_all(dst.parent().expect("skill_path 带有上级目录")).and_then(|_| replace_dir(src, &dst))
    } else {
        // 替换中断留下的备份也一并删除，否则状态仍会显示需要更新；skills 文件夹不存在时没有备份
        let mut dirs = vec![dst.clone()];
        if let Ok((new, old)) = swap_dirs(&dst) {
            dirs.extend([new, old]);
        }
        dirs.iter().filter(|dir| dir.exists()).try_for_each(|dir| retry(|| fs::remove_dir_all(dir)))
    };
    result.map_err(|err| {
        log::warn!("无法{} Skill {}：{err}", if install { "安装" } else { "移除" }, dst.display());
        if install {
            "无法安装 Skill，请稍后重试，或打开 Skill 文件夹手动复制".to_string()
        } else {
            "无法移除 Skill，请稍后重试".to_string()
        }
    })
}

/// 在阻塞线程中执行修改（可为空），再读出最新状态
async fn run(app: AppHandle, edit: impl FnOnce(&Path) -> Result<(), String> + Send + 'static) -> Result<Info, String> {
    let src = bundled_skill(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        edit(&src)?;
        Ok(Info {
            skills: [SkillTarget::Claude, SkillTarget::Agents].iter().map(|&t| skill_status(t, &src)).collect(),
            skill_dir: src.to_string_lossy().into_owned(),
        })
    })
    .await
    .map_err(|err| format!("读取 Skill 的安装状态时出错：{err}"))?
}

#[tauri::command]
pub async fn skill_info(app: AppHandle) -> Result<Info, String> {
    run(app, |_| Ok(())).await
}

#[tauri::command]
pub async fn skill_install(app: AppHandle, target: SkillTarget) -> Result<Info, String> {
    run(app, move |src| edit_skill(target, src, true)).await
}

#[tauri::command]
pub async fn skill_remove(app: AppHandle, target: SkillTarget) -> Result<Info, String> {
    run(app, move |src| edit_skill(target, src, false)).await
}

#[tauri::command]
pub async fn skill_open_dir(app: AppHandle) -> Result<(), String> {
    let dir = bundled_skill(&app)?;
    tauri::async_runtime::spawn_blocking(move || tauri_plugin_opener::open_path(&dir, None::<&str>))
        .await
        .map_err(|err| format!("打开 Skill 文件夹时出错：{err}"))?
        .map_err(|err| {
            log::warn!("无法打开 Skill 文件夹：{err}");
            "无法打开 Skill 所在的文件夹，请重新安装 GPT Image Playground".to_string()
        })
}

#[cfg(test)]
mod tests;
