/**
 * 源码扫描型守卫的公共工具。
 *
 * ## 为什么需要这个文件
 *
 * 本项目已**五次**栽在「注释干扰源码守卫」上。前四次是注释把断言弄成假阳性/假阴性，
 * 第五次（v1.3.6）更隐蔽：**朴素的块注释剥离器 `/\*[\s\S]*?\*\//g` 会漏判字符串里的
 * `*` 与 `/`**。
 *
 * 实证：`src/main/plugins.ts` 有一行 Accept 头，其字符串值是
 * 「application/json,text/plain,」后接一个**星号、斜杠、星号相连**的三字符序列。
 * 该序列里同时出现了块注释的**起始符**（斜杠+星号）与**结束符**（星号+斜杠），
 * 二者重叠。于是朴素正则从这一行的起始符开始配对，一路吃到 360 行之后的另一处
 * 同类 Accept 头，把中间三个 Marketplace 函数**整段删掉** —— 守卫随即报
 * 「未找到声明」，而代码其实完好。
 * 若不追根因，极易误判为「代码缺字段」并去改正确的源码。
 *
 * > 留档：本文件初版的这段说明里**直接写出了那个字符串字面量**，结果其中的
 * > 结束符把本块注释**提前终止**，整个 helper 变成语法错误 —— 同一个坑，
 * > 连「记录这个坑的注释」都能踩进去。故此处一律用文字描述，不写字面量。
 *
 * 因此本文件提供一个**尊重字符串字面量**的剥离器，凡新增源码扫描守卫一律用它。
 *
 * ⚠️ 已知边界（刻意不做，避免过度工程）：**不识别正则字面量**。
 * `/foo\/\/bar/` 这类写法里的两个斜杠会被当行注释截断。当前被扫文件无此形态；
 * 若将来出现，症状是「守卫报某个声明找不到」，那时再扩展本函数。
 */

/**
 * 剥离 `//` 行注释与 `/* *\/` 块注释，保留字符串/模板字面量原样。
 *
 * 块注释替换为**一个空格**（而非空串），避免把两侧 token 粘成一个（例如
 * `a/*x*\/b` 不应变成 `ab`）。
 */
export const stripComments = (source: string): string => {
  let out = '';
  let i = 0;
  const length = source.length;

  while (i < length) {
    const ch = source[i];
    const next = source[i + 1];

    // 字符串 / 模板字面量：原样复制（其中的 /* 与 // 都不是注释）
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < length) {
        const current = source[i];
        if (current === '\\') {
          out += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += current;
        i += 1;
        if (current === quote) break;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      while (i < length && source[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      out += ' ';
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
};

/**
 * 截取某个顶层声明（函数 / 常量）的函数体。
 *
 * 终止条件用**行首** `};` —— 嵌套对象与回调的结尾都带缩进，因此不会误截；
 * 若声明在文中不存在或结构异常，会**显式断言失败**而不是静默返回空串
 * （静默返回空串会让「找不到」退化成「断言通过」，那是最糟的一种守卫失效）。
 */
export const sliceDeclaration = (
  source: string,
  marker: string,
  assertFound: (condition: unknown, message: string) => void,
): string => {
  const start = source.indexOf(marker);
  assertFound(start !== -1, `未找到声明：${marker} —— 守卫定位失效，请同步更新该测试`);
  const end = source.indexOf('\n};', start);
  assertFound(end !== -1, `未找到 ${marker} 的结束位置 —— 守卫定位失效`);
  return source.slice(start, end);
};
