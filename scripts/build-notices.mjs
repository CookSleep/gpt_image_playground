// 生成第三方许可清单 src/assets/third-party-notices.txt（npm run notices），由「设置 → 关于 → 第三方许可」弹窗显示。
// 生成结果提交进仓库，Web 版构建不需要 cargo-about；Rust 或前端依赖变化后重新运行并提交。
// 内容：third-party-licenses/ 中的字体许可，cargo-about 汇总的 Rust 依赖（配置见 src-tauri/about.toml，Windows 目标的普通与构建依赖），
// 以及 npm ls --omit=dev 列出的前端依赖。
// 需要 cargo-about：cargo install cargo-about --version 0.9.2 --locked --features cli
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT = 'src/assets/third-party-notices.txt'
const RULE = '='.repeat(80)
const THIN = '-'.repeat(80)

const read = (path) => readFileSync(path, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n').trim()

const parts = [
  'GPT Image Playground 第三方许可清单 / Third-Party Notices',
  '',
  'GPT Image Playground 以 MIT 协议发布。本文件列出 GPT Image Playground 使用的第三方组件及其许可原文，其中 Rust 依赖仅用于 Windows 客户端。',
  'GPT Image Playground is released under the MIT License. This file lists the third-party components used by GPT Image Playground and their license texts. Rust dependencies apply to the Windows client only.',
]

const section = (title, body) => parts.push('', '', RULE, title, RULE, '', body)

section('HarmonyOS Sans SC 字体', [
  '版权方：Huawei Device Co., Ltd.',
  '许可：HarmonyOS Sans Fonts License Agreement',
  '项目地址：https://developer.huawei.com/consumer/cn/design/resource/',
  '许可证：https://github.com/openharmony/resources/blob/master/LICENSE_Fonts',
  '',
  read('third-party-licenses/HarmonyOS-Sans-LICENSE.txt'),
].join('\n'))
section('Maple Mono NF CN 字体', [
  '版权方：The Maple Mono Project Authors',
  '许可：SIL Open Font License 1.1',
  '项目地址：https://github.com/subframe7536/maple-font',
  '',
  read('third-party-licenses/MapleMono-LICENSE.txt'),
].join('\n'))
section('Lobe Icons（设置中 Claude Code、Codex 的图标）', [
  '项目地址：https://github.com/lobehub/lobe-icons',
  '',
  read('third-party-licenses/LobeIcons-LICENSE.txt'),
].join('\n'))

// Rust：按许可原文分组，每组列出使用它的包；本项目自己的包（没有 source）不列出
let about
try {
  about = JSON.parse(execFileSync('cargo', ['about', 'generate', '--format', 'json', '--manifest-path', 'src-tauri/Cargo.toml', '--config', 'src-tauri/about.toml', '--locked', '--fail'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }))
} catch (err) {
  console.error('cargo about 运行失败。未安装时请先运行：cargo install cargo-about --version 0.9.2 --locked --features cli')
  throw err
}
const rust = []
const rustSeen = new Set()
for (const lic of about.licenses) {
  const users = lic.used_by.map((u) => u.crate).filter((c) => c.source)
  if (!users.length) continue
  const names = [...new Set(users.map((c) => `${c.name} ${c.version}`))].sort()
  for (const name of names) rustSeen.add(name)
  // MPL-2.0 要求说明源码获取方式；这些包都未经修改
  const source = lic.id === 'MPL-2.0'
    ? `\n以上包未经修改，源码见：\n${[...new Set(users.map((c) => c.name))].sort().map((n) => `  https://crates.io/crates/${n}`).join('\n')}`
    : ''
  rust.push(`${THIN}\n${lic.name}（${lic.id}）\n使用者：${names.join('、')}${source}\n${THIN}\n\n${lic.text.replace(/\r\n/g, '\n').trim()}`)
}
section(`Rust 依赖（共 ${rustSeen.size} 个包）`, rust.join('\n\n'))

// 前端：生产依赖，同名同版本只列一次；许可原文取包目录中的全部许可文件（如 LICENSE-MIT 与 LICENSE-APACHE-2.0），不含 .spdx。
// 包中没有许可文件时取 third-party-licenses/npm/<包名>.txt（@ 去掉，/ 换成 __），两处都没有则生成失败。
const missing = []
const tree = JSON.parse(execSync('npm ls --omit=dev --all --json --long', { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }))
const npm = new Map()
const walk = (deps) => {
  for (const [name, d] of Object.entries(deps ?? {})) {
    // 未安装的可选 peer 依赖没有版本，不随程序分发
    if (!d.version || npm.has(`${name} ${d.version}`)) continue
    const files = d.path && existsSync(d.path)
      ? readdirSync(d.path).filter((f) => /^(licen[cs]e|copying)([-_.].*)?$/i.test(f) && !/\.spdx$/i.test(f)).sort()
      : []
    const license = typeof d.license === 'object' ? d.license?.type : d.license
    const extra = `third-party-licenses/npm/${name.replace(/^@/, '').replace(/\//g, '__')}.txt`
    // 原文第一行为“来源：<包名> <版本>，<URL>”，版本不符时视同缺失
    if (!files.length && !(existsSync(extra) && read(extra).startsWith(`来源：${name} ${d.version}，`))) missing.push(`${name} ${d.version}（应放在 ${extra}，第一行注明该版本）`)
    const text = files.length ? files.map((f) => read(join(d.path, f))).join(`\n\n${THIN}\n\n`) : existsSync(extra) ? read(extra) : ''
    npm.set(`${name} ${d.version}`, `${THIN}\n${name} ${d.version}（${license ?? '未声明'}）\n${THIN}\n\n${text}`)
    walk(d.dependencies)
  }
}
walk(tree.dependencies)
if (missing.length) {
  console.error(`以下前端依赖的包中没有许可文件，请从上游仓库对应版本取许可原文（含版权行），放进 third-party-licenses/npm/，文件第一行注明来源 URL 与版本：\n${missing.map((m) => `  ${m}`).join('\n')}`)
  process.exit(1)
}
section(`前端依赖（共 ${npm.size} 个包）`, [...npm.keys()].sort().map((k) => npm.get(k)).join('\n\n'))

mkdirSync('src/assets', { recursive: true })
writeFileSync(OUT, `${parts.join('\n')}\n`)
console.log(`已生成 ${OUT}：Rust 依赖 ${rustSeen.size} 个、前端依赖 ${npm.size} 个。`)
