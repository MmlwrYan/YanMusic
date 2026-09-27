import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * CI 供应链守卫（IMP-17）。
 *
 * 复现（修复前）：`.github/workflows/build.yml` 共 12 处 `uses:` 全部为可移动引用
 * （`@v4` / `@v2` / `@stable` 分支），上游移动 tag/分支即可在无感知的情况下替换
 * 构建期执行的代码 —— 这是 GitHub Actions 供应链攻击的常见入口。
 * 现已全部固定为 40 位 commit SHA 并保留 `# vX.Y.Z` 注释（便于人工核对与
 * Dependabot 后续按 SHA 升级）。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowsDir = path.join(repoRoot, '.github', 'workflows');

/**
 * GitHub Actions 表达式定界符。
 * 本文件**必须**用拼接而非字面量书写 `${{` / `}}`：
 *  - 在模板字面量里字面量写 `${{` 会被解析为插值起始，导致语法错误；
 *  - 而本仓库自身的「CI 注入守卫」也会扫描字面量写法，误伤本文件。
 */
const OPEN = '$' + '{{';
const CLOSE = '}}';

const workflowFiles = readdirSync(workflowsDir).filter((name) => /\.ya?ml$/.test(name));
const sources = new Map(
  workflowFiles.map((name) => [name, readFileSync(path.join(workflowsDir, name), 'utf8')]),
);

interface UseRef {
  file: string;
  line: number;
  ref: string;
}

const collectUses = (): UseRef[] => {
  const refs: UseRef[] = [];
  for (const [file, text] of sources) {
    text.split(/\r?\n/).forEach((line, index) => {
      const match = line.match(/^\s*(?:-\s*)?uses:\s*(\S+)/);
      if (match) refs.push({ file, line: index + 1, ref: match[1] });
    });
  }
  return refs;
};

test('所有 uses: 必须固定到 40 位 commit SHA（不得使用可移动的 tag / 分支）', () => {
  const uses = collectUses();
  assert.ok(uses.length >= 10, `解析到的 uses 过少（${uses.length}），守卫可能失效`);
  const mutable = uses
    .filter((item) => !/@[0-9a-f]{40}$/.test(item.ref))
    .map((item) => `${item.file}:${item.line}  ${item.ref}`);
  assert.deepEqual(mutable, [], '存在未固定 SHA 的 Action 引用；上游移动 tag 即可替换构建期代码');
});

test('固定 SHA 的同时保留可读的版本注释', () => {
  const complaints: string[] = [];
  for (const item of collectUses()) {
    if (!/@[0-9a-f]{40}$/.test(item.ref)) continue;
    const line = sources.get(item.file)!.split(/\r?\n/)[item.line - 1];
    // 注释可以是 `# v4`（tag）也可以是 `# stable`（分支引用，如 dtolnay/rust-toolchain），
    // 因此只要求「# 后有非空内容」，不强制版本号形态。
    if (!/#\s*\S+/.test(line)) {
      complaints.push(`${item.file}:${item.line}  ${item.ref}（缺少 # <版本/分支> 注释）`);
    }
  }
  assert.deepEqual(complaints, [], '固定 SHA 后应保留版本注释，否则无法人工判断版本');
});

test('本地复合 Action（./path）不需要 SHA 固定', () => {
  const local = collectUses().filter((item) => item.ref.startsWith('./'));
  for (const item of local) {
    assert.ok(item.ref.startsWith('./'), '本地 action 引用应以 ./ 开头');
  }
});

/**
 * CI 脚本注入守卫（v1.2.4，对应审计发现 H-1）。
 *
 * ⚠️ 这份守卫同时是一份**订正记录**。初版审计把 H-1 判为
 * 「`env:` 传值 + 双引号内 `$ISSUE_BODY` 展开 = 可闭合引号执行命令」。
 * 2026-09-27 于本机做等价重放后**证伪**：
 *
 *     ISSUE_BODY='x"$(touch /tmp/PWNED) #'
 *     PROMPT="…$ISSUE_BODY"        # ← 未执行任何命令，PROMPT 只是多了一段文本
 *
 *   bash 不会对**变量的值**做二次命令替换解析，`env:` 路由本身是 GitHub 官方
 *   推荐的不可信输入传递方式。因此「env 传值」既不违规、`printf` 重构也不是
 *   一次真正的漏洞修复（它只是可观的可读性/防御性改写，予以保留）。
 *
 * 真实存在、且已实测复现的注入面是**写出 step output 的那一行**：
 *
 *     RESULT=$(curl … | jq -r …)          # 内容受攻击者间接影响
 *     echo "response=$RESULT" >> $GITHUB_OUTPUT
 *
 * 当 `$RESULT` 含换行时，会在 `$GITHUB_OUTPUT` 文件里**伪造出新的键**（CWE-93/74）。
 * 实测：喂入 `VALID\nmalicious_key=INJECTED`，output 文件里真的多出
 * `malicious_key=INJECTED` 一行 —— 后续步骤 `if: contains(...)` 的判定可被操纵。
 *
 * 修复方式（已落地）：先把 AI 结论**归一化**为严格枚举 `VALID|INVALID|UNKNOWN`，
 * 再改用 heredoc 定界符写出：
 *
 *     {
 *       echo "response<<__YAN_EOF__"
 *       echo "$VERDICT"
 *       echo "__YAN_EOF__"
 *     } >> "$GITHUB_OUTPUT"
 *
 * 本守卫据此校验两条**可实测**的结构性约束：
 *   A. 不可信 env 变量的展开**必须带引号**（`"$VAR"`）；
 *      裸写 `$VAR` 会在值含空格/换行/通配符时被分词或路径展开（CWE-78 的温床）。
 *   B. 写入 `$GITHUB_OUTPUT` 时，**不得**使用 `key=$VAR` 的裸插值形式 ——
 *      必须走 heredoc 定界符，或值已被归一化为无换行的严格枚举。
 */

/** 外部用户可控的表达式 —— 绑定到 step env 后即为不可信数据源 */
const UNTRUSTED_EXPRESSIONS = [
  'github.event.issue.title',
  'github.event.issue.body',
  'github.event.issue.user.login',
  'github.event.comment.body',
  'github.event.pull_request.title',
  'github.event.pull_request.body',
  'github.event.discussion.title',
  'github.event.discussion.body',
  'github.head_ref',
];

/** 判断一个 `${{ … }}` 表达式是否取自外部不可信来源 */
const isUntrustedExpr = (expr: string): boolean =>
  expr.split('||').some((branch) => {
    const tokens = branch.split(/[&!()]/).map((t) => t.trim());
    return tokens.some((t) =>
      UNTRUSTED_EXPRESSIONS.some((u) => t === u || t.startsWith(u + '.') || t.endsWith(u)),
    );
  });

interface StepEnvBinding {
  /** 变量名 */
  name: string;
  /** 绑定的 `${{ … }}` 表达式（未绑定的字面量则为空串） */
  expr: string;
}

interface RunStep {
  /** `run:` 行号（1-based） */
  startLine: number;
  /** run 脚本正文 */
  body: string;
  /** 同一步骤下 `env:` 中绑定到 `${{ … }}` 的变量 */
  envBindings: StepEnvBinding[];
}

/**
 * 极简 YAML 步进解析：按「列表项缩进」切出每个步骤，
 * 在步骤内分别取 `env:` 段与 `run:` 块。
 * 不追求通用（本项目 workflow 结构固定），但足以支撑结构化校验。
 */
const collectRunSteps = (text: string): RunStep[] => {
  const lines = text.split(/\r?\n/);
  const stepStarts: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*-\s+\S/.test(lines[i])) stepStarts.push(i);
    else if (/^\s*-\s*$/.test(lines[i])) stepStarts.push(i);
  }
  const steps: RunStep[] = [];
  for (let s = 0; s < stepStarts.length; s += 1) {
    const from = stepStarts[s];
    const to = s + 1 < stepStarts.length ? stepStarts[s + 1] : lines.length;
    const slice = lines.slice(from, to);

    let runIdx = -1;
    let runInline = '';
    for (let k = 0; k < slice.length; k += 1) {
      const m = slice[k].match(/^\s*run:[ \t]*(.*)$/);
      if (m) {
        runIdx = k;
        runInline = m[1].trim();
        break;
      }
    }
    if (runIdx < 0) continue;

    const runLineNo = from + runIdx + 1;
    let runBody: string;
    if (/^[|>]/.test(runInline)) {
      const runIndent = (slice[runIdx].match(/^(\s*)/) as RegExpMatchArray)[1].length;
      const body: string[] = [];
      let j = runIdx + 1;
      for (; j < slice.length; j += 1) {
        const line = slice[j];
        if (line.trim() === '') {
          body.push('');
          continue;
        }
        const ind = (line.match(/^(\s*)/) as RegExpMatchArray)[1].length;
        if (ind <= runIndent) break;
        body.push(line);
      }
      runBody = body.join('\n');
    } else {
      runBody = runInline;
    }

    // 收集同一步骤内 env: 的键值绑定（env 段必须缩进深于列表项）
    const envBindings: StepEnvBinding[] = [];
    let inEnv = false;
    let envIndent = -1;
    for (const line of slice) {
      if (/^\s*env:\s*$/.test(line)) {
        inEnv = true;
        envIndent = (line.match(/^(\s*)/) as RegExpMatchArray)[1].length;
        continue;
      }
      if (!inEnv) continue;
      const ind = (line.match(/^(\s*)/) as RegExpMatchArray)[1].length;
      if (line.trim() !== '' && ind <= envIndent) {
        inEnv = false;
        continue;
      }
      const kv = line.match(/^\s*([A-Za-z_]\w*)\s*:\s*(.*)$/);
      if (!kv) continue;
      const value = kv[2].trim().replace(/^["']|["']$/g, '');
      const exprMatch = value.match(/^\$\{\{(.*)\}\}$/);
      envBindings.push({ name: kv[1], expr: exprMatch ? exprMatch[1].trim() : '' });
    }

    steps.push({ startLine: runLineNo, body: runBody, envBindings });
  }
  return steps;
};

/**
 * 约束 A：不可信 env 变量必须带引号展开。
 * 只扫描 `run:` 正文；`${{ }}` 网关层替换发生在 shell 之前，不属此列。
 */
const findUnquotedUntrusted = (step: RunStep, label: string): string[] => {
  const untrustedNames = new Set(
    step.envBindings.filter((b) => b.expr && isUntrustedExpr(b.expr)).map((b) => b.name),
  );
  if (untrustedNames.size === 0) return [];

  const out: string[] = [];
  const lines = step.body.split(/\r?\n/);
  lines.forEach((line, idx) => {
    // 去掉单引号包住的部分（单引号内不展开，天然安全）
    const withoutSingleQuoted = line.replace(/'[^']*'/g, "''");
    // 去掉双引号包住的 `$VAR`（合法安全用法）
    const withoutDoubleQuoted = withoutSingleQuoted.replace(/"[^"]*"/g, '""');
    for (const name of untrustedNames) {
      // eslint-disable-next-line no-new
      const bare = new RegExp(`\\$${name}(?![A-Za-z0-9_])|\\$\\{${name}\\}`);
      if (bare.test(withoutDoubleQuoted)) {
        out.push(`${label}:${step.startLine + idx + 1}  不可信变量 $${name} 未加引号展开（应写 "$NAME"）`);
      }
    }
  });
  return out;
};

/**
 * 约束 B：`$GITHUB_OUTPUT` 的写入不得用裸 `key=$VAR` 形式。
 * 合法形态只有两种：
 *   1) heredoc 定界符 —— `echo "key<<EOF"` / `echo "key<<-"` …
 *   2) 值为无换行的严格枚举（调用方须自行保证，本守卫只放行带定界符的写法）
 * 因此：只要出现 `>> $GITHUB_OUTPUT` 且同文件不存在任何 `<<` 定界符写入，
 * 且该行含 `$VAR` 插值，即判违规。
 */
const findOutputForgery = (step: RunStep, label: string): string[] => {
  const out: string[] = [];
  const body = step.body;
  const hasHeredocWrite = /echo\s+"?[A-Za-z_]\w*<<-?/.test(body);
  const lines = body.split(/\r?\n/);
  lines.forEach((line, idx) => {
    if (!/\$GITHUB_OUTPUT/.test(line)) return;
    if (!/>>|>/.test(line)) return;
    // heredoc 定界符写法本行不含 `$VAR` 插值，直接放行
    if (/echo\s+"?[A-Za-z_]\w*<<-?/.test(line)) return;
    if (hasHeredocWrite && /\$GITHUB_OUTPUT/.test(line) && /^\s*\}\s*>>/.test(line)) return;
    if (/\$[A-Za-z_]\w*/.test(line)) {
      out.push(
        `${label}:${step.startLine + idx + 1}  裸插值写入 $GITHUB_OUTPUT（值含换行可伪造 output 键，CWE-93）`,
      );
    }
  });
  return out;
};

/** 汇总两条约束 */
const findCiInjectionViolations = (text: string, label = '<inline>'): string[] => {
  const out: string[] = [];
  for (const step of collectRunSteps(text)) {
    out.push(...findUnquotedUntrusted(step, label));
    out.push(...findOutputForgery(step, label));
  }
  return out;
};

test('CI 注入防线：不可信变量不得裸展开；$GITHUB_OUTPUT 不得裸插值写入', () => {
  const violations: string[] = [];
  for (const [file, text] of sources) {
    violations.push(...findCiInjectionViolations(text, file));
  }
  assert.deepEqual(
    violations,
    [],
    '存在 CI 注入面；见上方描述的两条结构性约束（带引号展开 / heredoc 写 output）',
  );
});

test('守卫自检：真实漏洞（GITHUB_OUTPUT 裸插值）必须被拦下', () => {
  const VULNERABLE = [
    'jobs:',
    '  a:',
    '    steps:',
    '      - name: AI Judge',
    '        run: |',
    '          RESULT=$(echo x)',
    '          echo "response=$RESULT" >> $GITHUB_OUTPUT',
  ].join('\n');
  const v = findCiInjectionViolations(VULNERABLE, 'vulnerable.yml');
  assert.equal(v.length, 1, `守卫自检失败：应拦下 1 处，实际 ${v.length} 处`);
  assert.ok(v[0].includes('GITHUB_OUTPUT'), '守卫自检失败：违规点未指向 GITHUB_OUTPUT');
});

test('守卫自检：heredoc 写 output（修复后写法）必须放行', () => {
  const FIXED = [
    'jobs:',
    '  a:',
    '    steps:',
    '      - name: AI Judge',
    '        run: |',
    '          case "$RESULT" in',
    '            INVALID) VERDICT=INVALID ;;',
    '            *) VERDICT=UNKNOWN ;;',
    '          esac',
    '          {',
    '            echo "response<<__YAN_EOF__"',
    '            echo "$VERDICT"',
    '            echo "__YAN_EOF__"',
    '          } >> "$GITHUB_OUTPUT"',
  ].join('\n');
  assert.deepEqual(
    findCiInjectionViolations(FIXED, 'fixed.yml'),
    [],
    '守卫自检失败：heredoc 写法被误报',
  );
});

test('守卫自检：不可信变量裸展开必须被拦下，带引号必须放行', () => {
  const header = (runLines: string[]) =>
    [
      'jobs:',
      '  a:',
      '    steps:',
      '      - name: x',
      '        env:',
      '          ISSUE_BODY: ' + OPEN + ' github.event.issue.body ' + CLOSE,
      '        run: |',
      ...runLines.map((l) => '          ' + l),
    ].join('\n');

  const bad = findCiInjectionViolations(header(['PROMPT=$ISSUE_BODY']), 'bad.yml');
  assert.equal(bad.length, 1, `应拦下裸展开，实际 ${bad.length} 处`);

  const good = findCiInjectionViolations(header(['PROMPT="$ISSUE_BODY"']), 'good.yml');
  assert.deepEqual(good, [], '带引号展开被误报');

  // printf 位置参数写法也应放行
  const good2 = findCiInjectionViolations(
    header(['PROMPT=$(printf "%s" "$ISSUE_BODY")']),
    'good2.yml',
  );
  assert.deepEqual(good2, [], 'printf 位置参数写法被误报');
});

test('守卫自检：collectRunSteps 必须能解析出多行 run 块与 env 绑定', () => {
  const sample = [
    'jobs:',
    '  a:',
    '    steps:',
    '      - name: x',
    '        env:',
    '          FOO: ' + OPEN + ' secrets.X ' + CLOSE,
    '        run: |',
    '          echo hi',
    '          echo bye',
  ].join('\n');
  const steps = collectRunSteps(sample);
  assert.equal(steps.length, 1, `run 步骤解析数量不符（${steps.length}）`);
  assert.ok(steps[0].body.includes('echo hi'), 'run 块内容解析不完整');
  assert.equal(steps[0].envBindings.length, 1, 'env 绑定解析数量不符');
  assert.equal(steps[0].envBindings[0].name, 'FOO', 'env 变量名解析错误');
  assert.ok(sources.size >= 3, `解析到的 workflow 数量过少（${sources.size}），守卫可能失效`);
});


