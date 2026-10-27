'use strict';

/**
 * Parser PHP leve: tokenizador + extração de declarações (classes, métodos,
 * propriedades, constantes) e de pistas de tipo usadas na inferência semântica.
 * Não tenta ser um parser completo de PHP — só o necessário para autocomplete.
 */

const PUNCTS = [
    '?->', '...', '<=>', '===', '!==', '**=', '??=', '<<=', '>>=',
    '->', '::', '=>', '==', '!=', '<>', '<=', '>=', '&&', '||', '??', '++', '--',
    '.=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '**'
];

const MEMBER_MODIFIERS = new Set(['public', 'protected', 'private', 'static', 'abstract', 'final', 'var', 'readonly']);

function isIdentStart(c) {
    return /[A-Za-z_\x80-\uffff\\]/.test(c);
}

function isIdentChar(c) {
    return /[\w\x80-\uffff\\]/.test(c);
}

/** Retorna o índice logo após o fechamento da string iniciada em `i`, e se ela foi fechada. */
function skipString(src, i) {
    const q = src[i];
    let j = i + 1;
    while (j < src.length) {
        const c = src[j];
        if (c === '\\') { j += 2; continue; }
        if (c === q) return { end: j + 1, closed: true };
        j++;
    }
    return { end: src.length, closed: false };
}

/**
 * Tokeniza código PHP. Tokens: { t, v, s, e } com t em
 * 'id' | 'var' | 'str' | 'num' | 'doc' | 'p' (pontuação/operador).
 * opts.php = true começa direto em modo PHP (útil para trechos de expressão).
 */
function tokenize(src, opts = {}) {
    const toks = [];
    const n = src.length;
    let i = 0;
    let php = !!opts.php;

    while (i < n) {
        if (!php) {
            const k = src.indexOf('<?', i);
            if (k < 0) break;
            if (src.startsWith('<?php', k)) i = k + 5;
            else if (src.startsWith('<?=', k)) i = k + 3;
            else i = k + 2;
            php = true;
            continue;
        }

        const c = src[i];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }

        if (c === '?' && src[i + 1] === '>') {
            toks.push({ t: 'p', v: ';', s: i, e: i + 2 });
            php = false;
            i += 2;
            continue;
        }

        // atributos PHP 8: #[...]
        if (c === '#' && src[i + 1] === '[') {
            let d = 0, j = i + 1;
            for (; j < n; j++) {
                const ch = src[j];
                if (ch === '[') d++;
                else if (ch === ']') { d--; if (!d) { j++; break; } }
                else if (ch === '"' || ch === "'") j = skipString(src, j).end - 1;
            }
            i = j;
            continue;
        }

        if (c === '#' || (c === '/' && src[i + 1] === '/')) {
            while (i < n && src[i] !== '\n' && !(src[i] === '?' && src[i + 1] === '>')) i++;
            continue;
        }

        if (c === '/' && src[i + 1] === '*') {
            const e = src.indexOf('*/', i + 2);
            const end = e < 0 ? n : e + 2;
            if (src[i + 2] === '*' && src[i + 3] !== '/') toks.push({ t: 'doc', v: src.slice(i, end), s: i, e: end });
            i = end;
            continue;
        }

        if (c === "'" || c === '"' || c === '`') {
            const r = skipString(src, i);
            toks.push({ t: 'str', v: src.slice(i, r.end), s: i, e: r.end, open: !r.closed });
            i = r.end;
            continue;
        }

        if (c === '<' && src.startsWith('<<<', i)) {
            const m = /^<<<[ \t]*(['"]?)([A-Za-z_]\w*)\1\r?\n/.exec(src.slice(i, i + 200));
            if (m) {
                const re = new RegExp('\\n[ \\t]*' + m[2] + '\\b', 'g');
                re.lastIndex = i + m[0].length - 1;
                const f = re.exec(src);
                const end = f ? f.index + f[0].length : n;
                toks.push({ t: 'str', v: src.slice(i, end), s: i, e: end, heredoc: true, open: !f });
                i = end;
                continue;
            }
        }

        if (c === '$' && i + 1 < n && /[A-Za-z_\x80-\uffff]/.test(src[i + 1])) {
            let j = i + 2;
            while (j < n && /[\w\x80-\uffff]/.test(src[j])) j++;
            toks.push({ t: 'var', v: src.slice(i, j), s: i, e: j });
            i = j;
            continue;
        }

        if (isIdentStart(c) && !(c === '\\' && !isIdentStart(src[i + 1] || ''))) {
            let j = i + 1;
            while (j < n && isIdentChar(src[j])) j++;
            toks.push({ t: 'id', v: src.slice(i, j), s: i, e: j });
            i = j;
            continue;
        }

        if (/\d/.test(c)) {
            let j = i + 1;
            while (j < n && /[\w.]/.test(src[j])) j++;
            toks.push({ t: 'num', v: src.slice(i, j), s: i, e: j });
            i = j;
            continue;
        }

        let p = c;
        for (const op of PUNCTS) {
            if (src.startsWith(op, i)) { p = op; break; }
        }
        toks.push({ t: 'p', v: p, s: i, e: i + p.length });
        i += p.length;
    }
    return toks;
}

function isP(tok, v) {
    return !!tok && tok.t === 'p' && tok.v === v;
}

function isId(tok, v) {
    return !!tok && tok.t === 'id' && (v === undefined || tok.v.toLowerCase() === v);
}

const OPEN = { '(': ')', '[': ']', '{': '}' };
const CLOSE = { ')': '(', ']': '[', '}': '{' };

/** Índice do fechamento correspondente ao token de abertura em `i` (ou o último índice se desbalanceado). */
function matchForward(toks, i) {
    const open = toks[i].v, close = OPEN[open];
    let d = 0;
    for (let j = i; j < toks.length; j++) {
        const t = toks[j];
        if (t.t !== 'p') continue;
        if (t.v === open) d++;
        else if (t.v === close) { d--; if (!d) return j; }
    }
    return toks.length - 1;
}

/** Índice da abertura correspondente ao token de fechamento em `i` (ou -1). */
function matchBackward(toks, i) {
    const close = toks[i].v, open = CLOSE[close];
    let d = 0;
    for (let j = i; j >= 0; j--) {
        const t = toks[j];
        if (t.t !== 'p') continue;
        if (t.v === close) d++;
        else if (t.v === open) { d--; if (!d) return j; }
    }
    return -1;
}

/** Fim (exclusivo) da expressão que começa em `i`: para em ';' ou ',' no nível 0, ou em fechamento sem par. */
function exprEnd(toks, i, limit = toks.length) {
    let d = 0;
    for (let j = i; j < limit; j++) {
        const t = toks[j];
        if (t.t !== 'p') {
            if (d === 0 && t.t === 'id' && /^(as|and|or)$/i.test(t.v)) return j;
            continue;
        }
        if (OPEN[t.v]) d++;
        else if (CLOSE[t.v]) { if (d === 0) return j; d--; }
        else if (d === 0 && (t.v === ';' || t.v === ',' || t.v === '=>')) return j;
    }
    return limit;
}

function stringValue(tok) {
    if (!tok || tok.t !== 'str' || tok.heredoc) return null;
    let v = tok.v.slice(1);
    if (!tok.open) v = v.slice(0, -1);
    return v.replace(/\\(['"\\])/g, '$1');
}

function lineOf(src, offset, cache) {
    // busca binária num array de inícios de linha
    let starts = cache.starts;
    if (!starts) {
        starts = [0];
        for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
        cache.starts = starts;
    }
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo;
}

/** Interpreta um docblock: resumo, @param, @return, @var, @deprecated. */
function parseDocBlock(text) {
    if (!text) return null;
    const lines = text.replace(/^\/\*\*/, '').replace(/\*\/$/, '').split('\n')
        .map(l => l.replace(/^\s*\*\s?/, '').replace(/\s+$/, ''));
    const summary = [];
    const out = { params: {} };
    let inTags = false;
    for (const line of lines) {
        const m = /^@(\w+)\s*(.*)$/.exec(line.trim());
        if (m) {
            inTags = true;
            const tag = m[1].toLowerCase(), rest = m[2].trim();
            if (tag === 'param') {
                const w = rest.split(/\s+/);
                let type = null, name = null, desc;
                if (/^(\.\.\.)?&?\$/.test(w[0])) { name = w[0]; desc = w.slice(1).join(' '); }
                else { type = w[0]; name = w[1]; desc = w.slice(2).join(' '); }
                if (name && /\$\w+/.test(name)) out.params[name.replace(/^.*\$/, '$')] = { type, desc };
            } else if (tag === 'return' || tag === 'returns') {
                const w = rest.split(/\s+/);
                out.ret = { type: w[0] || null, desc: rest };
            } else if (tag === 'var') {
                out.varType = rest.split(/\s+/)[0] || null;
            } else if (tag === 'deprecated') {
                out.deprecated = true;
            }
            continue;
        }
        if (!inTags && line.trim()) summary.push(line.trim());
    }
    out.summary = summary.join(' ');
    return out;
}

/**
 * Analisa o arquivo e devolve { namespace, uses, classes }.
 * Cada classe traz métodos/propriedades/constantes, docblocks e pistas para
 * inferência (expressões de retorno, atribuições a $this->prop, addAttribute()).
 */
function parseFile(src) {
    const toks = tokenize(src);
    const lineCache = {};
    const res = { namespace: '', uses: {}, classes: [] };
    let doc = null;
    let mods = [];

    const ctx = { src, toks, lineCache, res };

    for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (t.t === 'doc') { doc = t.v; continue; }
        if (t.t === 'id') {
            const lw = t.v.toLowerCase();
            const prev = toks[i - 1];
            if (lw === 'namespace' && toks[i + 1] && toks[i + 1].t === 'id') {
                res.namespace = toks[i + 1].v.replace(/^\\/, '');
                i++;
                continue;
            }
            if (lw === 'use' && toks[i + 1] && toks[i + 1].t === 'id' && !isP(prev, ')')) {
                i = parseUse(ctx, i + 1);
                continue;
            }
            if (lw === 'abstract' || lw === 'final' || lw === 'readonly') { mods.push(lw); continue; }
            if ((lw === 'class' || lw === 'interface' || lw === 'trait' || lw === 'enum') &&
                !isP(prev, '::') && !isId(prev, 'new') && toks[i + 1] && toks[i + 1].t === 'id') {
                i = parseClass(ctx, i, mods, doc);
                doc = null; mods = [];
                continue;
            }
        }
        doc = null;
        mods = [];
    }
    return res;
}

function resolveName(ctx, name) {
    if (!name) return name;
    if (name.startsWith('\\')) return name.slice(1);
    const lw = name.toLowerCase();
    if (['self', 'static', 'parent'].includes(lw)) return name;
    const first = name.split('\\')[0].toLowerCase();
    const u = ctx.res.uses[first];
    if (u) return name.includes('\\') ? u + name.slice(name.indexOf('\\')) : u;
    return name;
}

function parseUse(ctx, i) {
    const { toks, res } = ctx;
    if (isId(toks[i], 'function') || isId(toks[i], 'const')) {
        while (i < toks.length && !isP(toks[i], ';')) i++;
        return i;
    }
    let prefix = '';
    while (i < toks.length && !isP(toks[i], ';')) {
        const t = toks[i];
        if (t.t === 'id' && !isId(t, 'as')) {
            let full = t.v.replace(/^\\/, '');
            if (full.endsWith('\\') && isP(toks[i + 1], '{')) { prefix = full; i += 2; continue; }
            full = prefix + full;
            let alias = full.split('\\').pop();
            if (isId(toks[i + 1], 'as') && toks[i + 2]) { alias = toks[i + 2].v; i += 2; }
            res.uses[alias.toLowerCase()] = full;
        } else if (isP(t, '}')) {
            prefix = '';
        }
        i++;
    }
    return i;
}

function parseClass(ctx, i, mods, doc) {
    const { toks, src, lineCache } = ctx;
    const kind = toks[i].v.toLowerCase();
    const name = toks[i + 1].v;
    const cls = {
        name,
        ns: ctx.res.namespace,
        kind,
        abstract: mods.includes('abstract'),
        final: mods.includes('final'),
        extends: [],
        implements: [],
        traits: [],
        methods: [],
        properties: [],
        constants: [],
        attributes: [],
        propAssign: {},
        line: lineOf(src, toks[i].s, lineCache),
        start: toks[i].s
    };
    const d = parseDocBlock(doc);
    if (d) { cls.summary = d.summary; if (d.deprecated) cls.deprecated = true; }

    let j = i + 2, mode = null;
    while (j < toks.length && !isP(toks[j], '{')) {
        const t = toks[j];
        if (isId(t, 'extends')) mode = 'extends';
        else if (isId(t, 'implements')) mode = 'implements';
        else if (t.t === 'id' && mode) cls[mode].push(resolveName(ctx, t.v));
        j++;
    }
    if (j >= toks.length) { ctx.res.classes.push(cls); return j; }
    const bodyEnd = matchForward(toks, j);
    cls.end = toks[bodyEnd].e;
    parseClassBody(ctx, cls, j + 1, bodyEnd);
    ctx.res.classes.push(cls);
    return bodyEnd;
}

function parseClassBody(ctx, cls, start, end) {
    const { toks, src, lineCache } = ctx;
    let mdoc = null;
    let mm = [];
    let k = start;
    const reset = () => { mdoc = null; mm = []; };

    while (k < end) {
        const t = toks[k];
        if (t.t === 'doc') { mdoc = t.v; k++; continue; }
        if (t.t === 'id' && MEMBER_MODIFIERS.has(t.v.toLowerCase())) { mm.push(t.v.toLowerCase()); k++; continue; }

        if (isId(t, 'use')) {
            k++;
            while (k < end && !isP(toks[k], ';') && !isP(toks[k], '{')) {
                if (toks[k].t === 'id') cls.traits.push(resolveName(ctx, toks[k].v));
                k++;
            }
            if (isP(toks[k], '{')) k = matchForward(toks, k);
            k++; reset();
            continue;
        }

        if (isId(t, 'const')) {
            const d = parseDocBlock(mdoc);
            k++;
            while (k < end && !isP(toks[k], ';')) {
                // const [tipo] NOME = valor [, NOME = valor]
                let q = k;
                while (q < end && !isP(toks[q], '=') && !isP(toks[q], ';')) q++;
                const nameTok = toks[q - 1];
                if (!isP(toks[q], '=')) { k = q; break; }
                const ve = exprEnd(toks, q + 1, end);
                cls.constants.push({
                    name: nameTok.v,
                    value: ve > q + 1 ? src.slice(toks[q + 1].s, toks[ve - 1].e).slice(0, 120) : '',
                    visibility: visibilityOf(mm),
                    summary: d && d.summary || undefined,
                    line: lineOf(src, nameTok.s, lineCache)
                });
                k = ve;
                if (isP(toks[k], ',')) k++;
            }
            k++; reset();
            continue;
        }

        if (isId(t, 'case') && cls.kind === 'enum') {
            const nameTok = toks[k + 1];
            if (nameTok) cls.constants.push({ name: nameTok.v, value: 'case', visibility: 'public', line: lineOf(src, nameTok.s, lineCache) });
            while (k < end && !isP(toks[k], ';')) k++;
            k++; reset();
            continue;
        }

        if (isId(t, 'function')) {
            k = parseMethod(ctx, cls, k, end, mm, mdoc);
            reset();
            continue;
        }

        if (t.t === 'var' || t.t === 'id' || isP(t, '?')) {
            k = parseProperty(ctx, cls, k, end, mm, mdoc);
            reset();
            continue;
        }

        if (isP(t, '{')) k = matchForward(toks, k);
        k++;
        reset();
    }
}

function visibilityOf(mm) {
    return mm.includes('private') ? 'private' : mm.includes('protected') ? 'protected' : 'public';
}

function parseProperty(ctx, cls, k, end, mm, mdoc) {
    const { toks, src, lineCache } = ctx;
    const d = parseDocBlock(mdoc);
    let typeStart = null, typeEnd = null;
    while (k < end && toks[k].t !== 'var' && !isP(toks[k], ';')) {
        if (typeStart === null) typeStart = toks[k];
        typeEnd = toks[k];
        k++;
    }
    const type = typeStart ? src.slice(typeStart.s, typeEnd.e) : undefined;
    while (k < end && !isP(toks[k], ';')) {
        const t = toks[k];
        if (t.t === 'var') {
            let def;
            let q = k + 1;
            if (isP(toks[q], '=')) {
                const ve = exprEnd(toks, q + 1, end);
                if (ve > q + 1) def = src.slice(toks[q + 1].s, toks[ve - 1].e).slice(0, 120);
                q = ve;
            }
            cls.properties.push({
                name: t.v.slice(1),
                static: mm.includes('static'),
                visibility: visibilityOf(mm),
                type,
                docType: d && d.varType || undefined,
                summary: d && d.summary || undefined,
                def,
                line: lineOf(src, t.s, lineCache)
            });
            k = q;
            continue;
        }
        if (isP(t, '{')) { k = matchForward(toks, k); } // property hooks (PHP 8.4)
        k++;
    }
    return k + 1;
}

function parseParams(ctx, open, close) {
    const { toks, src } = ctx;
    const params = [];
    let segStart = open + 1;
    let d = 0;
    const segs = [];
    for (let j = open + 1; j < close; j++) {
        const t = toks[j];
        if (t.t !== 'p') continue;
        if (OPEN[t.v]) d++;
        else if (CLOSE[t.v]) d--;
        else if (t.v === ',' && d === 0) { segs.push([segStart, j]); segStart = j + 1; }
    }
    if (segStart < close) segs.push([segStart, close]);

    for (const [a, b] of segs) {
        let promoted = null, byRef = false, variadic = false, typeA = null, typeB = null, name = null, def;
        for (let j = a; j < b; j++) {
            const t = toks[j];
            if (!name && t.t === 'id' && /^(public|protected|private|readonly)$/i.test(t.v)) { if (!/readonly/i.test(t.v)) promoted = t.v.toLowerCase(); continue; }
            if (!name && isP(t, '&')) { byRef = true; continue; }
            if (!name && isP(t, '...')) { variadic = true; continue; }
            if (!name && t.t === 'var') {
                name = t.v;
                if (isP(toks[j + 1], '=') && j + 2 < b) def = src.slice(toks[j + 2].s, toks[b - 1].e).slice(0, 80);
                break;
            }
            if (!name) { if (typeA === null) typeA = t; typeB = t; }
        }
        if (!name) continue;
        params.push({
            name,
            type: typeA ? src.slice(typeA.s, typeB.e) : undefined,
            def,
            byRef: byRef || undefined,
            variadic: variadic || undefined,
            promoted: promoted || undefined
        });
    }
    return params;
}

function parseMethod(ctx, cls, k, end, mm, mdoc) {
    const { toks, src, lineCache } = ctx;
    let m = k + 1;
    if (isP(toks[m], '&')) m++;
    const nameTok = toks[m];
    if (!nameTok || nameTok.t !== 'id') return k + 1;
    m++;
    if (!isP(toks[m], '(')) return m;
    const close = matchForward(toks, m);
    const params = parseParams(ctx, m, close);
    m = close + 1;

    let returnType;
    if (isP(toks[m], ':')) {
        const a = m + 1;
        while (m < end && !isP(toks[m], '{') && !isP(toks[m], ';')) m++;
        if (m > a) returnType = src.slice(toks[a].s, toks[m - 1].e);
    }

    const d = parseDocBlock(mdoc);
    const method = {
        name: nameTok.v,
        static: mm.includes('static'),
        visibility: visibilityOf(mm),
        abstract: mm.includes('abstract') || cls.kind === 'interface' || undefined,
        params,
        returnType,
        summary: d && d.summary || undefined,
        line: lineOf(src, nameTok.s, lineCache)
    };
    if (d) {
        if (d.deprecated) method.deprecated = true;
        if (d.ret && d.ret.type) method.docReturn = d.ret.type;
        if (d.ret && d.ret.desc) method.returnDesc = d.ret.desc;
        for (const p of params) {
            const dp = d.params[p.name];
            if (dp) {
                if (dp.desc) p.desc = dp.desc;
                if (dp.type && !p.type) p.docType = dp.type;
            }
        }
    }

    // parâmetros promovidos do construtor viram propriedades
    for (const p of params) {
        if (p.promoted) {
            cls.properties.push({ name: p.name.slice(1), static: false, visibility: p.promoted, type: p.type, line: method.line });
        }
    }

    if (isP(toks[m], '{')) {
        const bodyEnd = matchForward(toks, m);
        analyzeBody(ctx, cls, method, m, bodyEnd);
        m = bodyEnd + 1;
    } else {
        m++;
    }
    cls.methods.push(method);
    return m;
}

/**
 * Varre o corpo de um método coletando:
 *  - expressões de `return` (para inferir o tipo de retorno)
 *  - `$this->prop = expr` (para inferir o tipo de propriedades)
 *  - `addAttribute('campo')` (atributos de modelos TRecord)
 *  - atribuições a variáveis locais usadas pelas expressões acima
 */
function analyzeBody(ctx, cls, method, start, end) {
    const { toks, src } = ctx;
    const returns = [];
    const assigns = {};
    const props = [];
    const text = (a, b) => (b > a ? src.slice(toks[a].s, toks[b - 1].e) : '');

    for (let p = start + 1; p < end; p++) {
        const t = toks[p];
        if (isId(t, 'function')) {
            // pula closures aninhadas
            let q = p + 1;
            if (isP(toks[q], '&')) q++;
            if (isP(toks[q], '(')) {
                q = matchForward(toks, q) + 1;
                if (isId(toks[q], 'use') && isP(toks[q + 1], '(')) q = matchForward(toks, q + 1) + 1;
                while (q < end && !isP(toks[q], '{') && !isP(toks[q], ';')) q++;
                if (isP(toks[q], '{')) { p = matchForward(toks, q); continue; }
            }
            continue;
        }
        if (isId(t, 'return')) {
            const e = exprEnd(toks, p + 1, end);
            const ex = text(p + 1, e);
            if (ex && returns.length < 4 && !returns.includes(ex)) returns.push(ex.slice(0, 300));
            continue;
        }
        if (t.t === 'var' && t.v === '$this' && isP(toks[p + 1], '->') && isId(toks[p + 2]) && isP(toks[p + 3], '=')) {
            const e = exprEnd(toks, p + 4, end);
            const ex = text(p + 4, e);
            if (ex) props.push({ prop: toks[p + 2].v, expr: ex.slice(0, 300) });
            continue;
        }
        if (t.t === 'var' && isP(toks[p + 1], '=') && !isP(toks[p - 1], '->') && !isP(toks[p - 1], '::')) {
            const e = exprEnd(toks, p + 2, end);
            const ex = text(p + 2, e);
            if (ex) (assigns[t.v] = assigns[t.v] || []).push({ expr: ex.slice(0, 300) });
            continue;
        }
        if (t.t === 'var' && (isId(toks[p - 1], 'as') || (isP(toks[p - 1], '=>') && toks[p - 3] && isId(toks[p - 3], 'as')))) {
            // foreach (EXPR as [$k =>] $v)
            let q = p - 1;
            while (q > start && !isId(toks[q], 'as')) q--;
            let o = q;
            while (o > start && !isId(toks[o], 'foreach')) o--;
            if (isId(toks[o], 'foreach') && isP(toks[o + 1], '(')) {
                const ex = text(o + 2, q);
                if (ex) (assigns[t.v] = assigns[t.v] || []).push({ each: ex.slice(0, 300) });
            }
            continue;
        }
        if (isId(t, 'addattribute') && (isP(toks[p - 1], '->') || isP(toks[p - 1], '::')) && isP(toks[p + 1], '(')) {
            const v = stringValue(toks[p + 2]);
            if (v && !cls.attributes.includes(v)) cls.attributes.push(v);
            continue;
        }
        // hooks opcionais: if (method_exists($this, 'onBeforeStore')) $this->onBeforeStore($obj);
        if (isId(t, 'method_exists') && isP(toks[p + 1], '(') && toks[p + 2] && toks[p + 2].v === '$this' && isP(toks[p + 3], ',')) {
            const hook = isP(toks[p + 5], ')') && stringValue(toks[p + 4]);
            if (hook && /^\w+$/.test(hook) && !(cls.hooks || []).some(h => h.name === hook)) {
                const params = [];
                for (let q = p + 5; q < Math.min(end, p + 60); q++) {
                    if (isId(toks[q], hook.toLowerCase()) && isP(toks[q - 1], '->') && isP(toks[q + 1], '(')) {
                        const close = matchForward(toks, q + 1);
                        let s = q + 2;
                        for (let j = q + 2; j <= close; j++) {
                            if (j === close || (isP(toks[j], ',') && exprEnd(toks, s, close) === j)) {
                                if (j > s) {
                                    const vars = toks.slice(s, j).filter(x => x.t === 'var' && x.v !== '$this');
                                    const cast = toks.slice(s, j).find(x => x.t === 'id' && /^(object|array)$/i.test(x.v));
                                    params.push({ name: vars.length === 1 && j - s === 1 ? vars[0].v : cast ? '$' + cast.v.toLowerCase() : '$param' + (params.length + 1) });
                                }
                                s = j + 1;
                            }
                        }
                        break;
                    }
                }
                (cls.hooks = cls.hooks || []).push({ name: hook, params, summary: `Hook opcional: chamado por ${cls.name}::${method.name}() quando definido na subclasse.` });
            }
        }
    }

    // locais necessárias para resolver as expressões coletadas (fechamento transitivo)
    const needed = new Set();
    const collect = s => { for (const m of s.match(/\$\w+/g) || []) if (m !== '$this') needed.add(m); };
    returns.forEach(collect);
    props.forEach(x => collect(x.expr));
    for (let round = 0; round < 3; round++) {
        for (const v of [...needed]) for (const a of assigns[v] || []) collect(a.expr || a.each);
    }
    const locals = {};
    for (const v of needed) {
        const list = [];
        const param = method.params.find(p => p.name === v);
        if (param && (param.type || param.docType)) list.push({ type: param.type || param.docType });
        for (const a of assigns[v] || []) list.push(a);
        if (list.length) locals[v] = list.slice(-4);
    }

    if (returns.length) method.returns = returns;
    if (Object.keys(locals).length) method.locals = locals;
    for (const pa of props) {
        const list = cls.propAssign[pa.prop] = cls.propAssign[pa.prop] || [];
        if (list.length < 3) {
            const entry = { expr: pa.expr };
            const l = {};
            for (const v of pa.expr.match(/\$\w+/g) || []) if (locals[v]) l[v] = locals[v];
            if (Object.keys(l).length) entry.locals = l;
            list.push(entry);
        }
    }
}

module.exports = {
    tokenize,
    parseFile,
    parseDocBlock,
    matchForward,
    matchBackward,
    exprEnd,
    stringValue,
    isP,
    isId
};
