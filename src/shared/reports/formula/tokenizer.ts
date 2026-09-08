/**
 * Formula tokenizer. Numbers, identifiers, the four operators, parentheses and
 * commas; whitespace is skipped. Anything else is an error that names its
 * position, so a typo in a definition fails at compile time with a message a
 * person can act on.
 */

export type Token =
  | { type: "num"; value: number; pos: number }
  | { type: "ident"; value: string; pos: number }
  | { type: "op"; value: "+" | "-" | "*" | "/"; pos: number }
  | { type: "lparen"; pos: number }
  | { type: "rparen"; pos: number }
  | { type: "comma"; pos: number };

export class FormulaSyntaxError extends Error {
  constructor(
    message: string,
    public readonly pos: number
  ) {
    super(`${message} (at position ${pos})`);
    this.name = "FormulaSyntaxError";
  }
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "lparen", pos: i });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen", pos: i });
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "comma", pos: i });
      i++;
      continue;
    }
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/") {
      tokens.push({ type: "op", value: ch, pos: i });
      i++;
      continue;
    }
    if (DIGIT.test(ch) || (ch === "." && DIGIT.test(source[i + 1] ?? ""))) {
      const start = i;
      while (i < source.length && DIGIT.test(source[i])) i++;
      if (source[i] === ".") {
        i++;
        while (i < source.length && DIGIT.test(source[i])) i++;
      }
      if (source[i] === "e" || source[i] === "E") {
        let j = i + 1;
        if (source[j] === "+" || source[j] === "-") j++;
        if (DIGIT.test(source[j] ?? "")) {
          i = j;
          while (i < source.length && DIGIT.test(source[i])) i++;
        }
      }
      const text = source.slice(start, i);
      const value = Number(text);
      if (!Number.isFinite(value)) {
        throw new FormulaSyntaxError(`Invalid number "${text}"`, start);
      }
      tokens.push({ type: "num", value, pos: start });
      continue;
    }
    if (IDENT_START.test(ch)) {
      const start = i;
      while (i < source.length && IDENT_CHAR.test(source[i])) i++;
      tokens.push({ type: "ident", value: source.slice(start, i), pos: start });
      continue;
    }
    throw new FormulaSyntaxError(`Unexpected character "${ch}"`, i);
  }
  return tokens;
}
