//! 原图与缩略图：文件保存在 images/、thumbnails/ 下按文件名前两位分桶，元数据存在同名表中
use std::fs::{self, File};
use std::io::{ErrorKind, Write};
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{now_ms, Result, Storage, StorageError};

/// 非 base64 的 dataUrl 按原文保存时使用的 mime，读取时前端原样返回
pub const RAW_DATA_URL_MIME: &str = "text/x-data-url";

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    Image,
    Thumbnail,
}

impl Kind {
    /// 表名与目录名相同
    fn name(self) -> &'static str {
        match self {
            Kind::Image => "images",
            Kind::Thumbnail => "thumbnails",
        }
    }
}

/// 图片元数据；序列化后放在 image_get / thumbnail_get 响应的头部
#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    #[serde(skip)]
    pub id: String,
    pub mime: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    /// 仅原图
    pub source: Option<String>,
    /// 仅原图
    pub created_at: Option<i64>,
    /// 仅缩略图
    pub thumbnail_version: Option<i64>,
}

/// image_stats 的单项
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageStat {
    pub id: String,
    pub bytes: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub thumbnail_bytes: Option<i64>,
    pub thumbnail_version: Option<i64>,
}

/// 文件名（不含扩展名）。只有前端生成的两种 id 格式直接使用：SHA-256（64 位小写十六进制）
/// 和 hashDataUrlFallback 的 fallback-<16 位小写十六进制>。其他 id（例如外部备份中的任意字符串）
/// 改用 h-<sha256>。这样所有文件名和分桶目录都是小写，避免 NTFS 不区分大小写导致的撞名和误删，
/// 也杜绝了路径穿越和 con、nul 等 Windows 保留名
pub fn file_stem(id: &str) -> String {
    let is_hex = |s: &str| {
        s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    let safe = (id.len() == 64 && is_hex(id))
        || id
            .strip_prefix("fallback-")
            .is_some_and(|rest| rest.len() == 16 && is_hex(rest));
    if safe {
        return id.to_string();
    }
    let hash: String = Sha256::digest(id.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("h-{hash}")
}

pub fn ext_for_mime(mime: &str) -> &'static str {
    let base = mime.split(';').next().unwrap_or("").trim();
    match base.to_ascii_lowercase().as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/avif" => "avif",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        RAW_DATA_URL_MIME => "txt",
        _ => "bin",
    }
}

/// 响应格式：4 字节小端 JSON 长度 + 元数据 JSON + 文件内容；不存在时返回空字节
pub fn encode_file(found: Option<(FileMeta, Vec<u8>)>) -> Vec<u8> {
    let Some((meta, bytes)) = found else {
        return Vec::new();
    };
    let json = serde_json::to_vec(&meta).expect("元数据序列化不会失败");
    let mut out = Vec::with_capacity(4 + json.len() + bytes.len());
    out.extend_from_slice(&(json.len() as u32).to_le_bytes());
    out.extend_from_slice(&json);
    out.extend_from_slice(&bytes);
    out
}

fn remove_files(storage: &Storage, files: &[String]) {
    for file in files {
        match fs::remove_file(storage.root.join(file)) {
            Err(err) if err.kind() != ErrorKind::NotFound => {
                log::warn!("删除文件失败 {file}：{err}")
            }
            _ => {}
        }
    }
}

fn query_file(conn: &Connection, kind: Kind, id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        &format!("SELECT file FROM {} WHERE id = ?1", kind.name()),
        [id],
        |row| row.get(0),
    )
    .optional()
}

fn insert_row(conn: &Connection, kind: Kind, meta: &FileMeta, rel: &str, len: usize) -> Result<()> {
    match kind {
        Kind::Image => conn.execute(
            "INSERT OR REPLACE INTO images (id, mime, file, bytes, width, height, source, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                meta.id,
                meta.mime,
                rel,
                len as i64,
                meta.width,
                meta.height,
                meta.source,
                meta.created_at.unwrap_or_else(now_ms)
            ],
        )?,
        Kind::Thumbnail => conn.execute(
            "INSERT OR REPLACE INTO thumbnails (id, mime, file, width, height, version)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                meta.id,
                meta.mime,
                rel,
                meta.width,
                meta.height,
                meta.thumbnail_version
            ],
        )?,
    };
    Ok(())
}

impl Storage {
    /// 先写临时文件并 fsync，再在锁内 rename 到最终路径并写入数据库行。
    /// 崩溃时最多留下没有记录的孤儿文件，不会出现有记录但文件缺失
    pub fn put_file(&self, kind: Kind, meta: &FileMeta, bytes: &[u8]) -> Result<()> {
        let stem = file_stem(&meta.id);
        let bucket = &stem
            .trim_start_matches("h-")
            .trim_start_matches("fallback-")[..2];
        let rel = format!(
            "{}/{bucket}/{stem}.{}",
            kind.name(),
            ext_for_mime(&meta.mime)
        );
        let path = self.root.join(&rel);

        // 原图内容由 id（dataUrl 的哈希）决定，记录和文件都已存在时只更新元数据（例如补写宽高），不重写大文件。
        // 缩略图的内容会随版本变化，始终重写
        if kind == Kind::Image {
            let conn = self.lock();
            let existing: Option<(String, i64)> = conn
                .query_row(
                    "SELECT file, bytes FROM images WHERE id = ?1",
                    [&meta.id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            // 长度不同说明已有文件损坏或内容不同，走完整重写
            let same = existing.is_some_and(|(file, len)| file == rel && len == bytes.len() as i64);
            if same && path.is_file() {
                conn.execute(
                    "UPDATE images SET mime = ?2, width = ?3, height = ?4, source = ?5,
                     created_at = COALESCE(?6, created_at) WHERE id = ?1",
                    params![
                        meta.id,
                        meta.mime,
                        meta.width,
                        meta.height,
                        meta.source,
                        meta.created_at
                    ],
                )?;
                return Ok(());
            }
        }

        let tmp = self.root.join("tmp").join(format!(
            "{stem}.{}.tmp",
            TMP_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let written = File::create(&tmp).and_then(|mut f| {
            f.write_all(bytes)?;
            f.sync_all()
        });
        if let Err(err) = written {
            let _ = fs::remove_file(&tmp);
            return Err(err.into());
        }

        // 建分桶目录、rename 与写库都在同一把锁内，孤儿清理和删除不会在其间插入
        let conn = self.lock();
        let placed = query_file(&conn, kind, &meta.id)
            .map_err(StorageError::from)
            .and_then(|old| {
                fs::create_dir_all(path.parent().expect("路径必有上级目录"))?;
                fs::rename(&tmp, &path)?;
                Ok(old)
            });
        let old_file = match placed {
            Ok(old) => old,
            Err(err) => {
                let _ = fs::remove_file(&tmp);
                return Err(err);
            }
        };
        if let Err(err) = insert_row(&conn, kind, meta, &rel, bytes.len()) {
            // 原记录不指向这个路径时，新文件没有任何引用，立即删除；指向同一路径时文件仍被原记录使用
            if old_file.as_deref() != Some(rel.as_str()) {
                remove_files(self, &[rel]);
            }
            return Err(err);
        }
        // 同一 id 换了扩展名时，旧文件不再被引用
        if let Some(old) = old_file.filter(|old| *old != rel) {
            remove_files(self, &[old]);
        }
        Ok(())
    }

    /// 记录存在但文件缺失时记录日志并按不存在处理，与 IndexedDB 中找不到图片的表现一致
    pub fn get_file(&self, kind: Kind, id: &str) -> Result<Option<(FileMeta, Vec<u8>)>> {
        let row = {
            let conn = self.lock();
            let sql = match kind {
                Kind::Image => "SELECT mime, width, height, source, created_at, NULL, file FROM images WHERE id = ?1",
                Kind::Thumbnail => "SELECT mime, width, height, NULL, NULL, version, file FROM thumbnails WHERE id = ?1",
            };
            conn.query_row(sql, [id], |row| {
                Ok((
                    FileMeta {
                        id: id.to_string(),
                        mime: row.get(0)?,
                        width: row.get(1)?,
                        height: row.get(2)?,
                        source: row.get(3)?,
                        created_at: row.get(4)?,
                        thumbnail_version: row.get(5)?,
                    },
                    row.get::<_, String>(6)?,
                ))
            })
            .optional()?
        };
        let Some((meta, file)) = row else {
            return Ok(None);
        };
        match fs::read(self.root.join(&file)) {
            Ok(bytes) => Ok(Some((meta, bytes))),
            Err(err) if err.kind() == ErrorKind::NotFound => {
                log::warn!("记录存在但文件缺失：{file}");
                Ok(None)
            }
            Err(err) => Err(err.into()),
        }
    }

    pub fn image_meta(&self, id: &str) -> Result<Option<FileMeta>> {
        Ok(self
            .lock()
            .query_row(
                "SELECT mime, width, height, source, created_at FROM images WHERE id = ?1",
                [id],
                |row| {
                    Ok(FileMeta {
                        id: id.to_string(),
                        mime: row.get(0)?,
                        width: row.get(1)?,
                        height: row.get(2)?,
                        source: row.get(3)?,
                        created_at: row.get(4)?,
                        thumbnail_version: None,
                    })
                },
            )
            .optional()?)
    }

    /// 只更新仍存在的图片，避免异步解析完成后恢复已删除的记录。
    pub fn update_image_dimensions(&self, id: &str, width: i64, height: i64) -> Result<bool> {
        if width <= 0 || height <= 0 {
            return Err(StorageError::new("invalid", "图片尺寸无效"));
        }
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let updated = tx.execute(
            "UPDATE images SET width = ?2, height = ?3 WHERE id = ?1",
            params![id, width, height],
        )? > 0;
        if updated {
            tx.execute(
                "UPDATE thumbnails SET width = ?2, height = ?3 WHERE id = ?1",
                params![id, width, height],
            )?;
        }
        tx.commit()?;
        Ok(updated)
    }

    /// 各图片文件的完整路径，供 CLI 交给 AI 工具直接读取；没有记录或文件缺失时为 None
    pub fn image_paths(&self, ids: &[String]) -> Result<Vec<Option<String>>> {
        let conn = self.lock();
        let mut stmt = conn.prepare("SELECT file FROM images WHERE id = ?1")?;
        ids.iter()
            .map(|id| {
                let file: Option<String> = stmt.query_row([id], |row| row.get(0)).optional()?;
                // 库中的相对路径以 / 分隔，逐段拼接成本机的写法
                Ok(file
                    .map(|file| {
                        file.split('/')
                            .fold(self.root.clone(), |path, part| path.join(part))
                    })
                    .filter(|path| path.is_file())
                    .map(|path| path.to_string_lossy().into_owned()))
            })
            .collect()
    }

    pub fn image_ids(&self, include_thumbnails: bool) -> Result<Vec<String>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(if include_thumbnails {
            "SELECT id FROM images UNION SELECT id FROM thumbnails ORDER BY id"
        } else {
            "SELECT id FROM images ORDER BY id"
        })?;
        let ids = stmt
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(ids)
    }

    /// 每张原图的大小与缩略图信息，供导出估算分卷和启动时筛选需要补全缩略图的图片，不读取文件内容。
    /// 缩略图表没有大小列，逐个读取文件元数据；文件缺失时视为没有缩略图
    pub fn image_stats(&self) -> Result<Vec<ImageStat>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT i.id, i.bytes, i.width, i.height, t.file, t.version
             FROM images i LEFT JOIN thumbnails t ON t.id = i.id ORDER BY i.id",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        // 读取文件元数据不需要持有数据库锁
        drop(stmt);
        drop(conn);
        Ok(rows
            .into_iter()
            .map(|(id, bytes, width, height, file, version)| {
                let thumbnail_bytes = file
                    .and_then(|file| fs::metadata(self.root.join(file)).ok())
                    .map(|m| m.len() as i64);
                ImageStat {
                    id,
                    bytes,
                    width,
                    height,
                    thumbnail_version: version.filter(|_| thumbnail_bytes.is_some()),
                    thumbnail_bytes,
                }
            })
            .collect())
    }

    /// 同时删除原图和缩略图：先在一个事务中删除记录，再删文件。
    /// 删文件也在锁内进行，避免并发写入同一 id 的新文件被误删
    pub fn delete_image(&self, id: &str) -> Result<()> {
        self.delete_where("WHERE id = ?1", Some(id))
    }

    pub fn clear_images(&self) -> Result<()> {
        self.delete_where("", None)
    }

    fn delete_where(&self, filter: &str, id: Option<&str>) -> Result<()> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let mut files = Vec::new();
        for table in [Kind::Image.name(), Kind::Thumbnail.name()] {
            let args: Vec<&str> = id.into_iter().collect();
            let mut stmt = tx.prepare(&format!("SELECT file FROM {table} {filter}"))?;
            let rows = stmt.query_map(rusqlite::params_from_iter(&args), |row| row.get(0))?;
            files.extend(rows.collect::<rusqlite::Result<Vec<String>>>()?);
            drop(stmt);
            tx.execute(
                &format!("DELETE FROM {table} {filter}"),
                rusqlite::params_from_iter(&args),
            )?;
        }
        tx.commit()?;
        remove_files(self, &files);
        Ok(())
    }

    /// 删除数据库中没有对应记录的图片文件，返回删除数量。
    /// 核对和删除都在锁内逐个进行；put_file 的建目录、rename 和写库同在锁内，因此不会误删正在写入的文件或分桶目录
    pub fn cleanup_orphans(&self) -> Result<usize> {
        let mut removed = 0;
        for kind in [Kind::Image, Kind::Thumbnail] {
            let dir = self.root.join(kind.name());
            for bucket in fs::read_dir(&dir)?.flatten() {
                if !bucket.path().is_dir() {
                    continue;
                }
                let bucket_name = bucket.file_name().to_string_lossy().into_owned();
                for entry in fs::read_dir(bucket.path())?.flatten() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    let rel = format!("{}/{bucket_name}/{name}", kind.name());
                    let conn = self.lock();
                    let referenced: bool = conn.query_row(
                        &format!(
                            "SELECT EXISTS(SELECT 1 FROM {} WHERE file = ?1)",
                            kind.name()
                        ),
                        [&rel],
                        |row| row.get(0),
                    )?;
                    if referenced {
                        continue;
                    }
                    let removed_ok = if entry.path().is_dir() {
                        fs::remove_dir_all(entry.path())
                    } else {
                        fs::remove_file(entry.path())
                    };
                    match removed_ok {
                        Ok(()) => removed += 1,
                        Err(err) => log::warn!("删除孤儿文件失败 {rel}：{err}"),
                    }
                }
                // 空的分桶目录顺手删掉；非空时删除失败，忽略即可
                let _conn = self.lock();
                let _ = fs::remove_dir(bucket.path());
            }
        }
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(id: &str, mime: &str) -> FileMeta {
        FileMeta {
            id: id.into(),
            mime: mime.into(),
            width: Some(10),
            height: Some(20),
            source: Some("generated".into()),
            created_at: Some(123),
            thumbnail_version: None,
        }
    }

    const ID: &str = "ab00000000000000000000000000000000000000000000000000000000000001";

    #[test]
    fn file_stem_hashes_unsafe_ids() {
        assert_eq!(file_stem(ID), ID);
        assert_eq!(
            file_stem("fallback-0123456789abcdef"),
            "fallback-0123456789abcdef"
        );
        // 大写十六进制、长度不符、Windows 保留名、H- 前缀等一律走哈希
        for other in [
            &ID.to_uppercase()[..],
            &ID[..63],
            "con",
            "nul",
            "H-abc",
            "ABcdef",
            "fallback-0123",
        ] {
            assert!(file_stem(other).starts_with("h-"), "{other}");
        }
        assert_eq!(
            file_stem("fallback-0011223344556677"),
            "fallback-0011223344556677"
        );
        for bad in [
            "", "a", "../etc", "ab/cd", "ab\\cd", "ab.cd", "ab:cd", "中文", "a b", "h-abc",
        ] {
            let stem = file_stem(bad);
            assert!(stem.starts_with("h-") && stem.len() == 66, "{bad}");
            assert!(stem[2..].bytes().all(|b| b.is_ascii_hexdigit()));
        }
        assert!(file_stem(&"a".repeat(129)).starts_with("h-"));
        assert_ne!(file_stem("../x"), file_stem("../y"));
    }

    #[test]
    fn ext_follows_mime() {
        assert_eq!(ext_for_mime("image/png"), "png");
        assert_eq!(ext_for_mime("image/JPEG"), "jpg");
        assert_eq!(ext_for_mime("image/svg+xml;charset=utf-8"), "svg");
        assert_eq!(ext_for_mime(RAW_DATA_URL_MIME), "txt");
        assert_eq!(ext_for_mime("application/x-whatever"), "bin");
    }

    #[test]
    fn image_put_get_delete() {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::open(dir.path()).unwrap();
        let bytes: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        storage
            .put_file(Kind::Image, &meta(ID, "image/png"), &bytes)
            .unwrap();
        let mut thumb = meta(ID, "image/webp");
        thumb.source = None;
        thumb.created_at = None;
        thumb.thumbnail_version = Some(2);
        storage.put_file(Kind::Thumbnail, &thumb, b"thumb").unwrap();

        let image_path = dir.path().join(format!("images/ab/{ID}.png"));
        let thumb_path = dir.path().join(format!("thumbnails/ab/{ID}.webp"));
        assert_eq!(fs::read(&image_path).unwrap(), bytes);
        assert!(thumb_path.is_file());
        assert_eq!(fs::read_dir(dir.path().join("tmp")).unwrap().count(), 0);

        let (got, got_bytes) = storage.get_file(Kind::Image, ID).unwrap().unwrap();
        assert_eq!(got, meta(ID, "image/png"));
        assert_eq!(got_bytes, bytes);
        let (got, got_bytes) = storage.get_file(Kind::Thumbnail, ID).unwrap().unwrap();
        assert_eq!(got, thumb);
        assert_eq!(got_bytes, b"thumb");
        assert_eq!(storage.image_ids(false).unwrap(), vec![ID.to_string()]);

        storage.delete_image(ID).unwrap();
        assert!(storage.get_file(Kind::Image, ID).unwrap().is_none());
        assert!(storage.get_file(Kind::Thumbnail, ID).unwrap().is_none());
        assert!(!image_path.exists());
        assert!(!thumb_path.exists());
        assert!(storage.image_ids(false).unwrap().is_empty());
    }

    #[test]
    fn cleanup_candidates_include_thumbnails_without_originals() {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::open(dir.path()).unwrap();
        storage
            .put_file(Kind::Thumbnail, &meta(ID, "image/webp"), b"thumb")
            .unwrap();
        assert!(storage.image_ids(false).unwrap().is_empty());
        assert_eq!(storage.image_ids(true).unwrap(), vec![ID.to_string()]);
        storage.delete_image(ID).unwrap();
        assert!(storage.image_ids(true).unwrap().is_empty());
        assert!(storage.get_file(Kind::Thumbnail, ID).unwrap().is_none());
    }

    #[test]
    fn dimensions_update_preserves_files_and_does_not_restore_deleted_images() {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::open(dir.path()).unwrap();
        storage
            .put_file(Kind::Image, &meta(ID, "image/png"), b"original")
            .unwrap();
        storage
            .put_file(Kind::Thumbnail, &meta(ID, "image/webp"), b"thumbnail")
            .unwrap();
        assert!(storage.update_image_dimensions(ID, 2496, 1664).unwrap());
        let image = storage.image_meta(ID).unwrap().unwrap();
        assert_eq!(image.width, Some(2496));
        assert_eq!(image.height, Some(1664));
        assert_eq!(image.source, meta(ID, "image/png").source);
        assert_eq!(
            storage.get_file(Kind::Image, ID).unwrap().unwrap().1,
            b"original"
        );
        let (thumbnail, bytes) = storage.get_file(Kind::Thumbnail, ID).unwrap().unwrap();
        assert_eq!(thumbnail.width, Some(2496));
        assert_eq!(bytes, b"thumbnail");
        storage.delete_image(ID).unwrap();
        assert!(!storage.update_image_dimensions(ID, 2496, 1664).unwrap());
        assert!(storage.image_meta(ID).unwrap().is_none());
    }

    #[test]
    fn existing_image_only_updates_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::open(dir.path()).unwrap();
        let path = dir.path().join(format!("images/ab/{ID}.png"));
        storage
            .put_file(Kind::Image, &meta(ID, "image/png"), b"original")
            .unwrap();
        // 用标记内容替换文件，验证第二次写入不会重写文件
        fs::write(&path, b"marker").unwrap();
        let mut updated = meta(ID, "image/png");
        updated.width = Some(99);
        updated.created_at = None;
        storage
            .put_file(Kind::Image, &updated, b"original")
            .unwrap();
        let (got, got_bytes) = storage.get_file(Kind::Image, ID).unwrap().unwrap();
        assert_eq!(got.width, Some(99));
        assert_eq!(got.created_at, Some(123));
        assert_eq!(got_bytes, b"marker");
        assert_eq!(fs::read_dir(dir.path().join("tmp")).unwrap().count(), 0);

        // 请求体长度与记录不同时完整重写
        storage
            .put_file(Kind::Image, &updated, b"other content")
            .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"other content");

        // 文件丢失时仍会重新写入
        fs::remove_file(&path).unwrap();
        storage
            .put_file(Kind::Image, &updated, b"original")
            .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"original");
    }

    #[test]
    fn unsafe_id_is_stored_under_hashed_name() {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::open(dir.path()).unwrap();
        let id = "../../evil 图";
        storage
            .put_file(Kind::Image, &meta(id, "image/png"), b"x")
            .unwrap();
        assert!(!dir.path().join("evil.png").exists());
        let stem = file_stem(id);
        assert!(dir
            .path()
            .join(format!("images/{}/{stem}.png", &stem[2..4]))
            .is_file());
        assert_eq!(storage.image_ids(false).unwrap(), vec![id.to_string()]);
        assert_eq!(storage.get_file(Kind::Image, id).unwrap().unwrap().1, b"x");
        // 孤儿清理按路径核对，不会误删哈希命名的文件
        assert_eq!(storage.cleanup_orphans().unwrap(), 0);
        storage.delete_image(id).unwrap();
        assert!(storage.get_file(Kind::Image, id).unwrap().is_none());
    }

    #[test]
    fn failed_insert_removes_new_file_only_when_unreferenced() {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::open(dir.path()).unwrap();
        let mut thumb = meta(ID, "image/webp");
        thumb.thumbnail_version = Some(1);
        storage.put_file(Kind::Thumbnail, &thumb, b"v1").unwrap();
        storage
            .lock()
            .execute_batch(
                "CREATE TRIGGER fail BEFORE INSERT ON thumbnails BEGIN SELECT RAISE(ABORT, 'fail'); END",
            )
            .unwrap();

        // 原记录指向同一路径：文件保留
        assert!(storage.put_file(Kind::Thumbnail, &thumb, b"v2").is_err());
        assert!(dir
            .path()
            .join(format!("thumbnails/ab/{ID}.webp"))
            .is_file());

        // 没有原记录：新文件立即删除
        assert!(storage
            .put_file(
                Kind::Thumbnail,
                &meta(
                    "cd00000000000000000000000000000000000000000000000000000000000001",
                    "image/webp"
                ),
                b"x"
            )
            .is_err());
        assert!(!dir.path().join("thumbnails/cd/cd00000000000000000000000000000000000000000000000000000000000001.webp").exists());
        assert_eq!(fs::read_dir(dir.path().join("tmp")).unwrap().count(), 0);
    }

    #[test]
    fn missing_file_reads_as_none() {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::open(dir.path()).unwrap();
        storage
            .put_file(Kind::Image, &meta(ID, "image/png"), b"x")
            .unwrap();
        fs::remove_file(dir.path().join(format!("images/ab/{ID}.png"))).unwrap();
        assert!(storage.get_file(Kind::Image, ID).unwrap().is_none());
        assert!(storage.get_file(Kind::Image, "nope").unwrap().is_none());
    }

    #[test]
    fn mime_change_removes_old_file() {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::open(dir.path()).unwrap();
        storage
            .put_file(Kind::Image, &meta(ID, "image/png"), b"x")
            .unwrap();
        storage
            .put_file(Kind::Image, &meta(ID, "image/jpeg"), b"y")
            .unwrap();
        assert!(!dir.path().join(format!("images/ab/{ID}.png")).exists());
        assert_eq!(
            fs::read(dir.path().join(format!("images/ab/{ID}.jpg"))).unwrap(),
            b"y"
        );
    }

    #[test]
    fn clear_images_removes_rows_and_files() {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::open(dir.path()).unwrap();
        for id in [
            "aa00000000000000000000000000000000000000000000000000000000000001",
            "bb00000000000000000000000000000000000000000000000000000000000002",
        ] {
            storage
                .put_file(Kind::Image, &meta(id, "image/png"), b"x")
                .unwrap();
            storage
                .put_file(Kind::Thumbnail, &meta(id, "image/webp"), b"t")
                .unwrap();
        }
        storage.clear_images().unwrap();
        assert!(storage.image_ids(false).unwrap().is_empty());
        assert!(storage
            .get_file(
                Kind::Thumbnail,
                "aa00000000000000000000000000000000000000000000000000000000000001"
            )
            .unwrap()
            .is_none());
        assert!(!dir
            .path()
            .join("images/aa/aa00000000000000000000000000000000000000000000000000000000000001.png")
            .exists());
        assert!(!dir.path().join("thumbnails/bb/bb00000000000000000000000000000000000000000000000000000000000002.webp").exists());
    }

    #[test]
    fn cleanup_removes_only_orphans() {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::open(dir.path()).unwrap();
        storage
            .put_file(Kind::Image, &meta(ID, "image/png"), b"x")
            .unwrap();
        storage
            .put_file(Kind::Thumbnail, &meta(ID, "image/webp"), b"t")
            .unwrap();
        // 没有记录的文件、扩展名与记录不符的文件、整个孤儿分桶
        fs::write(dir.path().join(format!("images/ab/{ID}.jpg")), b"o").unwrap();
        fs::write(dir.path().join("images/ab/ab999999.png"), b"o").unwrap();
        fs::create_dir_all(dir.path().join("thumbnails/zz")).unwrap();
        fs::write(dir.path().join("thumbnails/zz/zz000000.webp"), b"o").unwrap();
        // 数据目录下的 WebView2 数据（webview/）不属于图片分桶，不能被清理
        fs::create_dir_all(dir.path().join("webview/EBWebView")).unwrap();
        fs::write(dir.path().join("webview/EBWebView/Local State"), b"w").unwrap();

        assert_eq!(storage.cleanup_orphans().unwrap(), 3);
        assert!(dir.path().join("webview/EBWebView/Local State").is_file());
        assert!(dir.path().join(format!("images/ab/{ID}.png")).is_file());
        assert!(dir
            .path()
            .join(format!("thumbnails/ab/{ID}.webp"))
            .is_file());
        assert!(!dir.path().join("images/ab/ab999999.png").exists());
        assert!(!dir.path().join("thumbnails/zz").exists());
        assert_eq!(storage.cleanup_orphans().unwrap(), 0);
    }

    #[test]
    fn write_after_cleanup_removed_empty_bucket() {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::open(dir.path()).unwrap();
        fs::create_dir_all(dir.path().join("images/cd")).unwrap();
        storage.cleanup_orphans().unwrap();
        assert!(!dir.path().join("images/cd").exists());
        storage
            .put_file(
                Kind::Image,
                &meta(
                    "cd00000000000000000000000000000000000000000000000000000000000001",
                    "image/png",
                ),
                b"x",
            )
            .unwrap();
        assert_eq!(
            storage
                .get_file(
                    Kind::Image,
                    "cd00000000000000000000000000000000000000000000000000000000000001"
                )
                .unwrap()
                .unwrap()
                .1,
            b"x"
        );
    }

    #[test]
    fn mixed_case_ids_share_bucket_without_being_removed() {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::open(dir.path()).unwrap();
        // 找一个哈希分桶与 ID 相同（ab）的大小写混合 id
        let mixed = (0..)
            .map(|i| format!("ABcdef{i}"))
            .find(|id| file_stem(id)[2..4] == ID[..2])
            .unwrap();
        for id in [mixed.as_str(), ID, "H-abc"] {
            storage
                .put_file(Kind::Image, &meta(id, "image/png"), id.as_bytes())
                .unwrap();
        }
        // H- 前缀的 id 与哈希文件名不冲突
        let h_id = format!("H-{}", &file_stem("x")[2..]);
        storage
            .put_file(Kind::Image, &meta(&h_id, "image/png"), b"h")
            .unwrap();
        storage
            .put_file(Kind::Image, &meta("x", "image/png"), b"x")
            .unwrap();

        assert_eq!(storage.cleanup_orphans().unwrap(), 0);
        for id in [mixed.as_str(), ID, "H-abc"] {
            assert_eq!(
                storage.get_file(Kind::Image, id).unwrap().unwrap().1,
                id.as_bytes()
            );
        }
        assert_eq!(
            storage.get_file(Kind::Image, &h_id).unwrap().unwrap().1,
            b"h"
        );
        assert_eq!(storage.get_file(Kind::Image, "x").unwrap().unwrap().1, b"x");
        // 所有分桶目录都是小写
        for entry in fs::read_dir(dir.path().join("images")).unwrap().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            assert_eq!(name, name.to_lowercase());
        }
    }

    #[test]
    fn image_stats_reports_sizes_without_reading_files() {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::open(dir.path()).unwrap();
        let other = "cd00000000000000000000000000000000000000000000000000000000000002";
        storage
            .put_file(Kind::Image, &meta(ID, "image/png"), b"12345")
            .unwrap();
        storage
            .put_file(Kind::Image, &meta(other, "image/png"), b"123")
            .unwrap();
        let thumb = FileMeta {
            thumbnail_version: Some(2),
            ..meta(ID, "image/webp")
        };
        storage.put_file(Kind::Thumbnail, &thumb, b"ab").unwrap();
        let stats = storage.image_stats().unwrap();
        assert_eq!(stats.len(), 2);
        assert_eq!(
            (
                stats[0].id.as_str(),
                stats[0].bytes,
                stats[0].thumbnail_bytes,
                stats[0].thumbnail_version
            ),
            (ID, 5, Some(2), Some(2))
        );
        assert_eq!((stats[0].width, stats[0].height), (Some(10), Some(20)));
        assert_eq!(
            (
                stats[1].bytes,
                stats[1].thumbnail_bytes,
                stats[1].thumbnail_version
            ),
            (3, None, None)
        );

        // 缩略图文件缺失时按没有缩略图处理
        let file: String = storage
            .lock()
            .query_row("SELECT file FROM thumbnails", [], |row| row.get(0))
            .unwrap();
        fs::remove_file(storage.root.join(file)).unwrap();
        let stats = storage.image_stats().unwrap();
        assert_eq!(
            (stats[0].thumbnail_bytes, stats[0].thumbnail_version),
            (None, None)
        );
    }

    #[test]
    fn encode_file_layout() {
        assert!(encode_file(None).is_empty());
        let out = encode_file(Some((meta(ID, "image/png"), vec![1, 2, 3])));
        let len = u32::from_le_bytes(out[..4].try_into().unwrap()) as usize;
        let json: serde_json::Value = serde_json::from_slice(&out[4..4 + len]).unwrap();
        assert_eq!(json["mime"], "image/png");
        assert_eq!(json["createdAt"], 123);
        assert_eq!(json["thumbnailVersion"], serde_json::Value::Null);
        assert_eq!(&out[4 + len..], &[1, 2, 3]);
    }
}
