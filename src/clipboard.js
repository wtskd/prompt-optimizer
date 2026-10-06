// 剪贴板复制：零依赖，只用 node:child_process。
// Windows 上不用 `clip`——它按控制台代码页（GBK）解码 stdin，UTF-8 中文会变乱码；
// 改走 PowerShell Set-Clipboard（经 UTF-8 临时文件中转），失败再退回 clip。
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { fnv1a } from './util.js';

const POWERSHELL_COPY = (file) =>
  `Get-Content -LiteralPath '${file}' -Raw -Encoding UTF8 | Set-Clipboard`;

/**
 * 把文本复制到系统剪贴板。
 * @returns {{ok:true, tool:string} | {ok:false, error:string, tried:string[]}}
 */
export function copyText(text, { platform = process.platform, run = spawnSync } = {}) {
  const s = String(text ?? '');
  const tried = [];

  const tryRun = (cmd, args, input) => {
    try {
      const r = run(cmd, args, input === undefined ? {} : { input, encoding: 'utf8' });
      return !r.error && (r.status === 0 || r.status === null);
    } catch {
      return false;
    }
  };

  if (platform === 'win32') {
    tried.push('powershell');
    const file = join(tmpdir(), `prompt-opt-${fnv1a(`${Date.now()}-${s.length}`)}.txt`);
    try {
      writeFileSync(file, s, 'utf8');
      if (tryRun('powershell.exe', ['-NoProfile', '-Command', POWERSHELL_COPY(file)])) {
        return { ok: true, tool: 'powershell Set-Clipboard' };
      }
      tried.push('clip');
      if (tryRun('clip', [], s)) return { ok: true, tool: 'clip' };
    } finally {
      try {
        rmSync(file, { force: true });
      } catch {
        // 临时文件删不掉不影响复制结果
      }
    }
  } else if (platform === 'darwin') {
    tried.push('pbcopy');
    if (tryRun('pbcopy', [], s)) return { ok: true, tool: 'pbcopy' };
  } else {
    for (const [cmd, args, name] of [
      ['wl-copy', [], 'wl-copy'],
      ['xclip', ['-selection', 'clipboard'], 'xclip'],
    ]) {
      tried.push(name);
      if (tryRun(cmd, args, s)) return { ok: true, tool: name };
    }
  }
  return {
    ok: false,
    error: `没有可用的剪贴板工具（尝试：${tried.join(' → ') || '无'}）`,
    tried,
  };
}
