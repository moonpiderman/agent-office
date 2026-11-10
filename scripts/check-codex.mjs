// Codex 세션 점검: ~/.codex/sessions 아래 jsonl의 "구조"만 봅니다.
// 대화 내용, 명령어 원문, auth.json 등은 읽거나 기록하지 않습니다.
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
const HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const ROOT = path.join(HOME, 'sessions');
const out = { root: ROOT, exists: fs.existsSync(ROOT), otherDirsInCodexHome: [], files: 0, pathPatterns: {}, live30min: 0, recent: [] };
try { out.otherDirsInCodexHome = fs.readdirSync(HOME, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch {}
const walk = (d, dep = 0, acc = []) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch {} for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory() && dep < 6) walk(p, dep + 1, acc); else if (e.name.endsWith('.jsonl')) acc.push(p); } return acc; };
const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
if (out.exists) {
  const files = walk(ROOT).map(f => ({ f, st: fs.statSync(f) }));
  out.files = files.length;
  for (const { f } of files) bump(out.pathPatterns, path.relative(ROOT, f).replace(/\d/g, '9').replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, 'UUID').replace(/rollout-.*\.jsonl$/, 'rollout-*.jsonl'));
  out.live30min = files.filter(x => Date.now() - x.st.mtimeMs < 30 * 60e3).length;
  for (const { f, st } of files.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs).slice(0, 5)) {
    const r = { minutesAgo: Math.round((Date.now() - st.mtimeMs) / 60e3), sizeKB: Math.round(st.size / 1024), wrapped: 0, bare: 0, lineTypes: {}, payloadTypes: {}, topKeys: {}, payloadKeys: {}, toolNames: {}, shellFirstWords: {}, reasoning: { items: 0, withSummary: 0, eventAgentReasoning: 0 }, hasCwd: false, hasGit: false, version: null, model: null, originator: null, approvalLike: {}, errorLike: 0, hasCallIds: false };
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue; let o; try { o = JSON.parse(line); } catch { continue; }
      for (const k of Object.keys(o)) bump(r.topKeys, k);
      const p = o.payload && typeof o.payload === 'object' ? (r.wrapped++, o.payload) : (r.bare++, o);
      bump(r.lineTypes, o.type || '(none)');
      if (p.type) bump(r.payloadTypes, (o.payload ? o.type + '/' : '') + p.type);
      for (const k of Object.keys(p)) bump(r.payloadKeys, k);
      if (p.cwd) r.hasCwd = true; if (p.git) r.hasGit = true;
      if (p.cli_version) r.version = p.cli_version; if (p.model) r.model = p.model; if (p.originator) r.originator = p.originator;
      if (p.call_id) r.hasCallIds = true;
      if (/function_call|custom_tool_call|local_shell_call|web_search_call|tool_call/.test(p.type || '') && !/output/.test(p.type)) {
        const name = p.name || p.type; bump(r.toolNames, name);
        // 셸 명령은 첫 단어(프로그램 이름)만 집계
        let cmd = null;
        try { const a = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : (p.arguments || p.action || {}); cmd = a.command || a.cmd; } catch {}
        if (Array.isArray(cmd)) cmd = cmd[0] === 'bash' || cmd[0] === 'zsh' ? String(cmd[cmd.length - 1]) : cmd.join(' ');
        if (typeof cmd === 'string') { const w = cmd.trim().split(/\s+/)[0].replace(/^.*\//, ''); if (w) bump(r.shellFirstWords, w.slice(0, 20)); }
      }
      if (p.type === 'reasoning') { r.reasoning.items++; if (Array.isArray(p.summary) && p.summary.some(s => (s.text || '').trim())) r.reasoning.withSummary++; }
      if (p.type === 'agent_reasoning') r.reasoning.eventAgentReasoning++;
      if (/approv|permission|elicit/i.test(p.type || '')) bump(r.approvalLike, p.type);
      if (/output/.test(p.type || '')) { const s = typeof p.output === 'string' ? p.output : JSON.stringify(p.output || ''); if (/"exit_code":\s*[1-9]|"success":\s*false|error/i.test(s.slice(0, 400))) r.errorLike++; }
    }
    const top = (o, n = 25) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n));
    r.shellFirstWords = top(r.shellFirstWords); r.payloadKeys = top(r.payloadKeys, 40);
    out.recent.push(r);
  }
}
const dest = path.join(path.dirname(new URL(import.meta.url).pathname), 'check-codex-report.json');
fs.writeFileSync(dest, JSON.stringify(out, null, 2));
console.log('점검 완료 →', dest);
