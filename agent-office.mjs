#!/usr/bin/env node
// Agent Office — Claude Code / Codex 세션 기록(jsonl)을 읽어 아이소메트릭 사무실 빌딩으로 보여주는 로컬 대시보드
//   node agent-office.mjs                  → http://localhost:4777
//   --port 5000      포트 변경
//   --live 30        몇 분 이내 기록이 있으면 '출근'으로 볼지 (기본 30)
//   --days 7         며칠 이내 쓴 프로젝트를 층으로 보여줄지 (기본 7)
//   --no-claude / --no-codex   한쪽만 보기
//   CLAUDE_PROJECTS=/경로, CODEX_HOME=/경로   세션 폴더 직접 지정
// 외부 패키지 없음 · 훅/설정 변경 없음 · 127.0.0.1 에서만 열림 · 파일은 읽기만 함

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PORT = Number(opt('--port', process.env.PORT || 4777));
const LIVE_MIN = Number(opt('--live', 30));
const FLOOR_DAYS = Number(opt('--days', 7));
const ROOT = process.env.CLAUDE_PROJECTS ||
  path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CODEX_ROOT = path.join(CODEX_HOME, 'sessions');
const USE_CLAUDE = !args.includes('--no-claude');
const USE_CODEX = !args.includes('--no-codex');
const TAIL = 1024 * 1024;

// ───────────── 유틸 ─────────────
const cut = (s, n = 70) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const base = (p) => (p ? String(p).split(/[\\/]/).filter(Boolean).pop() : '');
const statSafe = (p) => { try { return fs.statSync(p); } catch { return null; } };
const readdirSafe = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } };

function readTail(file, size, bytes = TAIL) {
  const len = Math.min(size, bytes);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
  const lines = buf.toString('utf8').split('\n');
  if (len < size) lines.shift();
  return lines;
}
function readHead(file, bytes = 96 * 1024) {
  const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(bytes); const n = fs.readSync(fd, buf, 0, bytes, 0); return buf.subarray(0, n).toString('utf8'); }
  finally { fs.closeSync(fd); }
}

// 도구 → 방
function catOf(tool = '') {
  if (/^(Read|Grep|Glob|LS|NotebookRead|View|Skill|ToolSearch)$/.test(tool)) return 'library';
  if (/^(Edit|MultiEdit|Write|NotebookEdit|Artifact)$/.test(tool)) return 'dev';
  if (/^(Bash|BashOutput|KillShell|KillBash|Monitor|TaskStop)$/.test(tool)) return 'server';
  if (/^(TodoWrite|TaskCreate|TaskUpdate|TaskList|TaskGet|EnterPlanMode|ExitPlanMode)$/.test(tool)) return 'meeting';
  if (/^(Agent|Task|SendMessage)$/.test(tool)) return 'desk';
  if (/^(AskUserQuestion)$/.test(tool)) return 'boss';
  return 'web'; // WebSearch, WebFetch, mcp__* 등
}
function toolDetail(name, input = {}) {
  try {
    switch (name) {
      case 'Bash': return cut(input.description || input.command, 60);
      case 'Read': case 'Edit': case 'MultiEdit': case 'Write': return base(input.file_path);
      case 'NotebookEdit': return base(input.notebook_path);
      case 'Grep': case 'Glob': return cut(input.pattern, 50);
      case 'WebFetch': try { return new URL(input.url).host; } catch { return cut(input.url, 50); }
      case 'WebSearch': return cut(input.query, 50);
      case 'Agent': case 'Task': return cut(input.description || input.subagent_type, 50);
      case 'Skill': return cut(input.skill || input.command, 40);
      case 'TodoWrite': { const t = (input.todos || []).find((x) => x.status === 'in_progress'); return t ? cut(t.activeForm || t.content, 50) : `${(input.todos || []).length}개 항목`; }
      case 'TaskCreate': return cut(input.subject, 50);
      case 'AskUserQuestion': return cut(input.questions?.[0]?.question, 60);
      default: {
        if (name.startsWith('mcp__')) return name.split('__').slice(1).join(' · ');
        const v = Object.values(input).find((x) => typeof x === 'string'); return cut(v || '', 50);
      }
    }
  } catch { return ''; }
}
const resultText = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.text || '').join(' ') : '';

// ───────────── jsonl 파싱 ─────────────
function parse(file, lines, mtimeMs, isSub) {
  const s = {
    id: base(file).replace(/\.jsonl$/, ''), file, mtimeMs, cwd: '', branch: '', title: '', model: '',
    firstPrompt: '', firstHead: '', lastPrompt: '', lastText: '', events: [], tools: 0, prompts: 0,
    todos: [], thinkingText: '', thinkingMs: 0, lastError: null, agentId: '', lastTs: 0,
    pending: new Map(), tasks: new Map(), lastKind: null,
  };
  const push = (e) => { s.events.push(e); if (s.events.length > 50) s.events.shift(); };
  for (const line of lines) {
    if (!line || line.length < 2) continue;
    // 큰 api-request 줄은 굳이 파싱하지 않음
    if (line.startsWith('{"type":"api-request')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.cwd) s.cwd = o.cwd;
    if (o.gitBranch) s.branch = o.gitBranch;
    if (o.agentId && !s.agentId) s.agentId = o.agentId;
    if (o.type === 'ai-title' && o.aiTitle) s.title = o.aiTitle;
    if (o.type === 'custom-title' && o.customTitle) s.title = o.customTitle;
    if (o.type === 'summary' && o.summary && !s.title) s.title = o.summary;
    if (!isSub && o.isSidechain) continue;
    if (!o.message || o.isMeta) continue;
    const ts = o.timestamp ? Date.parse(o.timestamp) : 0;
    if (ts) s.lastTs = ts;
    const m = o.message;

    if (o.type === 'user') {
      const items = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [];
      for (const it of items) {
        if (it?.type === 'tool_result') {
          const p = s.pending.get(it.tool_use_id);
          s.pending.delete(it.tool_use_id);
          const t = s.tasks.get(it.tool_use_id); if (t) { t.done = true; t.doneTs = ts; }
          s.lastKind = 'tool_result';
          if (it.is_error && p) {
            const txt = cut(resultText(it.content), 80);
            if (!/rejected|user doesn't want|interrupted/i.test(txt)) {
              s.lastError = { ts, tool: p.name, text: txt };
              push({ ts, kind: 'err', tool: p.name, text: txt });
            } else push({ ts, kind: 'stop', text: `${p.name} 거절됨` });
          }
        } else if (it?.type === 'text') {
          const t = it.text || '';
          if (t.startsWith('[Request interrupted')) { s.lastKind = 'interrupted'; push({ ts, kind: 'stop', text: '중단됨' }); continue; }
          if (/^<(command-name|local-command|command-message)/.test(t)) {
            const mm = t.match(/<command-name>([^<]+)<\/command-name>/); if (mm) push({ ts, kind: 'cmd', text: mm[1] });
            continue;
          }
          if (t.startsWith('<') || !t.trim()) continue;
          s.prompts++; s.lastPrompt = cut(t, 140);
          if (!s.firstPrompt) { s.firstPrompt = cut(t, 140); s.firstHead = t.slice(0, 200); }
          push({ ts, kind: 'user', text: cut(t, 160) }); s.lastKind = 'user';
        }
      }
    } else if (o.type === 'assistant') {
      if (m.model && !m.model.startsWith('<')) s.model = m.model;
      if (o.thinkingDurationMs) s.thinkingMs = o.thinkingDurationMs;
      for (const it of Array.isArray(m.content) ? m.content : []) {
        if (it?.type === 'text' && it.text?.trim()) {
          s.lastText = cut(it.text, 160); push({ ts, kind: 'say', text: cut(it.text, 160) }); s.lastKind = 'text';
        } else if (it?.type === 'thinking') {
          const t = (it.thinking || '').trim();
          if (t) { s.thinkingText = cut(t.split(/\n/).find((x) => x.trim()) || t, 90); }
          if (s.lastKind !== 'tool') s.lastKind = 'thinking';
          push({ ts, kind: 'think', text: t ? cut(t, 120) : '생각함' });
        } else if (it?.type === 'tool_use') {
          const d = toolDetail(it.name, it.input || {});
          s.pending.set(it.id, { id: it.id, name: it.name, detail: d, ts });
          s.tools++; s.lastKind = 'tool';
          push({ ts, kind: 'tool', tool: it.name, text: d });
          const inp = it.input || {};
          if (it.name === 'Agent' || it.name === 'Task') {
            s.tasks.set(it.id, { type: inp.subagent_type || 'general-purpose', desc: inp.description || '', head: String(inp.prompt || '').slice(0, 200), done: false, doneTs: 0 });
          }
          if (it.name === 'TodoWrite' && Array.isArray(inp.todos)) s.todos = inp.todos.map((t) => ({ text: cut(t.content || t.activeForm, 60), status: t.status }));
          if (it.name === 'TaskCreate' && inp.subject) s.todos.push({ text: cut(inp.subject, 60), status: 'pending' });
          if (it.name === 'TaskUpdate' && inp.taskId && inp.status) { const t = s.todos[Number(inp.taskId) - 1]; if (t) t.status = inp.status; }
        }
      }
    }
  }
  if (!s.lastTs) s.lastTs = mtimeMs;
  return s;
}

const LONG = new Set(['Bash', 'BashOutput', 'Agent', 'Task', 'WebFetch', 'WebSearch', 'Monitor', 'Skill']);
function classify(s, now) {
  const age = now - s.mtimeMs;
  const ps = [...s.pending.values()];
  const p = ps[ps.length - 1];
  const r = { state: 'idle', tool: '', cat: 'desk', detail: '', since: s.lastTs };
  const codex = s.agent === 'codex';
  if (p) {
    r.tool = p.name; r.detail = p.detail; r.since = p.ts || s.mtimeMs; r.cat = p.cat || catOf(p.name);
    const dur = now - (p.ts || s.mtimeMs);
    if (p.name === 'AskUserQuestion' || p.name === 'ExitPlanMode' || r.cat === 'boss') { r.state = 'waiting'; r.cat = 'boss'; }
    else if (age > LIVE_MIN * 60e3) { r.state = 'sleep'; r.cat = 'lounge'; }
    else if (!codex && dur > 12e3 && age > 12e3 && !LONG.has(p.name) && !p.name.startsWith('mcp__')) { r.state = 'waiting'; r.cat = 'boss'; r.approval = true; }
    else r.state = 'working';
  } else if (codex ? (s.turnActive && age < 10 * 60e3) : (['user', 'tool_result', 'thinking'].includes(s.lastKind) && age < 3 * 60e3)) {
    r.state = 'thinking';
  } else {
    const idle = now - s.lastTs;
    r.detail = s.lastText;
    if (idle < 2 * 60e3) { r.state = 'idle'; r.cat = 'desk'; }
    else if (idle < 15 * 60e3) { r.state = 'idle'; r.cat = 'lounge'; }
    else { r.state = 'sleep'; r.cat = 'lounge'; }
  }
  return r;
}

// ───────────── Codex 파싱 ─────────────
const LIB_CMDS = new Set(['rg', 'grep', 'cat', 'sed', 'head', 'tail', 'ls', 'find', 'fd', 'nl', 'wc', 'tree', 'less', 'bat', 'jq', 'awk', 'stat', 'file', 'pwd', 'du', 'diff', 'git-grep']);
const WEB_CMDS = new Set(['curl', 'wget', 'http', 'xh']);
function codexCmd(raw) {
  let a = raw;
  if (typeof raw === 'string') { try { a = JSON.parse(raw); } catch { a = raw; } }
  let cmd = '';
  if (typeof a === 'string') cmd = a;
  else if (a && typeof a === 'object') {
    cmd = a.cmd ?? a.command ?? a.code ?? a.input ?? a.script ?? a.query ?? a.question ?? a.questions?.[0]?.question ?? a.prompt ?? '';
    if (Array.isArray(cmd)) cmd = /^(ba|z)?sh$/.test(cmd[0]) && cmd.length > 2 ? cmd[cmd.length - 1] : cmd.join(' ');
  }
  cmd = String(cmd || '');
  // 코드 모드(JS 안에서 셸 호출)인 경우 안쪽 명령을 꺼내 봄
  const inner = cmd.match(/(?:cmd|command)["']?\s*[:=]\s*\[?\s*["'`]([^"'`\n]{2,200})/);
  if (inner && !/^\s*[\w-]+\s/.test(cmd.split('\n')[0])) cmd = inner[1];
  return cmd;
}
function codexCat(name, cmd) {
  if (/request_user_input|ask_user|user_input/i.test(name)) return 'boss';
  if (name === 'update_plan') return 'meeting';
  if (/^(spawn_agent|send_message|followup_task|wait_agent|list_agents|interrupt_agent)$/.test(name)) return 'desk';
  if (/apply_patch/.test(name) || /\*\*\* Begin Patch|^\s*apply_patch/m.test(cmd)) return 'dev';
  if (/web_search|web\.run|search_query/i.test(name)) return 'web';
  if (name === 'view_image') return 'library';
  if (/^(exec|shell|local_shell|exec_command|container\.exec|js|wait|write_stdin|unified_exec)$/.test(name)) {
    const c = cmd.trim().replace(/^(cd\s+[^;&|]+(&&|;)\s*)+/, '').replace(/^(\w+=\S+\s+)+/, '');
    const w = (c.split(/\s+/)[0] || '').replace(/^.*\//, '');
    if (LIB_CMDS.has(w) || (w === 'git' && /^git\s+(log|show|diff|grep|blame|status)\b/.test(c))) return 'library';
    if (WEB_CMDS.has(w)) return 'web';
    if (/^(cat|tee)\b.*>/.test(c) || /open\([^)]*['"]w/.test(c)) return 'dev';
    return 'server';
  }
  if (name.startsWith('mcp__') || name.includes('__')) return 'web';
  return 'server';
}
function codexDetail(name, cmd, raw) {
  const files = [...cmd.matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+)/g)].map((x) => base(x[1].trim()));
  if (files.length) return cut(files.join(', '), 60);
  if (name === 'update_plan') { try { const a = JSON.parse(raw); const t = (a.plan || []).find((x) => x.status === 'in_progress'); return cut(t?.step || a.explanation || '계획 정리', 50); } catch { return '계획 정리'; } }
  if (name === 'spawn_agent') { const a = jsonObj(raw); return cut(a?.task_name || a?.message || '서브에이전트 호출', 50); }
  return cut(cmd.split('\n').find((l) => l.trim()) || name, 60);
}
const codexErr = (out) => {
  let s = typeof out === 'string' ? out : JSON.stringify(out ?? '');
  try { const j = JSON.parse(s); if (j?.metadata?.exit_code > 0) return true; if (j?.success === false) return true; if (typeof j?.output === 'string') s = j.output; } catch {}
  return /exit(?:_| )code["']?\s*[:=]?\s*[1-9]|Process exited with code [1-9]|"success":\s*false/i.test(s.slice(0, 600));
};
const outText = (out) => { let s = typeof out === 'string' ? out : JSON.stringify(out ?? ''); try { const j = JSON.parse(s); if (typeof j?.output === 'string') s = j.output; } catch {} return cut(s.split('\n').filter((l) => l.trim()).slice(-1)[0] || s, 80); };

const codexFileId = (file) => {
  const m = base(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return m?.[1] || base(file).replace(/\.jsonl$/, '').replace(/^rollout-[\d-T:]+-?/, '');
};
function codexSubType(source, threadSource = '') {
  const sub = source && typeof source === 'object' ? source.subagent : null;
  if (typeof sub === 'string') return sub;
  if (sub && typeof sub === 'object') {
    for (const k of ['task_name', 'agent_name', 'name', 'type', 'role', 'other']) if (typeof sub[k] === 'string' && sub[k]) return sub[k];
    const v = Object.values(sub).find((x) => typeof x === 'string' && x);
    if (v) return v;
    const k = Object.keys(sub)[0]; if (k) return k;
  }
  return threadSource ? threadSource.replace(/_(review|spawn)$/, '') : '';
}
const jsonObj = (raw) => {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : null; } catch { return null; }
};

const codexHeadMetaCache = new Map();
function codexHeadMeta(file) {
  if (codexHeadMetaCache.has(file)) return codexHeadMetaCache.get(file);
  let meta = null;
  try {
    for (const line of readHead(file).split('\n')) {
      if (!line.includes('session_meta')) continue;
      const o = JSON.parse(line); if (o.type !== 'session_meta') continue;
      const p = o.payload && typeof o.payload === 'object' ? o.payload : o;
      meta = {
        id: p.id || p.session_id || codexFileId(file), parentId: p.parent_thread_id || '',
        cwd: p.cwd || '', branch: p.git?.branch || '', threadSource: p.thread_source || '',
        subType: codexSubType(p.source, p.thread_source || ''), isSub: !!(p.parent_thread_id || p.source?.subagent),
      };
      break;
    }
  } catch {}
  meta ||= { id: codexFileId(file), parentId: '', cwd: '', branch: '', threadSource: '', subType: '', isSub: false };
  codexHeadMetaCache.set(file, meta);
  return meta;
}

function parseCodex(file, lines, mtimeMs) {
  const s = {
    id: codexFileId(file), file, mtimeMs, agent: 'codex', parentId: '', isSub: false, subType: '', threadSource: '',
    cwd: '', branch: '', title: '', model: '', firstPrompt: '', firstHead: '', lastPrompt: '', lastText: '', events: [], tools: 0, prompts: 0,
    todos: [], thinkingText: '', thinkingMs: 0, lastError: null, lastTs: 0, pending: new Map(), tasks: new Map(), spawned: new Map(), lastKind: null, turnActive: false,
  };
  const push = (e) => { s.events.push(e); if (s.events.length > 50) s.events.shift(); };
  for (const line of lines) {
    if (!line || line.length < 2) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const p = o.payload && typeof o.payload === 'object' ? o.payload : o;
    const kind = o.payload ? o.type : (p.type === 'message' || /call/.test(p.type || '') || p.type === 'reasoning' ? 'response_item' : o.type);
    const ts = o.timestamp ? Date.parse(o.timestamp) : 0;
    if (kind === 'session_meta') {
      if (p.id || p.session_id) s.id = p.id || p.session_id;
      if (p.cwd) s.cwd = p.cwd; if (p.git?.branch) s.branch = p.git.branch;
      s.parentId = p.parent_thread_id || ''; s.threadSource = p.thread_source || '';
      s.subType = codexSubType(p.source, s.threadSource); s.isSub = !!(s.parentId || p.source?.subagent);
      continue;
    }
    if (kind === 'turn_context') { if (p.cwd) s.cwd = p.cwd; if (p.model) s.model = p.model; continue; }
    if (kind === 'event_msg') {
      if (p.type === 'task_started') { s.turnActive = true; s.lastKind = 'user'; if (ts) s.lastTs = ts; }
      else if (p.type === 'task_complete' || p.type === 'turn_aborted') {
        s.turnActive = false; s.pending.clear(); if (ts) s.lastTs = ts; s.lastKind = 'text';
        if (p.last_agent_message) s.lastText = cut(p.last_agent_message, 160);
        if (p.type === 'turn_aborted') push({ ts, kind: 'stop', text: '중단됨' });
      } else if (p.type === 'agent_reasoning' && p.text) s.thinkingText = cut(p.text, 90);
      continue;
    }
    if (kind !== 'response_item') continue;
    if (ts) s.lastTs = ts;
    const t = p.type || '';
    if (t === 'message') {
      const txt = (Array.isArray(p.content) ? p.content : []).map((c) => c?.text || '').join(' ').trim();
      if (!txt) continue;
      if (p.role === 'user') {
        if (txt.startsWith('<') || /^# AGENTS\.md/.test(txt)) continue;
        s.prompts++; s.lastPrompt = cut(txt, 140); if (!s.firstPrompt) s.firstPrompt = cut(txt, 140);
        push({ ts, kind: 'user', text: cut(txt, 160) });
      } else if (p.role === 'assistant') { s.lastText = cut(txt, 160); s.lastKind = 'text'; push({ ts, kind: 'say', text: cut(txt, 160) }); }
    } else if (t === 'reasoning') {
      const sum = (Array.isArray(p.summary) ? p.summary : []).map((x) => x?.text || '').join(' ').trim();
      if (sum) s.thinkingText = cut(sum.replace(/\*\*/g, ''), 90);
      s.lastKind = 'thinking'; push({ ts, kind: 'think', text: sum ? cut(sum.replace(/\*\*/g, ''), 120) : '생각함' });
    } else if (/_call$/.test(t)) {
      const name = p.name || t.replace(/_call$/, '');
      const raw = p.arguments ?? p.input ?? p.action ?? '';
      const arg = jsonObj(raw);
      const cmd = t === 'local_shell_call' ? codexCmd({ command: p.action?.command }) : t === 'web_search_call' ? String(p.action?.query || '') : codexCmd(raw);
      const cat = t === 'web_search_call' ? 'web' : codexCat(name, cmd);
      const detail = t === 'web_search_call' ? cut(cmd || '웹 검색', 50) : codexDetail(name, cmd, typeof raw === 'string' ? raw : JSON.stringify(raw));
      s.tools++; push({ ts, kind: 'tool', tool: name, text: detail });
      const callId = p.call_id || p.id || String(ts);
      if (t !== 'web_search_call') s.pending.set(callId, { id: callId, name, detail, ts, cat });
      s.lastKind = 'tool';
      if (name === 'update_plan') { try { const a = JSON.parse(raw); if (Array.isArray(a.plan)) s.todos = a.plan.map((x) => ({ text: cut(x.step, 60), status: x.status })); } catch {} }
      if (name === 'spawn_agent') s.tasks.set(callId, { type: arg?.task_name || 'general-purpose', desc: cut(arg?.message || arg?.prompt || arg?.task_name || '', 80) });
    } else if (/_call_output$/.test(t)) {
      const pend = s.pending.get(p.call_id); s.pending.delete(p.call_id); s.lastKind = 'tool_result';
      if (pend && codexErr(p.output)) { const txt = outText(p.output); s.lastError = { ts, tool: pend.name, text: txt }; push({ ts, kind: 'err', tool: pend.name, text: txt }); }
      const task = s.tasks.get(p.call_id); const out = jsonObj(p.output);
      const childId = out?.agent_id || out?.thread_id || out?.id;
      if (task && childId) s.spawned.set(String(childId), task);
    }
  }
  const meta = codexHeadMeta(file);
  s.id = meta.id || s.id; s.parentId = meta.parentId || s.parentId; s.isSub ||= meta.isSub;
  s.subType ||= meta.subType; s.threadSource ||= meta.threadSource; s.cwd ||= meta.cwd; s.branch ||= meta.branch;
  if (!s.lastTs) s.lastTs = mtimeMs;
  return s;
}

// ───────────── 스캔 ─────────────
const parsed = new Map();   // file -> { mtimeMs, size, s }
const projInfo = new Map(); // claude dir -> { files: Map(name -> {mtimeMs,size}), lastActive, cwd, cwdFrom }
const codexFiles = new Map(); // path -> { mtimeMs, size, cwd }
let lastFull = 0;

function getParsed(file, st, kind) {
  let c = parsed.get(file);
  if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
    try {
      const s = kind === 'codex' ? parseCodex(file, readTail(file, st.size, TAIL * 2), st.mtimeMs) : parse(file, readTail(file, st.size), st.mtimeMs, kind === 'sub');
      if (kind !== 'codex') s.agent = 'claude';
      c = { mtimeMs: st.mtimeMs, size: st.size, s };
    } catch { return null; }
    parsed.set(file, c);
  }
  return c.s;
}
const headCwd = (file) => { try { const mm = readHead(file).match(/"cwd":"((?:[^"\\]|\\.)*)"/); return mm ? JSON.parse(`"${mm[1]}"`) : ''; } catch { return ''; } };

function scanProject(dir, full) {
  const pdir = path.join(ROOT, dir);
  let info = projInfo.get(dir);
  if (!info) { info = { files: new Map(), lastActive: 0, cwd: '', cwdFrom: '' }; projInfo.set(dir, info); }
  for (const e of readdirSafe(pdir)) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const known = info.files.get(e.name);
    if (known && !full && Date.now() - known.mtimeMs > LIVE_MIN * 60e3) continue;
    const st = statSafe(path.join(pdir, e.name)); if (!st) continue;
    info.files.set(e.name, { mtimeMs: st.mtimeMs, size: st.size });
  }
  info.lastActive = Math.max(0, ...[...info.files.values()].map((f) => f.mtimeMs));
  return info;
}

// Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
function scanCodex(now, full) {
  const dayDirs = [];
  if (full || !codexFiles.size) {
    for (const y of readdirSafe(CODEX_ROOT)) { if (!y.isDirectory()) continue;
      for (const m of readdirSafe(path.join(CODEX_ROOT, y.name))) { if (!m.isDirectory()) continue;
        for (const d of readdirSafe(path.join(CODEX_ROOT, y.name, m.name))) { if (!d.isDirectory()) continue;
          const dt = new Date(Number(y.name), Number(m.name) - 1, Number(d.name)).getTime();
          if (!isNaN(dt) && now - dt <= (FLOOR_DAYS + 1) * 864e5) dayDirs.push(path.join(CODEX_ROOT, y.name, m.name, d.name));
        } } }
    for (const k of codexFiles.keys()) if (now - codexFiles.get(k).mtimeMs > (FLOOR_DAYS + 1) * 864e5) codexFiles.delete(k);
  } else {
    for (const back of [0, 1]) { const d = new Date(now - back * 864e5); dayDirs.push(path.join(CODEX_ROOT, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))); }
  }
  for (const dd of dayDirs) for (const e of readdirSafe(dd)) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const f = path.join(dd, e.name); const known = codexFiles.get(f);
    if (known && !full && now - known.mtimeMs > LIVE_MIN * 60e3) continue;
    const st = statSafe(f); if (!st) continue;
    codexFiles.set(f, { mtimeMs: st.mtimeMs, size: st.size, cwd: known?.cwd || '' });
  }
  if (!full) for (const [f, info] of codexFiles) if (now - info.mtimeMs < LIVE_MIN * 60e3) { const st = statSafe(f); if (st) { info.mtimeMs = st.mtimeMs; info.size = st.size; } }
}

function publishCodexSub(s, c, now, task) {
  const finished = !s.turnActive && s.pending.size === 0 && s.lastKind === 'text';
  if (finished && now - s.mtimeMs > 30e3) return null;
  if (!finished && now - s.mtimeMs > 10 * 60e3) return null;
  const fallbackDesc = s.subType === 'guardian' ? '승인 검토' : s.firstPrompt || s.threadSource || '서브에이전트';
  return {
    id: s.id, type: task?.type || s.subType || 'general-purpose',
    desc: cut(task?.desc || fallbackDesc, 50),
    state: finished ? 'done' : c.state === 'idle' || c.state === 'sleep' ? 'working' : c.state,
    tool: c.tool, cat: c.cat === 'boss' ? 'desk' : c.cat, detail: c.detail,
    done: finished, doneTs: finished ? s.lastTs : 0, lastError: s.lastError,
    thinkingText: s.thinkingText, events: s.events.slice(-25), lastTs: s.lastTs, model: s.model,
  };
}

function snapshot() {
  const now = Date.now();
  const full = now - lastFull > 5000;
  if (full) lastFull = now;
  const floors = new Map();
  const olderKeys = new Set();
  const floorOf = (cwd, fallback) => {
    const key = cwd || fallback; let f = floors.get(key);
    if (!f) { f = { key, name: base(cwd) || fallback, cwd, lastActive: 0, sessions: [], agents: new Set() }; floors.set(key, f); }
    return f;
  };

  if (USE_CLAUDE) {
    const dirs = full || !projInfo.size ? readdirSafe(ROOT).filter((e) => e.isDirectory()).map((e) => e.name) : [...projInfo.keys()];
    for (const dir of dirs) {
      const prev = projInfo.get(dir);
      const hot = prev && now - prev.lastActive < LIVE_MIN * 60e3;
      const info = full || hot || !prev ? scanProject(dir, full || !prev) : prev;
      if (!info.files.size) continue;
      if (now - info.lastActive > FLOOR_DAYS * 864e5) { olderKeys.add(info.cwd || dir); continue; }
      const sessions = [];
      for (const [name, f] of info.files) {
        if (now - f.mtimeMs > LIVE_MIN * 60e3) continue;
        const s = getParsed(path.join(ROOT, dir, name), f, 'claude'); if (!s || !s.events.length) continue;
        if (s.cwd) info.cwd = s.cwd;
        sessions.push(publish(s, classify(s, now), now, dir));
      }
      if (!info.cwd) {
        const latest = [...info.files.entries()].sort((a, b) => b[1].mtimeMs - a[1].mtimeMs)[0];
        if (latest && info.cwdFrom !== latest[0]) { info.cwdFrom = latest[0]; info.cwd = headCwd(path.join(ROOT, dir, latest[0])); }
      }
      const fl = floorOf(info.cwd, dir.replace(/^-+/, '').split('-').pop());
      fl.lastActive = Math.max(fl.lastActive, info.lastActive); fl.agents.add('claude'); fl.sessions.push(...sessions);
    }
  }

  if (USE_CODEX) {
    scanCodex(now, full);
    const fileById = new Map();
    for (const [f, info] of codexFiles) {
      if (now - info.mtimeMs > FLOOR_DAYS * 864e5) continue;
      const meta = codexHeadMeta(f); fileById.set(meta.id || codexFileId(f), [f, info]);
      if (!info.cwd) info.cwd = meta.cwd || headCwd(f) || '';
      const fl = floorOf(info.cwd, 'codex');
      fl.lastActive = Math.max(fl.lastActive, info.mtimeMs); fl.agents.add('codex');
    }

    const active = new Map();
    const loadCodex = (f, info) => {
      const s = getParsed(f, info, 'codex'); if (!s) return null;
      if (s.cwd) info.cwd = s.cwd; else s.cwd = info.cwd || '';
      active.set(s.id, { s, info, f }); return s;
    };
    for (const [f, info] of codexFiles) {
      if (now - info.mtimeMs > LIVE_MIN * 60e3 || now - info.mtimeMs > FLOOR_DAYS * 864e5) continue;
      loadCodex(f, info);
    }
    // 활동 중인 자식만 새로 기록되고 부모 파일은 잠든 경우에도 부모까지 불러온다.
    for (const item of [...active.values()]) {
      let parentId = item.s.parentId; const seen = new Set();
      while (parentId && !active.has(parentId) && !seen.has(parentId)) {
        seen.add(parentId); const parentFile = fileById.get(parentId); if (!parentFile) break;
        const ps = loadCodex(parentFile[0], parentFile[1]); if (!ps) break; parentId = ps.parentId;
      }
    }
    const children = new Map();
    for (const item of active.values()) if (item.s.parentId && active.has(item.s.parentId)) {
      const list = children.get(item.s.parentId) || []; list.push(item); children.set(item.s.parentId, list);
    }
    const descendants = (id, seen = new Set()) => {
      if (seen.has(id)) return []; seen.add(id);
      const direct = children.get(id) || [];
      return direct.flatMap((x) => [x, ...descendants(x.s.id, seen)]);
    };
    for (const item of active.values()) {
      const { s, info } = item;
      if (s.parentId && active.has(s.parentId)) continue;
      const subs = descendants(s.id).map((child) => {
        const parent = active.get(child.s.parentId)?.s;
        return publishCodexSub(child.s, classify(child.s, now), now, parent?.spawned.get(child.s.id));
      }).filter(Boolean);
      if (now - info.mtimeMs > LIVE_MIN * 60e3 && !subs.length) continue;
      if (!s.events.length && !subs.length) continue;
      const pub = publish(s, classify(s, now), now, null); pub.subs = subs;
      const fl = floorOf(s.cwd || info.cwd, 'codex'); fl.sessions.push(pub);
    }
  }

  for (const k of parsed.keys()) {
    const st = parsed.get(k); const keep = k.startsWith(CODEX_ROOT) ? (FLOOR_DAYS + 1) * 864e5 : (LIVE_MIN + 5) * 60e3;
    if (now - st.mtimeMs > keep) parsed.delete(k);
  }
  const list = [...floors.values()].map((f) => ({ ...f, agents: [...f.agents] })).sort((a, b) => a.name.localeCompare(b.name));
  const older = [...olderKeys].filter((k) => !floors.has(k)).length;
  return {
    now, roots: { claude: USE_CLAUDE ? ROOT : null, codex: USE_CODEX ? CODEX_ROOT : null },
    rootExists: (USE_CLAUDE && fs.existsSync(ROOT)) || (USE_CODEX && fs.existsSync(CODEX_ROOT)),
    liveMin: LIVE_MIN, floorDays: FLOOR_DAYS, olderFloors: older, floors: list,
  };
}

function publish(s, c, now, dir) {
  // 서브에이전트(Claude): <프로젝트>/<세션ID>/subagents/agent-*.jsonl
  const subs = [];
  const tasks = [...s.tasks.entries()];
  if (dir) for (const e of readdirSafe(path.join(ROOT, dir, s.id, 'subagents'))) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const f = path.join(ROOT, dir, s.id, 'subagents', e.name);
    const st = statSafe(f); if (!st || now - st.mtimeMs > LIVE_MIN * 60e3) continue;
    const ss = getParsed(f, st, 'sub'); if (!ss) continue;
    const cl = classify(ss, now);
    const match = tasks.find(([, t]) => t.head && ss.firstHead && ss.firstHead.slice(0, 80) === t.head.slice(0, 80));
    const t = match?.[1];
    const finished = ss.pending.size === 0 && ss.lastKind === 'text';
    let done, doneTs;
    if (t) { done = t.done && finished; doneTs = Math.max(t.doneTs || 0, ss.lastTs); }
    else { done = finished && now - st.mtimeMs > 8000; doneTs = ss.lastTs; }
    if (done && now - doneTs > 30e3) continue;
    if (!done && now - st.mtimeMs > 10 * 60e3) continue; // 멈춘 채 오래된 서브에이전트는 숨김
    subs.push({
      id: ss.agentId || ss.id, type: t?.type || 'general-purpose', desc: cut(t?.desc || ss.firstPrompt, 50),
      state: done ? 'done' : cl.state === 'idle' || cl.state === 'sleep' ? 'working' : cl.state,
      tool: cl.tool, cat: cl.cat === 'boss' ? 'desk' : cl.cat, detail: cl.detail, done, doneTs,
      lastError: ss.lastError, thinkingText: ss.thinkingText, events: ss.events.slice(-25), lastTs: ss.lastTs, model: ss.model,
    });
  }
  let subType = '';
  if (c.tool === 'Agent' || c.tool === 'Task' || c.tool === 'spawn_agent') { const p = [...s.pending.values()].pop(); subType = s.tasks.get(p?.id)?.type || ''; }
  return {
    id: s.id, agent: s.agent, title: s.title || s.firstPrompt, firstPrompt: s.firstPrompt, lastPrompt: s.lastPrompt, lastText: s.lastText,
    cwd: s.cwd, branch: s.branch, model: s.model, prompts: s.prompts, tools: s.tools, ...c, subType,
    thinkingText: s.thinkingText, thinkingMs: s.thinkingMs, lastError: s.lastError, todos: s.todos.slice(0, 12),
    events: s.events.slice(-40), lastTs: s.lastTs, mtimeMs: s.mtimeMs, subs,
  };
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/state')) {
    let body; try { body = JSON.stringify(snapshot()); } catch (e) { res.writeHead(500); return res.end(String(e?.stack || e)); }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(body);
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `포트 ${PORT}가 이미 사용 중이에요. --port 다른번호 로 실행해 보세요.` : e); process.exit(1); });
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  🏢 Agent Office  →  http://localhost:${PORT}`);
  if (USE_CLAUDE) console.log(`     Claude Code : ${ROOT}${fs.existsSync(ROOT) ? '' : '  (없음)'}`);
  if (USE_CODEX) console.log(`     Codex       : ${CODEX_ROOT}${fs.existsSync(CODEX_ROOT) ? '' : '  (없음)'}`);
  console.log(`     ${LIVE_MIN}분 안에 기록이 있으면 출근 · 최근 ${FLOOR_DAYS}일 프로젝트를 층으로 표시 (Ctrl+C 종료)\n`);
});

// ═════════════════════════════ 화면 ═════════════════════════════
const PAGE = String.raw`<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Office</title>
<style>
:root{--bg:#f4f5f7;--panel:#ffffff;--line:#e4e6eb;--ink:#1f2328;--muted:#6b7280;--soft:#f6f7f9;--accent:#d97757;
--working:#22a35a;--thinking:#3b82f6;--waiting:#e5a000;--idle:#9aa1ab;--err:#e04f3f;--done:#8b5cf6}
@media (prefers-color-scheme:dark){:root{--bg:#15171a;--panel:#1d2024;--line:#2c3036;--ink:#e8eaed;--muted:#9aa0a8;--soft:#24282d}}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{font:13px/1.45 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard",sans-serif;color:var(--ink);background:var(--bg)}
.app{display:grid;grid-template-columns:250px 1fr 320px;height:100vh}
.side{background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
.right{border-right:0;border-left:1px solid var(--line)}
.sh{padding:12px 14px 8px;display:flex;align-items:center;gap:8px;font-weight:700}
.sh small{margin-left:auto;font-weight:500;color:var(--muted);font-size:10px;letter-spacing:.8px}
.scroll{overflow:auto;min-height:0;flex:1}
.fl{margin:4px 10px;border:1px solid var(--line);border-radius:10px;cursor:pointer;background:var(--panel);overflow:hidden}
.fl .row{display:flex;align-items:center;gap:8px;padding:8px 10px}
.fl .no{min-width:30px;height:24px;border-radius:6px;background:var(--soft);display:grid;place-items:center;font-weight:800;font-size:11px;color:var(--muted)}
.fl.live .no{background:#e7f6ed;color:#147a3f}
.fl .nm{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fl .sub{font-size:11px;color:var(--muted)}
.fl .lamp{width:8px;height:8px;border-radius:50%;background:#c9ccd1;margin-left:auto;flex:none}
.fl.live .lamp{background:var(--working);box-shadow:0 0 0 3px #22a35a33}
.fl.sel{border-color:var(--accent);box-shadow:0 0 0 2px #d9775733}
.fl.dark{opacity:.55}
.ss{border-top:1px dashed var(--line);padding:4px 6px 6px}
.si{display:flex;gap:7px;align-items:center;padding:5px 6px;border-radius:6px;font-size:12px}
.si:hover{background:var(--soft)}
.si .d{width:7px;height:7px;border-radius:50%;flex:none}
.si .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.si .a{color:var(--muted);font-size:10.5px;flex:none}
.foot{padding:10px 14px;border-top:1px solid var(--line);font-size:11px;color:var(--muted);display:flex;flex-direction:column;gap:6px}
.tog{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;color:var(--ink)}
.stage{position:relative;overflow:hidden;background:radial-gradient(ellipse at 50% 40%,#fbfbfd,#eceef2)}
@media (prefers-color-scheme:dark){.stage{background:radial-gradient(ellipse at 50% 40%,#2a2e34,#17191c)}}
canvas{position:absolute;inset:0;width:100%;height:100%;cursor:grab}
canvas.drag{cursor:grabbing}
.labs{position:absolute;inset:0;pointer-events:none}
.lab{position:absolute;left:0;top:0;transform-origin:50% 100%;pointer-events:auto;cursor:pointer;will-change:transform}
.bb{background:#fff;color:#222;border:1px solid #e3e5e9;border-radius:9px;padding:3px 8px;font-size:11px;white-space:nowrap;max-width:210px;overflow:hidden;text-overflow:ellipsis;box-shadow:0 2px 6px #0000001a;position:relative}
.bb .nm{display:block;font-size:9.5px;color:#8a8f98;font-weight:600;line-height:1.2}
.bb:after{content:"";position:absolute;left:50%;bottom:-5px;margin-left:-5px;border:5px solid transparent;border-bottom:0;border-top-color:#fff}
.bb.cloud{border-radius:16px;background:#f1f6ff;border-color:#cfe0ff;font-style:italic;color:#2b4d8a}
.bb.cloud:after{border:0;width:6px;height:6px;border-radius:50%;background:#f1f6ff;border:1px solid #cfe0ff;bottom:-9px;margin-left:-3px}
.bb.err{background:#fff0ee;border-color:#f6c3bb;color:#b4321f;font-weight:600}
.bb.err:after{border-top-color:#fff0ee}
.bb.wait{background:#fff7df;border-color:#f5d98a;color:#7a5600;font-weight:600}
.bb.wait:after{border-top-color:#fff7df}
.bb.say{background:#efeaff;border-color:#d6caff;color:#4b2fa8;font-weight:600}
.bb.say:after{border-top-color:#efeaff}
.bb.mute{opacity:.75}
.lab.sel .bb{box-shadow:0 0 0 2px var(--accent)}
.hud{position:absolute;left:14px;top:12px;display:flex;gap:8px;align-items:center;z-index:3}
.badge{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:6px 10px;display:flex;gap:8px;align-items:center;box-shadow:0 1px 3px #0000000f}
.badge b.no{background:var(--accent);color:#fff;border-radius:6px;padding:1px 6px;font-size:11px}
.live{color:var(--working);font-weight:800;font-size:10px;letter-spacing:.6px}
.zoom{position:absolute;left:14px;bottom:14px;display:flex;flex-direction:column;gap:4px;z-index:3}
.zoom button{width:30px;height:30px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer;font-size:15px}
.elev{position:absolute;left:50%;top:40%;transform:translate(-50%,-50%) scale(.9);background:#1f2328;color:#ffd36b;font:800 34px/1 ui-monospace,Menlo,monospace;padding:16px 26px;border-radius:14px;opacity:0;transition:.25s;z-index:4;pointer-events:none;letter-spacing:2px;box-shadow:0 10px 30px #0004}
.elev.on{opacity:1;transform:translate(-50%,-50%) scale(1)}
.dim{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none;z-index:2}
.dim div{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 18px;text-align:center;color:var(--muted);box-shadow:0 4px 16px #00000014}
.card{margin:0 12px 12px;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.card h4{margin:0;padding:8px 10px;font-size:12px;background:var(--soft);display:flex;align-items:center;gap:6px}
.card h4 span{margin-left:auto;font-weight:500;color:var(--muted);font-size:11px}
.pp{display:flex;gap:8px;align-items:center;padding:7px 10px;border-top:1px solid var(--line);cursor:pointer}
.pp:hover{background:var(--soft)}.pp.sel{background:#d9775714}
.av{width:22px;height:22px;border-radius:50%;flex:none;display:grid;place-items:center;color:#fff;font-size:10px;font-weight:800}
.pp .tx{flex:1;min-width:0}.pp .tx b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px}
.pp .tx i{display:block;font-style:normal;color:var(--muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chip{font-size:10px;padding:1px 7px;border-radius:999px;font-weight:700;flex:none}
.log{max-height:38vh;overflow:auto}
.ev{display:grid;grid-template-columns:38px 18px 1fr;gap:4px;padding:5px 10px;border-top:1px solid var(--line);font-size:11.5px}
.ev .tm{color:var(--muted);font-size:10.5px;font-variant-numeric:tabular-nums}
.ev .tx{word-break:break-all}.ev .tl{font-weight:700;color:var(--working);margin-right:4px}
.ev.user .tx{font-weight:600}.ev.err .tx{color:var(--err)}.ev.think .tx{color:var(--thinking);font-style:italic}
.leg{display:grid;grid-template-columns:1fr 1fr;gap:4px 8px;padding:8px 10px;border-top:1px solid var(--line);font-size:11px}
.leg div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.leg span{color:var(--muted)}
.todo{padding:6px 10px;border-top:1px solid var(--line);font-size:11.5px;display:flex;gap:6px}
.empty{padding:14px;color:var(--muted);text-align:center;font-size:12px}
.mbtn{display:none}
@media (max-width:980px){.app{grid-template-columns:1fr;grid-template-rows:auto 60vh auto;height:auto}.side{max-height:40vh}.right{border-left:0;border-top:1px solid var(--line);max-height:none}}
</style></head><body>
<div class="app">
  <aside class="side">
    <div class="sh">🏢 층별 안내 <small>FLOOR GUIDE</small></div>
    <div class="scroll" id="floors"></div>
    <div class="foot">
      <label class="tog"><input type="checkbox" id="follow" checked> 일하는 층 자동으로 따라가기</label>
      <div id="older"></div>
    </div>
  </aside>
  <main class="stage" id="stage">
    <canvas id="cv"></canvas>
    <div class="labs" id="labs"></div>
    <div class="hud"><div class="badge" id="badge">불러오는 중…</div></div>
    <div class="zoom"><button id="zi" title="확대">＋</button><button id="zo" title="축소">－</button><button id="zf" title="맞춤">⤢</button></div>
    <div class="elev" id="elev">▲ 1F</div>
    <div class="dim" id="dim" style="display:none"></div>
  </main>
  <aside class="side right">
    <div class="sh" id="rtitle">사무실</div>
    <div class="scroll">
      <div class="card"><h4>👥 사무실 사람들 <span id="pcount"></span></h4><div id="people"></div></div>
      <div class="card" id="todoCard" style="display:none"><h4>🗒️ 화이트보드 <span id="todoOwner"></span></h4><div id="todos"></div></div>
      <div class="card"><h4>📜 활동 로그 <span id="logOwner"></span></h4><div class="log" id="log"></div></div>
      <div class="card"><h4>🗺️ 어디서 무엇을 하나</h4><div class="leg">
        <div>📚 자료실 <span>읽기·검색</span></div><div>💻 개발실 <span>코드 수정</span></div>
        <div>🗄️ 서버실 <span>명령·git</span></div><div>🌐 정보검색실 <span>웹·MCP</span></div>
        <div>🗒️ 회의실 <span>계획·할 일</span></div><div>🧑‍💻 내 자리 <span>질문·승인</span></div>
        <div>🪑 업무 자리 <span>지시·대기</span></div><div>☕ 라운지 <span>쉬는 중</span></div>
        <div>🛗 엘리베이터 <span>서브에이전트</span></div><div>💦 <span>도구 실패</span></div><div><b style="color:#d97757">✳</b> Claude Code</div><div><b style="color:#10a37f">&gt;_</b> Codex</div>
      </div></div>
    </div>
  </aside>
</div>
<script>
// ───────── 공통 ─────────
const $=id=>document.getElementById(id);
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const cutS=(s,n)=>{s=String(s||'');return s.length>n?s.slice(0,n-1)+'…':s};
function hash(s){let h=2166136261;for(const c of String(s))h=Math.imul(h^c.charCodeAt(0),16777619);return h>>>0}
function ago(ms){const s=Math.max(0,Math.round(ms/1000));if(s<60)return s+'초';const m=Math.round(s/60);if(m<60)return m+'분';const h=Math.floor(m/60);if(h<24)return h+'시간';return Math.floor(h/24)+'일'}
function hhmm(t){const d=new Date(t);return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')}
const TOOL_KO={Bash:'명령 실행',BashOutput:'출력 확인',Read:'읽는 중',Edit:'수정 중',MultiEdit:'수정 중',Write:'작성 중',NotebookEdit:'노트북 수정',
 Grep:'검색 중',Glob:'파일 찾기',WebFetch:'웹 읽기',WebSearch:'웹 검색',Agent:'호출 중',Task:'호출 중',TodoWrite:'할 일 정리',TaskCreate:'할 일 추가',
 TaskUpdate:'할 일 갱신',AskUserQuestion:'질문',ExitPlanMode:'계획 승인 요청',Skill:'스킬 펼침',ToolSearch:'도구 찾기',Artifact:'페이지 게시',Monitor:'모니터링',
 exec:'명령',shell:'명령',exec_command:'명령',js:'JS 실행',wait:'기다리는 중',apply_patch:'패치 적용',update_plan:'계획 정리',spawn_agent:'서브에이전트 호출',send_message:'메시지 전달',followup_task:'후속 작업 전달',wait_agent:'서브에이전트 대기',request_user_input_async:'질문',request_user_input:'질문',view_image:'이미지 보기',web_search:'웹 검색'};
const CAT_ICON={library:'📖',dev:'⌨️',server:'🗄️',web:'🌐',meeting:'🗒️',desk:'📞',boss:'🙋',lounge:'☕'};
const ST_KO={working:'작업 중',thinking:'생각 중',waiting:'확인 필요',idle:'대기',sleep:'졸고 있음',done:'보고 완료'};
const ST_C={working:'var(--working)',thinking:'var(--thinking)',waiting:'var(--waiting)',idle:'var(--idle)',sleep:'var(--idle)',done:'var(--done)'};
const AGENT={claude:{c:'#d97757',n:'Claude'},codex:{c:'#10a37f',n:'Codex'},Explore:{c:'#2f9e5b',n:'Explore'},Plan:{c:'#8b5cf6',n:'Plan'},guardian:{c:'#7c3aed',n:'Guardian'},'general-purpose':{c:'#3b82f6',n:'범용'}};
const agentOf=t=>AGENT[t]||{c:'#64748b',n:t||'에이전트'};
const sessionLive=s=>s.state!=='sleep'||(s.subs||[]).some(x=>x.state!=='sleep'&&x.state!=='done');
function toolName(t){if(!t)return '';if(t.indexOf('mcp__')===0)return t.split('__')[1]+' 도구';return TOOL_KO[t]||t}

// ───────── 아이소메트릭 월드 ─────────
const TW=44,TH=22,ZH=24;
const iso=(x,y,z)=>[(x-y)*TW/2,(x+y)*TH/2-(z||0)*ZH];
const ROOMS={
 library:{n:'📚 자료실',x0:0,y0:0,x1:7,y1:6,f:'#f1e6d3'},
 meeting:{n:'🗒️ 회의실',x0:8,y0:0,x1:13,y1:6,f:'#e6edf6'},
 web:{n:'🌐 정보검색실',x0:14,y0:0,x1:21,y1:6,f:'#e0f1eb'},
 dev:{n:'💻 개발실',x0:0,y0:7,x1:9,y1:13,f:'#eceef7'},
 desk:{n:'🪑 업무 자리',x0:10,y0:7,x1:15,y1:13,f:'#f6efe3'},
 server:{n:'🗄️ 서버실',x0:16,y0:7,x1:21,y1:13,f:'#dee3eb'},
 lounge:{n:'☕ 라운지',x0:0,y0:14,x1:7,y1:19,f:'#f3e5d5'},
 boss:{n:'🧑‍💻 내 자리',x0:8,y0:14,x1:15,y1:19,f:'#efe9f7'},
 elevator:{n:'🛗 엘리베이터',x0:16,y0:14,x1:21,y1:19,f:'#e7e8ea'}
};
function shade(hex,a){let c=parseInt(hex.slice(1),16),r=c>>16,g=c>>8&255,b=c&255;const f=v=>Math.max(0,Math.min(255,Math.round(a<0?v*(1+a):v+(255-v)*a)));return '#'+((1<<24)+(f(r)<<16)+(f(g)<<8)+f(b)).toString(16).slice(1)}
const OBJ=[];
function B(x,y,w,d,h,col,ex,z){const o={x,y,z:z||0,w,d,h,top:col,left:shade(col,-.1),right:shade(col,-.22)};if(ex)Object.assign(o,ex);OBJ.push(o);return o}
const SPOTS={};
// 자료실
for(let i=0;i<6;i++)B(.35+i*1.15,.15,1.05,.55,1.75,'#8a5a33',{kind:'shelf',seed:i});
B(1.4,3,2.3,1.05,.5,'#b98252');B(4.3,3,2.3,1.05,.5,'#b98252');
SPOTS.library=[[1,1.35],[2.3,1.35],[3.6,1.35],[4.9,1.35],[6.2,1.35],[2,4.75],[3.3,4.75],[5,4.75],[6.2,4.75]];
// 회의실
B(8.7,.12,4.6,.06,1.3,'#ffffff',{kind:'board'},.45);
B(9,2.5,4,1.5,.5,'#cfd4dc');
SPOTS.meeting=[[9.3,4.6],[10.7,4.6],[12.1,4.6],[13.3,3.3],[9.6,1.65],[11.1,1.65],[12.6,1.65]];
// 정보검색실
for(let i=0;i<3;i++)B(14.7+i*2.2,.35,1.05,.5,1.4,'#39414f',{kind:'kiosk',seed:i});
B(15,4,2.2,.9,.5,'#e9eaee');B(17.6,4,2.2,.9,.5,'#e9eaee');
SPOTS.web=[[15.2,1.55],[17.4,1.55],[19.6,1.55],[15.6,5.6],[16.8,5.6],[18.2,5.6],[19.3,5.6],[20.9,3.3]];
// 개발실
const DEV=[];for(let r=0;r<2;r++)for(let k=0;k<3;k++){const x=.7+k*2.95,y=7.9+r*3;B(x,y,2.3,1,.55,'#f3f3f5');DEV.push(B(x+.75,y+.12,.8,.08,.62,'#c9cdd3',{kind:'imac',idx:DEV.length},.55));}
SPOTS.dev=DEV.map(o=>[o.x+.4,o.y+1.6]);
// Claude 자리
const DESKS=[[10.5,8],[13.1,8],[10.5,11],[13.1,11]];
DESKS.forEach(([x,y])=>{B(x,y,2,1,.55,'#c79868');B(x+.55,y+.15,.75,.08,.5,'#2b2f36',{kind:'mon'},.55);B(x+1.5,y+.35,.3,.25,.08,'#3a3a3a',{kind:'phone'},.55)});
SPOTS.desk=DESKS.map(([x,y])=>[x+1,y+1.65]).concat([[11.5,12.9],[14.3,12.9],[12.8,10]]);
// 서버실
[16.6,19.2].forEach(rx=>{for(let j=0;j<4;j++)B(rx,7.55+j*1.5,.9,1.3,1.55,'#2c3038',{kind:'rack',seed:j+rx})});
SPOTS.server=[[18,8.3],[18,10],[18,11.8],[20.6,8.3],[20.6,10],[20.6,11.8],[18,13.3]];
// 라운지
B(.6,14.55,3.2,.4,.95,'#6c7fa3');B(.6,14.95,3.2,.9,.42,'#7f91b5');
B(5.2,14.6,.4,3,.95,'#6c7fa3');B(4.35,14.6,.85,3,.42,'#7f91b5');
B(1.4,16.7,1.8,.8,.3,'#a46f40');B(6.4,18.6,.75,.6,1.15,'#3f3f44',{kind:'coffee'});
SPOTS.lounge=[[1.1,16.2],[2.2,16.2],[3.3,16.2],[3.7,17.4],[1,18.3],[2.4,18.4],[5.6,18.8],[4.2,19]];
// 내 자리
B(9.5,15.15,3.8,1.2,.6,'#6d4c35');B(10.9,15.2,1.1,.08,.72,'#22252b',{kind:'mon'},.6);
SPOTS.boss=[[10.1,17.3],[11.4,17.6],[12.7,17.3],[13.9,17.6],[9.2,18.7],[14.8,18.7]];
const USER={x:11.45,y:14.75};
// 엘리베이터
const ELEV=B(18.5,14.2,2.8,1.15,2.45,'#b9bfc9',{kind:'elev'});
const SPAWN=[19.9,16.1];
SPOTS.elevator=[[17.3,16.9],[18.5,17.7],[19.7,18.4],[20.9,17.3],[17.6,18.9]];
// 화분
[[7.25,.55],[13.45,6.4],[9.5,13.45],[15.5,7.4],[.5,13.4],[7.3,19.3],[15.4,19.3],[21.4,6.45],[21.4,13.45],[14,.6]].forEach(([x,y])=>OBJ.push({kind:'plant',x,y,w:.4,d:.4,h:.8,z:0}));
// 칸막이
function wallSegs(){const segs=[];const hz=(y,gaps)=>{for(let x=0;x<22;x++)if(!gaps.includes(x))segs.push([x,y-.06,1,.12])};
 const vt=(x,y0,y1,gaps)=>{for(let y=y0;y<=y1;y++)if(!gaps.includes(y))segs.push([x-.06,y,.12,1])};
 hz(7,[3,4,11,12,17,18]);hz(14,[3,4,11,12,18,19]);vt(8,0,6,[3,4]);vt(14,0,6,[3,4]);vt(10,7,13,[9,10]);vt(16,7,13,[9,10]);vt(8,14,19,[16,17]);vt(16,14,19,[16,17]);
 segs.forEach(([x,y,w,d])=>OBJ.push({x,y,z:0,w,d,h:.42,top:'#d7dde5',left:'#c6ced8',right:'#b8c1cc',kind:'wall'}));}
wallSegs();

// ───────── 상태 ─────────
let DATA=null,clientOff=0,curFloor=null,selChar=null,firstLoad=true;
const chars=new Map();const departed=new Set();let elevOpenUntil=0;
const view={zoom:1,px:0,py:0};
const cv=$('cv'),ctx=cv.getContext('2d');
function serverNow(){return Date.now()-clientOff}

// ───────── 그리기 ─────────
function poly(pts,fill,stroke){ctx.beginPath();pts.forEach((p,i)=>i?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]));ctx.closePath();ctx.fillStyle=fill;ctx.fill();if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=.6;ctx.stroke()}}
function drawBox(o){const {x,y,z,w,d,h}=o;
 poly([iso(x,y+d,z),iso(x+w,y+d,z),iso(x+w,y+d,z+h),iso(x,y+d,z+h)],o.left,'#00000014');
 poly([iso(x+w,y,z),iso(x+w,y+d,z),iso(x+w,y+d,z+h),iso(x+w,y,z+h)],o.right,'#00000014');
 poly([iso(x,y,z+h),iso(x+w,y,z+h),iso(x+w,y+d,z+h),iso(x,y+d,z+h)],o.top,'#00000014');}
// 박스의 앞(+y)면을 0..100 좌표로 쓰기
function faceY(o,fn,z0,z1){const zt=o.z+(z1==null?o.h:z1),zb=o.z+(z0||0);const O=iso(o.x,o.y+o.d,zt),U=iso(o.x+o.w,o.y+o.d,zt);
 ctx.save();ctx.transform((U[0]-O[0])/100,(U[1]-O[1])/100,0,(zt-zb)*ZH/100,O[0],O[1]);fn();ctx.restore()}
function faceX(o,fn){const O=iso(o.x+o.w,o.y,o.z+o.h),U=iso(o.x+o.w,o.y+o.d,o.z+o.h);ctx.save();ctx.transform((U[0]-O[0])/100,(U[1]-O[1])/100,0,o.h*ZH/100,O[0],O[1]);fn();ctx.restore()}

function busy(cat){for(const c of chars.values())if(c.room===cat&&!c.path.length&&c.data&&c.data.state==='working')return true;return false}
function occupantAt(cat,idx){for(const c of chars.values())if(c.room===cat&&c.spotIdx===idx&&!c.path.length&&c.data&&c.data.state==='working')return c;return null}
function floorTodos(){const f=curFloorData();if(!f)return null;let best=null;for(const s of f.sessions)if(s.todos&&s.todos.length&&(!best||s.lastTs>best.lastTs))best=s;return best}

function drawObj(o,t){
 if(o.kind==='plant'){const [sx,sy]=iso(o.x+.2,o.y+.2,0);ctx.fillStyle='#b5754a';ctx.fillRect(sx-5,sy-9,10,9);ctx.fillStyle='#4f9d5a';
  [[0,-20,9],[-6,-15,7],[6,-15,7],[0,-27,6]].forEach(([dx,dy,r])=>{ctx.beginPath();ctx.arc(sx+dx,sy+dy,r,0,7);ctx.fill()});ctx.fillStyle='#3f8a4b';ctx.beginPath();ctx.arc(sx+3,sy-17,4,0,7);ctx.fill();return}
 drawBox(o);
 if(o.kind==='shelf'){faceY(o,()=>{const cols=['#d97757','#3b82f6','#22a35a','#e5a000','#8b5cf6','#e04f3f','#14b8a6'];
   for(let r=0;r<4;r++){ctx.fillStyle='#6e4526';ctx.fillRect(0,r*25+22,100,3);for(let b=0;b<9;b++){ctx.fillStyle=cols[(b*3+r+o.seed)%7];const hh=13+((b+r+o.seed)%3)*3;ctx.fillRect(6+b*10,r*25+22-hh,8,hh)}}})}
 else if(o.kind==='board'){faceY(o,()=>{ctx.strokeStyle='#9aa3ae';ctx.lineWidth=2;ctx.strokeRect(2,3,96,94);const s=floorTodos();ctx.fillStyle='#2b4d8a';ctx.font='bold 13px sans-serif';ctx.fillText('TODO',6,18);
   if(s){s.todos.slice(0,4).forEach((td,i)=>{ctx.fillStyle=td.status==='completed'?'#22a35a':td.status==='in_progress'?'#d97757':'#555';ctx.font='11px sans-serif';ctx.fillText((td.status==='completed'?'☑ ':td.status==='in_progress'?'▶ ':'☐ ')+cutS(td.text,16),6,36+i*16)})}
   else{ctx.fillStyle='#b7bec8';for(let i=0;i<4;i++)ctx.fillRect(8,30+i*15,40+(i*17)%40,3)}})}
 else if(o.kind==='kiosk'){const occ=occupantAt('web',o.seed);faceY(o,()=>{ctx.fillStyle=occ?'#5fb3ff':'#1d4f7a';ctx.fillRect(10,8,80,45);ctx.fillStyle='#ffffffcc';ctx.font='22px sans-serif';ctx.fillText('🌐',36,40);
   if(occ){ctx.fillStyle='#ffffff99';const k=(performance.now()/120)%30;ctx.fillRect(14,46-k%10,60,2)}})}
 else if(o.kind==='imac'){const occ=occupantAt('dev',o.idx);faceY(o,()=>{ctx.fillStyle=occ?'#1e2430':'#2f3540';ctx.fillRect(6,6,88,70);
   if(occ){const t=performance.now()/90;const cols=['#7ee787','#79c0ff','#ffa657','#d2a8ff','#ff7b72'];for(let i=0;i<7;i++){const k=Math.floor(t)+i;ctx.fillStyle=cols[k%5];ctx.fillRect(10+(k%3)*6,10+i*9,20+(k*13)%50,4)}}
   else{ctx.fillStyle='#4a5260';ctx.fillRect(40,34,20,8)}})}
 else if(o.kind==='mon'){faceY(o,()=>{ctx.fillStyle='#3d6fa8';ctx.fillRect(6,8,88,70)})}
 else if(o.kind==='rack'){const fast=busy('server');faceX(o,()=>{const t=performance.now()/1000*(fast?7:1.2);for(let r=0;r<7;r++){ctx.fillStyle='#1b1e24';ctx.fillRect(6,6+r*13,88,10);
   for(let l=0;l<4;l++){const on=((t+hash(o.seed+':'+r+':'+l)%97/97)%1)>.5;ctx.fillStyle=on?(l===3?'#ffb020':'#3ee07a'):'#24402e';ctx.fillRect(60+l*8,9+r*13,5,4)}}})}
 else if(o.kind==='elev'){const open=Math.max(0,Math.min(1,(elevOpenUntil-performance.now())/500));faceY(o,()=>{ctx.fillStyle='#8d949f';ctx.fillRect(14,24,72,76);
   const g=open*30;ctx.fillStyle='#d5d9df';ctx.fillRect(15,25,35-g,75);ctx.fillRect(50+g,25,35-g,75);ctx.fillStyle='#1f2328';ctx.fillRect(34,6,32,13);ctx.fillStyle='#ffd36b';ctx.font='bold 10px monospace';
   const f=curFloorData();ctx.fillText('▲'+(f?f.no+'F':''),38,16)})}
 else if(o.kind==='coffee'){const [sx,sy]=iso(o.x+.4,o.y+.3,o.h);ctx.fillStyle='#ffffff88';const k=(performance.now()/600)%1;ctx.beginPath();ctx.arc(sx,sy-6-k*8,2.5,0,7);ctx.fill()}
}

function drawChar(c,t){
 const [sx,sy]=iso(c.x,c.y,0);const a=c.alpha==null?1:c.alpha;ctx.save();ctx.globalAlpha=a;
 const col=c.color;const walk=c.path.length>0;const st=c.data&&c.data.state;
 const bob=walk?Math.abs(Math.sin(t/90))*2:(st==='working'?Math.sin(t/140)*1:st==='sleep'?0:Math.sin(t/600)*.6);
 const s=c.small?.82:1;const y0=sy-bob;
 ctx.fillStyle='#0000001f';ctx.beginPath();ctx.ellipse(sx,sy,10*s,4.5*s,0,0,7);ctx.fill();
 if(selChar===c.id){ctx.strokeStyle='#d97757';ctx.lineWidth=2;ctx.beginPath();ctx.ellipse(sx,sy,14*s,6.5*s,0,0,7);ctx.stroke()}
 // 다리
 const lp=walk?Math.sin(t/90)*3:0;ctx.fillStyle='#3a3f4a';ctx.fillRect(sx-5*s,y0-9*s+lp*.3,4*s,9*s-lp*.3);ctx.fillRect(sx+1*s,y0-9*s-lp*.3,4*s,9*s+lp*.3);
 // 몸
 ctx.fillStyle=col;rr(sx-8*s,y0-25*s,16*s,17*s,5*s);ctx.fill();
 ctx.fillStyle=shade(col,-.15);ctx.fillRect(sx-8*s,y0-12*s,16*s,3*s);
 if(c.kind==='claude'){ctx.fillStyle='#fff';ctx.font='bold '+(c.agent==='codex'?7*s:8*s)+'px monospace';ctx.textAlign='center';ctx.fillText(c.agent==='codex'?'>_':'✳',sx,y0-14*s);ctx.textAlign='left'}
 // 팔
 ctx.fillStyle=shade(col,-.08);
 if(st==='thinking'){ctx.fillRect(sx+6*s,y0-24*s,4*s,10*s);}
 else if(st==='waiting'){ctx.fillRect(sx+7*s,y0-38*s,4*s,15*s);ctx.fillStyle='#f2cfae';ctx.beginPath();ctx.arc(sx+9*s,y0-39*s,3*s,0,7);ctx.fill()}
 else if(st==='working'&&!walk){const k=Math.sin(t/70)>0?1:-1;ctx.fillRect(sx-11*s,y0-21*s+k,4*s,8*s);ctx.fillRect(sx+7*s,y0-21*s-k,4*s,8*s)}
 else{ctx.fillRect(sx-11*s,y0-23*s,4*s,11*s);ctx.fillRect(sx+7*s,y0-23*s,4*s,11*s)}
 // 머리
 const hx=sx,hy=y0-32*s;ctx.fillStyle='#f2cfae';ctx.beginPath();ctx.arc(hx,hy,8*s,0,7);ctx.fill();
 ctx.fillStyle=c.hair;ctx.beginPath();ctx.arc(hx,hy-1*s,8.3*s,Math.PI*1.02,Math.PI*1.98);ctx.fill();
 if(st==='thinking'){ctx.fillStyle='#f2cfae';ctx.beginPath();ctx.arc(hx+6*s,hy+7*s,3*s,0,7);ctx.fill()}
 // 눈
 ctx.fillStyle='#2b2118';if(st==='sleep'){ctx.fillRect(hx-4*s,hy+1*s,3*s,1);ctx.fillRect(hx+1.5*s,hy+1*s,3*s,1)}else{ctx.fillRect(hx-3.5*s,hy,2*s,2.2*s);ctx.fillRect(hx+1.8*s,hy,2*s,2.2*s)}
 if(c.type==='Explore'){ctx.fillStyle='#1f6e3d';ctx.beginPath();ctx.arc(hx,hy-3*s,8.6*s,Math.PI,0);ctx.fill();ctx.fillRect(hx-2*s,hy-4*s,12*s,2.5*s)}
 if(c.type==='Plan'){ctx.strokeStyle='#2b2118';ctx.lineWidth=1;ctx.beginPath();ctx.arc(hx-2.6*s,hy+1*s,2.6*s,0,7);ctx.moveTo(hx+5.2*s,hy+1*s);ctx.arc(hx+2.6*s,hy+1*s,2.6*s,0,7);ctx.stroke()}
 // 식은땀
 if(c.errOn){ctx.fillStyle='#5fb3ff';const k=(t/400)%1;ctx.beginPath();ctx.moveTo(hx+9*s,hy-6*s+k*6);ctx.quadraticCurveTo(hx+12*s,hy-1*s+k*6,hx+9*s,hy+1*s+k*6);ctx.quadraticCurveTo(hx+6*s,hy-1*s+k*6,hx+9*s,hy-6*s+k*6);ctx.fill()}
 if(st==='sleep'){ctx.fillStyle='#8a93a0';ctx.font='bold 10px sans-serif';const k=(t/900)%1;ctx.globalAlpha=a*(1-k);ctx.fillText('z',hx+8+k*6,hy-10-k*10)}
 ctx.restore();
}
function rr(x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath()}
function drawUser(t){const [sx,sy]=iso(USER.x,USER.y,0);ctx.fillStyle='#55606e';rr(sx-9,sy-27,18,18,6);ctx.fill();ctx.fillStyle='#f2cfae';ctx.beginPath();ctx.arc(sx,sy-34,8,0,7);ctx.fill();ctx.fillStyle='#2b2b2b';ctx.beginPath();ctx.arc(sx,sy-35,8.4,Math.PI,0);ctx.fill();
 ctx.fillStyle='#fff';ctx.strokeStyle='#d0d4da';rr(sx-11,sy-58,22,13,6);ctx.fill();ctx.stroke();ctx.fillStyle='#333';ctx.font='bold 9px sans-serif';ctx.textAlign='center';ctx.fillText('나',sx,sy-48.5);ctx.textAlign='left'}

let cam={s:1,ox:0,oy:0};
function layout(){const r=cv.getBoundingClientRect();const dpr=window.devicePixelRatio||1;if(cv.width!==Math.round(r.width*dpr)||cv.height!==Math.round(r.height*dpr)){cv.width=Math.round(r.width*dpr);cv.height=Math.round(r.height*dpr)}
 const fit=Math.min(r.width/930,r.height/520);cam.s=fit*view.zoom;cam.ox=r.width/2-((484-440)/2)*cam.s+view.px;cam.oy=r.height/2-(212)*cam.s+view.py+10;return {r,dpr}}
function frame(t){
 const {r,dpr}=layout();ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,r.width,r.height);
 ctx.setTransform(dpr*cam.s,0,0,dpr*cam.s,dpr*cam.ox,dpr*cam.oy);
 // 바닥 그림자 판
 poly([iso(-.3,-.3,0),iso(22.3,-.3,0),iso(22.3,20.3,0),iso(-.3,20.3,0)],'#00000010');
 for(const k in ROOMS){const R=ROOMS[k];poly([iso(R.x0,R.y0),iso(R.x1+1,R.y0),iso(R.x1+1,R.y1+1),iso(R.x0,R.y1+1)],R.f);
  ctx.strokeStyle='#0000000b';ctx.lineWidth=.5;ctx.beginPath();for(let x=R.x0+1;x<=R.x1;x++){const a=iso(x,R.y0),b=iso(x,R.y1+1);ctx.moveTo(a[0],a[1]);ctx.lineTo(b[0],b[1])}for(let y=R.y0+1;y<=R.y1;y++){const a=iso(R.x0,y),b=iso(R.x1+1,y);ctx.moveTo(a[0],a[1]);ctx.lineTo(b[0],b[1])}ctx.stroke();
  const p=iso(R.x0+.25,R.y1+.75);ctx.font='bold 10px sans-serif';const w=ctx.measureText(R.n).width+12;ctx.fillStyle='#ffffffd9';rr(p[0]-2,p[1]-11,w,16,8);ctx.fill();ctx.fillStyle='#4b5563';ctx.fillText(R.n,p[0]+4,p[1]+1)}
 // 뒷벽
 drawBox({x:0,y:-.3,z:0,w:22,d:.3,h:1.8,top:'#f4f1ec',left:'#e9e4dc',right:'#ddd6cb'});
 drawBox({x:-.3,y:0,z:0,w:.3,d:20,h:1.8,top:'#f4f1ec',left:'#e9e4dc',right:'#e2dbd0'});
 // 창문
 [[2.5],[10],[17]].forEach(([x])=>faceY({x,y:-.3,z:0,w:3,d:.3,h:1.8},()=>{ctx.fillStyle=skyCol();ctx.fillRect(8,14,84,46);ctx.fillStyle='#fff';ctx.fillRect(48,14,4,46)}));
 // 정렬해서 그리기
 const list=[];for(const o of OBJ)list.push({k:o.x+o.w/2+o.y+o.d/2,o});
 list.push({k:USER.x+USER.y,u:1});for(const c of chars.values())list.push({k:c.x+c.y+.3,c});
 list.sort((a,b)=>a.k-b.k);
 for(const it of list){if(it.o)drawObj(it.o,t);else if(it.u)drawUser(t);else drawChar(it.c,t)}
 positionLabels();
}
function skyCol(){const h=new Date().getHours();return h<6||h>=19?'#24365e':h===18||h===6?'#f2a86f':'#a8d8f4'}

// ───────── 캐릭터 ─────────
function makeChar(id,kind,type,sessionId,agent){const a=kind==='claude'?(AGENT[agent]||AGENT.claude):agentOf(type);const hairs=['#3b2a20','#6b4226','#1f1f24','#a0673a','#d9b36c','#55565c'];
 const el=document.createElement('div');el.className='lab';el.innerHTML='<div class="bb"></div>';el.onclick=e=>{e.stopPropagation();selectChar(id)};$('labs').appendChild(el);
 return {id,kind,type,sessionId,agent:agent||'claude',color:a.c,hair:hairs[hash(id)%6],x:SPAWN[0],y:SPAWN[1],path:[],room:null,spotIdx:null,phase:'work',el,alpha:1,small:kind==='sub',say:null,sayUntil:0,data:null,token:0}}
function goTo(c,x,y,instant){if(c.tx!=null&&Math.abs(c.tx-x)<.01&&Math.abs(c.ty-y)<.01&&!instant)return;c.tx=x;c.ty=y;
 if(instant){c.x=x;c.y=y;c.path=[];return}c.path=[[x,c.y],[x,y]]}
function removeChar(c){c.el.remove();chars.delete(c.id);if(selChar===c.id)selChar=null}
function leave(c,msg){if(c.phase==='leaving')return;c.phase='leaving';c.room='elevator';c.spotIdx=null;if(msg){c.say=msg;c.sayUntil=performance.now()+4000}
 goTo(c,SPAWN[0],SPAWN[1]);c.onArrive=()=>{elevOpenUntil=performance.now()+1400;c.fading=performance.now()}}
function say(c,msg,ms){c.say=msg;c.sayUntil=performance.now()+(ms||2500)}

let last=performance.now();
function tick(t){const dt=Math.min(.05,(t-last)/1000);last=t;
 for(const c of [...chars.values()]){
  if(c.path.length){const [px,py]=c.path[0];const dx=px-c.x,dy=py-c.y,dd=Math.hypot(dx,dy),sp=3.6*dt;if(dd<=sp){c.x=px;c.y=py;c.path.shift();if(!c.path.length&&c.onArrive){const f=c.onArrive;c.onArrive=null;f()}}else{c.x+=dx/dd*sp;c.y+=dy/dd*sp}}
  if(c.fading){c.alpha=Math.max(0,1-(t-c.fading)/700);if(c.alpha<=0){if(c.kind==='sub')departed.add(c.id);removeChar(c)}}
  c.errOn=!!(c.data&&c.data.lastError&&serverNow()-c.data.lastError.ts<8000);
 }
 frame(t);requestAnimationFrame(tick)}

function bubbleOf(c){const d=c.data||{};const now=performance.now();
 if(c.say&&c.sayUntil>now)return {cls:'say',t:c.say};
 if(c.errOn)return {cls:'err',t:'💦 '+toolName(d.lastError.tool)+' 실패 · '+cutS(d.lastError.text,40)};
 if(c.phase==='leaving')return {cls:'say',t:'👋 퇴근합니다!'};
 if(c.phase==='report')return {cls:'say',t:'📄 결과 보고하러 가는 중'};
 if(d.state==='working'){if(d.tool==='Agent'||d.tool==='Task'||d.tool==='spawn_agent')return {cls:'',t:'📞 '+agentOf(d.subType).n+' 호출 · '+(d.detail||'')};return {cls:'',t:(CAT_ICON[d.cat]||'🛠')+' '+toolName(d.tool)+(d.detail?' · '+d.detail:'')}}
 if(d.state==='waiting'){if(d.tool==='AskUserQuestion'||/request_user_input/.test(d.tool))return {cls:'wait',t:'❓ 물어볼 게 있어요 · '+(d.detail||'')};if(d.tool==='ExitPlanMode')return {cls:'wait',t:'📋 계획 확인해 주세요'};return {cls:'wait',t:'✋ 승인 기다리는 중? · '+toolName(d.tool)+' '+(d.detail||'')}}
 if(d.state==='thinking')return {cls:'cloud',t:d.thinkingText?'💭 '+d.thinkingText:'💭 고민 중…'};
 if(d.state==='sleep')return {cls:'mute',t:'💤'};
 if(d.state==='done')return {cls:'say',t:'✅ 완료'};
 if(d.cat==='lounge')return {cls:'mute',t:'☕ 쉬는 중'};
 return {cls:'mute',t:'💬 다음 지시 기다리는 중'}}
function nameOf(c){const d=c.data||{};if(c.kind==='claude')return (AGENT[c.agent]||AGENT.claude).n+(c.label?' '+c.label:'')+' · '+cutS(d.title||'새 세션',18);return agentOf(c.type).n+' · '+cutS(d.desc||'',18)}
function positionLabels(){const sc=Math.max(.75,Math.min(1.1,cam.s));const L=[];
 for(const c of chars.values()){const [sx,sy]=iso(c.x,c.y,0);const X=sx*cam.s+cam.ox,Y=(sy-(c.small?38:46))*cam.s+cam.oy;
  const b=bubbleOf(c);const key=b.cls+'|'+b.t+'|'+nameOf(c);if(c._k!==key){c._k=key;c.el.firstChild.className='bb '+b.cls;c.el.firstChild.innerHTML='<span class="nm">'+esc(nameOf(c))+'</span>'+esc(b.t);c._w=0}
  if(!c._w){c._w=c.el.offsetWidth;c._h=c.el.offsetHeight}
  L.push({c,X,Y,w:c._w*sc,h:c._h*sc})}
 // 말풍선끼리 겹치면 위로 밀어 올리기
 L.sort((a,b)=>b.Y-a.Y);const placed=[];
 for(const l of L){let y=l.Y,moved=true,guard=0;while(moved&&guard++<20){moved=false;for(const p of placed){if(Math.abs(p.X-l.X)<(p.w+l.w)/2+2&&y>p.y-p.h-2&&y-l.h<p.y+2){y=p.y-p.h-3;moved=true}}}
  placed.push({X:l.X,y,w:l.w,h:l.h});const c=l.c;
  c.el.style.transform='translate('+l.X+'px,'+y+'px) translate(-50%,-100%) scale('+sc+')';c.el.style.opacity=c.alpha;c.el.classList.toggle('sel',selChar===c.id);c.el.style.zIndex=selChar===c.id?9999:Math.round((c.x+c.y)*10)}}

// ───────── 데이터 반영 ─────────
function curFloorData(){return DATA&&DATA.floors.find(f=>f.key===curFloor)}
function roomFor(c){const d=c.data;if(!d)return 'desk';
 if(d.state==='working')return d.cat||'desk';if(d.state==='waiting')return 'boss';
 if(d.state==='thinking')return c.room&&c.room!=='elevator'?c.room:(c.kind==='claude'?'desk':'library');
 if(c.kind==='sub')return c.room&&c.room!=='elevator'?c.room:'library';
 return d.cat||'lounge'}
function apply(){
 const floors=DATA.floors;floors.forEach((f,i)=>f.no=i+1);
 // 층 선택
 const liveFloors=floors.filter(f=>f.sessions.some(sessionLive));
 if($('follow').checked||!curFloor||!floors.find(f=>f.key===curFloor)){
  let best=null,bt=0;for(const f of floors)for(const s of f.sessions){const t=Math.max(s.lastTs,s.mtimeMs);if(t>bt){bt=t;best=f}}
  if(!best)best=floors[floors.length-1];if(best&&best.key!==curFloor)switchFloor(best.key,!firstLoad)}
 const f=curFloorData();const instant=firstLoad||floorJustSwitched;floorJustSwitched=false;firstLoad=false;
 const want=new Set();
 if(f){const sess=f.sessions.slice().sort((a,b)=>a.id<b.id?-1:1);
  sess.forEach((s,i)=>{const id='c:'+s.id;want.add(id);let c=chars.get(id);
   if(!c){c=makeChar(id,'claude','claude',s.id,s.agent);chars.set(id,c);if(!instant){elevOpenUntil=performance.now()+1400;say(c,'🏢 출근!',1800)}}
   c.data=s;c.home=i;const same=sess.filter(x=>x.agent===s.agent);c.label=same.length>1?String(same.indexOf(s)+1):'';
   for(const sb of s.subs){const sid='s:'+sb.id;if(departed.has(sid))continue;want.add(sid);let k=chars.get(sid);
    if(!k){if(sb.done&&instant){departed.add(sid);continue}k=makeChar(sid,'sub',sb.type,s.id);chars.set(sid,k);if(!instant){elevOpenUntil=performance.now()+1400;say(k,'🛗 출근했습니다',1800)}}
    k.data=sb;k.type=sb.type;k.color=agentOf(sb.type).c}});}
 for(const c of [...chars.values()])if(!want.has(c.id)){if(instant)removeChar(c);else if(c.phase!=='leaving')leave(c,c.kind==='sub'?'👋 퇴근합니다!':'🏠 퇴근')}
 // 자리 배정
 const occ={};const take=(r,i)=>{(occ[r]=occ[r]||new Set()).add(i)};const has=(r,i)=>occ[r]&&occ[r].has(i);
 const list=[...chars.values()].filter(c=>c.phase!=='leaving').sort((a,b)=>(a.kind===b.kind?(a.id<b.id?-1:1):a.kind==='claude'?-1:1));
 for(const c of list){
  if(c.kind==='sub'&&c.data&&c.data.done){if(c.phase!=='report'){c.phase='report';const tok=++c.token;const p=chars.get('c:'+c.sessionId);const px=p?p.tx||p.x:12,py=p?p.ty||p.y:10;c.room='report';c.spotIdx=null;
    goTo(c,px+.75,py+.55,instant);c.onArrive=()=>{if(c.token!==tok)return;say(c,'📄 결과 보고드립니다',2000);setTimeout(()=>{if(c.token===tok)leave(c)},2000)};if(instant)c.onArrive()}continue}
  if(c.phase==='report'){c.phase='work';c.token++;c.onArrive=null;say(c,'🔁 일 하나 더 받았어요',2200)}
  let room=roomFor(c);
  if(room==='desk'&&c.kind==='claude'){const i=c.home%SPOTS.desk.length;take('desk',i);c.room='desk';c.spotIdx=i;const sp=SPOTS.desk[i];goTo(c,sp[0],sp[1],instant);continue}
 }
 for(const c of list){if(c.phase!=='work')continue;let room=roomFor(c);if(room==='desk'&&c.kind==='claude')continue;
  if(room==='desk')room='library';
  const spots=SPOTS[room]||SPOTS.lounge;let idx=null;
  if(c.room===room&&c.spotIdx!=null&&!has(room,c.spotIdx))idx=c.spotIdx;
  else{const st=hash(c.id)%spots.length;for(let k=0;k<spots.length;k++){const j=(st+k)%spots.length;if(!has(room,j)){idx=j;break}}}
  let x,y;if(idx==null){const R=ROOMS[room];x=R.x0+1+Math.random()*(R.x1-R.x0-1);y=R.y1-.5;}else{take(room,idx);[x,y]=spots[idx]}
  c.room=room;c.spotIdx=idx;goTo(c,x,y,instant)}
 renderPanels();
}
let floorJustSwitched=false;
function switchFloor(key,anim){curFloor=key;floorJustSwitched=true;for(const c of [...chars.values()])removeChar(c);selChar=null;
 const f=curFloorData();if(anim&&f){const e=$('elev');e.textContent='▲ '+f.no+'F';e.classList.add('on');setTimeout(()=>e.classList.remove('on'),1100)}}

// ───────── 패널 ─────────
function renderPanels(){
 const now=serverNow();const floors=DATA.floors;const f=curFloorData();
 $('floors').innerHTML=floors.slice().reverse().map(fl=>{const live=fl.sessions.some(sessionLive);const sel=fl.key===curFloor;
  const n=fl.sessions.length,subs=fl.sessions.reduce((a,s)=>a+s.subs.length,0);
  const tags=(fl.agents||[]).map(a=>'<b style="color:'+AGENT[a].c+'">'+(a==='codex'?'&gt;_':'✳')+'</b>').join(' ');
  const sub=tags+' '+(n?(n+'명 근무'+(subs?' · 서브 '+subs:'')):'불 꺼짐 · '+ago(now-fl.lastActive)+' 전');
  let h='<div class="fl'+(live?' live':'')+(sel?' sel':'')+(!n?' dark':'')+'" data-k="'+esc(fl.key)+'"><div class="row"><span class="no">'+fl.no+'F</span><div style="min-width:0"><div class="nm">'+esc(fl.name)+'</div><div class="sub">'+sub+'</div></div><span class="lamp"></span></div>';
  if(sel&&n)h+='<div class="ss">'+fl.sessions.map(s=>'<div class="si" data-c="c:'+esc(s.id)+'"><span class="d" style="background:'+ST_C[s.state]+'"></span><span class="t">'+esc(s.title||'새 세션')+'</span><span class="a">'+ST_KO[s.state]+'</span></div>').join('')+'</div>';
  return h+'</div>'}).join('')||'<div class="empty">최근 '+DATA.floorDays+'일 동안 쓴 프로젝트가 없어요</div>';
 $('floors').querySelectorAll('.fl').forEach(el=>el.onclick=e=>{const si=e.target.closest('.si');if(si){selectChar(si.dataset.c);return}
  if(el.dataset.k!==curFloor){$('follow').checked=false;switchFloor(el.dataset.k,true);apply()}});
 $('older').textContent=DATA.olderFloors?'💤 '+DATA.floorDays+'일 넘게 불 꺼진 층 '+DATA.olderFloors+'개는 숨겼어요':'';
 // 상단 배지 / 빈 층
 if(f){const n=f.sessions.length;$('badge').innerHTML='<b class="no">'+f.no+'F</b><b>'+esc(f.name)+'</b><span style="color:var(--muted)">'+(n?n+'명 근무':'불 꺼짐')+'</span>'+(n?'<span class="live">● LIVE</span>':'');
  $('dim').style.display=n?'none':'grid';$('dim').innerHTML='<div>🌙 이 층은 불이 꺼져 있어요<br><small>마지막 활동 '+ago(now-f.lastActive)+' 전</small></div>';
  $('rtitle').innerHTML='🏢 '+esc(f.name)+' <small style="font-weight:400;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(f.cwd||'')+'</small>'}
 else{$('badge').textContent='출근한 에이전트가 없어요';$('dim').style.display='grid';$('dim').innerHTML='<div>'+(DATA.rootExists?'🪑 최근 '+DATA.floorDays+'일 동안 쓴 프로젝트가 없어요':'세션 폴더를 찾지 못했어요<br><small>'+esc([DATA.roots.claude,DATA.roots.codex].filter(Boolean).join(' / '))+'</small>')+'</div>'}
 // 사람들
 const ppl=[...chars.values()].filter(c=>c.phase!=='leaving').sort((a,b)=>(a.sessionId+(a.kind==='claude'?'0':'1')+a.id)<(b.sessionId+(b.kind==='claude'?'0':'1')+b.id)?-1:1);
 $('pcount').textContent=ppl.length+'명';
 $('people').innerHTML=ppl.map(c=>{const d=c.data||{};const st=d.state||'idle';const b=bubbleOf(c);
  return '<div class="pp'+(selChar===c.id?' sel':'')+'" data-c="'+esc(c.id)+'" style="'+(c.kind==='sub'?'padding-left:24px':'')+'"><span class="av" style="background:'+c.color+'">'+(c.kind==='claude'?(c.agent==='codex'?'&gt;_':'✳'):agentOf(c.type).n[0])+'</span><span class="tx"><b>'+esc(nameOf(c))+'</b><i>'+esc(b.t)+'</i></span><span class="chip" style="background:color-mix(in srgb,'+ST_C[st]+' 18%,transparent);color:'+ST_C[st]+'">'+ST_KO[st]+'</span></div>'}).join('')||'<div class="empty">아무도 없어요</div>';
 $('people').querySelectorAll('.pp').forEach(el=>el.onclick=()=>selectChar(el.dataset.c));
 // 화이트보드
 const ts=floorTodos();$('todoCard').style.display=ts?'':'none';
 if(ts){$('todoOwner').textContent=cutS(ts.title,20);$('todos').innerHTML=ts.todos.map(t=>'<div class="todo"><span>'+(t.status==='completed'?'✅':t.status==='in_progress'?'▶️':'⬜')+'</span><span style="'+(t.status==='completed'?'color:var(--muted);text-decoration:line-through':'')+'">'+esc(t.text)+'</span></div>').join('')}
 // 로그
 const sc=selChar&&chars.get(selChar);let evs=[],owner='';
 if(sc&&sc.data){evs=sc.data.events||[];owner=nameOf(sc)}
 else if(f){f.sessions.forEach(s=>{(s.events||[]).forEach(e=>evs.push(Object.assign({who:(AGENT[s.agent]||AGENT.claude).n},e)));s.subs.forEach(sb=>(sb.events||[]).forEach(e=>evs.push(Object.assign({who:agentOf(sb.type).n},e))))});evs.sort((a,b)=>a.ts-b.ts);evs=evs.slice(-60);owner='층 전체'}
 const IC={user:'🧑',say:'💬',tool:'🛠',err:'💦',stop:'✋',cmd:'⌘',think:'💭'};
 $('logOwner').textContent=owner;
 $('log').innerHTML=evs.slice().reverse().map(e=>'<div class="ev '+e.kind+'"><span class="tm">'+(e.ts?hhmm(e.ts):'')+'</span><span>'+(IC[e.kind]||'·')+'</span><span class="tx">'+(e.who&&!sc?'<b style="color:var(--muted);font-weight:600">'+esc(e.who)+'</b> ':'')+(e.kind==='tool'?'<span class="tl">'+esc(e.tool)+'</span>':'')+esc(e.text)+'</span></div>').join('')||'<div class="empty">기록 없음</div>';
}
function selectChar(id){selChar=selChar===id?null:id;renderPanels()}
cv.addEventListener('click',()=>{if(!moved&&selChar){selChar=null;renderPanels()}});

// ───────── 카메라 조작 ─────────
let drag=null,moved=false;
cv.addEventListener('mousedown',e=>{drag={x:e.clientX,y:e.clientY,px:view.px,py:view.py};moved=false;cv.classList.add('drag')});
addEventListener('mousemove',e=>{if(!drag)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.abs(dx)+Math.abs(dy)>3)moved=true;view.px=drag.px+dx;view.py=drag.py+dy});
addEventListener('mouseup',()=>{drag=null;cv.classList.remove('drag')});
cv.addEventListener('wheel',e=>{e.preventDefault();view.zoom=Math.max(.5,Math.min(3,view.zoom*(e.deltaY<0?1.1:.9)))},{passive:false});
$('zi').onclick=()=>view.zoom=Math.min(3,view.zoom*1.2);$('zo').onclick=()=>view.zoom=Math.max(.5,view.zoom/1.2);$('zf').onclick=()=>{view.zoom=1;view.px=0;view.py=0};
$('follow').onchange=()=>{if(DATA)apply()};

// ───────── 폴링 ─────────
let inflight=false;
async function poll(){if(inflight)return;inflight=true;try{const r=await fetch('/api/state');const d=await r.json();clientOff=Date.now()-d.now;DATA=d;apply()}catch(e){$('badge').textContent='⚠️ 서버 연결 끊김 — node agent-office.mjs 실행 중인지 확인'}finally{inflight=false}}
poll();setInterval(poll,500);requestAnimationFrame(tick);
</script></body></html>`;
