// Claude Office 가능성 점검: 세션 jsonl의 "구조"만 보고 내용(대화 텍스트)은 기록하지 않습니다.
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
const ROOT = process.env.CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
const out = { root: ROOT, exists: fs.existsSync(ROOT), projects: 0, sessions: 0, recent: [] };
const walk = (d, dep = 0, acc = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory() && dep < 4) walk(p, dep + 1, acc); else if (e.name.endsWith('.jsonl')) acc.push(p); } return acc; };
if (out.exists) {
  const projs = fs.readdirSync(ROOT, { withFileTypes: true }).filter(e => e.isDirectory());
  out.projects = projs.length;
  const files = walk(ROOT).map(f => ({ f, st: fs.statSync(f) }));
  const mains = files.filter(x => !x.f.includes(`${path.sep}subagents${path.sep}`) && !path.basename(x.f).startsWith('agent-'));
  out.sessions = mains.length;
  out.subagentFiles = files.length - mains.length;
  out.subagentLayout = { inSubagentsDir: files.filter(x => x.f.includes(`${path.sep}subagents${path.sep}`)).length, agentPrefixed: files.filter(x => path.basename(x.f).startsWith('agent-')).length };
  out.liveLast30min = mains.filter(x => Date.now() - x.st.mtimeMs < 30 * 60e3).length;
  const pick = mains.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs).slice(0, 5);
  for (const { f, st } of pick) {
    const r = { minutesAgo: Math.round((Date.now() - st.mtimeMs) / 60e3), sizeKB: Math.round(st.size / 1024), lineTypes: {}, topKeys: {}, tools: {}, thinking: { blocks: 0, withText: 0 }, toolErrors: 0, hasCwd: false, hasBranch: false, version: null, titleTypes: [], taskCalls: 0, taskTypes: {}, subagents: 0, subMatchedByPrompt: 0, subFirstLineKeys: null };
    const taskPrompts = [];
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue; let o; try { o = JSON.parse(line); } catch { continue; }
      r.lineTypes[o.type] = (r.lineTypes[o.type] || 0) + 1;
      for (const k of Object.keys(o)) r.topKeys[k] = (r.topKeys[k] || 0) + 1;
      if (o.cwd) r.hasCwd = true; if (o.gitBranch) r.hasBranch = true; if (o.version) r.version = o.version;
      if (/title|summary/i.test(o.type) && !r.titleTypes.includes(o.type)) r.titleTypes.push(o.type);
      const c = o.message?.content; if (!Array.isArray(c)) continue;
      for (const it of c) {
        if (it.type === 'tool_use') { r.tools[it.name] = (r.tools[it.name] || 0) + 1; if (it.name === 'Task' || it.name === 'Agent') { r.taskCalls++; const t = it.input?.subagent_type || '(none)'; r.taskTypes[t] = (r.taskTypes[t] || 0) + 1; if (it.input?.prompt) taskPrompts.push(String(it.input.prompt).slice(0, 120)); } }
        if (it.type === 'thinking') { r.thinking.blocks++; if ((it.thinking || '').trim()) r.thinking.withText++; }
        if (it.type === 'tool_result' && it.is_error) r.toolErrors++;
      }
    }
    const sid = path.basename(f, '.jsonl'); const sd = path.join(path.dirname(f), sid, 'subagents');
    if (fs.existsSync(sd)) for (const sf of fs.readdirSync(sd).filter(n => n.endsWith('.jsonl'))) {
      r.subagents++;
      const lines = fs.readFileSync(path.join(sd, sf), 'utf8').split('\n').filter(Boolean);
      try { const o = JSON.parse(lines[0]); if (!r.subFirstLineKeys) r.subFirstLineKeys = Object.keys(o);
        const fp = typeof o.message?.content === 'string' ? o.message.content : (o.message?.content || []).find?.(x => x.type === 'text')?.text || '';
        if (taskPrompts.some(p => fp.startsWith(p.slice(0, 80)))) r.subMatchedByPrompt++; } catch {}
    }
    out.recent.push(r);
  }
}
const dest = path.join(path.dirname(new URL(import.meta.url).pathname), 'check-report.json');
fs.writeFileSync(dest, JSON.stringify(out, null, 2));
console.log('점검 완료 →', dest);
