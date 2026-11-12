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
