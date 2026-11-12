// OpenSpec tasks.md 解析。约定（仍是合法的 OpenSpec 勾选清单）：
//   - [ ] T-1 实现 importUsers（AC-1, AC-2, S-1）
//   - [x] T-2 入口加管理员校验（AC-3）依赖 T-1
// 引用：AC-n（验收标准）、S-n（design.md 结构变更）；依赖：「依赖 / depends on」后列出 T-n。

export interface ParsedTask {
  id: string;
  title: string;
  done: boolean;
  acRefs: string[];
  structureRefs: string[];
  dependsOn: string[];
  line: number;
}

export interface ParsedTasks {
  file: string;
  tasks: ParsedTask[];
  /** 勾选清单中没有 T-n 编号的条目 */
  malformed: { line: number; text: string }[];
}

const CHECKBOX_RE = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/;
const TASK_ID_RE = /^(T-\d+)\b\s*(.*)$/;
const DEPENDS_RE = /(?:依赖|depends\s+on)\s*[:：]?\s*((?:T-\d+\s*[,，、]?\s*)+)/i;

function refs(text: string, re: RegExp): string[] {
  return [...new Set(text.match(re) ?? [])];
}

export function parseTasks(file: string, text: string): ParsedTasks {
  const out: ParsedTasks = { file, tasks: [], malformed: [] };
  text.split('\n').forEach((raw, i) => {
    const box = CHECKBOX_RE.exec(raw);
    if (!box) return;
    const body = box[2]!.trim();
    const m = TASK_ID_RE.exec(body);
    if (!m) {
      out.malformed.push({ line: i + 1, text: body });
      return;
    }
    const rest = m[2]!;
    const dep = DEPENDS_RE.exec(rest);
    const dependsOn = dep ? refs(dep[1]!, /\bT-\d+\b/g) : [];
    const withoutDeps = dep ? rest.replace(dep[0], '') : rest;
    out.tasks.push({
      id: m[1]!,
      title: withoutDeps.trim(),
      done: box[1] !== ' ',
      acRefs: refs(withoutDeps, /\bAC-\d+\b/g),
      structureRefs: refs(withoutDeps, /\bS-\d+\b/g),
      dependsOn,
      line: i + 1,
    });
  });
  return out;
}

/** 任务结构（不含勾选状态），用于绑定哈希：勾选进度不应使 G4 失效 */
export function taskStructure(parsed: ParsedTasks): unknown {
  return parsed.tasks.map(({ id, title, acRefs, structureRefs, dependsOn }) => ({ id, title, acRefs, structureRefs, dependsOn }));
}

/** 找出依赖环；返回每个环的节点序列 */
export function findCycles(tasks: Pick<ParsedTask, 'id' | 'dependsOn'>[]): string[][] {
  const graph = new Map(tasks.map((t) => [t.id, t.dependsOn]));
  const state = new Map<string, 'visiting' | 'done'>();
  const cycles: string[][] = [];
  const stack: string[] = [];
  const visit = (id: string) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      cycles.push([...stack.slice(stack.indexOf(id)), id]);
      return;
    }
    state.set(id, 'visiting');
    stack.push(id);
    for (const dep of graph.get(id) ?? []) if (graph.has(dep)) visit(dep);
    stack.pop();
    state.set(id, 'done');
  };
  for (const t of tasks) visit(t.id);
  return cycles;
}

/** 按依赖排出执行顺序（无环时）；同层按编号顺序 */
export function executionOrder(tasks: Pick<ParsedTask, 'id' | 'dependsOn'>[]): string[] {
  const remaining = new Map(tasks.map((t) => [t.id, new Set(t.dependsOn.filter((d) => tasks.some((x) => x.id === d)))]));
  const order: string[] = [];
  while (remaining.size) {
    const ready = [...remaining].filter(([, deps]) => [...deps].every((d) => order.includes(d))).map(([id]) => id);
    if (!ready.length) throw new Error('任务依赖存在环');
    for (const id of ready) {
      order.push(id);
      remaining.delete(id);
    }
  }
  return order;
}

/** 把指定任务勾选为完成；找不到时抛错 */
export function markTaskDone(text: string, id: string): string {
  const re = new RegExp(`^(\\s*[-*]\\s+)\\[ \\](\\s+${id}\\b)`, 'm');
  if (!re.test(text)) {
    if (new RegExp(`^\\s*[-*]\\s+\\[[xX]\\]\\s+${id}\\b`, 'm').test(text)) return text;
    throw new Error(`tasks.md 中找不到未完成的任务 ${id}`);
  }
  return text.replace(re, '$1[x]$2');
}

/** 下一个可做的任务：未完成、依赖都已完成，按文档顺序取第一个 */
export function nextTask(parsed: ParsedTasks): ParsedTask | undefined {
  const done = new Set(parsed.tasks.filter((t) => t.done).map((t) => t.id));
  return parsed.tasks.find((t) => !t.done && t.dependsOn.every((d) => done.has(d)));
}
