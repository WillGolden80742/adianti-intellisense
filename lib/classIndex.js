'use strict';

/**
 * Índice de classes em camadas:
 *   overlay   — classes do documento sendo editado (sempre o texto mais recente)
 *   workspace — classes do projeto (app/model, app/control, ...)
 *   framework — classes do Adianti embarcadas (data/framework.json)
 * No Adianti as classes do núcleo são usadas pelo nome curto (AdiantiClassMap),
 * então a busca é por nome curto, sem diferenciar maiúsculas.
 */

function shortName(name) {
    if (!name) return '';
    const s = name.replace(/^\\/, '');
    const i = s.lastIndexOf('\\');
    return (i >= 0 ? s.slice(i + 1) : s).toLowerCase();
}

class ClassIndex {
    constructor(framework) {
        this.framework = new Map();
        this.frameworkVersion = framework.version;
        for (const c of require('./phpStubs')) this.framework.set(shortName(c.name), c);
        for (const c of framework.classes) {
            c.source = 'framework';
            this.framework.set(shortName(c.name), c);
        }
        this.workspace = new Map();       // nome -> classe
        this.files = new Map();           // arquivo -> [nomes]
        this.overlay = null;              // Map nome -> classe (documento atual)
        this.version = 0;
        this._subCache = new Map();
    }

    setFile(file, classes) {
        this.removeFile(file);
        const names = [];
        for (const c of classes) {
            c.source = 'workspace';
            c.file = file;
            const k = shortName(c.name);
            this.workspace.set(k, c);
            names.push(k);
        }
        this.files.set(file, names);
        this._touch();
    }

    removeFile(file) {
        const names = this.files.get(file);
        if (!names) return;
        for (const k of names) {
            const c = this.workspace.get(k);
            if (c && c.file === file) this.workspace.delete(k);
        }
        this.files.delete(file);
        this._touch();
    }

    clearWorkspace() {
        this.workspace.clear();
        this.files.clear();
        this._touch();
    }

    /** Executa fn com as classes do documento atual sobrepostas ao índice. */
    withOverlay(classes, fn) {
        const prev = this.overlay;
        this.overlay = new Map(classes.map(c => [shortName(c.name), c]));
        this._subCache = new Map();
        try { return fn(); } finally { this.overlay = prev; this._subCache = new Map(); }
    }

    _touch() {
        this.version++;
        this._subCache = new Map();
    }

    get(name) {
        const k = shortName(name);
        if (!k) return null;
        return (this.overlay && this.overlay.get(k)) || this.workspace.get(k) || this.framework.get(k) || null;
    }

    allClasses() {
        const map = new Map(this.framework);
        for (const [k, c] of this.workspace) map.set(k, c);
        if (this.overlay) for (const [k, c] of this.overlay) map.set(k, c);
        return [...map.values()];
    }

    parentOf(cls) {
        if (!cls || cls.kind !== 'class' || !cls.extends.length) return null;
        const p = this.get(cls.extends[0]);
        return p && p !== cls ? p : null;
    }

    /**
     * Linearização para busca de membros: a própria classe, seus traits,
     * depois o pai (e os traits dele), por fim as interfaces.
     * Cada item: { cls, depth }.
     */
    lineage(cls) {
        const out = [];
        const seen = new Set();
        const visit = (c, depth, viaInterface) => {
            if (!c || seen.has(c) || out.length > 40) return;
            seen.add(c);
            out.push({ cls: c, depth });
            for (const t of c.traits || []) visit(this.get(t), depth, false);
            if (c.kind === 'interface') {
                for (const p of c.extends) visit(this.get(p), depth + 1, true);
            } else if (!viaInterface) {
                visit(this.parentOf(c), depth + 1, false);
            }
        };
        visit(cls, 0, false);
        // interfaces por último (métodos abstratos ainda não vistos)
        for (const { cls: c, depth } of [...out]) {
            for (const i of c.implements || []) visit(this.get(i), depth + 1, true);
        }
        return out;
    }

    isSubclassOf(cls, baseName) {
        if (typeof cls === 'string') cls = this.get(cls);
        if (!cls) return false;
        const key = shortName(cls.name) + '<' + baseName.toLowerCase();
        if (this._subCache.has(key)) return this._subCache.get(key);
        const base = baseName.toLowerCase();
        let r = false;
        for (const { cls: c } of this.lineage(cls)) {
            if (shortName(c.name) === base) { r = true; break; }
        }
        this._subCache.set(key, r);
        return r;
    }

    findMethod(cls, name) {
        const lw = name.toLowerCase();
        for (const { cls: c, depth } of this.lineage(cls)) {
            const m = c.methods.find(x => x.name.toLowerCase() === lw);
            if (m) return { method: m, owner: c, depth };
        }
        return null;
    }

    findProperty(cls, name) {
        for (const { cls: c, depth } of this.lineage(cls)) {
            const p = c.properties.find(x => x.name === name);
            if (p) return { property: p, owner: c, depth };
            if (c.propAssign && c.propAssign[name]) return { property: { name, visibility: 'public', inferredOnly: true }, owner: c, depth };
        }
        return null;
    }

    findConstant(cls, name) {
        for (const { cls: c, depth } of this.lineage(cls)) {
            const k = c.constants.find(x => x.name === name);
            if (k) return { constant: k, owner: c, depth };
        }
        return null;
    }

    /** Atributos de um modelo TRecord (addAttribute) somando a hierarquia. */
    attributesOf(cls) {
        const out = [];
        for (const { cls: c } of this.lineage(cls)) for (const a of c.attributes || []) if (!out.includes(a)) out.push(a);
        return out;
    }

    /** Classes que herdam de TRecord (modelos). */
    models() {
        return this.allClasses().filter(c => c.kind === 'class' && c.source !== 'framework' && this.isSubclassOf(c, 'TRecord'));
    }
}

module.exports = { ClassIndex, shortName };
