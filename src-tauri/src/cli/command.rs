//! 命令行程序 `gpt-image-playground-cli`（安装为 `bin\gpt-image-playground.exe`，见 `src/bin/cli.rs`）：解析参数，
//! 连接正在运行的应用（见 `pipe`），发出与界面相同的操作，再输出给人看的文本或 `--json`。应用没有运行时直接失败。
//! - 每条命令一个管道连接，用完即退出；生图提交后先在 stderr 输出任务 ID，等到全部任务结束才返回，中途被中断时任务照常在应用中完成。
//! - 本机文件在这里处理：`--image` 的路径（相对路径按当前目录）读成 data URL 再交给应用；
//!   结果图片本来就是应用数据目录中的文件，应用返回其路径，`--output` 再复制一份到指定目录。
//! - `--json` 输出一行 JSON，非 ASCII 字符转义为 \uXXXX，在任何代码页的终端中读取都不会乱码；出错时原因一律写在 stderr。
//! - 退出码：0 成功，1 应用返回错误或连不上应用，2 用法错误。
use std::ffi::OsString;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use base64::Engine;
use serde_json::{json, Map, Value};

const USAGE: &str = "用法：
  gpt-image-playground generate <提示词> [--prompt <提示词>]… [--image <图片>]… [--size <尺寸>]
                                [--quality <质量>] [--complexity auto|low|medium|high] [-n <数量>]
                                [--format png|jpeg|webp|svg|gif] [--frames <2-16>] [--frame-duration <20-2000>]
                                [--compression <0-100>] [--moderation auto|low] [--transparent] [--output <目录>] [--json]
  gpt-image-playground history [<任务 ID>…] [--limit <数量>] [--offset <数量>] [--json]
  gpt-image-playground image <图片 ID 或任务 ID> [--output <目录>] [--json]
  gpt-image-playground settings [--json]                  设置、生图参数、API 配置、自定义服务商与代理
  gpt-image-playground settings set <键> <值> [--json]
  gpt-image-playground profile use <配置 ID> [--json]      切换启用的 API 配置
  gpt-image-playground profile save <JSON> [--id <配置 ID>] [--activate | --no-activate] [--json]
  gpt-image-playground profile delete <配置 ID> [--json]
  gpt-image-playground provider save <JSON> [--id <服务商 ID>] [--json]
  gpt-image-playground provider delete <服务商 ID> [--json]

  用正在运行的 GPT Image Playground 生图、查看历史记录、查看和修改设置，效果与在应用里操作相同；应用需要保持打开。
  generate 用应用启用的 API 配置生图，提交后先输出任务 ID，全部任务结束后输出图片文件的路径；给出的参数会保存为应用的参数。
  多个 --prompt 按应用的批量提交方式一起提交。--image 为参考图：本机图片路径或历史记录中的图片 ID，可重复，最多 16 张。
  质量：auto、low、medium、high、xhigh、max。--output 把结果图片另外复制到该目录。history 给出任务 ID 时只列出这些任务。
  settings set 的键：设置项名，params.<参数名>，proxy.mode、proxy.url；值按 JSON 解析，不是 JSON 时当作字符串。
  <JSON> 为 API 配置或服务商的字段，写 - 时从标准输入读取。profile save 不带 --id 时新建，新建的配置默认启用。
  --json 输出 JSON（非 ASCII 字符转义为 \\uXXXX）。
  退出码：0 成功，1 出错，2 用法错误。";

#[derive(Debug, PartialEq)]
pub struct Command {
    /// 应用一侧的操作名，见 `src/lib/cliBridge.ts`
    pub tool: &'static str,
    pub arguments: Map<String, Value>,
    pub json: bool,
    pub output: Option<PathBuf>,
}

/// 历史记录里的图片 id 是 64 位十六进制的 SHA-256
fn is_image_id(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_hexdigit())
}

fn text(v: OsString, what: &str) -> Result<String, String> {
    v.into_string().map_err(|_| format!("{what} 含有无法识别的字符"))
}

/// `-` 从标准输入读取，其余按 JSON 解析为对象
fn read_object(arg: String, read_stdin: impl FnOnce() -> io::Result<String>) -> Result<Value, String> {
    let raw = if arg == "-" { read_stdin().map_err(|err| format!("读取标准输入失败：{err}"))? } else { arg };
    match serde_json::from_str::<Value>(raw.trim_start_matches('\u{feff}')) {
        Ok(v) if v.is_object() => Ok(v),
        Ok(_) => Err("<JSON> 应为一个对象".into()),
        Err(err) => Err(format!("<JSON> 无法解析：{err}")),
    }
}

/// 参考图：本机路径（相对路径按当前目录）读成 data URL，图片 ID 原样交给应用
fn reference_image(item: &str, cwd: &Path) -> Result<Value, String> {
    if is_image_id(item) || item.starts_with("data:") {
        return Ok(Value::String(item.into()));
    }
    let path = cwd.join(item);
    let mime = match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => return Err(format!("不支持的参考图格式（需要 png、jpg、webp 或 gif）：{item}")),
    };
    let bytes = std::fs::read(&path).map_err(|err| format!("读取参考图 {} 失败：{err}", path.display()))?;
    Ok(Value::String(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))))
}

fn need(words: &mut impl Iterator<Item = String>, what: &str) -> Result<String, String> {
    words.next().ok_or_else(|| format!("缺少{what}"))
}

/// 解析参数；`args` 不含程序名
pub fn parse(
    args: impl IntoIterator<Item = OsString>,
    cwd: &Path,
    read_stdin: impl FnOnce() -> io::Result<String>,
) -> Result<Command, String> {
    let mut args = args.into_iter();
    let cmd = args.next().map(|a| text(a, "命令")).transpose()?.unwrap_or_default();
    let mut words = Vec::new();
    let mut opts: Vec<(String, Option<OsString>)> = Vec::new();
    let mut json = false;
    const FLAGS: [&str; 3] = ["--transparent", "--activate", "--no-activate"];
    while let Some(arg) = args.next() {
        let flag = arg.to_string_lossy().into_owned();
        if flag == "--json" {
            json = true;
        } else if FLAGS.contains(&flag.as_str()) {
            opts.push((flag, None));
        } else if flag.starts_with("--") || flag == "-n" {
            let value = args.next().ok_or_else(|| format!("{flag} 后面缺少值"))?;
            opts.push((flag, Some(value)));
        } else {
            words.push(text(arg, "参数")?);
        }
    }
    let allowed: &[&str] = match (cmd.as_str(), words.first().map(String::as_str)) {
        ("generate", _) => &[
            "--prompt", "--image", "--size", "--quality", "--complexity", "-n", "--format", "--frames", "--frame-duration", "--compression",
            "--moderation", "--transparent", "--output",
        ],
        ("history", _) => &["--limit", "--offset"],
        ("image", _) => &["--output"],
        ("profile", Some("save")) => &["--id", "--activate", "--no-activate"],
        ("provider", Some("save")) => &["--id"],
        _ => &[],
    };
    if let Some((flag, _)) = opts.iter().find(|(flag, _)| !allowed.contains(&flag.as_str())) {
        return Err(format!("无法识别的参数：{flag}"));
    }

    let mut a = Map::new();
    let mut output = None;
    let mut prompts = Vec::new();
    let mut images = Vec::new();
    let int = |flag: &str, v: &str, min: i64, max: i64| {
        v.parse::<i64>()
            .ok()
            .filter(|n| (min..=max).contains(n))
            .ok_or_else(|| format!("{flag} 应为 {min}–{max} 的整数"))
    };
    for (flag, value) in opts {
        let Some(value) = value else {
            match flag.as_str() {
                "--transparent" => a.insert("transparent_output".into(), true.into()),
                "--activate" => a.insert("activate".into(), true.into()),
                _ => a.insert("activate".into(), false.into()),
            };
            continue;
        };
        if flag == "--output" {
            output = Some(cwd.join(value));
            continue;
        }
        let value = text(value, &flag)?;
        let (key, value): (&str, Value) = match flag.as_str() {
            "--prompt" => {
                prompts.push(value);
                continue;
            }
            "--image" => {
                images.push(reference_image(&value, cwd)?);
                continue;
            }
            "--size" => ("size", value.into()),
            "--quality" => ("quality", value.into()),
            "--complexity" => ("complexity", value.into()),
            "--frames" => ("frame_count", int(&flag, &value, 2, 16)?.into()),
            "--frame-duration" => ("frame_duration_ms", int(&flag, &value, 20, 2000)?.into()),
            "-n" => ("n", int(&flag, &value, 1, 100)?.into()),
            "--format" => ("output_format", value.into()),
            "--compression" => ("output_compression", int(&flag, &value, 0, 100)?.into()),
            "--moderation" => ("moderation", value.into()),
            "--limit" => ("limit", int(&flag, &value, 1, 50)?.into()),
            "--offset" => ("offset", int(&flag, &value, 0, i64::MAX)?.into()),
            _ => ("id", value.into()),
        };
        a.insert(key.into(), value);
    }

    let mut words = words.into_iter();
    let tool = match cmd.as_str() {
        "generate" => {
            let first = (words.len() > 0).then(|| words.by_ref().collect::<Vec<_>>().join(" "));
            let prompts: Vec<_> = first.into_iter().chain(prompts).filter(|p| !p.trim().is_empty()).collect();
            if prompts.is_empty() {
                return Err("请给出提示词".into());
            }
            a.insert("prompts".into(), prompts.into());
            if !images.is_empty() {
                a.insert("reference_images".into(), images.into());
            }
            "generate_image"
        }
        "history" => {
            let ids: Vec<String> = words.by_ref().collect();
            if !ids.is_empty() {
                a.insert("task_ids".into(), ids.into());
            }
            "list_history"
        }
        "image" => {
            let id = need(&mut words, "图片 ID 或任务 ID")?;
            a.insert(if is_image_id(&id) { "image_id" } else { "task_id" }.into(), id.into());
            "get_image"
        }
        "settings" => match words.next().as_deref() {
            None => "get_settings",
            Some("set") => {
                let key = need(&mut words, "设置项的键")?;
                let raw = need(&mut words, "设置项的值")?;
                let value = serde_json::from_str(&raw).unwrap_or(Value::String(raw));
                let (group, key) = match key.split_once('.') {
                    Some(("params", k)) => ("params", k.to_string()),
                    Some(("proxy", k)) => ("proxy", k.to_string()),
                    _ => ("settings", key),
                };
                a.insert(group.into(), json!({ key: value }));
                "update_settings"
            }
            Some(other) => return Err(format!("无法识别的参数：{other}")),
        },
        "profile" | "provider" => {
            let action = need(&mut words, "操作（save、delete 等）")?;
            match (cmd.as_str(), action.as_str()) {
                ("profile", "use") => {
                    a.insert("active_profile_id".into(), need(&mut words, "配置 ID")?.into());
                    "update_settings"
                }
                (_, "save") => {
                    let body = read_object(need(&mut words, "<JSON>")?, read_stdin)?;
                    a.insert(if cmd == "profile" { "profile" } else { "provider" }.into(), body);
                    if cmd == "profile" { "save_api_profile" } else { "save_custom_provider" }
                }
                (_, "delete") => {
                    a.insert("id".into(), need(&mut words, "ID")?.into());
                    if cmd == "profile" { "delete_api_profile" } else { "delete_custom_provider" }
                }
                _ => return Err(format!("无法识别的操作：{cmd} {action}")),
            }
        }
        "" => return Err("请给出命令".into()),
        _ => return Err(format!("无法识别的命令：{cmd}")),
    };
    if let Some(extra) = words.next() {
        return Err(format!("多余的参数：{extra}"));
    }
    Ok(Command { tool, arguments: a, json, output })
}

/// 把 `\u{80}` 以上的字符写成 `\uXXXX`（超出基本平面的写成代理对）
fn ascii_json(value: &Value) -> String {
    let mut out = String::new();
    for c in value.to_string().chars() {
        if c.is_ascii() {
            out.push(c);
            continue;
        }
        let mut buf = [0u16; 2];
        for unit in c.encode_utf16(&mut buf) {
            out.push_str(&format!("\\u{unit:04x}"));
        }
    }
    out
}

/// 输出到 stdout；读取方先关闭管道时按正常结束处理
fn emit(text: &str) {
    let mut out = io::stdout().lock();
    let _ = writeln!(out, "{text}").and_then(|()| out.flush());
}

#[cfg(windows)]
async fn forward(tool: &str, args: &Map<String, Value>) -> Result<Value, String> {
    use std::io::ErrorKind;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let pipe = match super::pipe::open().await {
        Ok(pipe) => pipe,
        Err(err) if err.kind() == ErrorKind::NotFound => {
            return Err("GPT Image Playground 没有运行，请先打开应用再重试".into());
        }
        Err(err) => return Err(format!("无法连接 GPT Image Playground：{err}")),
    };
    let (read, mut write) = tokio::io::split(pipe);
    let mut request = json!({ "tool": tool, "arguments": args }).to_string().into_bytes();
    request.push(b'\n');
    write.write_all(&request).await.map_err(|err| format!("发送命令失败：{err}"))?;
    let mut read = BufReader::new(read);
    loop {
        let mut line = Vec::new();
        read.read_until(b'\n', &mut line).await.map_err(|err| format!("读取应用的回复失败：{err}"))?;
        if line.is_empty() {
            return Err("应用没有回复就断开了连接，可能已经退出".into());
        }
        let reply: Value = serde_json::from_slice(&line).map_err(|err| format!("应用的回复无法识别：{err}"))?;
        // 进度写到 stderr，stdout 只留最终结果（--json 时为一行 JSON）
        if let Some(text) = reply["progress"].as_str() {
            eprintln!("{text}");
            continue;
        }
        return match reply["error"].as_str() {
            Some(message) => Err(message.into()),
            None => Ok(reply),
        };
    }
}

#[cfg(not(windows))]
async fn forward(_tool: &str, _args: &Map<String, Value>) -> Result<Value, String> {
    Err("命令行只在 Windows 客户端中提供".into())
}

/// 把应用数据目录中的图片复制到 `dir`，按应用给出的文件名（`task-<任务 ID>-01.png` 等）命名，返回复制后的路径
fn copy_files(dir: &Path, files: &[Value]) -> Result<Vec<String>, String> {
    std::fs::create_dir_all(dir).map_err(|err| format!("无法创建目录 {}：{err}", dir.display()))?;
    files
        .iter()
        .filter_map(|f| Some((f["path"].as_str()?, f["name"].as_str()?)))
        .map(|(file, name)| {
            let from = Path::new(file);
            let to = dir.join(name);
            std::fs::copy(from, &to).map_err(|err| format!("复制 {file} 到 {} 失败：{err}", to.display()))?;
            Ok(to.to_string_lossy().into_owned())
        })
        .collect()
}

pub fn run() -> ExitCode {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    if args.is_empty() || args.iter().any(|a| a == "-h" || a == "--help") {
        emit(USAGE);
        return if args.is_empty() { ExitCode::from(2) } else { ExitCode::SUCCESS };
    }
    if args[0] == "--version" {
        emit(env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    let cwd = std::env::current_dir().unwrap_or_default();
    let cmd = match parse(args, &cwd, || io::read_to_string(io::stdin().lock())) {
        Ok(cmd) => cmd,
        Err(message) => {
            eprintln!("{message}。用法见 gpt-image-playground --help");
            return ExitCode::from(2);
        }
    };
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(err) => {
            eprintln!("无法启动异步运行时：{err}");
            return ExitCode::from(1);
        }
    };
    let reply = runtime.block_on(forward(cmd.tool, &cmd.arguments)).and_then(|mut reply| {
        if let Some(dir) = &cmd.output {
            let files = reply["files"].as_array().cloned().unwrap_or_default();
            let copied = copy_files(dir, &files)?;
            reply["data"]["copied"] = copied.clone().into();
            let text = reply["text"].as_str().unwrap_or_default().to_string();
            let lines: Vec<_> = copied.iter().map(|p| format!("已复制到：{p}")).collect();
            reply["text"] = format!("{text}\n{}", lines.join("\n")).into();
        }
        Ok(reply)
    });
    match reply {
        Ok(reply) if cmd.json => emit(&ascii_json(&reply["data"])),
        Ok(reply) => emit(reply["text"].as_str().unwrap_or_default()),
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::from(1);
        }
    }
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests;
