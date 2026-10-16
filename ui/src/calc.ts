/**
 * A small calculator for "2+2*3" typed in a note (no eval). Numbers may use a comma (3,5), × ÷ − are accepted,
 * % after a number means /100, ^ is a power. Returns null when the text is not an arithmetic expression.
 */
export function calculate(source: string): number | null {
  const text = source.replace(/[×х*]/gi, "*").replace(/[÷:]/g, "/").replace(/[−–—]/g, "-").replace(/\s+/g, "").replace(/,/g, ".");
  if (!/^[0-9.+\-*/^()%]+$/.test(text) || !/[+\-*/^]/.test(text.replace(/^-/, ""))) return null;
  let pos = 0;
  const peek = () => text[pos];
  const number = (): number => {
    const start = pos;
    while (pos < text.length && /[0-9.]/.test(text[pos])) pos++;
    if (start === pos) throw new Error("number");
    const value = Number(text.slice(start, pos));
    if (!Number.isFinite(value)) throw new Error("number");
    return value;
  };
  const primary = (): number => {
    if (peek() === "(") { pos++; const v = sum(); if (peek() !== ")") throw new Error("paren"); pos++; return postfix(v); }
    if (peek() === "-") { pos++; return -power(); }
    if (peek() === "+") { pos++; return power(); }
    return postfix(number());
  };
  const postfix = (v: number): number => { while (peek() === "%") { pos++; v /= 100; } return v; };
  const power = (): number => { const base = primary(); if (peek() === "^") { pos++; return Math.pow(base, power()); } return base; };
  const product = (): number => {
    let v = power();
    while (peek() === "*" || peek() === "/") { const op = text[pos++]; const r = power(); v = op === "*" ? v * r : v / r; }
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (peek() === "+" || peek() === "-") { const op = text[pos++]; const r = product(); v = op === "+" ? v + r : v - r; }
    return v;
  };
  try {
    const result = sum();
    if (pos !== text.length || !Number.isFinite(result)) return null;
    return result;
  } catch { return null; }
}

/** The result as it is written in Russian: a comma, at most 10 significant digits, no trailing zeros. */
export function formatResult(value: number): string {
  const rounded = Number(value.toPrecision(10));
  return String(rounded).replace(".", ",");
}

/** The arithmetic expression at the end of a line ("Итого: 12*3,5 =" → "12*3,5"), or null. */
export function trailingExpression(line: string): string | null {
  const cleaned = line.replace(/=\s*$/, "").trimEnd();
  const match = cleaned.match(/[0-9(][0-9.,+\-*/×÷:^()%\s−–—х]*$/i);
  if (!match) return null;
  const expression = match[0].trim();
  return calculate(expression) === null ? null : expression;
}
