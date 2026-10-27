'use strict';

/**
 * Motor de inferência de tipos (autocomplete semântico).
 *
 * Um "tipo" é { name, of?, array?, static?, parentRef? }:
 *   name      nome da classe
 *   of        classe do modelo quando o tipo é TRepository
 *   array     profundidade de array (Customer[] => 1)
 *   static    referência à classe (X::) em vez de instância
 *   parentRef acesso via parent::/self:: (permite métodos de instância)
 *
 * Funciona sobre tokens do documento (escopo real do cursor) e sobre as
 * pistas guardadas no índice (expressões de retorno, $this->prop = ...).
 */

const { tokenize, matchBackward, matchForward, exprEnd, stringValue, isP, isId } = require('./phpParser');
const rules = require('./adiantiRules');

const BUILTINS = new Set(['string', 'int', 'integer', 'float', 'double', 'bool', 'boolean', 'array', 'callable', 'iterable', 'object',
    'mixed', 'void', 'null', 'false', 'true', 'never', 'resource', 'number', 'scalar', 'stdclass']);
const KEYWORDS_BEFORE_PAREN = new Set(['if', 'elseif', 'while', 'for', 'foreach', 'switch', 'return', 'echo', 'print', 'catch', 'match',
    'fn', 'function', 'use', 'isset', 'empty', 'array', 'list', 'and', 'or', 'new', 'clone', 'include', 'require', 'include_once', 'require_once', 'unset', 'exit', 'die']);
const MAX_DEPTH = 14;

class Resolver {
    constructor(index) {
        this.index = index;
    }

    // ------------------------------------------------------------------ escopo

    /** Classe e funções envolventes no índice `end` (exclusivo) dos tokens. */
    scopeAt(toks, end) {
        const stack = [];
        for (let i = 0; i < end; i++) {
            const t = toks[i];
            if (t.t !== 'p') continue;
            if (t.v === '{') stack.push(i);
            else if (t.v === '}') stack.pop();
        }
        const funcs = [];
        let clsName = null;
        for (let s = stack.length - 1; s >= 0; s--) {
            const info = this.classifyBrace(toks, stack[s]);
            if (info.kind === 'function') funcs.push(info);
            else if (info.kind === 'class') { clsName = info.name; break; }
        }
        return { clsName, funcs };
    }

    classifyBrace(toks, b) {
        // cabeçalho de classe: class X extends Y implements A, B {
        for (let k = b - 1; k >= 0 && (toks[k].t === 'id' || isP(toks[k], ',')); k--) {
            const lw = toks[k].t === 'id' ? toks[k].v.toLowerCase() : '';
            if ((lw === 'class' || lw === 'interface' || lw === 'trait' || lw === 'enum') && !isP(toks[k - 1], '::') && toks[k + 1] && toks[k + 1].t === 'id' && k + 1 < b) {
                return { kind: 'class', name: toks[k + 1].v };
            }
        }
        // enum X: string {
        if (toks[b - 2] && isP(toks[b - 2], ':') && isId(toks[b - 4], 'enum')) return { kind: 'class', name: toks[b - 3].v };

        let k = b - 1;
        if (!isP(toks[k], ')')) {
            // tipo de retorno: function x(): ?Tipo {
            let q = k;
            while (q >= 0 && (toks[q].t === 'id' || isP(toks[q], '?') || isP(toks[q], '|') || isP(toks[q], '&'))) q--;
            if (isP(toks[q], ':') && isP(toks[q - 1], ')')) k = q - 1;
            else return { kind: 'block' };
        }
        let open = matchBackward(toks, k);
        if (open < 0) return { kind: 'block' };
        let useVars = null;
        if (isId(toks[open - 1], 'use') && isP(toks[open - 2], ')')) {
            useVars = toks.slice(open + 1, k).filter(t => t.t === 'var').map(t => t.v);
            k = open - 2;
            open = matchBackward(toks, k);
            if (open < 0) return { kind: 'block' };
        }
        const before = toks[open - 1];
        if (isId(before, 'function')) return { kind: 'function', closure: true, paramsOpen: open, paramsClose: k, bodyOpen: b, useVars };
        if (before && before.t === 'id' && (isId(toks[open - 2], 'function') || (isP(toks[open - 2], '&') && isId(toks[open - 3], 'function')))) {
            return { kind: 'function', name: before.v, paramsOpen: open, paramsClose: k, bodyOpen: b };
        }
        return { kind: 'block' };
    }

    /** Cria o contexto de resolução para uma posição do documento. */
    docContext(toks, end) {
        const sc = this.scopeAt(toks, end);
        const cls = sc.clsName ? this.index.get(sc.clsName) : null;
        return {
            kind: 'doc',
            toks,
            cls,
            funcs: sc.funcs,
            depth: 0
        };
    }

    storedContext(parent, owner, thisType, locals) {
        return {
            kind: 'stored',
            cls: owner,
            thisType,
            locals: locals || {},
            inProgress: new Set(),
            depth: (parent ? parent.depth : 0) + 1
        };
    }

    // ------------------------------------------------------------- variáveis

    /** Candidatos de tipo para `$name` no documento, antes do token `before`. */
    docVarCandidates(ctx, name, before) {
        const toks = ctx.toks;
        const out = [];
        const ranges = ctx.funcs.length ? ctx.funcs.map(f => [f.paramsOpen, f]) : [[0, null]];
        for (const [from, fn] of ranges) {
            if (fn) {
                // parâmetros tipados: function x(TForm $form)
                for (let j = fn.paramsOpen + 1; j < fn.paramsClose; j++) {
                    if (toks[j].t === 'var' && toks[j].v === name) {
                        let q = j - 1;
                        while (isP(toks[q], '&') || isP(toks[q], '...')) q--;
                        if (toks[q] && toks[q].t === 'id' && !/^(public|protected|private|readonly)$/i.test(toks[q].v)) out.push({ pos: j, type: toks[q].v });
                    }
                }
            }
            for (let p = fn ? fn.paramsClose + 1 : from; p < before; p++) {
                const t = toks[p];
                if (t.t === 'doc') {
                    const re = new RegExp('@var\\s+([\\\\\\w\\[\\]|?<>]+)\\s+\\' + name + '\\b');
                    const m = re.exec(t.v);
                    if (m) out.push({ pos: p, type: m[1] });
                    else {
                        const m2 = /@var\s+([\\\w[\]|?<>]+)\s*\*\//.exec(t.v);
                        if (m2 && toks[p + 1] && toks[p + 1].v === name) out.push({ pos: p, type: m2[1] });
                    }
                    continue;
                }
                if (t.t !== 'var' || t.v !== name) continue;
                const prev = toks[p - 1];
                if (isP(toks[p + 1], '=') && !isP(prev, '->') && !isP(prev, '::')) {
                    out.push({ pos: p, a: p + 2, b: exprEnd(toks, p + 2, before) });
                } else if (isId(prev, 'as') || (isP(prev, '=>') && toks[p - 3] && isId(toks[p - 3], 'as'))) {
                    let q = p - 1;
                    while (q > 0 && !isId(toks[q], 'as')) q--;
                    let o = q;
                    while (o > 0 && !isId(toks[o], 'foreach')) o--;
                    if (isId(toks[o], 'foreach')) out.push({ pos: p, each: true, a: o + 2, b: q });
                } else if (prev && prev.t === 'id' && isP(toks[p - 2], '(') && isId(toks[p - 3], 'catch')) {
                    out.push({ pos: p, type: prev.v });
                }
            }
            if (out.length) break; // achou no escopo mais interno
            if (fn && fn.closure && fn.useVars && !fn.useVars.includes(name)) break;
        }
        return out.sort((x, y) => x.pos - y.pos);
    }

    resolveVar(ctx, name, before) {
        if (name === '$this') {
            if (ctx.kind === 'stored') return ctx.thisType ? { ...ctx.thisType, static: false } : null;
            return ctx.cls ? { name: ctx.cls.name, self: true } : null;
        }
        if (ctx.depth > MAX_DEPTH) return null;

        if (ctx.kind === 'stored') {
            if (ctx.inProgress.has(name)) return null;
            ctx.inProgress.add(name);
            try {
                const list = ctx.locals[name] || [];
                for (let i = list.length - 1; i >= 0; i--) {
                    const e = list[i];
                    let t = null;
                    if (e.type) t = this.parseType(e.type, ctx.thisType);
                    else if (e.expr) t = this.resolveString(ctx, e.expr);
                    else if (e.each) t = elementOf(this.resolveString(ctx, e.each));
                    if (t) return t;
                }
            } finally {
                ctx.inProgress.delete(name);
            }
            return null;
        }

        const cands = this.docVarCandidates(ctx, name, before);
        for (let i = cands.length - 1; i >= 0; i--) {
            const c = cands[i];
            let t = null;
            const sub = { ...ctx, depth: ctx.depth + 1 };
            if (c.type) t = this.parseType(c.type, ctx.cls ? { name: ctx.cls.name } : null);
            else if (c.each) t = elementOf(this.resolveRange(sub, ctx.toks, c.a, c.b));
            else t = this.resolveRange(sub, ctx.toks, c.a, c.b);
            if (t) return t;
        }
        return null;
    }

    // ------------------------------------------------------------ expressões

    resolveString(ctx, expr) {
        const toks = tokenize(expr, { php: true });
        const sub = { ...ctx, toks: ctx.kind === 'doc' ? toks : undefined, depth: ctx.depth + 1 };
        return this.resolveRange(sub, toks, 0, toks.length);
    }

    /** Resolve o tipo da expressão toks[a..b). */
    resolveRange(ctx, toks, a, b) {
        if (ctx.depth > MAX_DEPTH || a >= b) return null;

        // ruídos à esquerda: &, @, clone, casts
        while (a < b) {
            const t = toks[a];
            if (isP(t, '&') || isP(t, '@') || isId(t, 'clone')) { a++; continue; }
            if (isP(t, '(') && toks[a + 1] && toks[a + 1].t === 'id' && BUILTINS.has(toks[a + 1].v.toLowerCase()) && isP(toks[a + 2], ')')) return null;
            break;
        }

        // ?? e ternário: tenta cada ramo
        const splits = [];
        let d = 0, hasTernary = false;
        for (let j = a; j < b; j++) {
            const t = toks[j];
            if (t.t !== 'p') continue;
            if ('([{'.includes(t.v)) d++;
            else if (')]}'.includes(t.v)) d--;
            else if (d === 0 && (t.v === '??' || t.v === '?' || t.v === ':')) { splits.push(j); if (t.v === '?') hasTernary = true; }
        }
        if (splits.length) {
            const parts = [];
            let s = a;
            for (const j of splits) { parts.push([s, j]); s = j + 1; }
            parts.push([s, b]);
            const tryParts = hasTernary ? parts.slice(1) : parts;
            for (const [x, y] of tryParts) {
                const t = this.resolveRange(ctx, toks, x, y);
                if (t) return t;
            }
            return null;
        }

        const chain = parseChain(toks, a, b);
        if (!chain) return null;
        return this.evalChain(ctx, toks, chain);
    }

    currentClassName(ctx) {
        if (ctx.kind === 'stored') return ctx.thisType ? ctx.thisType.name : (ctx.cls && ctx.cls.name);
        return ctx.cls ? ctx.cls.name : null;
    }

    evalBase(ctx, toks, base) {
        const index = this.index;
        switch (base.kind) {
            case 'new': {
                const lw = base.cls.toLowerCase();
                let name = base.cls;
                if (lw === 'self' || lw === 'static') name = this.currentClassName(ctx);
                else if (lw === 'parent') {
                    const p = ctx.cls && index.parentOf(index.get(this.currentClassName(ctx)) || ctx.cls);
                    name = p && p.name;
                }
                const cls = name && index.get(name);
                if (!cls) return null;
                const strArg = argGetter(toks, base.args);
                const r = rules.ruleNew(index, cls.name, strArg);
                return r || { name: cls.name };
            }
            case 'group':
                return this.resolveRange({ ...ctx, depth: ctx.depth + 1 }, toks, base.a, base.b);
            case 'var':
                return this.resolveVar(ctx, base.name, base.pos);
            case 'class': {
                const lw = base.name.toLowerCase();
                const curName = this.currentClassName(ctx);
                if (lw === 'self' || lw === 'static') return curName ? { name: curName, static: true, parentRef: true } : null;
                if (lw === 'parent') {
                    const cur = curName && index.get(curName);
                    const p = cur && index.parentOf(ctx.kind === 'stored' && ctx.cls ? ctx.cls : cur);
                    return p ? { name: p.name, static: true, parentRef: true, viaParent: true } : null;
                }
                const cls = index.get(base.name);
                return cls ? { name: cls.name, static: true } : null;
            }
            default:
                return null;
        }
    }

    evalChain(ctx, toks, chain) {
        let cur = this.evalBase(ctx, toks, chain.base);
        for (const seg of chain.segs) {
            if (!cur) return null;
            cur = this.evalSegment(ctx, toks, cur, seg);
        }
        return cur;
    }

    evalSegment(ctx, toks, cur, seg) {
        const index = this.index;
        if (seg.kind === 'index') return elementOf(cur);
        if (cur.array) return null;
        const cls = index.get(cur.name);
        if (!cls) return null;

        switch (seg.kind) {
            case 'prop':
                if (cur.static) return null;
                return this.propertyType(ctx, cur, seg.name);
            case 'sprop':
                return this.propertyType(ctx, { ...cur, static: false }, seg.name.replace(/^\$/, ''));
            case 'const':
                return null;
            case 'call':
            case 'scall': {
                const strArg = argGetter(toks, seg.args);
                let receiver = seg.kind === 'call' ? { ...cur, static: false } : cur;
                let hit = index.findMethod(cls, seg.name);
                if (!hit && seg.kind === 'call') {
                    const dec = this.decoratedType(ctx, receiver);
                    if (dec) { receiver = dec; hit = index.findMethod(index.get(dec.name), seg.name); }
                }
                if (!hit) {
                    const r = rules.ruleReturn(index, receiver, seg.name, strArg);
                    return r || null;
                }
                return this.returnType(ctx, receiver, hit, strArg);
            }
            default:
                return null;
        }
    }

    /** Tipo de retorno de um método, na ordem: regra Adianti, tipo declarado, @return, corpo. */
    returnType(ctx, receiver, hit, strArg = () => null) {
        const index = this.index;
        const r = rules.ruleReturn(index, receiver, hit.method.name, strArg);
        if (r !== undefined) return r;
        const m = hit.method;
        if (m.name.toLowerCase() === '__construct') return null;
        const inst = { ...receiver, static: false, parentRef: false, viaParent: false };
        const declared = this.parseType(m.returnType, inst);
        if (declared) return declared;
        const doc = this.parseType(m.docReturn, inst);
        if (doc) return doc;
        if (m.returns && (ctx.depth || 0) < MAX_DEPTH) {
            const sctx = this.storedContext(ctx, hit.owner, inst, m.locals);
            for (const ex of m.returns) {
                const t = this.resolveString(sctx, ex);
                if (t) return t;
            }
        }
        return null;
    }

    /** Tipo de uma propriedade: declarado, @var, atribuições $this->prop = ..., ou get_prop() de TRecord. */
    propertyType(ctx, receiver, name) {
        const index = this.index;
        const cls = index.get(receiver.name);
        if (!cls) return null;
        const inst = { ...receiver, static: false, parentRef: false, viaParent: false };
        const hit = index.findProperty(cls, name);
        if (hit && !hit.property.inferredOnly) {
            const t = this.parseType(hit.property.type, inst) || this.parseType(hit.property.docType, inst);
            if (t) return t;
        }
        if ((ctx.depth || 0) < MAX_DEPTH) {
            for (const { cls: c } of index.lineage(cls)) {
                for (const entry of (c.propAssign && c.propAssign[name]) || []) {
                    const sctx = this.storedContext(ctx, c, inst, entry.locals);
                    const t = this.resolveString(sctx, entry.expr);
                    if (t) return t;
                }
            }
        }
        if (index.isSubclassOf(cls, 'TRecord')) {
            const g = index.findMethod(cls, 'get_' + name);
            if (g) return this.returnType(ctx, inst, g);
        }
        return null;
    }

    /** Objeto decorado por wrappers (BootstrapFormBuilder -> TForm, BootstrapDatagridWrapper -> TDataGrid). */
    decoratedType(ctx, receiver) {
        const cls = this.index.get(receiver.name);
        if (!cls || !this.index.findMethod(cls, '__call')) return null;
        const t = this.propertyType(ctx, receiver, 'decorated');
        return t && t.name.toLowerCase() !== cls.name.toLowerCase() ? t : null;
    }

    /** Converte string de tipo (PHP ou docblock) em tipo; ignora escalares. */
    parseType(str, receiver) {
        if (!str) return null;
        for (let part of String(str).split('|')) {
            part = part.trim().replace(/^\?/, '').replace(/^\\/, '').replace(/[()]/g, '');
            let arr = 0;
            const g = /^(?:array|list|iterable)<(?:[^,>]+,\s*)?([^>]+)>$/i.exec(part);
            if (g) { arr++; part = g[1].trim(); }
            while (part.endsWith('[]')) { arr++; part = part.slice(0, -2); }
            const lw = part.toLowerCase();
            if (lw === 'static' || lw === 'self' || lw === '$this') {
                if (receiver) return { ...receiver, static: false, array: arr || undefined };
                continue;
            }
            if (!part || BUILTINS.has(lw) || !/^[A-Za-z_\\][\w\\]*$/.test(part)) continue;
            const cls = this.index.get(part);
            if (cls) return { name: cls.name, array: arr || undefined };
        }
        return null;
    }

    // ---------------------------------------------------------------- membros

    /**
     * Membros acessíveis de um tipo.
     * scopeCls: classe onde o cursor está (para protected/private).
     */
    members(ctx, type, scopeCls) {
        const index = this.index;
        const cls = index.get(type.name);
        if (!cls || type.array) return [];
        const out = [];
        const seen = new Set();
        const staticAccess = !!type.static;
        const related = scopeCls && (index.isSubclassOf(scopeCls, cls.name) || index.isSubclassOf(cls, scopeCls.name));
        const canSee = (vis, owner) => vis === 'public' || (vis === 'protected' && related) ||
            (vis === 'private' && scopeCls && owner.name.toLowerCase() === scopeCls.name.toLowerCase());

        const add = (kind, name, info, owner, depth, extra) => {
            const key = kind + ':' + name.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            out.push({ kind, name, info, owner, depth, ...extra });
        };

        const lineage = index.lineage(cls);
        for (const { cls: c, depth } of lineage) {
            for (const m of c.methods) {
                const lw = m.name.toLowerCase();
                if (lw.startsWith('__') && !(lw === '__construct' && type.viaParent)) continue;
                if (!canSee(m.visibility, c)) { seen.add('method:' + lw); continue; }
                if (staticAccess && !m.static && !type.parentRef) continue;
                if (!staticAccess && m.static) continue;
                add('method', m.name, m, c, depth);
            }
            for (const p of c.properties) {
                if (!canSee(p.visibility, c)) continue;
                if (staticAccess !== !!p.static) continue;
                add('property', staticAccess ? '$' + p.name : p.name, p, c, depth);
            }
            if (staticAccess) {
                for (const k of c.constants) if (canSee(k.visibility, c)) add('constant', k.name, k, c, depth);
            } else if (c.propAssign) {
                for (const name of Object.keys(c.propAssign)) {
                    if (!c.properties.some(p => p.name === name)) add('property', name, { name, visibility: 'public', inferredOnly: true }, c, depth);
                }
            }
        }

        if (staticAccess) {
            add('constant', 'class', { name: 'class', value: 'nome da classe' }, cls, 99);
        } else if (index.isSubclassOf(cls, 'TRecord')) {
            // atributos do modelo e relações via get_xxx()
            for (const a of index.attributesOf(cls)) add('attribute', a, { name: a }, cls, -1);
            for (const { cls: c, depth } of lineage) {
                if (c.source === 'framework') continue;
                for (const m of c.methods) {
                    if (/^get_\w+/i.test(m.name) && !m.static) add('virtual', m.name.slice(4), m, c, depth - 1);
                }
            }
        }

        if (!staticAccess) {
            const dec = this.decoratedType(ctx, type);
            if (dec) {
                for (const m of this.members(ctx, { name: dec.name }, null)) {
                    add(m.kind, m.name, m.info, m.owner, m.depth + 10, { decorated: true });
                }
            }
        }
        return out;
    }

    // ------------------------------------------------- análise na posição

    /**
     * Analisa o texto antes do cursor e devolve o contexto de completion:
     *   { type: 'member', recv, partial, ctx }
     *   { type: 'class', mode, partial }
     *   { type: 'override', partial, ctx }
     *   { type: 'callback', cls, partial }       ['onSave'] em [$this, '...']
     *   { type: 'arg', call, argIndex, args, partial }
     */
    analyze(prefix) {
        const toks = tokenize(prefix);
        const n = toks.length;
        const last = toks[n - 1];
        const ctx = this.docContext(toks, n);
        if (!last) return { type: 'class', mode: 'any', partial: '', ctx, toks };

        const atEnd = last.e === prefix.length;
        if (last.t === 'str' && last.open && atEnd) return this.analyzeString(ctx, toks, n - 1);
        if (last.t === 'var' && atEnd) return { type: 'variable', partial: last.v, ctx, toks };
        if (last.t === 'num' && atEnd) return null;

        let partial = '';
        let idx = n - 1;
        if (last.t === 'id' && atEnd) { partial = last.v; idx = n - 2; }
        const prev = toks[idx];

        if (isP(prev, '->') || isP(prev, '?->') || isP(prev, '::')) {
            const start = exprStart(toks, idx - 1);
            if (start < 0) return null;
            const recv = this.resolveRange(ctx, toks, start, idx);
            return { type: 'member', recv, staticAccess: isP(prev, '::'), partial, ctx, toks };
        }

        const prevLw = prev && prev.t === 'id' ? prev.v.toLowerCase() : '';
        if (prevLw === 'new') {
            // $peca = new TCombo(...) -> o nome da variável sugere o nome do campo
            const assignVar = isP(toks[idx - 1], '=') && toks[idx - 2] && toks[idx - 2].t === 'var' ? toks[idx - 2].v : null;
            return { type: 'class', mode: 'new', partial, ctx, toks, assignVar };
        }
        if (prevLw === 'function' && ctx.cls && !ctx.funcs.length) return { type: 'override', partial, ctx, toks };
        if (prevLw === 'instanceof' || prevLw === 'catch') return { type: 'class', mode: 'any', partial, ctx, toks, typePos: true };

        // extends/implements (com listas separadas por vírgula)
        for (let k = idx; k >= 0 && k > idx - 20; k--) {
            const t = toks[k];
            if (t.t === 'id' && /^(extends|implements)$/i.test(t.v)) return { type: 'class', mode: t.v.toLowerCase(), partial, ctx, toks };
            if (!(t.t === 'id' || isP(t, ','))) break;
        }
        if (isId(prev, 'use') && ctx.cls && !ctx.funcs.length) return { type: 'class', mode: 'trait', partial, ctx, toks };

        const exprStartTok = prev && (prev.t === 'p' ? ['=', '(', ',', '[', '=>', '??', '?', ':', '.', '!'].includes(prev.v) : ['return', 'echo', 'instanceof'].includes(prevLw));
        if (partial && (/^[A-Z_\\]/.test(partial) || (exprStartTok && /^t[a-z]/i.test(partial))) &&
            !['class', 'interface', 'trait', 'function', 'const', 'namespace', 'enum', 'case', 'goto', 'as'].includes(prevLw) &&
            !(prev && prev.t === 'var')) {
            return { type: 'class', mode: 'any', partial, ctx, toks, typePos: isTypePosition(toks, idx) };
        }
        return null;
    }

    analyzeString(ctx, toks, strIdx) {
        const partial = stringValue(toks[strIdx]) || '';
        // abertura mais interna ainda não fechada: ( ou [
        let d = 0, open = -1;
        for (let j = strIdx - 1; j >= 0; j--) {
            const t = toks[j];
            if (t.t !== 'p') continue;
            if (t.v === ')' || t.v === ']' || t.v === '}') d++;
            else if (t.v === '(' || t.v === '[' || t.v === '{') {
                if (d === 0) { open = j; break; }
                d--;
            } else if (d === 0 && t.v === ';') break;
        }
        if (open < 0) return null;

        const args = splitArgs(toks, open + 1, strIdx + 1);
        const argIndex = args.length - 1;

        if (isP(toks[open], '[')) {
            // callback [$this, 'metodo'] / ['Classe', 'metodo'] / [Classe::class, 'metodo']
            if (argIndex !== 1) return null;
            const [a, b] = args[0];
            let clsName = null;
            if (b - a === 1 && toks[a].t === 'var' && toks[a].v === '$this') clsName = ctx.cls && ctx.cls.name;
            else if (b - a === 1 && isId(toks[a], '__class__')) clsName = ctx.cls && ctx.cls.name;
            else if (b - a === 1 && toks[a].t === 'str') clsName = stringValue(toks[a]);
            else if (b - a === 3 && isP(toks[a + 1], '::') && isId(toks[a + 2], 'class')) {
                const lw = toks[a].v.toLowerCase();
                clsName = (lw === 'self' || lw === 'static') ? ctx.cls && ctx.cls.name : toks[a].v;
            } else {
                const t = this.resolveRange(ctx, toks, a, b);
                clsName = t && t.name;
            }
            const cls = clsName && this.index.get(clsName);
            return cls ? { type: 'callback', cls, partial, ctx, toks } : null;
        }

        if (!isP(toks[open], '(')) return null;
        const call = this.calleeAt(ctx, toks, open);
        if (!call) return null;
        return { type: 'arg', call, argIndex, args, partial, ctx, toks };
    }

    /** Quem está sendo chamado no '(' em `open`: construtor (new X) ou método. */
    calleeAt(ctx, toks, open) {
        const b = toks[open - 1];
        if (!b || b.t !== 'id') return null;
        const index = this.index;
        if (isId(toks[open - 2], 'new')) {
            const lw = b.v.toLowerCase();
            const name = (lw === 'self' || lw === 'static') ? ctx.cls && ctx.cls.name :
                lw === 'parent' ? (ctx.cls && index.parentOf(ctx.cls) || {}).name : b.v;
            const cls = name && index.get(name);
            if (!cls) return null;
            const hit = index.findMethod(cls, '__construct');
            return { kind: 'ctor', cls, hit, recv: { name: cls.name }, label: cls.name };
        }
        const acc = toks[open - 2];
        if (isP(acc, '->') || isP(acc, '?->') || isP(acc, '::')) {
            const start = exprStart(toks, open - 3);
            if (start < 0) return null;
            let recv = this.resolveRange(ctx, toks, start, open - 2);
            if (!recv) return null;
            if (isP(acc, '->')) recv = { ...recv, static: false };
            let cls = index.get(recv.name);
            let hit = cls && index.findMethod(cls, b.v);
            if (!hit && cls && !recv.static) {
                const dec = this.decoratedType(ctx, recv);
                if (dec) { recv = dec; cls = index.get(dec.name); hit = index.findMethod(cls, b.v); }
            }
            if (!hit) return null;
            return { kind: 'method', cls, hit, recv, label: hit.owner.name + (hit.method.static ? '::' : '->') + hit.method.name };
        }
        return null;
    }

    /** Chamada envolvente (para signature help): { call, argIndex }. */
    callAt(prefix) {
        const toks = tokenize(prefix);
        let end = toks.length;
        if (end && toks[end - 1].t === 'str' && toks[end - 1].open) end--;
        let d = 0;
        let commas = 0;
        for (let j = end - 1; j >= 0; j--) {
            const t = toks[j];
            if (t.t !== 'p') continue;
            if (t.v === ')' || t.v === ']' || t.v === '}') d++;
            else if (t.v === '[' || t.v === '{') { if (d === 0) return null; d--; }
            else if (t.v === '(') {
                if (d > 0) { d--; continue; }
                const ctx = this.docContext(toks, toks.length);
                const call = this.calleeAt(ctx, toks, j);
                if (call) return { call, argIndex: commas, ctx, toks, open: j };
                return null;
            } else if (t.v === ',' && d === 0) commas++;
            else if (t.v === ';' && d === 0) return null;
        }
        return null;
    }
}

// ----------------------------------------------------------------- helpers

/**
 * O token em `idx` precede uma posição de tipo? (parâmetro de function/fn/catch,
 * tipo de retorno, tipo de propriedade) — aí não cabe sugerir `Classe::metodo()`.
 */
function isTypePosition(toks, idx) {
    const prev = toks[idx];
    if (!prev) return false;
    if (isP(prev, ':') && isP(toks[idx - 1], ')')) return true;
    if (prev.t === 'id' && /^(public|protected|private|readonly|var|static)$/i.test(prev.v)) return true;
    if (!(isP(prev, '(') || isP(prev, ',') || isP(prev, '?') || isP(prev, '|'))) return false;
    let d = 0;
    for (let j = idx; j >= 0; j--) {
        const t = toks[j];
        if (t.t !== 'p') continue;
        if (t.v === ')' || t.v === ']' || t.v === '}') d++;
        else if (t.v === '(' || t.v === '[' || t.v === '{') {
            if (d > 0) { d--; continue; }
            if (t.v !== '(') return false;
            const b = toks[j - 1];
            return isId(b, 'function') || isId(b, 'fn') || isId(b, 'catch') ||
                (b && b.t === 'id' && (isId(toks[j - 2], 'function') || (isP(toks[j - 2], '&') && isId(toks[j - 3], 'function'))));
        } else if (t.v === ';' && d === 0) return false;
    }
    return false;
}

function elementOf(t) {
    if (!t || !t.array) return null;
    const r = { ...t, array: t.array - 1 };
    if (!r.array) delete r.array;
    return r;
}

/** Divide os argumentos de toks[a..b) por vírgulas de nível 0. */
function splitArgs(toks, a, b) {
    const out = [];
    let d = 0, s = a;
    for (let j = a; j < b; j++) {
        const t = toks[j];
        if (t.t !== 'p') continue;
        if ('([{'.includes(t.v)) d++;
        else if (')]}'.includes(t.v)) d--;
        else if (t.v === ',' && d === 0) { out.push([s, j]); s = j + 1; }
    }
    out.push([s, b]);
    return out;
}

/** Função que lê o i-ésimo argumento literal ('Classe' ou Classe::class) de uma chamada. */
function argGetter(toks, args) {
    return i => {
        if (!args) return null;
        const parts = splitArgs(toks, args[0], args[1]);
        const p = parts[i];
        if (!p) return null;
        const [a, b] = p;
        if (b - a === 1 && toks[a].t === 'str') return stringValue(toks[a]);
        if (b - a === 3 && toks[a].t === 'id' && isP(toks[a + 1], '::') && isId(toks[a + 2], 'class')) return toks[a].v;
        return null;
    };
}

/** Início da expressão-cadeia (postfix) que termina no token `e` (inclusive). */
function exprStart(toks, e) {
    let i = e;
    while (i >= 0) {
        const t = toks[i];
        if (isP(t, ')') || isP(t, ']')) {
            const j = matchBackward(toks, i);
            if (j < 0) return -1;
            const p = toks[j - 1];
            if (p && (p.t === 'id' || p.t === 'var' || isP(p, ')') || isP(p, ']'))) {
                if (p.t === 'id' && KEYWORDS_BEFORE_PAREN.has(p.v.toLowerCase())) return j;
                i = j - 1;
                continue;
            }
            return j;
        }
        if (t.t === 'id' || t.t === 'var' || t.t === 'str') {
            const p = toks[i - 1];
            if (p && (isP(p, '->') || isP(p, '?->') || isP(p, '::'))) { i -= 2; continue; }
            if (isId(p, 'new')) return i - 1;
            return i;
        }
        return -1;
    }
    return -1;
}

/** Interpreta toks[a..b) como base + segmentos (->x, ->x(), ::x(), ::CONST, [i]). */
function parseChain(toks, a, b) {
    let k = a;
    let base;
    const t = toks[k];
    if (!t) return null;
    if (isId(t, 'new')) {
        const c = toks[k + 1];
        if (!c || c.t !== 'id' || isId(c, 'class')) return null;
        base = { kind: 'new', cls: c.v };
        k += 2;
        if (isP(toks[k], '(') && k < b) {
            const close = matchForward(toks, k);
            base.args = [k + 1, close];
            k = close + 1;
        }
    } else if (isP(t, '(')) {
        const close = matchForward(toks, k);
        if (close >= b) return null;
        base = { kind: 'group', a: k + 1, b: close };
        k = close + 1;
    } else if (t.t === 'var') {
        base = { kind: 'var', name: t.v, pos: k };
        k++;
    } else if (t.t === 'id') {
        if (isP(toks[k + 1], '(')) return null; // chamada de função global
        base = { kind: 'class', name: t.v };
        k++;
    } else {
        return null;
    }

    const segs = [];
    while (k < b) {
        const s = toks[k];
        if (isP(s, '->') || isP(s, '?->')) {
            const nm = toks[k + 1];
            if (!nm || nm.t !== 'id' || k + 1 >= b) return null;
            if (isP(toks[k + 2], '(') && k + 2 < b) {
                const close = matchForward(toks, k + 2);
                segs.push({ kind: 'call', name: nm.v, args: [k + 3, close] });
                k = close + 1;
            } else {
                segs.push({ kind: 'prop', name: nm.v });
                k += 2;
            }
        } else if (isP(s, '::')) {
            const nm = toks[k + 1];
            if (!nm || k + 1 >= b) return null;
            if (nm.t === 'var') { segs.push({ kind: 'sprop', name: nm.v }); k += 2; continue; }
            if (nm.t !== 'id') return null;
            if (isP(toks[k + 2], '(') && k + 2 < b) {
                const close = matchForward(toks, k + 2);
                segs.push({ kind: 'scall', name: nm.v, args: [k + 3, close] });
                k = close + 1;
            } else {
                segs.push({ kind: 'const', name: nm.v });
                k += 2;
            }
        } else if (isP(s, '[')) {
            const close = matchForward(toks, k);
            segs.push({ kind: 'index' });
            k = close + 1;
        } else {
            return null;
        }
    }
    return { base, segs };
}

module.exports = { Resolver, exprStart, parseChain, splitArgs, elementOf };
