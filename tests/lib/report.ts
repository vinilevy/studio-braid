import { writeFile } from 'node:fs/promises';

export type Severity = 'FAIL' | 'WARN' | 'INFO' | 'PASS';

export interface Finding {
  id: string;
  severity: Severity;
  area: string;
  title: string;
  detail?: string;
  fixHint?: string;
  evidence?: unknown;
}

export interface Table {
  title: string;
  headers: string[];
  rows: string[][];
}

export type Verdict = 'APROVADO' | 'APROVADO COM RESSALVAS' | 'REPROVADO';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = { red: paint(31), green: paint(32), yellow: paint(33), blue: paint(34), dim: paint(2), bold: paint(1), cyan: paint(36) };

const badge: Record<Severity, string> = {
  FAIL: c.red('✗ FAIL'),
  WARN: c.yellow('! WARN'),
  INFO: c.blue('i INFO'),
  PASS: c.green('✓ PASS'),
};

export class Report {
  readonly findings: Finding[] = [];
  readonly tables: Table[] = [];
  readonly facts: Record<string, unknown> = {};

  constructor(readonly tool: string, readonly subject: string, readonly strict = false) {}

  add(f: Finding): void {
    // --strict promotes every warning to a failure.
    this.findings.push(this.strict && f.severity === 'WARN' ? { ...f, severity: 'FAIL' } : f);
  }
  pass(id: string, area: string, title: string, detail?: string): void {
    this.add({ id, severity: 'PASS', area, title, detail });
  }
  fail(id: string, area: string, title: string, extra: Partial<Finding> = {}): void {
    this.add({ id, severity: 'FAIL', area, title, ...extra });
  }
  warn(id: string, area: string, title: string, extra: Partial<Finding> = {}): void {
    this.add({ id, severity: 'WARN', area, title, ...extra });
  }
  info(id: string, area: string, title: string, extra: Partial<Finding> = {}): void {
    this.add({ id, severity: 'INFO', area, title, ...extra });
  }
  table(title: string, headers: string[], rows: string[][]): void {
    this.tables.push({ title, headers, rows });
  }

  count(sev: Severity): number {
    return this.findings.filter((f) => f.severity === sev).length;
  }
  get verdict(): Verdict {
    if (this.count('FAIL') > 0) return 'REPROVADO';
    return this.count('WARN') > 0 ? 'APROVADO COM RESSALVAS' : 'APROVADO';
  }
  get exitCode(): number {
    return this.count('FAIL') > 0 ? 1 : 0;
  }

  print(): void {
    const line = c.dim('─'.repeat(78));
    console.log(`\n${line}\n${c.bold(this.tool)}  ${c.dim(this.subject)}\n${line}`);
    for (const t of this.tables) printTable(t);
    const order: Severity[] = ['FAIL', 'WARN', 'INFO', 'PASS'];
    for (const sev of order) {
      const list = this.findings.filter((f) => f.severity === sev);
      if (list.length === 0) continue;
      console.log('');
      for (const f of list) {
        console.log(`${badge[sev]}  ${c.dim(`[${f.area}]`)} ${f.title}`);
        if (f.detail) for (const l of f.detail.split('\n')) console.log(`         ${c.dim(l)}`);
        if (f.fixHint && sev !== 'PASS') console.log(`         ${c.cyan('→ correção:')} ${f.fixHint}`);
      }
    }
    const v = this.verdict;
    const colored = v === 'REPROVADO' ? c.red(v) : v === 'APROVADO' ? c.green(v) : c.yellow(v);
    console.log(`\n${line}\nVEREDITO: ${c.bold(colored)}   ${c.red(`${this.count('FAIL')} falha(s)`)} · ${c.yellow(`${this.count('WARN')} alerta(s)`)} · ${c.green(`${this.count('PASS')} ok`)}\n${line}`);
    const blockers = this.findings.filter((f) => f.severity === 'FAIL');
    if (blockers.length > 0) {
      console.log(`\n${c.bold('RELATÓRIO PARA A IA 1 (corrigir antes de nova rodada):')}`);
      blockers.forEach((f, i) => {
        console.log(`${i + 1}. [${f.id}] ${f.title}`);
        if (f.detail) for (const l of f.detail.split('\n')) console.log(`   ${l}`);
        if (f.fixHint) console.log(`   Correção sugerida: ${f.fixHint}`);
      });
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      tool: this.tool,
      subject: this.subject,
      generatedAt: new Date().toISOString(),
      strict: this.strict,
      verdict: this.verdict,
      counts: { fail: this.count('FAIL'), warn: this.count('WARN'), info: this.count('INFO'), pass: this.count('PASS') },
      facts: this.facts,
      findings: this.findings,
      tables: this.tables,
    };
  }

  async writeJson(file: string): Promise<void> {
    await writeFile(file, `${JSON.stringify(this.toJSON(), null, 2)}\n`, 'utf8');
  }
}

function printTable(t: Table): void {
  const widths = t.headers.map((h, i) => Math.max(visible(h), ...t.rows.map((r) => visible(r[i] ?? ''))));
  const fmt = (cells: string[]) => cells.map((cell, i) => cell + ' '.repeat(Math.max(0, (widths[i] ?? 0) - visible(cell)))).join('  ');
  console.log(`\n${c.bold(t.title)}`);
  console.log(c.dim(fmt(t.headers)));
  for (const r of t.rows) console.log(fmt(r));
}

// eslint-disable-next-line no-control-regex
const visible = (s: string): number => s.replace(/\x1b\[[0-9;]*m/g, '').length;

export const ms = (v: number | undefined, digits = 1): string => (v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)}ms`);
export const signedMs = (v: number | undefined, digits = 1): string =>
  v === undefined || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(digits)}ms`;
