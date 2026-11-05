use super::*;

fn run_parse(args: &[&str]) -> Result<Command, String> {
    let cwd = std::env::temp_dir();
    parse(args.iter().map(OsString::from), &cwd, || Ok(r#"{"name":"来自标准输入"}"#.into()))
}

#[test]
fn generate_joins_words_and_collects_prompts() {
    let cmd = run_parse(&["generate", "一只", "猫", "--prompt", "一只狗", "--size", "1024x1024", "-n", "2", "--transparent", "--json"]).unwrap();
    assert_eq!(cmd.tool, "generate_image");
    assert!(cmd.json);
    assert_eq!(cmd.arguments["prompts"], json!(["一只 猫", "一只狗"]));
    assert_eq!(cmd.arguments["size"], "1024x1024");
    assert_eq!(cmd.arguments["n"], 2);
    assert_eq!(cmd.arguments["transparent_output"], true);

    let cmd = run_parse(&["generate", "--prompt", "a", "--prompt", "b"]).unwrap();
    assert_eq!(cmd.arguments["prompts"], json!(["a", "b"]));
    assert!(run_parse(&["generate"]).is_err());
}

#[test]
fn generate_parses_complexity_and_gif_flags() {
    let cmd = run_parse(&["generate", "x", "--complexity", "low", "--format", "gif", "--frames", "4", "--frame-duration", "120"]).unwrap();
    assert_eq!(cmd.arguments["complexity"], "low");
    assert_eq!(cmd.arguments["output_format"], "gif");
    assert_eq!(cmd.arguments["frame_count"], 4);
    assert_eq!(cmd.arguments["frame_duration_ms"], 120);
    assert!(run_parse(&["generate", "x", "--frames", "17"]).is_err());
    assert!(run_parse(&["generate", "x", "--frame-duration", "10"]).is_err());
}

#[test]
fn reference_images_are_read_relative_to_cwd() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("ref.png"), [1u8, 2, 3]).unwrap();
    let id = "a".repeat(64);
    let cmd = parse(
        ["generate", "x", "--image", "ref.png", "--image", &id].iter().map(OsString::from),
        dir.path(),
        || unreachable!(),
    )
    .unwrap();
    assert_eq!(cmd.arguments["reference_images"], json!(["data:image/png;base64,AQID", id]));
    assert!(parse(["generate", "x", "--image", "a.bmp"].iter().map(OsString::from), dir.path(), || unreachable!()).is_err());
    assert!(parse(["generate", "x", "--image", "missing.png"].iter().map(OsString::from), dir.path(), || unreachable!()).is_err());
}

#[test]
fn output_is_resolved_against_cwd() {
    let cwd = std::env::temp_dir();
    let cmd = run_parse(&["image", &"b".repeat(64), "--output", "out"]).unwrap();
    assert_eq!(cmd.output, Some(cwd.join("out")));
    assert_eq!(cmd.arguments["image_id"], "b".repeat(64));
    let cmd = run_parse(&["image", "task-1"]).unwrap();
    assert_eq!(cmd.arguments["task_id"], "task-1");
}

#[test]
fn settings_set_groups_keys_and_parses_values() {
    let cmd = run_parse(&["settings", "set", "params.quality", "low"]).unwrap();
    assert_eq!(cmd.tool, "update_settings");
    assert_eq!(cmd.arguments["params"], json!({ "quality": "low" }));
    let cmd = run_parse(&["settings", "set", "batchPromptConcurrency", "3"]).unwrap();
    assert_eq!(cmd.arguments["settings"], json!({ "batchPromptConcurrency": 3 }));
    let cmd = run_parse(&["settings", "set", "proxy.mode", "none"]).unwrap();
    assert_eq!(cmd.arguments["proxy"], json!({ "mode": "none" }));
    assert_eq!(run_parse(&["settings"]).unwrap().tool, "get_settings");
    assert!(run_parse(&["settings", "set", "x"]).is_err());
}

#[test]
fn profile_and_provider_commands() {
    let cmd = run_parse(&["profile", "save", r#"{"name":"新"}"#, "--id", "p1", "--no-activate"]).unwrap();
    assert_eq!(cmd.tool, "save_api_profile");
    assert_eq!(cmd.arguments["profile"], json!({ "name": "新" }));
    assert_eq!(cmd.arguments["id"], "p1");
    assert_eq!(cmd.arguments["activate"], false);
    let cmd = run_parse(&["provider", "save", "-"]).unwrap();
    assert_eq!(cmd.arguments["provider"], json!({ "name": "来自标准输入" }));
    let cmd = run_parse(&["profile", "use", "p2"]).unwrap();
    assert_eq!(cmd.arguments["active_profile_id"], "p2");
    assert_eq!(run_parse(&["provider", "delete", "c1"]).unwrap().tool, "delete_custom_provider");
    assert!(run_parse(&["profile", "save", "[1]"]).is_err());
    assert!(run_parse(&["profile", "rename", "x"]).is_err());
}

#[test]
fn rejects_unknown_or_misplaced_options() {
    assert!(run_parse(&["history", "--size", "1"]).is_err());
    assert!(run_parse(&["history", "--limit", "0"]).is_err());
    assert_eq!(run_parse(&["history", "t1", "t2"]).unwrap().arguments["task_ids"], json!(["t1", "t2"]));
    assert!(run_parse(&["generate", "x", "--size"]).is_err());
    assert!(run_parse(&["draw", "x"]).is_err());
}

#[test]
fn ascii_json_escapes_non_ascii() {
    let value = json!({ "t": "猫🐱" });
    let out = ascii_json(&value);
    assert!(out.is_ascii());
    assert_eq!(serde_json::from_str::<Value>(&out).unwrap(), value);
}
