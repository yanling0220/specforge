// 从测试运行器的输出中解析测试总数（T3.6：测试数量不得下降）。
// 支持常见运行器的汇总行；其他运行器可在配置 testReport.pattern 中给出正则（第一个捕获组为总数）。

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

const sum = (text: string, re: RegExp) => [...text.matchAll(re)].reduce((n, m) => n + Number(m[1]), 0);
const last = (text: string, re: RegExp) => [...text.matchAll(re)].at(-1);
const lastNumber = (text: string, re: RegExp) => {
  const m = last(text, re);
  return m ? Number(m[1]) : undefined;
};

interface Parser {
  name: string;
  parse(text: string): number | undefined;
}

const PARSERS: Parser[] = [
  // node --test：TAP「# tests 4」或 spec 报告「ℹ tests 4」
  { name: 'node', parse: (t) => lastNumber(t, /^[#ℹ] tests (\d+)\s*$/gm) },
  // vitest：「Tests  2 failed | 111 passed (113)」
  { name: 'vitest', parse: (t) => lastNumber(t, /^\s*Tests\s+.*\((\d+)\)\s*$/gm) },
  // jest：「Tests:       1 failed, 3 passed, 4 total」
  { name: 'jest', parse: (t) => lastNumber(t, /^Tests:\s+.*?(\d+) total/gm) },
  // pytest：「==== 3 passed, 1 skipped in 0.12s ====」
  {
    name: 'pytest',
    parse: (t) => {
      const line = last(t, /^=+ (.*?\b(?:passed|failed|skipped|errors?|xfailed|xpassed)\b.*?) in [\d.]+s/gm)?.[1];
      return line === undefined ? undefined : sum(line, /(\d+) (?:passed|failed|skipped|errors?|xfailed|xpassed)\b/g);
    },
  },
  // mocha：「5 passing」「1 failing」「2 pending」
  {
    name: 'mocha',
    parse: (t) => (/^\s*\d+ passing\b/m.test(t) ? sum(t, /^\s*(\d+) (?:passing|failing|pending)\b/gm) : undefined),
  },
  // cargo test：每个测试二进制一行「test result: ok. 3 passed; 0 failed; 1 ignored」
  {
    name: 'cargo',
    parse: (t) =>
      /^test result: /m.test(t)
        ? [...t.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/gm)].reduce((n, m) => n + Number(m[1]) + Number(m[2]) + Number(m[3]), 0)
        : undefined,
  },
];

export interface TestCount {
  total: number;
  /** 识别出的格式，或 pattern */
  format: string;
}

/** 解析测试总数；无法识别时返回 undefined。pattern 优先 */
export function parseTestCount(output: string, pattern?: string): TestCount | undefined {
  const text = output.replace(ANSI, '').replace(/\r/g, '');
  if (pattern) {
    const m = last(text, new RegExp(pattern, 'gm'));
    return m?.[1] !== undefined ? { total: Number(m[1]), format: 'pattern' } : undefined;
  }
  for (const p of PARSERS) {
    const n = p.parse(text);
    if (n !== undefined && !Number.isNaN(n)) return { total: n, format: p.name };
  }
  return undefined;
}
