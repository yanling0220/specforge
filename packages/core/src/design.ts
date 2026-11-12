// OpenSpec design.md 解析。约定（仍是合法的 OpenSpec 文档）：
// - 正文引用每个 AC 编号，说明如何实现
// - 一节「## 结构变更」，逐条列出 `- [S-n] …`；没有结构变更时写 `- 无：<原因>`

export interface StructuralChange {
  id: string;
  text: string;
  line: number;
}

export interface ParsedDesign {
  file: string;
  acRefs: Set<string>;
  /** 是否存在「结构变更」一节 */
  hasStructureSection: boolean;
  changes: StructuralChange[];
  /** 明确声明无结构变更时的原因 */
  noneReason?: string;
  /** 结构变更一节中格式不对的条目 */
  malformed: { line: number; text: string }[];
}

const STRUCTURE_HEADING_RE = /^##\s+(结构变更|Structural Changes)\s*$/i;
const ITEM_RE = /^\s*[-*]\s+(.*)$/;
const CHANGE_RE = /^\[(S-\d+)\]\s*(.+)$/;
const NONE_RE = /^(无|none)\s*[:：]\s*(.+)$/i;
const AC_REF_RE = /\bAC-\d+\b/g;

export function parseDesign(file: string, text: string): ParsedDesign {
  const out: ParsedDesign = { file, acRefs: new Set(text.match(AC_REF_RE) ?? []), hasStructureSection: false, changes: [], malformed: [] };
  let inSection = false;
  text.split('\n').forEach((raw, i) => {
    const line = raw.trimEnd();
    if (/^##\s/.test(line)) {
      inSection = STRUCTURE_HEADING_RE.test(line);
      if (inSection) out.hasStructureSection = true;
      return;
    }
    if (!inSection) return;
    const item = ITEM_RE.exec(line);
    if (!item) return;
    const body = item[1]!.trim();
    const change = CHANGE_RE.exec(body);
    const none = NONE_RE.exec(body);
    if (change) out.changes.push({ id: change[1]!, text: change[2]!.trim(), line: i + 1 });
    else if (none) out.noneReason = none[2]!.trim();
    else out.malformed.push({ line: i + 1, text: body });
  });
  return out;
}

/** 结构变更条目中提到的路径（反引号包裹，或形如 a/b.ext） */
export function pathsIn(text: string): string[] {
  const quoted = [...text.matchAll(/`([^`\s]+)`/g)].map((m) => m[1]!);
  const bare = [...text.matchAll(/(?:^|\s)((?:[\w.-]+\/)*[\w-][\w.-]*\.[A-Za-z0-9]+)(?=\s|$|[，,。:：)）])/g)].map((m) => m[1]!);
  return [...new Set([...quoted, ...bare])].filter((p) => p.includes('/') || p.includes('.'));
}
