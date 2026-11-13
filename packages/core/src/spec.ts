// OpenSpec spec.md 解析：Requirement / Scenario，Scenario 标题中带 [AC-n] 编号。

export interface ParsedScenario {
  acId?: string;
  title: string;
  line: number;
}

export interface ParsedRequirement {
  title: string;
  body: string;
  line: number;
  scenarios: ParsedScenario[];
}

export interface ParsedSpec {
  file: string;
  requirements: ParsedRequirement[];
}

const REQUIREMENT_RE = /^###\s+Requirement:\s*(.+)$/;
const SCENARIO_RE = /^####\s+Scenario:\s*(.+)$/;
const AC_RE = /\[(AC-\d+)\]/;
export const QUESTION_REF_RE = /\bQ-\d+\b/g;

export function parseSpec(file: string, text: string): ParsedSpec {
  const requirements: ParsedRequirement[] = [];
  let current: ParsedRequirement | undefined;
  text.split('\n').forEach((raw, i) => {
    const line = raw.trimEnd();
    const req = REQUIREMENT_RE.exec(line);
    if (req) {
      current = { title: req[1]!.trim(), body: '', line: i + 1, scenarios: [] };
      requirements.push(current);
      return;
    }
    if (/^##\s/.test(line)) {
      current = undefined;
      return;
    }
    const sc = SCENARIO_RE.exec(line);
    if (sc && current) {
      const title = sc[1]!.trim();
      current.scenarios.push({ acId: AC_RE.exec(title)?.[1], title, line: i + 1 });
      return;
    }
    if (current) current.body += line + '\n';
  });
  return { file, requirements };
}

export function acIdsOf(specs: ParsedSpec[]): string[] {
  return specs.flatMap((s) => s.requirements.flatMap((r) => r.scenarios.flatMap((sc) => (sc.acId ? [sc.acId] : []))));
}

export function questionRefsIn(text: string): Set<string> {
  return new Set(text.match(QUESTION_REF_RE) ?? []);
}

const OUT_OF_SCOPE_RE = /^##\s+(范围外|Out of Scope)\s*$/im;

/**
 * 在 proposal 的「## 范围外」一节末尾追加条目（T3.5 后续）：已有内容一字不改；
 * 没有这一节时在文末新建；与已有行完全相同的条目不重复追加。
 */
export function appendOutOfScope(proposal: string, items: string[]): string {
  const lines = proposal.replace(/\n+$/, '').split('\n');
  const existing = new Set(lines.map((l) => l.trim()));
  const add = items.map((i) => `- ${i.trim().replace(/^-\s*/, '')}`).filter((l) => !existing.has(l));
  if (!add.length) return proposal;
  const start = lines.findIndex((l) => OUT_OF_SCOPE_RE.test(l));
  if (start < 0) return `${lines.join('\n')}\n\n## 范围外\n${add.join('\n')}\n`;
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  // 插在本节最后一个非空行之后
  let at = end;
  while (at > start + 1 && !lines[at - 1]!.trim()) at--;
  return [...lines.slice(0, at), ...add, ...lines.slice(at)].join('\n') + '\n';
}
