/**
 * Formula parser — recursive descent over the tokenizer's output.
 *
 *   expr    := term (('+' | '-') term)*
 *   term    := unary (('*' | '/') unary)*
 *   unary   := '-' unary | primary
 *   primary := NUMBER | IDENT | IDENT '(' expr (',' expr)* ')' | '(' expr ')'
 *
 * Function names are checked here, against the evaluator's table, so an
 * unknown function or a wrong arity is a compile-time error with a position
 * rather than a zero at report time.
 */

import { FormulaNode } from "./ast";
import { FUNCTIONS, functionArityError } from "./functions";
import { FormulaSyntaxError, Token, tokenize } from "./tokenizer";

class Parser {
  private index = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly source: string
  ) {}

  parse(): FormulaNode {
    if (this.tokens.length === 0) {
      throw new FormulaSyntaxError("Empty formula", 0);
    }
    const node = this.expr();
    if (this.index < this.tokens.length) {
      const token = this.tokens[this.index];
      throw new FormulaSyntaxError(`Unexpected ${describe(token)}`, token.pos);
    }
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private next(): Token {
    const token = this.tokens[this.index];
    if (!token) {
      throw new FormulaSyntaxError("Unexpected end of formula", this.source.length);
    }
    this.index++;
    return token;
  }

  private expr(): FormulaNode {
    let left = this.term();
    for (;;) {
      const token = this.peek();
      if (token?.type === "op" && (token.value === "+" || token.value === "-")) {
        this.index++;
        const right = this.term();
        left = { kind: "bin", op: token.value, left, right };
        continue;
      }
      return left;
    }
  }

  private term(): FormulaNode {
    let left = this.unary();
    for (;;) {
      const token = this.peek();
      if (token?.type === "op" && (token.value === "*" || token.value === "/")) {
        this.index++;
        const right = this.unary();
        left = { kind: "bin", op: token.value, left, right };
        continue;
      }
      return left;
    }
  }

  private unary(): FormulaNode {
    const token = this.peek();
    if (token?.type === "op" && token.value === "-") {
      this.index++;
      return { kind: "neg", operand: this.unary() };
    }
    if (token?.type === "op" && token.value === "+") {
      this.index++;
      return this.unary();
    }
    return this.primary();
  }

  private primary(): FormulaNode {
    const token = this.next();
    switch (token.type) {
      case "num":
        return { kind: "num", value: token.value };
      case "lparen": {
        const inner = this.expr();
        this.expect("rparen", "Expected )");
        return inner;
      }
      case "ident": {
        if (this.peek()?.type === "lparen") {
          this.index++;
          const args: FormulaNode[] = [];
          if (this.peek()?.type !== "rparen") {
            args.push(this.expr());
            while (this.peek()?.type === "comma") {
              this.index++;
              args.push(this.expr());
            }
          }
          this.expect("rparen", "Expected )");
          const fn = FUNCTIONS[token.value];
          if (!fn) {
            throw new FormulaSyntaxError(`Unknown function "${token.value}"`, token.pos);
          }
          const arityError = functionArityError(token.value, args.length);
          if (arityError) throw new FormulaSyntaxError(arityError, token.pos);
          return { kind: "call", fn: token.value, args };
        }
        if (FUNCTIONS[token.value]) {
          throw new FormulaSyntaxError(
            `"${token.value}" is a function and needs arguments`,
            token.pos
          );
        }
        return { kind: "ref", id: token.value };
      }
      default:
        throw new FormulaSyntaxError(`Unexpected ${describe(token)}`, token.pos);
    }
  }

  private expect(type: Token["type"], message: string): void {
    const token = this.peek();
    if (!token || token.type !== type) {
      throw new FormulaSyntaxError(message, token?.pos ?? this.source.length);
    }
    this.index++;
  }
}

function describe(token: Token): string {
  switch (token.type) {
    case "num":
      return `number ${token.value}`;
    case "ident":
      return `"${token.value}"`;
    case "op":
      return `"${token.value}"`;
    case "lparen":
      return `"("`;
    case "rparen":
      return `")"`;
    case "comma":
      return `","`;
  }
}

/** Parse a formula. Throws FormulaSyntaxError with a position on any fault. */
export function parseFormula(source: string): FormulaNode {
  return new Parser(tokenize(source), source).parse();
}
