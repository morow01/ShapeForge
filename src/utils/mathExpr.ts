/**
 * Evaluates a simple mathematical expression string (e.g. "0.62/2", "10 + 5*2", "(12 - 4) / 2").
 * Returns the numeric result if valid and finite, or null if the expression is invalid or cannot be parsed.
 */
export function evaluateMathExpression(input: string): number | null {
  if (!input) return null;
  // Replace comma with dot for decimal notation (common in many European locales)
  const sanitized = input.trim().replace(/,/g, ".");
  if (!sanitized) return null;

  // Fast-path simple numbers without operators
  if (/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(sanitized)) {
    const num = Number(sanitized);
    return Number.isFinite(num) ? num : null;
  }

  // Tokenize
  const tokens: string[] = [];
  let i = 0;
  while (i < sanitized.length) {
    const ch = sanitized[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === "^" || ch === "(" || ch === ")") {
      tokens.push(ch);
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let numStr = "";
      let hasDot = false;
      while (i < sanitized.length && /[0-9.]/.test(sanitized[i])) {
        if (sanitized[i] === ".") {
          if (hasDot) return null; // Multiple dots in a single number
          hasDot = true;
        }
        numStr += sanitized[i];
        i++;
      }
      tokens.push(numStr);
      continue;
    }
    // Check for "pi"
    if (sanitized.slice(i, i + 2).toLowerCase() === "pi") {
      tokens.push(String(Math.PI));
      i += 2;
      continue;
    }
    // Unknown character -> invalid expression
    return null;
  }

  if (tokens.length === 0) return null;

  let pos = 0;

  function peek(): string | undefined {
    return tokens[pos];
  }

  function consume(expected?: string): string | null {
    const token = tokens[pos];
    if (expected && token !== expected) return null;
    pos++;
    return token;
  }

  function parseExpression(): number | null {
    let val = parseTerm();
    if (val === null) return null;

    while (peek() === "+" || peek() === "-") {
      const op = consume();
      const nextTerm = parseTerm();
      if (nextTerm === null) return null;
      if (op === "+") val += nextTerm;
      else val -= nextTerm;
    }
    return val;
  }

  function parseTerm(): number | null {
    let val = parsePower();
    if (val === null) return null;

    while (peek() === "*" || peek() === "/") {
      const op = consume();
      const nextPower = parsePower();
      if (nextPower === null) return null;
      if (op === "*") {
        val *= nextPower;
      } else {
        if (Math.abs(nextPower) < 1e-15) return null; // Division by zero
        val /= nextPower;
      }
    }
    return val;
  }

  function parsePower(): number | null {
    let val = parseUnary();
    if (val === null) return null;

    if (peek() === "^") {
      consume();
      const exponent = parsePower(); // right-associative
      if (exponent === null) return null;
      val = Math.pow(val, exponent);
    }
    return val;
  }

  function parseUnary(): number | null {
    if (peek() === "+") {
      consume();
      return parseUnary();
    }
    if (peek() === "-") {
      consume();
      const val = parseUnary();
      return val === null ? null : -val;
    }
    return parsePrimary();
  }

  function parsePrimary(): number | null {
    const token = peek();
    if (!token) return null;

    if (token === "(") {
      consume("(");
      const expr = parseExpression();
      if (expr === null) return null;
      if (consume(")") === null) return null;
      return expr;
    }

    // Number token
    if (/^[0-9]+(?:\.[0-9]*)?$/.test(token) || /^\.[0-9]+$/.test(token)) {
      consume();
      const num = Number(token);
      return Number.isFinite(num) ? num : null;
    }

    return null;
  }

  const result = parseExpression();
  if (pos !== tokens.length || result === null || !Number.isFinite(result)) {
    return null;
  }

  return result;
}
