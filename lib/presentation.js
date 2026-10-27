'use strict';

/**
 * Textos exibidos ao usuário: assinaturas, documentação em markdown e
 * trechos de uso reais tirados dos exemplos do Tutor (SKILL.md).
 */

function paramLabel(p) {
    let s = '';
    const type = p.type || p.docType;
    if (type) s += type + ' ';
    if (p.byRef) s += '&';
    if (p.variadic) s += '...';
    s += p.name;
    if (p.def !== undefined) s += ' = ' + p.def;
    return s;
}

function returnLabel(m) {
    if (m.returnType) return m.returnType;
    if (m.docReturn && /^[\\\w|?[\]<>$]+$/.test(m.docReturn) && !/^(A|An|The)$/i.test(m.docReturn)) return m.docReturn;
    return '';
}

function methodSignature(m) {
    const ret = returnLabel(m);
    return `${m.name}(${m.params.map(paramLabel).join(', ')})${ret ? ': ' + ret : ''}`;
}

function methodDeclaration(owner, m) {
    const mods = [m.visibility || 'public'];
    if (m.static) mods.push('static');
    return `${owner.name}::${methodSignature(m)}\n// ${mods.join(' ')} function`;
}

function classDeclaration(c) {
    let s = '';
    if (c.abstract) s += 'abstract ';
    s += (c.kind || 'class') + ' ' + c.name;
    if (c.extends.length) s += ' extends ' + c.extends.map(short).join(', ');
    if (c.implements.length) s += ' implements ' + c.implements.map(short).join(', ');
    return s;
}

function short(n) {
    const i = n.lastIndexOf('\\');
    return i >= 0 ? n.slice(i + 1) : n;
}

function fqcn(c) {
    return c.ns ? c.ns + '\\' + c.name : c.name;
}

function sourceLabel(c) {
    if (c.source === 'framework') return 'Adianti Framework';
    if (c.source === 'php') return 'PHP';
    return 'workspace';
}

/** Linhas de código no formato markdown. */
function codeBlock(code) {
    return '```php\n' + code + '\n```';
}

class Presenter {
    constructor(examples, index) {
        this.ex = examples;
        this.index = index;
        this.skillById = new Map(examples.skills.map(s => [s.id, s]));
    }

    classUsage(name) {
        return this.ex.classUsage[name] || null;
    }

    methodUsage(name) {
        return this.ex.methodUsage[name.toLowerCase()] || null;
    }

    /** Quantas vezes a classe aparece nos exemplos do Tutor (só `new X` quando onlyNew). */
    usageCount(name, onlyNew) {
        const u = this.ex.classUsage[name];
        return u ? (onlyNew ? u.newCount || 0 : u.count) : 0;
    }

    examplesSection(lines, skills, className) {
        const out = [];
        if (lines && lines.length) {
            out.push('**Uso no Tutor:**');
            out.push(codeBlock(lines.join('\n')));
        }
        if (skills && skills.length) {
            const names = skills.slice(0, 6).map(id => {
                const s = this.skillById.get(id);
                return s && s.tutorClass ? s.tutorClass : id.replace(/^adianti-/, '');
            });
            let line = '**Exemplos:** ' + names.map(n => '`' + n + '`').join(', ');
            if (className) {
                const arg = encodeURIComponent(JSON.stringify([className]));
                line += ` — [inserir exemplo…](command:adianti.insertExample?${arg})`;
            }
            out.push(line);
        }
        return out.join('\n\n');
    }

    classMarkdown(c) {
        const parts = [codeBlock(classDeclaration(c))];
        const ctor = this.index.findMethod(c, '__construct');
        if (ctor && ctor.method.params.length) parts.push(codeBlock(`new ${c.name}(${ctor.method.params.map(paramLabel).join(', ')})`));
        if (c.summary) parts.push(c.summary);
        const meta = [`*${sourceLabel(c)}*`];
        if (c.ns) meta.push('`' + fqcn(c) + '`');
        parts.push(meta.join(' · '));
        if (c.source === 'workspace' && c.attributes && c.attributes.length) {
            parts.push('**Atributos:** ' + c.attributes.map(a => '`' + a + '`').join(', '));
        }
        const u = this.classUsage(c.name);
        if (u) parts.push(this.examplesSection(u.lines, u.skills, c.name));
        return parts.join('\n\n');
    }

    methodMarkdown(owner, m) {
        const parts = [codeBlock(methodDeclaration(owner, m))];
        if (m.deprecated) parts.push('**Obsoleto.**');
        if (m.summary) parts.push(m.summary);
        const pdocs = m.params.filter(p => p.desc).map(p => `- \`${p.name}\` — ${p.desc}`);
        if (pdocs.length) parts.push(pdocs.join('\n'));
        if (m.returnDesc && !m.returnType) parts.push('**Retorno:** ' + m.returnDesc);
        if (owner.source === 'framework') {
            const u = this.methodUsage(m.name);
            if (u) parts.push(this.examplesSection(u.lines, null));
        }
        return parts.join('\n\n');
    }

    propertyMarkdown(owner, p, typeName) {
        const t = typeName || p.type || p.docType;
        const parts = [codeBlock(`${p.visibility || 'public'}${p.static ? ' static' : ''} ${t ? t + ' ' : ''}$${p.name}`)];
        if (p.summary) parts.push(p.summary);
        parts.push(`*${owner.name}*`);
        return parts.join('\n\n');
    }

    constantMarkdown(owner, k) {
        return [codeBlock(`const ${owner.name}::${k.name}${k.value ? ' = ' + k.value : ''}`), k.summary || ''].filter(Boolean).join('\n\n');
    }

    typeLabel(t) {
        if (!t) return 'mixed';
        let s = t.name;
        if (t.of) s += `<${t.of}>`;
        for (let i = 0; i < (t.array || 0); i++) s += '[]';
        return s;
    }
}

module.exports = { Presenter, paramLabel, methodSignature, returnLabel, fqcn, short };
