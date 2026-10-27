#!/usr/bin/env node
'use strict';

/**
 * Gera os dados embarcados na extensão:
 *   data/framework.json  — índice de classes do Adianti (lido do código-fonte do framework)
 *   data/examples.json   — exemplos do Tutor (blocos ```php dos SKILL.md) e estatísticas de uso
 *
 * Uso: node scripts/build-data.js <raiz-do-tutor> <pasta-ADIANTI-MODULOS>
 */

const fs = require('fs');
const path = require('path');
const { tokenize, parseFile, matchForward, stringValue, isP, isId } = require('../lib/phpParser');

const root = path.resolve(process.argv[2] || '../adianti-tutor-8.7.0/tutor');
const modulesDir = path.resolve(process.argv[3] || '../ADIANTI-MODULOS');
const outDir = path.join(__dirname, '..', 'data');

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === 'vendor' && dir !== path.join(root, 'vendor')) continue;
            walk(p, out);
        } else if (e.name.endsWith('.php')) {
            out.push(p);
        }
    }
    return out;
}

function buildFramework() {
    const files = [
        ...walk(path.join(root, 'lib', 'adianti')),
        ...(fs.existsSync(path.join(root, 'vendor', 'adianti')) ? walk(path.join(root, 'vendor', 'adianti')) : [])
    ];
    const classes = [];
    for (const f of files) {
        const parsed = parseFile(fs.readFileSync(f, 'utf8'));
        for (const c of parsed.classes) {
            delete c.start;
            delete c.end;
            c.file = path.relative(root, f).split(path.sep).join('/');
            if (!c.attributes.length) delete c.attributes;
            if (!Object.keys(c.propAssign).length) delete c.propAssign;
            classes.push(c);
        }
    }
    let version = '';
    try { version = fs.readFileSync(path.join(root, 'lib', 'VERSION'), 'utf8').trim(); } catch (e) { /* opcional */ }
    return { version, classes };
}

function parseSkill(dir) {
    const file = path.join(modulesDir, dir, 'SKILL.md');
    if (!fs.existsSync(file)) return null;
    const md = fs.readFileSync(file, 'utf8');
    const fm = /^---\n([\s\S]*?)\n---/.exec(md);
    const meta = {};
    if (fm) {
        for (const line of fm[1].split('\n')) {
            const m = /^(\w+):\s*(.*)$/.exec(line);
            if (m) meta[m[1]] = m[2];
        }
    }
    const title = (/^#\s+(.+)$/m.exec(md) || [])[1] || dir;
    const tutorClass = (/Classe Tutor:\s*`(\w+)`/.exec(md) || [])[1];
    const source = (/Fonte lida automaticamente:\s*`([^`]+)`/.exec(md) || [])[1];
    const blocks = [];
    const re = /```php\n([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(md))) {
        // título da seção (## ...) que antecede o bloco
        const before = md.slice(0, m.index);
        const h = before.match(/^##\s+(.+)$/gm);
        blocks.push({ section: h ? h[h.length - 1].replace(/^##\s+/, '') : '', code: m[1].replace(/\s+$/, '') + '\n' });
    }
    return {
        id: meta.name || dir,
        description: meta.description || title,
        title: title.replace(/^Skill Adianti —\s*/, ''),
        tutorClass,
        source,
        blocks
    };
}

function bump(map, key, val) {
    const e = map[key] = map[key] || { count: 0, skills: [], lines: [] };
    e.count++;
    if (val && val.skill && !e.skills.includes(val.skill)) e.skills.push(val.skill);
    if (val && val.line) {
        const l = val.line.trim().replace(/\s+/g, ' ');
        if (l.length >= 12 && l.length <= 110 && !e.lines.includes(l)) e.lines.push(l);
    }
}

function buildExamples(frameworkClasses) {
    const known = new Map(frameworkClasses.map(c => [c.name.toLowerCase(), c.name]));
    const knownMethods = new Set();
    for (const c of frameworkClasses) for (const m of c.methods) knownMethods.add(m.name.toLowerCase());

    const skills = fs.readdirSync(modulesDir).sort().map(parseSkill).filter(s => s && s.blocks.length);
    const classUsage = {};
    const methodUsage = {};
    const literals = {};
    const staticCalls = {};

    for (const s of skills) {
        for (const b of s.blocks) {
            const code = b.code;
            const toks = tokenize(code, { php: !code.includes('<?php') });
            const lineAt = off => {
                const a = code.lastIndexOf('\n', off - 1) + 1;
                const z = code.indexOf('\n', off);
                return code.slice(a, z < 0 ? code.length : z);
            };

            for (let i = 0; i < toks.length; i++) {
                const t = toks[i];
                if (t.t !== 'id') continue;
                const lw = t.v.replace(/^\\/, '').toLowerCase();

                // uso de classes: new X, X::, extends X
                if (known.has(lw) && (isId(toks[i - 1], 'new') || isP(toks[i + 1], '::') || isId(toks[i - 1], 'extends'))) {
                    bump(classUsage, known.get(lw), { skill: s.id, line: lineAt(t.s) });
                    if (isId(toks[i - 1], 'new')) classUsage[known.get(lw)].newCount = (classUsage[known.get(lw)].newCount || 0) + 1;
                }
                // uso de métodos: ->m( ou X::m(
                if ((isP(toks[i - 1], '->') || isP(toks[i - 1], '::')) && isP(toks[i + 1], '(') && knownMethods.has(lw)) {
                    bump(methodUsage, lw, { line: lineAt(t.s) });
                }
                // chamadas estáticas de classes do framework: TTransaction::open(
                if (isP(toks[i - 1], '::') && isP(toks[i + 1], '(') && toks[i - 2] && known.has(toks[i - 2].v.toLowerCase())) {
                    const k = known.get(toks[i - 2].v.toLowerCase()) + '::' + t.v;
                    staticCalls[k] = (staticCalls[k] || 0) + 1;
                }

                // literais string usados como argumento: new X('..'), ->m('..'), X::m('..')
                if (isP(toks[i + 1], '(')) {
                    let key = null;
                    if (isId(toks[i - 1], 'new') && known.has(lw)) key = 'new:' + known.get(lw);
                    else if (isP(toks[i - 1], '->')) key = '->' + t.v;
                    else if (isP(toks[i - 1], '::') && toks[i - 2] && toks[i - 2].t === 'id') key = toks[i - 2].v + '::' + t.v;
                    if (!key) continue;
                    const close = matchForward(toks, i + 1);
                    let arg = 0, d = 0, argStart = i + 2;
                    for (let j = i + 2; j <= close; j++) {
                        const x = toks[j];
                        const isEnd = j === close || (d === 0 && isP(x, ','));
                        if (x.t === 'p' && '([{'.includes(x.v)) d++;
                        else if (x.t === 'p' && ')]}'.includes(x.v) && j !== close) d--;
                        if (isEnd) {
                            if (j - argStart === 1 && toks[argStart].t === 'str') {
                                const v = stringValue(toks[argStart]);
                                if (v && v.length <= 60 && !/[{}$<>]/.test(v)) {
                                    const k = key + '#' + arg;
                                    literals[k] = literals[k] || {};
                                    literals[k][v] = (literals[k][v] || 0) + 1;
                                }
                            }
                            arg++;
                            argStart = j + 1;
                        }
                    }
                }
            }
        }
    }

    // mantém só literais recorrentes (aparecem em 2+ exemplos), ordenados por frequência
    const lit = {};
    for (const [k, vals] of Object.entries(literals)) {
        const list = Object.entries(vals).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 20);
        if (list.length) lit[k] = list;
    }

    // ícones (fa:, far:, fas:, fab:, bi:, mi:) mais usados nos exemplos
    const iconCount = {};
    for (const vals of Object.values(literals)) {
        for (const [v, c] of Object.entries(vals)) {
            if (/^(fa|far|fas|fab|bi|bs|mi):[\w-]+(\s+[#\w-]+)*$/.test(v)) iconCount[v] = (iconCount[v] || 0) + c;
        }
    }
    const icons = Object.entries(iconCount).sort((a, b) => b[1] - a[1]).slice(0, 80);

    for (const u of [...Object.values(classUsage), ...Object.values(methodUsage)]) {
        u.lines = u.lines.sort((a, b) => a.length - b.length).slice(0, 3);
        u.skills = u.skills.slice(0, 12);
    }

    return { skills, classUsage, methodUsage, staticCalls, literals: lit, icons };
}

function main() {
    fs.mkdirSync(outDir, { recursive: true });
    const fw = buildFramework();
    fs.writeFileSync(path.join(outDir, 'framework.json'), JSON.stringify(fw));
    const ex = buildExamples(fw.classes);
    fs.writeFileSync(path.join(outDir, 'examples.json'), JSON.stringify(ex));
    const nMethods = fw.classes.reduce((a, c) => a + c.methods.length, 0);
    const nBlocks = ex.skills.reduce((a, s) => a + s.blocks.length, 0);
    console.log(`framework ${fw.version}: ${fw.classes.length} classes, ${nMethods} métodos`);
    console.log(`exemplos: ${ex.skills.length} skills, ${nBlocks} blocos php, ${Object.keys(ex.classUsage).length} classes usadas, ${Object.keys(ex.literals).length} chaves de literais, ${ex.icons.length} ícones`);
}

main();
