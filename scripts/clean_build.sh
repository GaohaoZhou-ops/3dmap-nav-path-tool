#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
CLEAN_DRY_RUN=0

for argument in "$@"; do
  case "$argument" in
    -n|--dry-run) CLEAN_DRY_RUN=1 ;;
    -h|--help)
      cat <<'HELP'
用法: ./scripts/clean_build.sh [--dry-run]

清理当前仓库内的 Web/Xcode 构建产物、工具缓存、表面渲染缓存和测试产物。
--dry-run / -n  只列出待清理项目，不删除文件。

保留工程配置、Pose、源点云、机器人资源、工程包、已安装依赖、签名和 IDE 配置。
iPad 配对目录包含同步必需的模型和结果，整体保留。
不清理浏览器自动保存、iPad 本机数据或仓库外的全局缓存；不终止服务。
请在编译和测试结束后运行。脚本需要 Node.js，不依赖 node_modules。
HELP
      exit 0 ;;
    *) printf '未知参数: %s（使用 --help 查看用法）\n' "$argument" >&2; exit 2 ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  printf '需要 Node.js 才能执行清理。\n' >&2
  exit 2
fi

node --input-type=module - "$PROJECT_DIR" "$CLEAN_DRY_RUN" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = fs.realpathSync(process.argv[2]);
const dryRun = process.argv[3] === '1';
const absolute = (relative) => path.join(root, relative);
const stat = (file) => {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const display = (relative) => JSON.stringify(relative);
const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

try {
  const pkg = JSON.parse(fs.readFileSync(absolute('package.json'), 'utf8'));
  if (root === path.parse(root).root || pkg.name !== 'atlas-route-studio'
      || !stat(absolute('vite.config.js')) || !stat(absolute('scripts/clean_build.sh'))) {
    throw new Error('未识别到 Atlas Route Studio 工程根目录，未执行清理');
  }

  // An ignore rule is not permission to delete: ignored files include real
  // point clouds, recovered projects and iPad transfers. Use an explicit list.
  const candidates = new Set([
    'dist', 'build', 'ipad/build', 'DerivedData', 'ipad/DerivedData', '.build', 'ipad/.build',
    '.vite', '.vite-temp', 'node_modules/.vite', 'node_modules/.vite-temp', 'node_modules/.cache',
    '.npm-cache', '.npm/_cacache', '.npm/_logs', '.cache', '.parcel-cache', '.turbo',
    '.eslintcache', '.stylelintcache', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.pyre', '.hypothesis',
    'coverage', '.nyc_output', '.coverage', 'htmlcov', 'playwright-report', 'blob-report',
    'test-results', 'test-artifacts', 'screenshots', 'ipad/test-artifacts', 'ipad/screenshots',
    '.atlas-cache/surfaces', '.atlas-cache/thumbnails', '.atlas-cache/previews', 'AtlasModelThumbnails',
  ]);

  // Do not traverse a symlinked ancestor (for example a shared node_modules or
  // an .atlas-cache symlink). Recursive removal never follows links inside a
  // disposable directory; only the link itself is removed in that case.
  function contained(relative) {
    if (path.isAbsolute(relative) || relative.split(path.sep).some((part) => part === '..' || part === '')) return false;
    let current = root;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      if (stat(current)?.isSymbolicLink()) return false;
    }
    return true;
  }

  let tracked = [];
  if (stat(absolute('.git'))) {
    tracked = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached'], { maxBuffer: 32 * 1024 * 1024 })
      .toString('utf8').split('\0').filter(Boolean);
  }

  function scan(relative, visit) {
    if (!contained(relative) || !stat(absolute(relative))?.isDirectory()) return;
    for (const entry of fs.readdirSync(absolute(relative), { withFileTypes: true })) {
      if (!entry.isSymbolicLink()) visit(path.join(relative, entry.name), entry);
    }
  }
  for (const directory of ['', 'ipad']) {
    if (directory && (!contained(directory) || !stat(absolute(directory))?.isDirectory())) continue;
    for (const entry of fs.readdirSync(absolute(directory), { withFileTypes: true })) {
      const name = entry.name;
      if (/\.xcresult(?:\.zip)?$/.test(name)
          || /^atlas-ipad-.*-(?:shots|attachments)(?:-\d+)?$/.test(name)
          || /^atlas-ipad-.*-tests?$/.test(name)
          || /^(?:atlas-|transfer-).*\.(?:png|mp4|log)$/.test(name)
          || /^(?:npm-debug|yarn-debug|yarn-error|pnpm-debug)\.log/.test(name)
          || /^vite\.config\..*\.timestamp-.*$/.test(name)
          || /\.tsbuildinfo$/.test(name) || /^\.coverage\./.test(name)) {
        candidates.add(path.join(directory, name));
      }
    }
  }
  function pythonCaches(directory) {
    scan(directory, (relative, entry) => {
      if (entry.isDirectory()) {
        if (['__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache'].includes(entry.name)) candidates.add(relative);
        else if (!['node_modules', 'build', '.git', 'fixtures', 'Fixtures', 'venv', 'env'].includes(entry.name)
                 && !entry.name.startsWith('.')) pythonCaches(relative);
      } else if (/\.py[co]$/.test(entry.name)) candidates.add(relative);
    });
  }
  for (const directory of ['src', 'scripts', 'tests', 'ipad/Tests', 'ipad/UITests']) pythonCaches(directory);

  // Leave the active service's file descriptor and PID record intact.
  let serviceRunning = false;
  const pidPath = absolute('.atlas-route.pid');
  if (contained('.atlas-route.pid') && stat(pidPath)?.isFile()) {
    const pid = fs.readFileSync(pidPath, 'utf8').trim().split(/\s+/)[0];
    if (/^[1-9]\d*$/.test(pid)) {
      try { process.kill(Number(pid), 0); serviceRunning = true; }
      catch (error) { serviceRunning = error.code !== 'ESRCH'; }
    }
  }
  if (!serviceRunning) candidates.add('.atlas-route.log');

  function digest(file) {
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
    const fd = fs.openSync(file, 'r');
    try {
      let count;
      while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
      return hash.digest('hex');
    } finally { fs.closeSync(fd); }
  }
  function publicBuildCopy(file, info) {
    // Vite's publicDir is maps/: dist contains a copy of the bundled PLY.
    // Only a byte-identical copy with its original still present is disposable.
    const relative = path.relative(absolute('dist'), file);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !info.isFile()) return false;
    const source = path.join('maps', relative);
    return contained(source) && stat(absolute(source))?.isFile()
      && fs.statSync(absolute(source)).size === info.size && digest(file) === digest(absolute(source));
  }

  // A user may accidentally save an actual project into a build/cache folder.
  // Keep the whole target if it contains project markers or model/teaching data,
  // including the images and relative resources referenced by that project.
  function inspect(file) {
    const info = fs.lstatSync(file);
    if (info.isSymbolicLink()) return { bytes: 0 };
    const name = path.basename(file);
    if (/\.atlas-project(?:\.zip)?$/i.test(name)
        || ['atlas.project.json', 'project.json', 'pose.json', 'session.json', 'result.json'].includes(name)
        || (/\.(?:ply|atls)$/i.test(name) && !publicBuildCopy(file, info))
        || /\.abxteach\.ndjson$/i.test(name)
        || /^(?:virtual-teaching|robot-teaching|robot-free-navigation|parking-merge)-.*\.(?:zip|json)$/.test(name)) {
      return { protected: path.relative(root, file), bytes: 0 };
    }
    if (info.isDirectory()) {
      let bytes = 0;
      for (const entry of fs.readdirSync(file)) {
        const result = inspect(path.join(file, entry));
        if (result.protected) return result;
        bytes += result.bytes;
      }
      return { bytes };
    }
    if (info.isFile() && name.toLowerCase().endsWith('.json')) {
      // Look for project identity even if a guide/config JSON was renamed.
      // Reading a small prefix also handles old configs containing large media.
      const fd = fs.openSync(file, 'r');
      const prefix = Buffer.alloc(Math.min(info.size, 16384));
      try { fs.readSync(fd, prefix, 0, prefix.length, 0); } finally { fs.closeSync(fd); }
      if (/atlas-route-studio-project|atlas-ipad-teaching\/1|"(?:schemaVersion|virtualTeachingTasks|cameraPose)"/.test(prefix.toString('utf8'))) {
        return { protected: path.relative(root, file), bytes: 0 };
      }
    }
    return { bytes: info.isFile() ? info.size : 0 };
  }

  console.log(`${dryRun ? '预览清理' : '清理工程'}：${root}`);
  let count = 0, total = 0, skipped = 0;
  const covered = [];
  for (const relative of [...candidates].sort((a, b) => a.length - b.length || a.localeCompare(b))) {
    if (!stat(absolute(relative)) || covered.some((parent) => relative.startsWith(`${parent}/`))) continue;
    const trackedFile = tracked.find((name) => name === relative || name.startsWith(`${relative}/`));
    if (!contained(relative) || trackedFile) {
      console.log(`[保留] ${display(relative)}：${trackedFile ? '含 Git 跟踪文件' : '路径含符号链接'}`);
      skipped += 1; covered.push(relative); continue;
    }
    const result = inspect(absolute(relative));
    if (result.protected) {
      console.log(`[保留] ${display(relative)}：含工程资料 ${display(result.protected)}`);
      skipped += 1; covered.push(relative); continue;
    }
    console.log(`[${dryRun ? '将清理' : '清理'}] ${display(relative)} (${megabytes(result.bytes)})`);
    if (!dryRun) fs.rmSync(absolute(relative), { recursive: true, force: true });
    total += result.bytes; count += 1; covered.push(relative);
  }
  console.log(`${dryRun ? '预计清理' : '已清理'} ${count} 项，文件大小合计 ${megabytes(total)}；保护性保留 ${skipped} 项。`);
  console.log('工程配置、Pose、源模型、iPad 配对/同步资料、浏览器自动保存和已安装依赖均保留。');
  if (serviceRunning) console.log('服务正在运行，保留日志和 PID 状态；清理后请重启服务以重建前端缓存。');
} catch (error) {
  console.error(`清理未完成：${error.message}`);
  process.exitCode = 1;
}
NODE
