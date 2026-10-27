'use strict';

/**
 * Exercita os providers do extension.js com uma API do VS Code simulada.
 * Uso: node test/extension-mock.js
 */

const Module = require('module');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

class Position {
    constructor(line, character) { this.line = line; this.character = character; }
    translate(dl, dc) { return new Position(this.line + dl, this.character + dc); }
}
class Range { constructor(start, end) { this.start = start; this.end = end; } }

const registered = {};
const tutorRoot = path.join(__dirname, '..', '..', 'adianti-tutor-8.7.0', 'tutor');

const vscode = {
    Position, Range,
    CompletionItem: class { constructor(label, kind) { this.label = label; this.kind = kind; } },
    CompletionList: class { constructor(items) { this.items = items; } },
    CompletionItemKind: new Proxy({}, { get: (_, k) => k }),
    CompletionItemTag: { Deprecated: 1 },
    SnippetString: class { constructor(v) { this.value = v; } },
    MarkdownString: class { constructor(v) { this.value = v; } },
    SignatureHelp: class { },
    SignatureInformation: class { constructor(label, doc) { this.label = label; this.documentation = doc; } },
    ParameterInformation: class { constructor(label) { this.label = label; } },
    Hover: class { constructor(c, r) { this.contents = c; this.range = r; } },
    Location: class { constructor(uri, pos) { this.uri = uri; this.pos = pos; } },
    Uri: { file: p => ({ fsPath: p, toString: () => 'file://' + p }) },
    languages: {
        registerCompletionItemProvider: (sel, p) => (registered.completion = p, {}),
        registerSignatureHelpProvider: (sel, p) => (registered.signature = p, {}),
        registerHoverProvider: (sel, p) => (registered.hover = p, {}),
        registerDefinitionProvider: (sel, p) => (registered.definition = p, {})
    },
    commands: { registerCommand: () => ({}) },
    window: {
        createOutputChannel: () => ({ appendLine: s => process.env.VERBOSE && console.log('[out] ' + s), dispose() { } }),
        setStatusBarMessage: () => { }
    },
    workspace: {
        workspaceFolders: [{ uri: { fsPath: tutorRoot } }],
        getConfiguration: () => ({ get: (k, d) => d }),
        onDidCloseTextDocument: () => ({}),
        onDidChangeConfiguration: () => ({}),
        createFileSystemWatcher: () => ({ onDidChange() { }, onDidCreate() { }, onDidDelete() { }, dispose() { } }),
        asRelativePath: p => path.relative(tutorRoot, typeof p === 'string' ? p : p.fsPath),
        findFiles: async (glob) => {
            const out = [];
            if (glob.includes('app/config')) {
                for (const f of fs.readdirSync(path.join(tutorRoot, 'app', 'config'))) out.push({ fsPath: path.join(tutorRoot, 'app', 'config', f) });
                return out;
            }
            (function walk(d) {
                for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                    const p = path.join(d, e.name);
                    if (e.isDirectory()) walk(p); else if (p.endsWith('.php')) out.push({ fsPath: p });
                }
            })(path.join(tutorRoot, 'app'));
            for (const f of fs.readdirSync(tutorRoot)) if (f.endsWith('.php')) out.push({ fsPath: path.join(tutorRoot, f) });
            return out;
        }
    }
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === 'vscode') return 'vscode';
    return origResolve.call(this, req, ...rest);
};
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscode };

function makeDoc(src) {
    const lines = src.split('\n');
    const offsetAt = p => lines.slice(0, p.line).reduce((a, l) => a + l.length + 1, 0) + p.character;
    const positionAt = off => {
        let line = 0;
        while (line < lines.length - 1 && off > lines[line].length) { off -= lines[line].length + 1; line++; }
        return new Position(line, off);
    };
    return {
        uri: { toString: () => 'untitled:test', fsPath: '/tmp/test.php' },
        version: 1,
        languageId: 'php',
        getText: r => r ? src.slice(offsetAt(r.start), offsetAt(r.end)) : src,
        offsetAt,
        positionAt,
        lineAt: line => ({ range: { end: new Position(line, lines[line].length) } }),
        getWordRangeAtPosition(pos, re) {
            re = re || /[A-Za-z_][\w]*/;
            const text = lines[pos.line];
            const g = new RegExp(re.source, 'g');
            let m;
            while ((m = g.exec(text))) {
                if (m.index <= pos.character && m.index + m[0].length >= pos.character) {
                    return new Range(new Position(pos.line, m.index), new Position(pos.line, m.index + m[0].length));
                }
                if (!m[0].length) g.lastIndex++;
            }
            return undefined;
        }
    };
}

/** Documento com '|' marcando o cursor. */
function docAt(src) {
    const off = src.indexOf('|');
    const doc = makeDoc(src.replace('|', ''));
    return { doc, pos: doc.positionAt(off) };
}

const labels = r => (Array.isArray(r) ? r : r ? r.items : []).map(i => typeof i.label === 'string' ? i.label : i.label.label);

const wrap = body => `<?php
class ProductForm extends TPage
{
    protected $form;
    public function __construct()
    {
        parent::__construct();
        $this->form = new BootstrapFormBuilder('form_product');
        ${body}
    }
    public function onSave($param) { }
}`;

(async () => {
    const ext = require('../extension.js');
    ext.activate({ extensionPath: path.join(__dirname, '..'), subscriptions: [] });
    await new Promise(r => setTimeout(r, 1500)); // indexação assíncrona

    let ok = 0;
    const t = async (name, fn) => { await fn(); ok++; console.log('  ok  ' + name); };

    await t('completion de membros em $this->form->', () => {
        const { doc, pos } = docAt(wrap('$this->form->|'));
        const r = registered.completion.provideCompletionItems(doc, pos);
        const l = labels(r);
        assert(l.includes('addFields') && l.includes('setFormTitle') && l.includes('getData'), l.slice(0, 10).join(','));
    });

    await t('completion de classes com new', () => {
        const { doc, pos } = docAt(wrap('$x = new TDB|'));
        const l = labels(registered.completion.provideCompletionItems(doc, pos));
        assert(l.includes('TDBCombo') && l.includes('TDBUniqueSearch'));
        assert(!l.includes('TField'), 'TField é abstrata');
    });

    const insertOf = (src, label, trigger) => {
        const { doc, pos } = docAt(wrap(src));
        const r = registered.completion.provideCompletionItems(doc, pos, null, trigger ? { triggerCharacter: trigger } : {});
        const items = Array.isArray(r) ? r : r ? r.items : [];
        const it = items.find(i => (i.label.label || i.label) === label);
        assert(it, `${label} não sugerido em: ${src}`);
        return it.insertText && it.insertText.value !== undefined ? it.insertText.value : it.insertText;
    };

    await t('exemplo do usuário: new TCombo/TEntry/TText com nome da variável', () => {
        assert.strictEqual(insertOf('$peca   = new TCo|', 'TCombo'), "TCombo('${1:peca}')$0");
        assert.strictEqual(insertOf('$tipo   = new TCombo|', 'TCombo'), "TCombo('${1:tipo}')$0");
        assert.strictEqual(insertOf('$qtd    = new TEnt|', 'TEntry'), "TEntry('${1:qtd}')$0");
        assert.strictEqual(insertOf('$custo  = new TEntry|', 'TEntry'), "TEntry('${1:custo}')$0");
        assert.strictEqual(insertOf('$motivo = new TTe|', 'TText'), "TText('${1:motivo}')$0");
    });

    await t('lista de classes abre ao digitar espaço depois de new', () => {
        assert.strictEqual(insertOf('$peca = new |', 'TCombo', ' '), "TCombo('${1:peca}')$0");
        const { doc, pos } = docAt(wrap('$a = 1 + |'));
        assert.strictEqual(registered.completion.provideCompletionItems(doc, pos, null, { triggerCharacter: ' ' }), undefined);
    });

    await t('construtor com vários argumentos (TDBCombo, TDataGridColumn)', () => {
        assert.strictEqual(insertOf('$cidade = new TDBCom|', 'TDBCombo'), "TDBCombo('${1:cidade}', '${2:database}', '${3:model}', '${4:key}', '${5:value}')$0");
        assert.strictEqual(insertOf('$col = new TDataGridCol|', 'TDataGridColumn'), "TDataGridColumn('${1:col}', '${2:label}', '${3:align}')$0");
        assert.strictEqual(insertOf('$vbox = new TVB|', 'TVBox'), undefined);
    });

    await t('digitação progressiva: new T, new TE, new TEn...', () => {
        for (const typed of ['new ', 'new T', 'new TE', 'new TEn', 'new TDB', 'new TDa']) {
            const { doc, pos } = docAt(wrap('$campo = ' + typed + '|'));
            const r = registered.completion.provideCompletionItems(doc, pos, null, typed.endsWith(' ') ? { triggerCharacter: ' ' } : {});
            const items = Array.isArray(r) ? r : r.items;
            const partial = typed.slice(4).toLowerCase();
            // aproximação do filtro do VS Code (prefixo) + ordenação por sortText
            const vis = items.filter(i => i.label.label.toLowerCase().startsWith(partial)).sort((a, b) => (a.sortText < b.sortText ? -1 : 1));
            assert(vis.length, 'nenhuma sugestão para ' + typed);
            if (process.env.VERBOSE) {
                const ins = vis[0].insertText && vis[0].insertText.value || vis[0].label.label;
                console.log(`      ${('$campo = ' + typed).padEnd(16)} → ${String(vis.length).padStart(3)} sugestões: ${vis.slice(0, 6).map(i => i.label.label).join(', ')}  | Enter: ${ins}`);
            }
        }
    });

    await t('chamada estática sem new: $container->add(TBread → TBreadCrumb::create', () => {
        assert.strictEqual(insertOf('$container->add(TBread|', 'TBreadCrumb::create'), 'TBreadCrumb::create($0)');
        assert.strictEqual(insertOf('$container->add(TBread|', 'TBreadCrumb'), undefined, 'a classe sozinha continua disponível');
        assert.strictEqual(insertOf('TTra|', 'TTransaction::open'), 'TTransaction::open($0)');
        assert.strictEqual(insertOf('$v = TSess|', 'TSession::getValue'), 'TSession::getValue($0)');
        assert.strictEqual(insertOf('$vbox->add(TPanelGroup|', 'TPanelGroup::pack'), 'TPanelGroup::pack($0)');
        assert.strictEqual(insertOf('$c = Custo|', 'Customer::find'), 'Customer::find($0)');
        assert.strictEqual(insertOf('$c = Custo|', 'Customer::where'), 'Customer::where($0)');
    });

    await t('sem Classe::metodo em posição de tipo', () => {
        const typeSrcs = ['function f(TCrit|', 'function f($a, TCrit|', 'catch (Excep|', 'function f(): TCrit|'];
        for (const s of typeSrcs) {
            const { doc, pos } = docAt(`<?php\nclass X extends TPage {\n    public ${s}\n}`);
            const l = labels(registered.completion.provideCompletionItems(doc, pos));
            assert(l.length && !l.some(x => x.includes('::')), s + ' → ' + l.filter(x => x.includes('::')).slice(0, 3));
        }
    });

    await t('signature help em TBreadCrumb::create(', () => {
        const { doc, pos } = docAt(wrap("$container->add(TBreadCrumb::create(|"));
        const h = registered.signature.provideSignatureHelp(doc, pos);
        assert(/TBreadCrumb::create\(\$options\)/.test(h.signatures[0].label), h.signatures[0].label);
    });

    await t('classe em minúsculas após = (sem new)', () => {
        const { doc, pos } = docAt(wrap('$x = ttrans|'));
        assert(labels(registered.completion.provideCompletionItems(doc, pos)).includes('TTransaction'));
    });

    await t('conexões em TTransaction::open', () => {
        const { doc, pos } = docAt(wrap("TTransaction::open('|"));
        const l = labels(registered.completion.provideCompletionItems(doc, pos));
        assert(l.includes('samples'), l.join(','));
    });

    await t('modelos no 3º argumento de TDBCombo', () => {
        const { doc, pos } = docAt(wrap("$c = new TDBCombo('city_id', 'samples', '|"));
        const l = labels(registered.completion.provideCompletionItems(doc, pos));
        assert(l.includes('City') && l.includes('Customer'), l.slice(0, 10).join(','));
    });

    await t('atributos do modelo no 5º argumento de TDBCombo', () => {
        const { doc, pos } = docAt(wrap("$c = new TDBCombo('city_id', 'samples', 'City', 'id', '|"));
        const l = labels(registered.completion.provideCompletionItems(doc, pos));
        assert(l.includes('name'), l.join(','));
    });

    await t('atributos em Customer::where(\'', () => {
        const { doc, pos } = docAt(wrap("Customer::where('|"));
        const l = labels(registered.completion.provideCompletionItems(doc, pos));
        assert(l.includes('name') && l.includes('city_id'), l.join(','));
    });

    await t('callbacks em new TAction([$this, \'', () => {
        const { doc, pos } = docAt(wrap("$a = new TAction([$this, '|"));
        const l = labels(registered.completion.provideCompletionItems(doc, pos));
        assert.strictEqual(l[0] !== undefined, true);
        assert(l.includes('onSave'), l.join(','));
    });

    await t('tipos de TMessage vindos do Tutor', () => {
        const { doc, pos } = docAt(wrap("new TMessage('|"));
        const l = labels(registered.completion.provideCompletionItems(doc, pos));
        assert(l.includes('info') && l.includes('error'), l.join(','));
    });

    await t('ícones no 3º argumento de addAction', () => {
        const { doc, pos } = docAt(wrap("$this->form->addAction('Salvar', new TAction([$this, 'onSave']), '|"));
        const l = labels(registered.completion.provideCompletionItems(doc, pos));
        assert(l.includes('fa:save green'), l.slice(0, 5).join(','));
    });

    await t('páginas em TApplication::loadPage', () => {
        const { doc, pos } = docAt(wrap("TApplication::loadPage('|"));
        const l = labels(registered.completion.provideCompletionItems(doc, pos));
        assert(l.includes('CustomerDataGridView'), l.slice(0, 5).join(','));
    });

    await t('signature help em new TDataGridColumn', () => {
        const { doc, pos } = docAt(wrap("$c = new TDataGridColumn('name', |"));
        const h = registered.signature.provideSignatureHelp(doc, pos);
        assert(/new TDataGridColumn\(\$name, \$label/.test(h.signatures[0].label), h.signatures[0].label);
        assert.strictEqual(h.activeParameter, 1);
    });

    await t('hover em classe, método e variável', () => {
        const src = wrap("$entry = new TEntry('x');\n        $entry->setMask('99');");
        const doc = makeDoc(src);
        const line = src.split('\n').findIndex(l => l.includes('setMask'));
        const hm = registered.hover.provideHover(doc, new Position(line, src.split('\n')[line].indexOf('setMask') + 2));
        assert(/TEntry::setMask/.test(hm.contents.value), hm.contents.value.slice(0, 80));
        const hv = registered.hover.provideHover(doc, new Position(line, src.split('\n')[line].indexOf('$entry') + 2));
        assert(/TEntry \$entry/.test(hv.contents.value), hv.contents.value);
        const lc = src.split('\n').findIndex(l => l.includes('new TEntry'));
        const hc = registered.hover.provideHover(doc, new Position(lc, src.split('\n')[lc].indexOf('TEntry') + 1));
        assert(/class TEntry extends TField/.test(hc.contents.value) && /Uso no Tutor/.test(hc.contents.value), hc.contents.value.slice(0, 200));
    });

    await t('override de métodos em TRecord', () => {
        const { doc, pos } = docAt(`<?php\nclass Product extends TRecord {\n    public function onBefore|\n}`);
        const l = labels(registered.completion.provideCompletionItems(doc, pos));
        assert(l.includes('onBeforeStore'), l.slice(0, 10).join(','));
    });

    await t('definição de classe do framework', async () => {
        const src = wrap("$e = new TEntry('x');");
        const doc = makeDoc(src);
        const line = src.split('\n').findIndex(l => l.includes('new TEntry'));
        const loc = await registered.definition.provideDefinition(doc, new Position(line, src.split('\n')[line].indexOf('TEntry') + 1));
        assert(loc && /lib\/adianti\/widget\/form\/TEntry\.php$/.test(loc.uri.fsPath), JSON.stringify(loc));
    });

    console.log(`\n${ok} ok`);
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
