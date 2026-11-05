use super::*;

#[test]
fn skill_copy_compare_and_ownership() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    fs::create_dir_all(src.join("references")).unwrap();
    fs::write(src.join("SKILL.md"), "---\nname: gpt-image-playground\n---\n").unwrap();
    fs::write(src.join("references").join("settings.md"), "a").unwrap();

    let dst = tmp.path().join("dst");
    copy_dir(&src, &dst).unwrap();
    assert!(is_ours(&dst));
    assert!(same_files(&src, &dst).unwrap());
    fs::write(src.join("references").join("settings.md"), "b").unwrap();
    assert!(!same_files(&src, &dst).unwrap());

    let other = tmp.path().join("other");
    fs::create_dir_all(&other).unwrap();
    fs::write(other.join("SKILL.md"), "---\nname: something\n---\n").unwrap();
    assert!(!is_ours(&other));
}

#[test]
fn skill_replace_keeps_old_copy_on_failure() {
    let tmp = tempfile::tempdir().unwrap();
    let skills = tmp.path().join(".claude").join("skills");
    let dst = skills.join(NAME);
    let src = tmp.path().join("src");
    fs::create_dir_all(&src).unwrap();
    fs::write(src.join("SKILL.md"), "new").unwrap();
    fs::create_dir_all(&dst).unwrap();
    fs::write(dst.join("SKILL.md"), "old").unwrap();

    replace_dir(&src, &dst).unwrap();
    assert_eq!(fs::read_to_string(dst.join("SKILL.md")).unwrap(), "new");
    // 临时文件夹不留在 skills 目录中
    assert_eq!(fs::read_dir(&skills).unwrap().count(), 1);
    assert_eq!(fs::read_dir(tmp.path().join(".claude")).unwrap().count(), 1);

    // 复制失败时保留原有的 Skill
    assert!(replace_dir(&tmp.path().join("missing"), &dst).is_err());
    assert_eq!(fs::read_to_string(dst.join("SKILL.md")).unwrap(), "new");
    assert_eq!(fs::read_dir(tmp.path().join(".claude")).unwrap().count(), 1);
}

#[test]
fn skill_replace_restores_interrupted_backup() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().join(".claude");
    let dst = base.join("skills").join(NAME);
    fs::create_dir_all(dst.parent().unwrap()).unwrap();
    // 上次替换中断：正式文件夹已改名为备份，新版未就位
    let old = base.join(format!(".{NAME}-skill-old"));
    fs::create_dir_all(&old).unwrap();
    fs::write(old.join("SKILL.md"), "old").unwrap();

    let src = tmp.path().join("src");
    fs::create_dir_all(&src).unwrap();
    fs::write(src.join("SKILL.md"), "---\nname: gpt-image-playground\n---\n").unwrap();
    // 正式文件夹不在但有备份时按需要更新处理，启动时会自动恢复
    assert_eq!(dir_state(&src, &dst), State::Outdated);

    // 这次复制也失败时，备份恢复为正式文件夹
    assert!(replace_dir(&tmp.path().join("missing"), &dst).is_err());
    assert_eq!(fs::read_to_string(dst.join("SKILL.md")).unwrap(), "old");
    assert!(!old.exists());
}

#[test]
fn skill_swap_dirs_follow_real_skills_location() {
    let tmp = tempfile::tempdir().unwrap();
    let skills = tmp.path().join(".claude").join("skills");
    fs::create_dir_all(&skills).unwrap();
    let (new, old) = swap_dirs(&skills.join(NAME)).unwrap();
    let base = fs::canonicalize(&skills).unwrap().parent().unwrap().to_path_buf();
    assert_eq!(new.parent(), Some(base.as_path()));
    assert_eq!(old.parent(), Some(base.as_path()));
    // skills 文件夹还不存在时没有临时文件夹可用
    assert!(swap_dirs(&tmp.path().join(".agents").join("skills").join(NAME)).is_err());
}
