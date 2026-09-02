/**
 * Tiny safe arithmetic expression language.
 *
 * Used in two places that must agree exactly:
 *   - validate.mjs, to prove every identifier in a spec resolves to a declared driver
 *   - runtime/channels.mjs, to evaluate channel bindings every frame
 *
 * Deliberately NOT `new Function`: specs can arrive from a model or an untrusted
 * file, and the emitted page should survive a strict CSP.
 */

const FUNCS = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round,
  sqrt: Math.sqrt, sign: Math.sign, exp: Math.exp, log: Math.log,
  pow: Math.pow, mod: (a, b) => ((a % b) + b) % b,
  min: Math.min, max: Math.max,
  clamp: (v, lo, hi) => Math.min(Math.max(v, lo), hi),
  step: (edge, v) => (v < edge ? 0 : 1),
  lerp: (a, b, k) => a + (b - a) * k,
  smoothstep: (e0, e1, v) => {
    const k = Math.min(Math.max((v - e0) / (e1 - e0 || 1e-9), 0), 1);
    return k * k * (3 - 2 * k);
  },
};

const CONSTS = { pi: Math.PI, tau: Math.PI * 2, e: Math.E };

const ARITY = {
  sin: 1, cos: 1, tan: 1, asin: 1, acos: 1, atan: 1, atan2: 2,
  abs: 1, floor: 1, ceil: 1, round: 1, sqrt: 1, sign: 1, exp: 1, log: 1,
  pow: 2, mod: 2, min: -1, max: -1, clamp: 3, step: 2, lerp: 3, smoothstep: 3,
};

class ExprError extends Error {}

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE]/.test(src[j])) {
        // don't swallow the 'e' of an identifier butted against a number
        if ((src[j] === 'e' || src[j] === 'E') && !/[0-9+-]/.test(src[j + 1] || '')) break;
        if ((src[j] === '+' || src[j] === '-')) break;
        j++;
      }
      const text = src.slice(i, j);
      const v = Number(text);
      if (!Number.isFinite(v)) throw new ExprError(`bad number "${text}"`);
      out.push({ t: 'num', v });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      out.push({ t: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('+-*/%(),'.includes(c)) { out.push({ t: c }); i++; continue; }
    throw new ExprError(`illegal character "${c}" at ${i}`);
  }
  out.push({ t: 'eof' });
  return out;
}

/** Recursive-descent parser -> AST. */
function parse(src) {
  const tk = tokenize(src);
  let p = 0;
  const peek = () => tk[p];
  const eat = (t) => {
    if (tk[p].t !== t) throw new ExprError(`expected "${t}" but found "${tk[p].t}"`);
    return tk[p++];
  };

  function primary() {
    const tok = peek();
    if (tok.t === 'num') { p++; return { k: 'num', v: tok.v }; }
    if (tok.t === '-') { p++; return { k: 'neg', a: primary() }; }
    if (tok.t === '+') { p++; return primary(); }
    if (tok.t === '(') { p++; const e = expr(); eat(')'); return e; }
    if (tok.t === 'id') {
      p++;
      if (peek().t === '(') {
        p++;
        const args = [];
        if (peek().t !== ')') {
          args.push(expr());
          while (peek().t === ',') { p++; args.push(expr()); }
        }
        eat(')');
        return { k: 'call', name: tok.v, args };
      }
      return { k: 'var', name: tok.v };
    }
    throw new ExprError(`unexpected "${tok.t}"`);
  }

  function term() {
    let left = primary();
    while (['*', '/', '%'].includes(peek().t)) {
      const op = tk[p++].t;
      left = { k: 'bin', op, a: left, b: primary() };
    }
    return left;
  }

  function expr() {
    let left = term();
    while (['+', '-'].includes(peek().t)) {
      const op = tk[p++].t;
      left = { k: 'bin', op, a: left, b: term() };
    }
    return left;
  }

  const ast = expr();
  eat('eof');
  return ast;
}

/** Walk an AST collecting every free variable name (excludes constants). */
function freeVars(ast, into = new Set()) {
  switch (ast.k) {
    case 'var': if (!(ast.name in CONSTS)) into.add(ast.name); break;
    case 'neg': freeVars(ast.a, into); break;
    case 'bin': freeVars(ast.a, into); freeVars(ast.b, into); break;
    case 'call': ast.args.forEach((a) => freeVars(a, into)); break;
  }
  return into;
}

function evalAst(ast, scope) {
  switch (ast.k) {
    case 'num': return ast.v;
    case 'neg': return -evalAst(ast.a, scope);
    case 'var': {
      if (ast.name in CONSTS) return CONSTS[ast.name];
      const v = scope[ast.name];
      return typeof v === 'number' && Number.isFinite(v) ? v : 0;
    }
    case 'bin': {
      const a = evalAst(ast.a, scope), b = evalAst(ast.b, scope);
      switch (ast.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return b === 0 ? 0 : a / b;
        case '%': return b === 0 ? 0 : ((a % b) + b) % b;
      }
      return 0;
    }
    case 'call': {
      const fn = FUNCS[ast.name];
      if (!fn) return 0;
      return fn(...ast.args.map((a) => evalAst(a, scope)));
    }
  }
  return 0;
}

/**
 * Compile a source string into { fn(scope) -> number, vars: Set<string> }.
 * Throws ExprError on syntax problems or unknown function names.
 */
export function compileExpr(src) {
  const ast = parse(String(src));
  const vars = freeVars(ast);

  // Reject unknown / mis-arity function calls up front rather than silently
  // returning 0 at frame 900.
  (function check(node) {
    if (node.k === 'call') {
      if (!(node.name in FUNCS)) throw new ExprError(`unknown function "${node.name}()"`);
      const want = ARITY[node.name];
      if (want > 0 && node.args.length !== want) {
        throw new ExprError(`${node.name}() takes ${want} argument(s), got ${node.args.length}`);
      }
      node.args.forEach(check);
    } else if (node.k === 'bin') { check(node.a); check(node.b); }
    else if (node.k === 'neg') check(node.a);
  })(ast);

  const fn = (scope) => {
    const v = evalAst(ast, scope);
    return Number.isFinite(v) ? v : 0;
  };
  return { fn, vars, ast };
}

export { ExprError, FUNCS, CONSTS };
