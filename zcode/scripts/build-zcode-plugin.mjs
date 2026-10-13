#!/usr/bin/env node
/* StudyMate · ZCode 分发层构建器（fork 自维护，不改上游任何源文件）
 *
 * 复刻 bin/openai-plugin.mjs 的装配顺序，把 preset/skills 的 DSH 技能经
 * 上游自己的 `adaptOpenAiSkill`（无头宿主兼容层，replaceRequired 天然护栏）
 * 转换成插件技能，再叠加一层 ZCode 覆写（宿主名与工具对照），产出：
 *   zcode/studymate/            —— 插件本体（.zcode-plugin/plugin.json + skills + commands + schemas/templates/docs）
 *   marketplace.json（仓库根）—— 由 zcode/VERSION 与 vendor 插件清单确定性生成
 *
 * 护栏：
 *   · adaptOpenAiSkill 在上游文案漂移时会 throw（替换点找不到）；
 *   · 本构建器再做产物校验：残留 `studymate_*` / `.dsh/` / `DSH_HOME` / `__STUDYMATE_SKILLS__` 一律失败；
 *   · 输出目录只允许覆盖带构建标记的旧产物，防止盖掉手工文件。
 * 用法：node zcode/scripts/build-zcode-plugin.mjs [--write]（缺省只构建到临时目录并校验）
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { adaptOpenAiSkill } from '../../bin/openai-skill-compat.mjs';
import { writeDocsPayload } from '../../bin/docs-payload.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const OUT = path.join(ROOT, 'zcode', 'studymate');
const MARKETPLACE = path.join(ROOT, 'marketplace.json');
const MARKER = '.zcode-build.json';
const WRITE = process.argv.includes('--write');

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'zcode', 'BUILD-CONFIG.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = fs.readFileSync(path.join(ROOT, 'zcode', 'VERSION'), 'utf8').trim();

// process.exit 不会跑外层 finally，fail 自己负责清理临时目录。
let stagingDir = null;
function fail(message) {
  if (stagingDir) fs.rmSync(stagingDir, { recursive: true, force: true });
  console.error(`BUILD FAILED: ${message}`);
  process.exit(1);
}

/* ── ZCode 覆写层 ──────────────────────────────────────────────────────── */

const GUIDE_ANCHOR = '## ZCode 宿主约定（导出时生成）\n';

const TOOL_MAP = [
  '',
  '> **ZCode 工具对照（本 fork 构建时注入）**：正文里的「宿主文件读取工具」= `Read`（图片查看同样是 `Read`）；写入与编辑 = `Write` / `Edit`；「命令执行」= `Bash`（Windows 下为 Git Bash，PowerShell 语义按上文原文处理）；「委派 / 子 agent」= `Agent` 工具（一个角色一次独立调用，相互独立的角色在同一条消息里并行发起；没有把握时按上文串行执行角色）；「提问工具」= `AskUserQuestion`；「浏览 / 检索」= `WebFetch` 或 `Bash` 里的 `curl`——只允许 `http`/`https`，发起请求前先检查目标主机名，拒绝 `localhost`、环回地址、私有与保留地址；「预览 / 展示页面」= 优先用 ZCode 内置 `visualize` 技能把课件片段渲染成会话内交互视图，需要离线归档时仍按上文 `npx … export` 产出静态副本并给可点击的绝对路径链接。上文提到的「阅读端」在 ZCode 里不存在，一律按本条替代。',
  '',
].join('\n');

function zcodeOverlay(text, name) {
  let out = text
    .replaceAll('OpenAI 宿主约定', 'ZCode 宿主约定')
    .replaceAll('Codex / ChatGPT Work', 'ZCode')
    .replaceAll('Codex 对话衔接', 'ZCode 对话衔接');
  const at = out.indexOf(GUIDE_ANCHOR);
  if (at < 0) {
    fail(`技能 ${name} 缺少「ZCode 宿主约定」标头——上游 HOST_GUIDE 文案变了，需同步更新构建器锚点`);
  }
  const head = at + GUIDE_ANCHOR.length;
  out = out.slice(0, head) + TOOL_MAP + out.slice(head);
  if (out.includes('DSH_HOME')) {
    out = out.replaceAll('$env:DSH_HOME', '宿主环境变量').replaceAll('DSH_HOME=', '学习工作区环境变量').replaceAll('DSH_HOME', '学习工作区环境变量');
  }
  return out;
}

/* ── 装配 ──────────────────────────────────────────────────────────────── */

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) fail(`构建输入不能含符号链接：${path.join(src, entry.name)}`);
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else fs.copyFileSync(from, to);
  }
}

const staging = fs.mkdtempSync(path.join(ROOT, 'zcode', '.build-'));
stagingDir = staging;
const plugin = path.join(staging, 'studymate');
try {
  fs.mkdirSync(plugin, { recursive: true });

  // 1. Codex 基座里的主机无关附件（interaction_state.mjs、codex-interaction.md），跳过 .codex-plugin 清单。
  const base = path.join(ROOT, 'openai', 'studymate');
  for (const entry of fs.readdirSync(base)) {
    if (entry === '.codex-plugin') continue;
    copyTree(path.join(base, entry), path.join(plugin, entry));
  }

  // 2. 技能：preset 源 → adaptOpenAiSkill → ZCode 覆写；基座里同名技能目录的其余文件（references 等）先铺再覆盖 SKILL.md。
  const skillNames = fs.readdirSync(path.join(ROOT, 'preset', 'skills'))
    .filter(name => fs.statSync(path.join(ROOT, 'preset', 'skills', name)).isDirectory())
    .sort();
  if (skillNames.length < 12) fail(`preset/skills 只剩 ${skillNames.length} 个技能目录——上游结构变了，需人工确认`);
  for (const name of skillNames) {
    const dest = path.join(plugin, 'skills', name);
    copyTree(path.join(ROOT, 'preset', 'skills', name), dest);
    const baseSkill = path.join(base, 'skills', name);
    if (fs.existsSync(baseSkill)) copyTree(baseSkill, dest);
    const skillFile = path.join(dest, 'SKILL.md');
    const source = fs.readFileSync(skillFile, 'utf8');
    fs.writeFileSync(skillFile, zcodeOverlay(adaptOpenAiSkill(source, name), name));
  }

  // 3. 数据骨架与契约（技能正文以 <root>/schemas、<root>/templates 为指针）。
  for (const dir of ['templates', 'schemas']) copyTree(path.join(ROOT, dir), path.join(plugin, dir));

  // 4. docs 载荷（技能里的 <root>/docs/规范/... 指针靠它兑现；内含 preset/skills→skills 改写）。
  writeDocsPayload(ROOT, plugin);

  // 5. 资产、许可与说明。
  fs.mkdirSync(path.join(plugin, 'assets'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'docs', 'images', 'logo.png'), path.join(plugin, 'assets', 'logo.png'));
  fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(plugin, 'LICENSE'));
  fs.cpSync(path.join(ROOT, 'zcode', 'studymate-commands'), path.join(plugin, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'README.md'), [
    '# StudyMate（ZCode 版）',
    '',
    `本目录是**构建产物**：由 \`zcode/scripts/build-zcode-plugin.mjs\` 从上游 ${config.upstreamRepo} 的 \`preset/skills\` 生成，请勿手工编辑。`,
    `上游引擎版本 ${pkg.version}；插件版本 ${version}。`,
    '',
    '安装与更新见仓库根 README 的「ZCode 插件」一节。学习数据默认写入 `~/StudyMate`（可在宿主里指定其他目录），与插件目录无关。',
    '',
  ].join('\n'));

  // 6. 插件清单（ZCode 优先探测 .zcode-plugin/plugin.json）。
  fs.mkdirSync(path.join(plugin, '.zcode-plugin'), { recursive: true });
  fs.writeFileSync(path.join(plugin, '.zcode-plugin', 'plugin.json'), `${JSON.stringify({
    name: 'studymate',
    version,
    description: 'StudyMate AI 学习搭档（ZCode 移植）：定路线、教材式课件、分层练习、可运行证据考核、跨科目共享记忆与进度持久化，面向数学与计算机科目自学。',
    author: { name: `Cattofu（上游 ${config.upstreamRepo}）· ZCode 移植见 ${config.forkRepo}` },
    license: 'MIT',
    repository: `https://github.com/${config.forkRepo}`,
    homepage: `https://github.com/${config.forkRepo}#readme`,
    keywords: ['learning', 'education', 'studymate', 'courseware', 'practice'],
    skills: 'skills',
    commands: 'commands',
  }, null, 2)}\n`);

  // 7. 构建标记：记录上游版本与本次产出，供覆盖护栏与追溯。
  fs.writeFileSync(path.join(plugin, MARKER), `${JSON.stringify({
    generator: 'zcode/scripts/build-zcode-plugin.mjs',
    pluginVersion: version,
    upstreamPackage: pkg.version,
  }, null, 2)}\n`);

  // 8. 校验。指令面（SKILL.md 与 commands）出现失效宿主引用即失败；
  //    参考文档与数据模板里的说明性提及（tools.md 宿主差异表、templates 的校验器名）
  //    与上游 Codex 产物同口径，只作提示。
  const problems = [];
  const warnings = [];
  // 失效引用出现在 SKILL.md 与 commands 即失败；skills 内的 references、schemas、
  // templates、docs 里的说明性提及只警告（上游 Codex 产物同样携带，属文档不是指令）。
  const scan = (dir, prefix, isInstruction) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { scan(abs, rel, isInstruction && entry.name !== 'references'); continue; }
      if (!/\.(md|json|yaml|yml|mjs|txt)$/.test(entry.name)) continue;
      const text = fs.readFileSync(abs, 'utf8');
      const hits = [];
      if (/\bstudymate_[a-z_]+\b/.test(text)) hits.push('studymate_* 引用');
      if (/__STUDYMATE_SKILLS__/.test(text)) hits.push('安装器占位符');
      if (/\.dsh\//.test(text)) hits.push('DSH 配置路径');
      if (/DSH_HOME/.test(text)) hits.push('DSH_HOME');
      if (hits.length) (isInstruction ? problems : warnings).push(`${rel}: ${hits.join('、')}`);
    }
  };
  scan(path.join(plugin, 'skills'), 'skills', true);
  scan(path.join(plugin, 'commands'), 'commands', true);
  if (warnings.length) console.log(`说明性引用（参考文档/模板，放行）：\n  ${warnings.join('\n  ')}`);
  if (!fs.existsSync(path.join(plugin, 'docs', '规范', '文件归属.md'))) {
    problems.push('docs/规范/文件归属.md 缺失——技能的 <root>/docs 指针会全部断链');
  }
  for (const name of skillNames) {
    const head = fs.readFileSync(path.join(plugin, 'skills', name, 'SKILL.md'), 'utf8')
      .match(/^---\n([\s\S]*?)\n---/);
    if (!head || !new RegExp(`^name: ${name}$`, 'm').test(head[1]) || !/^description: \S/m.test(head[1])) {
      problems.push(`skills/${name}: frontmatter 不是有效的 ZCode 技能头`);
    }
  }
  for (const f of fs.readdirSync(path.join(plugin, 'commands'))) {
    const text = fs.readFileSync(path.join(plugin, 'commands', f), 'utf8');
    if (!/^---\n[\s\S]*?^description: \S/m.test(text)) problems.push(`commands/${f}: 缺 description`);
  }
  JSON.parse(fs.readFileSync(path.join(plugin, '.zcode-plugin', 'plugin.json'), 'utf8'));
  if (problems.length) fail(`产物校验未通过：\n  ${problems.join('\n  ')}`);

  // 9. 生成仓库根 marketplace.json（两个插件条目；vendor 版本以它自己的清单为准）。
  const vendorManifestPath = path.join(ROOT, 'zcode', 'vendor', 'bilibili-persona', '.zcode-plugin', 'plugin.json');
  if (!fs.existsSync(vendorManifestPath)) fail('zcode/vendor/bilibili-persona 尚未就位（先跑 zcode/scripts/sync-video-vendor.mjs）');
  const vendor = JSON.parse(fs.readFileSync(vendorManifestPath, 'utf8'));
  const marketplace = {
    name: config.marketplaceName,
    version,
    plugins: [
      {
        name: 'studymate',
        version,
        source: 'zcode/studymate',
        description: 'StudyMate AI 学习搭档（ZCode 移植）：定路线、教材式课件、分层练习、可运行证据考核、进度与共享记忆。',
        displayName: 'StudyMate 学习搭档',
        category: 'productivity',
        keywords: ['learning', 'education', 'math', 'cs'],
        license: 'MIT',
      },
      {
        name: 'bilibili-persona',
        version: vendor.version,
        source: 'zcode/vendor/bilibili-persona',
        description: vendor.description,
        displayName: 'B 站网课蒸馏（video-to-skill）',
        category: 'productivity',
        keywords: ['bilibili', 'course', 'transcript', 'persona'],
        license: 'GPL-3.0',
      },
    ],
  };
  fs.writeFileSync(path.join(staging, 'marketplace.json'), `${JSON.stringify(marketplace, null, 2)}\n`);

  // 10. 交付。
  if (!WRITE) {
    console.log(`构建与校验通过（未写入），staging：${staging}`);
    process.exit(0);
  }
  if (fs.existsSync(OUT)) {
    if (!fs.existsSync(path.join(OUT, MARKER))) {
      fail(`${OUT} 存在但不是本构建器的产物（缺 ${MARKER}），拒绝覆盖`);
    }
    fs.rmSync(OUT, { recursive: true });
  }
  fs.renameSync(plugin, OUT);
  fs.copyFileSync(path.join(staging, 'marketplace.json'), MARKETPLACE);
  console.log(`已写入 ${OUT} 与 ${MARKETPLACE}（版本 ${version}）`);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
