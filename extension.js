'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { parseFile, tokenize, isP } = require('./lib/phpParser');
const { ClassIndex } = require('./lib/classIndex');
const { Resolver, exprStart } = require('./lib/resolver');
const { Presenter, paramLabel, returnLabel } = require('./lib/presentation');
const rules = require('./lib/adiantiRules');

const PHP = [{ language: 'php', scheme: 'file' }, { language: 'php', scheme: 'untitled' }];

let index, resolver, presenter, examples;
let connections = [];
const parseCache = new Map();   // uri -> { version, parsed }
let output;

function activate(context) {
    output = vscode.window.createOutputChannel('Adianti IntelliSense');
    const dataDir = path.join(context.extensionPath, 'data');
    index = new ClassIndex(JSON.parse(fs.readFileSync(path.join(dataDir, 'framework.json'), 'utf8')));
    examples = JSON.parse(fs.readFileSync(path.join(dataDir, 'examples.json'), 'utf8'));
    resolver = new Resolver(index);
    presenter = new Presenter(examples, index);
    output.appendLine(`Adianti ${index.frameworkVersion}: ${index.framework.size} classes do framework, ${examples.skills.length} exemplos do Tutor.`);

    context.subscriptions.push(
        output,
        vscode.languages.registerCompletionItemProvider(PHP, { provideCompletionItems }, '>', ':', "'", '"', '[', ' '),
        vscode.languages.registerSignatureHelpProvider(PHP, { provideSignatureHelp }, '(', ','),
        vscode.languages.registerHoverProvider(PHP, { provideHover }),
        vscode.languages.registerDefinitionProvider(PHP, { provideDefinition }),
        vscode.commands.registerCommand('adianti.insertExample', insertExample),
        vscode.commands.registerCommand('adianti.reindex', () => indexWorkspace(true)),
        vscode.workspace.onDidCloseTextDocument(d => parseCache.delete(d.uri.toString()))
    );

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{php,ini}');
    watcher.onDidChange(uri => onFileChanged(uri));
    watcher.onDidCreate(uri => onFileChanged(uri));
    watcher.onDidDelete(uri => { index.removeFile(uri.fsPath); if (isConfigFile(uri.fsPath)) loadConnections(); });
    context.subscriptions.push(watcher);
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('adianti')) indexWorkspace(true);
    }));

    indexWorkspace(false);
}

function deactivate() { }

function config() {
    return vscode.workspace.getConfiguration('adianti');
}

// ------------------------------------------------------------- workspace

async function indexWorkspace(verbose) {
    const cfg = config();
    if (!cfg.get('workspace.index', true)) { index.clearWorkspace(); return; }
    const exclude = cfg.get('workspace.exclude', '**/{vendor,node_modules,tmp,.git,lib/adianti}/**');
    const max = cfg.get('workspace.maxFiles', 5000);
    const started = Date.now();
    const files = await vscode.workspace.findFiles('**/*.php', exclude, max);
    index.clearWorkspace();
    let n = 0;
    for (let i = 0; i < files.length; i += 50) {
        await Promise.all(files.slice(i, i + 50).map(async uri => {
            try {
                const text = await fs.promises.readFile(uri.fsPath, 'utf8');
                index.setFile(uri.fsPath, parseFile(text).classes);
                n++;
            } catch (e) { /* arquivo ilegível: ignora */ }
        }));
    }
    await loadConnections();
    const msg = `Workspace indexado: ${n} arquivos PHP, ${index.workspace.size} classes, ${index.models().length} modelos TRecord, ${connections.length} conexões (${Date.now() - started} ms).`;
    output.appendLine(msg);
    if (verbose) vscode.window.setStatusBarMessage('$(check) Adianti: ' + msg, 5000);
}

async function onFileChanged(uri) {
    if (isConfigFile(uri.fsPath)) await loadConnections();
    if (!uri.fsPath.endsWith('.php')) return;
    const exclude = config().get('workspace.exclude', '');
    const rel = vscode.workspace.asRelativePath(uri, false);
    if (exclude && globToRegExp(exclude).test(rel)) return;
    try {
        index.setFile(uri.fsPath, parseFile(await fs.promises.readFile(uri.fsPath, 'utf8')).classes);
    } catch (e) {
        index.removeFile(uri.fsPath);
    }
}

function globToRegExp(glob) {
    // suficiente para o padrão de exclusão padrão (**, *, {a,b})
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
        else if (c === '*') re += '[^/]*';
        else if (c === '{') re += '(';
        else if (c === '}') re += ')';
        else if (c === ',') re += '|';
        else re += c.replace(/[.+^$()|[\]\\?]/g, '\\$&');
    }
    return new RegExp('^' + re + '$');
}

function isConfigFile(p) {
    return /[\\/]app[\\/]config[\\/][^\\/]+\.(php|ini)$/.test(p);
}

/** Conexões de banco: app/config/<nome>.php|ini que tenham a chave `type`. */
async function loadConnections() {
    const found = new Map();
    const files = await vscode.workspace.findFiles('**/app/config/*.{php,ini}', '**/{vendor,node_modules}/**', 200);
    for (const uri of files) {
        try {
            const text = await fs.promises.readFile(uri.fsPath, 'utf8');
            const isConn = uri.fsPath.endsWith('.ini') ? /^\s*type\s*=/m.test(text) : /['"]type['"]\s*=>/.test(text) && /['"](name|host)['"]\s*=>/.test(text);
            if (!isConn) continue;
            const name = path.basename(uri.fsPath).replace(/\.(php|ini)$/, '');
            const type = (/['"]?type['"]?\s*(?:=>|=)\s*['"]?(\w+)/.exec(text) || [])[1];
            const db = (/['"]?name['"]?\s*(?:=>|=)\s*['"]?([^'"\n,]+)/.exec(text) || [])[1];
            found.set(name, { name, type, db, file: uri.fsPath });
        } catch (e) { /* ignora */ }
    }
    connections = [...found.values()];
}

// ------------------------------------------------------------ documento

function parsedDoc(document) {
    const key = document.uri.toString();
    const c = parseCache.get(key);
    if (c && c.version === document.version) return c.parsed;
    const parsed = parseFile(document.getText());
    for (const cls of parsed.classes) { cls.source = 'workspace'; cls.file = document.uri.fsPath; }
    parseCache.set(key, { version: document.version, parsed });
    return parsed;
}

function withDocument(document, position, fn) {
    const parsed = parsedDoc(document);
    const text = document.getText();
    const offset = document.offsetAt(position);
    return index.withOverlay(parsed.classes, () => fn(text.slice(0, offset), text, offset));
}

// ------------------------------------------------------------ completion

function provideCompletionItems(document, position, token, context) {
    try {
        return withDocument(document, position, (prefix, text, offset) => {
            const r = resolver.analyze(prefix);
            if (!r) return undefined;
            // espaço só abre a lista depois de new / extends / implements
            if (context && context.triggerCharacter === ' ' && !(r.type === 'class' && r.mode !== 'any' && !r.partial)) return undefined;
            const nextChar = text[offset] || '';
            switch (r.type) {
                case 'member': return r.recv ? memberItems(r, document, position, nextChar) : undefined;
                case 'class': return config().get('completion.classes', true) ? classItems(r, document, position, nextChar) : undefined;
                case 'override': return overrideItems(r, document, position);
                case 'callback': return callbackItems(r, document, position);
                case 'arg': return argItems(r, document, position);
                default: return undefined;
            }
        });
    } catch (e) {
        output.appendLine('completion: ' + (e.stack || e));
        return undefined;
    }
}

function wordRange(document, position, re = /[A-Za-z_\x80-\uffff][\w\x80-\uffff]*/) {
    return document.getWordRangeAtPosition(position, re) || new vscode.Range(position, position);
}

/** Faixa do conteúdo da string em edição (do caractere após a aspa até o cursor). */
function stringRange(document, position, partial) {
    const start = position.translate(0, -Math.min(partial.length, position.character));
    return new vscode.Range(start, position);
}

function memberItems(r, document, position, nextChar) {
    const members = resolver.members(r.ctx, r.recv, r.ctx.cls);
    const range = wordRange(document, position, r.recv.static ? /\$?[A-Za-z_][\w]*/ : undefined);
    const items = [];
    for (const m of members) {
        let item;
        const owner = m.owner;
        if (m.kind === 'method') {
            item = new vscode.CompletionItem({
                label: m.name,
                detail: '(' + m.info.params.map(paramLabel).join(', ') + ')' + (returnLabel(m.info) ? ': ' + returnLabel(m.info) : ''),
                description: owner.name + (m.decorated ? ' (via __call)' : '')
            }, m.info.static ? vscode.CompletionItemKind.Function : vscode.CompletionItemKind.Method);
            if (nextChar !== '(') {
                if (m.info.params.length) {
                    item.insertText = new vscode.SnippetString(m.name + '($0)');
                    item.command = { command: 'editor.action.triggerParameterHints', title: '' };
                } else {
                    item.insertText = m.name + '()';
                }
            }
            item.documentation = markdown(presenter.methodMarkdown(owner, m.info));
            if (m.info.deprecated) item.tags = [vscode.CompletionItemTag.Deprecated];
        } else if (m.kind === 'constant') {
            item = new vscode.CompletionItem({ label: m.name, description: owner.name }, m.name === 'class' ? vscode.CompletionItemKind.Keyword : vscode.CompletionItemKind.Constant);
            if (m.name !== 'class') item.documentation = markdown(presenter.constantMarkdown(owner, m.info));
        } else if (m.kind === 'attribute') {
            item = new vscode.CompletionItem({ label: m.name, description: 'atributo · ' + owner.name }, vscode.CompletionItemKind.Field);
            item.documentation = markdown(`Atributo do modelo \`${owner.name}\` (\`addAttribute('${m.name}')\`).`);
        } else if (m.kind === 'virtual') {
            item = new vscode.CompletionItem({ label: m.name, description: 'get_' + m.name + '() · ' + owner.name }, vscode.CompletionItemKind.Reference);
            item.documentation = markdown(`Propriedade virtual: o Adianti chama \`get_${m.name}()\` ao ler \`->${m.name}\`.\n\n` + presenter.methodMarkdown(owner, m.info));
        } else {
            const t = resolver.propertyType(r.ctx, { ...r.recv, static: false }, m.name.replace(/^\$/, ''));
            item = new vscode.CompletionItem({ label: m.name, detail: t ? ': ' + presenter.typeLabel(t) : '', description: owner.name }, vscode.CompletionItemKind.Property);
            item.documentation = markdown(presenter.propertyMarkdown(owner, m.info, t && presenter.typeLabel(t)));
        }
        item.range = range;
        item.filterText = m.name;
        const usage = m.kind === 'method' && owner.source === 'framework' ? (presenter.methodUsage(m.name) || {}).count || 0 : 0;
        const kindRank = m.kind === 'attribute' || m.kind === 'virtual' ? 0 : m.kind === 'property' ? 1 : 2;
        item.sortText = `${String(Math.max(0, m.depth + 2)).padStart(2, '0')}${kindRank}${String(9999 - Math.min(usage, 9999)).padStart(4, '0')}${m.name}`;
        items.push(item);
    }
    return new vscode.CompletionList(items, false);
}

// parâmetros de construtor que recebem string (vão entre aspas no snippet)
const STRING_PARAMS = new Set(['name', 'label', 'title', 'value', 'type', 'message', 'database', 'model', 'key', 'class', 'method',
    'text', 'content', 'placeholder', 'mask', 'id', 'form', 'display_field', 'icon', 'image', 'align', 'width', 'height',
    'ordercolumn', 'formname', 'field', 'tag', 'pattern', 'file', 'filename', 'path', 'url', 'question', 'separator', 'color']);

function snippetEscape(s) {
    return String(s).replace(/[$}\\]/g, '\\$&');
}

/** `new TCombo` -> TCombo('${1:peca}') com os parâmetros obrigatórios do construtor. */
function constructorSnippet(c, assignVar) {
    const hit = index.findMethod(c, '__construct');
    const params = hit ? hit.method.params.filter(p => p.def === undefined && !p.variadic) : [];
    if (!params.length) return null;
    const parts = params.map((p, i) => {
        const pn = p.name.replace(/^&?\$/, '');
        let def = pn;
        if (i === 0 && assignVar && /^(name|id|field)$/i.test(pn)) def = assignVar.replace(/^\$/, '');
        const lit = (examples.literals[`new:${c.name}#${i}`] || [])[0];
        const quoted = STRING_PARAMS.has(pn.toLowerCase()) || (lit && !/^\d/.test(lit[0])) || /\bstring\b/i.test(p.type || '');
        return quoted ? `'\${${i + 1}:${snippetEscape(def)}}'` : `\${${i + 1}:\\$${snippetEscape(pn)}}`;
    });
    return `${c.name}(${parts.join(', ')})$0`;
}

/**
 * Prioridade das classes na lista:
 *   0 componentes do framework usados no Tutor (por frequência: TLabel, TAction, TEntry...)
 *   1 modelos TRecord do projeto
 *   2 demais classes do framework/PHP e utilitários do projeto
 *   3 páginas do projeto (TPage/TWindow raramente são instanciadas com new)
 * Em `extends`, as bases usuais (TPage, TWindow, TRecord...) vêm antes de tudo.
 */
function classSortText(c, mode) {
    const usage = presenter.usageCount(c.name, mode === 'new');
    let tier;
    if (mode === 'extends' && /^(TPage|TWindow|TRecord|TStandardList|TStandardForm|TStandardFormList|TStandardSeek)$/.test(c.name)) tier = 0;
    else if (c.source === 'framework' && usage > 0) tier = 1;
    else if (c.source === 'workspace' && index.isSubclassOf(c, 'TRecord')) tier = 2;
    else if (c.source === 'workspace' && (index.isSubclassOf(c, 'TPage') || index.isSubclassOf(c, 'TWindow'))) tier = 4;
    else tier = 3;
    return `${tier}${String(9999 - Math.min(usage, 9999)).padStart(4, '0')}${c.name}`;
}

function publicConstructor(c) {
    const hit = index.findMethod(c, '__construct');
    return !hit || hit.method.visibility === 'public';
}

function classItems(r, document, position, nextChar) {
    const range = wordRange(document, position, /[A-Za-z_\\][\w\\]*/);
    const items = [];
    for (const c of index.allClasses()) {
        if (r.mode === 'new' && (c.kind !== 'class' || c.abstract || !publicConstructor(c))) continue;
        if (r.mode === 'extends' && c.kind !== 'class' && c.kind !== 'interface') continue;
        if (r.mode === 'implements' && c.kind !== 'interface') continue;
        if (r.mode === 'trait' && c.kind !== 'trait') continue;
        if (r.mode === 'any' && c.kind === 'trait') continue;
        const kind = c.kind === 'interface' ? vscode.CompletionItemKind.Interface :
            c.kind === 'trait' ? vscode.CompletionItemKind.Module :
                c.kind === 'enum' ? vscode.CompletionItemKind.Enum : vscode.CompletionItemKind.Class;
        const item = new vscode.CompletionItem({ label: c.name, description: c.source === 'framework' ? (c.ns || 'Adianti') : c.source === 'php' ? 'PHP' : 'workspace' }, kind);
        item.range = range;
        if (r.mode === 'trait' && c.ns) item.insertText = c.ns + '\\' + c.name;
        if (r.mode === 'new' && nextChar !== '(') {
            const snip = constructorSnippet(c, r.assignVar);
            if (snip) {
                item.insertText = new vscode.SnippetString(snip);
                item.command = { command: 'editor.action.triggerParameterHints', title: '' };
                const ctor = index.findMethod(c, '__construct');
                item.label.detail = '(' + ctor.method.params.map(paramLabel).join(', ') + ')';
            }
        }
        item.documentation = markdown(presenter.classMarkdown(c));
        item.sortText = classSortText(c, r.mode);
        if (c.deprecated) item.tags = [vscode.CompletionItemTag.Deprecated];
        items.push(item);
        if (r.mode === 'any' && !r.typePos && nextChar !== ':') items.push(...staticCallItems(c, range));
    }
    return items;
}

// métodos estáticos herdados de TRecord oferecidos direto nos modelos: Customer::find(...)
const MODEL_STATICS = new Set(['find', 'where', 'all', 'getobjects', 'create', 'first', 'last', 'orderby', 'countobjects', 'getindexedarray', 'firstornew', 'firstorcreate']);

/** Itens `Classe::metodo(...)` para chamadas estáticas sem `new` (TBreadCrumb::create, TTransaction::open...). */
function staticCallItems(c, range) {
    if (c.kind !== 'class' || c.source === 'php') return [];
    const isModel = c.source === 'workspace' && index.isSubclassOf(c, 'TRecord');
    const out = [];
    const seen = new Set();
    for (const { cls: owner } of index.lineage(c)) {
        if (owner !== c && !isModel) break; // só os estáticos da própria classe, exceto modelos
        for (const m of owner.methods) {
            const lw = m.name.toLowerCase();
            if (!m.static || m.visibility !== 'public' || lw.startsWith('__') || seen.has(lw)) continue;
            if (owner !== c && !MODEL_STATICS.has(lw)) continue;
            if (c.source === 'workspace' && !isModel && owner !== c) continue;
            seen.add(lw);
            const label = `${c.name}::${m.name}`;
            const usage = examples.staticCalls[`${c.name}::${m.name}`] || 0;
            const item = new vscode.CompletionItem({
                label,
                detail: '(' + m.params.map(paramLabel).join(', ') + ')' + (returnLabel(m) ? ': ' + returnLabel(m) : ''),
                description: usage ? `${usage}× no Tutor` : (owner !== c ? owner.name : '')
            }, vscode.CompletionItemKind.Function);
            item.range = range;
            item.filterText = label;
            item.insertText = new vscode.SnippetString(label + (m.params.length ? '($0)' : '()$0'));
            if (m.params.length) item.command = { command: 'editor.action.triggerParameterHints', title: '' };
            item.documentation = markdown(presenter.methodMarkdown(owner, m));
            // logo após a própria classe; os mais usados no Tutor primeiro
            item.sortText = classSortText(c, 'any') + '::' + String(9999 - Math.min(usage, 9999)).padStart(4, '0') + m.name;
            if (m.deprecated) item.tags = [vscode.CompletionItemTag.Deprecated];
            out.push(item);
        }
    }
    return out;
}

function overrideItems(r, document, position) {
    const cls = r.ctx.cls;
    const parent = cls && index.parentOf(cls);
    if (!parent) return undefined;
    const own = new Set(cls.methods.map(m => m.name.toLowerCase()));
    const seen = new Set();
    const items = [];
    for (const { cls: c, depth } of index.lineage(parent)) {
        const hooks = (c.hooks || []).map(h => ({ ...h, visibility: 'public', static: false, hook: true }));
        for (const m of [...hooks, ...c.methods]) {
            const lw = m.name.toLowerCase();
            if (own.has(lw) || seen.has(lw) || m.visibility === 'private' || m.static && lw === '__construct') continue;
            seen.add(lw);
            const params = m.params.map(p => p.name + (p.def !== undefined ? ' = ' + p.def : '')).join(', ');
            const item = new vscode.CompletionItem({ label: m.name, detail: `(${params})`, description: (m.hook ? 'hook de ' : 'sobrescrever ') + c.name }, vscode.CompletionItemKind.Method);
            const body = lw === '__construct' ? `parent::__construct(${m.params.map(p => p.name).join(', ')});\n\t$0` : '$0';
            item.insertText = new vscode.SnippetString(`${m.name}(${params.replace(/[$}\\]/g, '\\$&')})\n{\n\t${body}\n}`);
            item.documentation = markdown(presenter.methodMarkdown(c, m));
            item.range = wordRange(document, position);
            item.sortText = String(depth).padStart(2, '0') + (m.hook ? '0' : /^on/i.test(m.name) ? '1' : '2') + m.name;
            items.push(item);
        }
    }
    return items;
}

function callbackItems(r, document, position) {
    const range = stringRange(document, position, r.partial);
    const items = [];
    const seen = new Set();
    for (const { cls: c, depth } of index.lineage(r.cls)) {
        for (const m of c.methods) {
            const lw = m.name.toLowerCase();
            if (lw.startsWith('__') || seen.has(lw)) continue;
            seen.add(lw);
            if (m.visibility === 'private' && depth > 0) continue;
            const item = new vscode.CompletionItem({ label: m.name, detail: '(' + m.params.map(p => p.name).join(', ') + ')', description: (m.static ? 'static · ' : '') + c.name }, vscode.CompletionItemKind.Method);
            item.range = range;
            item.documentation = markdown(presenter.methodMarkdown(c, m));
            item.sortText = (depth === 0 ? '0' : '1') + (/^on/i.test(m.name) ? '0' : '1') + (m.visibility === 'public' ? '0' : '1') + m.name;
            items.push(item);
        }
    }
    return items;
}

/** Sugestões dentro de strings em argumentos: conexões, modelos, atributos, métodos, ícones e literais do Tutor. */
function argItems(r, document, position) {
    const { call, argIndex, args, toks } = r;
    const params = call.hit ? call.hit.method.params : [];
    const param = params[argIndex] || (params.length && params[params.length - 1].variadic ? params[params.length - 1] : null);
    const pname = param ? param.name.replace(/^\$/, '').toLowerCase() : '';
    const range = stringRange(document, position, r.partial);
    const items = [];
    const seen = new Set();
    const push = (label, kind, description, documentation, sort) => {
        if (seen.has(label)) return;
        seen.add(label);
        const item = new vscode.CompletionItem({ label, description }, kind);
        item.range = range;
        if (documentation) item.documentation = markdown(documentation);
        item.sortText = sort + label;
        items.push(item);
    };

    const literalOf = i => {
        const a = args[i];
        if (!a || a[1] - a[0] !== 1) return null;
        const t = toks[a[0]];
        if (t.t === 'str') return t.v.slice(1, -1);
        return null;
    };
    const argByParam = names => {
        for (let i = 0; i < params.length; i++) {
            if (i !== argIndex && names.has(params[i].name.replace(/^\$/, '').toLowerCase())) return literalOf(i);
        }
        return null;
    };

    const ownerName = call.hit ? call.hit.owner.name : '';
    const recvCls = call.recv && index.get(call.recv.name);
    const recvIsModel = recvCls && index.isSubclassOf(recvCls, 'TRecord');
    const recvIsRepo = recvCls && index.isSubclassOf(recvCls, 'TRepository');
    const dbContext = /^(TRepository|TRecord|TCriteria|TDatabase|TTransaction)$/.test(ownerName) || recvIsModel || recvIsRepo;

    if (rules.DB_PARAMS.has(pname)) {
        for (const c of connections) push(c.name, vscode.CompletionItemKind.Value, `conexão${c.type ? ' · ' + c.type : ''}`, c.db ? `Banco: \`${c.db}\`\n\nArquivo: \`${vscode.workspace.asRelativePath(c.file)}\`` : null, '0');
    }

    if (rules.MODEL_PARAMS.has(pname) || (pname === 'class' && dbContext)) {
        for (const m of index.models()) push(m.name, vscode.CompletionItemKind.Class, 'modelo TRecord', presenter.classMarkdown(m), '0');
    } else if (pname === 'class' || pname === 'classname') {
        // páginas: TApplication::loadPage('Classe'), TScript, etc.
        for (const c of index.allClasses()) {
            if (c.source !== 'workspace' || c.kind !== 'class') continue;
            const isPage = index.isSubclassOf(c, 'TPage') || index.isSubclassOf(c, 'TWindow');
            push(c.name, vscode.CompletionItemKind.Class, isPage ? 'página' : 'classe', null, isPage ? '0' : '1');
        }
    }

    if (pname === 'method') {
        const clsName = argByParam(new Set(['class', 'classname']));
        const cls = clsName && index.get(clsName);
        if (cls) callbackItems({ cls, partial: r.partial }, document, position).forEach(i => { if (!seen.has(i.label.label)) { seen.add(i.label.label); items.push(i); } });
    }

    if (rules.ATTR_PARAMS.has(pname)) {
        let model = argByParam(rules.MODEL_PARAMS);
        if (!model && recvIsModel) model = recvCls.name;
        if (!model && recvIsRepo && call.recv.of) model = call.recv.of;
        const mcls = model && index.get(model);
        if (mcls) {
            for (const a of index.attributesOf(mcls)) push(a, vscode.CompletionItemKind.Field, 'atributo · ' + mcls.name, null, '0');
            if (pname === 'value' || pname === 'display_field') {
                push('{' + (index.attributesOf(mcls)[0] || 'name') + '}', vscode.CompletionItemKind.Snippet, 'máscara {atributo}', 'Máscara com atributos entre chaves, ex.: `{name} - {city->name}`', '1');
            }
            if (!seen.has('id')) push('id', vscode.CompletionItemKind.Field, 'chave primária', null, '0');
        }
    }

    if (rules.ICON_PARAMS.has(pname)) {
        for (const [icon, count] of examples.icons) push(icon, vscode.CompletionItemKind.Color, `ícone · ${count}× no Tutor`, null, '2');
    }
    if (pname === 'align') rules.ALIGN_VALUES.forEach(v => push(v, vscode.CompletionItemKind.EnumMember, 'alinhamento', null, '0'));

    // literais usados nos exemplos do Tutor para esta mesma chamada/argumento
    if (config().get('completion.tutorLiterals', true)) {
        const keys = [];
        if (call.kind === 'ctor') {
            for (const { cls: c } of index.lineage(call.cls)) keys.push(`new:${c.name}#${argIndex}`);
        } else if (call.hit) {
            const name = call.hit.method.name;
            keys.push(`${call.recv.name}::${name}#${argIndex}`, `${call.hit.owner.name}::${name}#${argIndex}`, `->${name}#${argIndex}`);
            if (call.recv.viaParent) keys.push(`parent::${name}#${argIndex}`);
        }
        for (const k of keys) {
            for (const [v, count] of examples.literals[k] || []) {
                push(v, vscode.CompletionItemKind.Text, `Tutor · ${count}×`, null, '3' + String(9999 - count).padStart(4, '0'));
            }
        }
    }
    return items.length ? items : undefined;
}

// --------------------------------------------------------- signature help

function provideSignatureHelp(document, position) {
    try {
        return withDocument(document, position, prefix => {
            const r = resolver.callAt(prefix);
            if (!r || !r.call.hit) return undefined;
            const { method, owner } = r.call.hit;
            const label = (r.call.kind === 'ctor' ? 'new ' + r.call.cls.name : owner.name + (method.static ? '::' : '->') + method.name) +
                '(' + method.params.map(paramLabel).join(', ') + ')' + (r.call.kind !== 'ctor' && returnLabel(method) ? ': ' + returnLabel(method) : '');
            const sig = new vscode.SignatureInformation(label, markdown(presenter.methodMarkdown(owner, method).replace(/^```php[\s\S]*?```\n*/, '')));
            sig.parameters = method.params.map(p => new vscode.ParameterInformation(paramLabel(p), p.desc ? markdown(p.desc) : undefined));
            const help = new vscode.SignatureHelp();
            help.signatures = [sig];
            help.activeSignature = 0;
            const last = method.params.length - 1;
            help.activeParameter = last >= 0 && method.params[last].variadic ? Math.min(r.argIndex, last) : r.argIndex;
            return help;
        });
    } catch (e) {
        output.appendLine('signature: ' + (e.stack || e));
        return undefined;
    }
}

// ---------------------------------------------------------- hover / definição

/** O que está sob o cursor: { kind: 'class'|'method'|'property'|'constant'|'variable', ... }. */
function targetAt(document, position) {
    const range = document.getWordRangeAtPosition(position, /\$?[A-Za-z_\\][\w\\]*/);
    if (!range) return null;
    const word = document.getText(range);
    return withDocument(document, range.end, prefix => {
        const toks = tokenize(prefix);
        const n = toks.length;
        const last = toks[n - 1];
        if (!last || last.t === 'str' || last.t === 'doc') return null;
        const ctx = resolver.docContext(toks, n);

        if (last.t === 'var') {
            let type = resolver.resolveVar(ctx, word, n - 1);
            // atribuição na própria linha: $x = new Y
            const after = document.getText(new vscode.Range(range.end, document.lineAt(range.end.line).range.end));
            if (!type && /^\s*=[^=]/.test(after)) {
                const ftoks = tokenize(prefix + after);
                if (isP(ftoks[n], '=')) {
                    let end = n + 1;
                    while (end < ftoks.length && !isP(ftoks[end], ';')) end++;
                    type = resolver.resolveRange(resolver.docContext(ftoks, ftoks.length), ftoks, n + 1, end);
                }
            }
            return { kind: 'variable', name: word, type, range };
        }
        if (last.t !== 'id') return null;
        const prev = toks[n - 2];
        if (isP(prev, '->') || isP(prev, '?->') || isP(prev, '::')) {
            const start = exprStart(toks, n - 3);
            if (start < 0) return null;
            let recv = resolver.resolveRange(ctx, toks, start, n - 2);
            if (!recv) return null;
            if (isP(prev, '->')) recv = { ...recv, static: false };
            const cls = index.get(recv.name);
            if (!cls) return null;
            let method = index.findMethod(cls, word);
            if (!method && !recv.static) {
                const dec = resolver.decoratedType(ctx, recv);
                if (dec) method = index.findMethod(index.get(dec.name), word);
            }
            const after = document.getText(new vscode.Range(range.end, document.lineAt(range.end.line).range.end));
            if (method && /^\s*\(/.test(after)) return { kind: 'method', hit: method, range };
            if (isP(prev, '::')) {
                const k = word !== 'class' && index.findConstant(cls, word);
                if (k) return { kind: 'constant', hit: k, range };
            } else {
                const p = index.findProperty(cls, word);
                if (p) return { kind: 'property', hit: p, type: resolver.propertyType(ctx, recv, word), range };
                if (index.isSubclassOf(cls, 'TRecord')) {
                    if (index.attributesOf(cls).includes(word)) return { kind: 'attribute', cls, name: word, range };
                    const g = index.findMethod(cls, 'get_' + word);
                    if (g) return { kind: 'method', hit: g, range, virtual: word, type: resolver.propertyType(ctx, recv, word) };
                }
            }
            return method ? { kind: 'method', hit: method, range } : null;
        }
        const lw = word.toLowerCase();
        if (lw === 'self' || lw === 'static' || lw === 'parent') return null;
        const cls = index.get(word);
        if (cls && !isP(prev, '->')) {
            // inclui o construtor se for `new X`
            return { kind: 'class', cls, range };
        }
        return null;
    });
}

function provideHover(document, position) {
    try {
        const t = targetAt(document, position);
        if (!t) return undefined;
        let md;
        switch (t.kind) {
            case 'class': md = presenter.classMarkdown(t.cls); break;
            case 'method':
                md = presenter.methodMarkdown(t.hit.owner, t.hit.method);
                if (t.virtual) md = `Propriedade virtual \`->${t.virtual}\`${t.type ? ': `' + presenter.typeLabel(t.type) + '`' : ''} (via \`get_${t.virtual}()\`)\n\n` + md;
                break;
            case 'property': md = presenter.propertyMarkdown(t.hit.owner, t.hit.property, t.type && presenter.typeLabel(t.type)); break;
            case 'constant': md = presenter.constantMarkdown(t.hit.owner, t.hit.constant); break;
            case 'attribute': md = `\`\`\`php\n${t.cls.name}->${t.name}\n\`\`\`\n\nAtributo do modelo (\`addAttribute('${t.name}')\`).`; break;
            case 'variable':
                if (!t.type) return undefined;
                md = '```php\n' + `${presenter.typeLabel(t.type)} ${t.name}` + '\n```\n\n*tipo inferido pelo Adianti IntelliSense*';
                break;
        }
        return md ? new vscode.Hover(markdown(md), t.range) : undefined;
    } catch (e) {
        output.appendLine('hover: ' + (e.stack || e));
        return undefined;
    }
}

const frameworkFileCache = new Map();

async function locateFrameworkFile(rel) {
    if (frameworkFileCache.has(rel)) return frameworkFileCache.get(rel);
    let found = null;
    for (const folder of vscode.workspace.workspaceFolders || []) {
        const p = path.join(folder.uri.fsPath, rel);
        if (fs.existsSync(p)) { found = vscode.Uri.file(p); break; }
    }
    if (!found) {
        const r = await vscode.workspace.findFiles('**/' + rel, '**/node_modules/**', 1);
        if (r.length) found = r[0];
    }
    frameworkFileCache.set(rel, found);
    return found;
}

async function provideDefinition(document, position) {
    const t = targetAt(document, position);
    if (!t) return undefined;
    let cls, line;
    if (t.kind === 'class') { cls = t.cls; line = cls.line; }
    else if (t.kind === 'method' || t.kind === 'property' || t.kind === 'constant') {
        cls = t.hit.owner;
        line = (t.hit.method || t.hit.property || t.hit.constant).line;
    } else if (t.kind === 'attribute') { cls = t.cls; line = cls.line; }
    if (!cls || !cls.file) return undefined;
    const uri = cls.source === 'framework' ? await locateFrameworkFile(cls.file) : vscode.Uri.file(cls.file);
    if (!uri) return undefined;
    return new vscode.Location(uri, new vscode.Position(line || 0, 0));
}

// -------------------------------------------------------------- comandos

/** Insere um exemplo do Tutor (blocos ```php dos SKILL.md). Opcionalmente filtra por classe. */
async function insertExample(className) {
    let skills = examples.skills;
    if (typeof className === 'string') {
        const u = examples.classUsage[className];
        if (u) skills = skills.filter(s => u.skills.includes(s.id) || s.blocks.some(b => new RegExp('\\b' + className + '\\b').test(b.code)));
    }
    const pick = await vscode.window.showQuickPick(skills.map(s => ({
        label: s.tutorClass || s.id.replace(/^adianti-/, ''),
        description: s.id,
        detail: s.description,
        skill: s
    })), {
        placeHolder: typeof className === 'string' ? `Exemplos do Tutor que usam ${className}` : 'Exemplo do Adianti Tutor para inserir',
        matchOnDescription: true,
        matchOnDetail: true
    });
    if (!pick) return;
    let block = pick.skill.blocks[0];
    if (pick.skill.blocks.length > 1) {
        const b = await vscode.window.showQuickPick(pick.skill.blocks.map((blk, i) => ({
            label: blk.section || `Bloco ${i + 1}`,
            detail: blk.code.split('\n').find(l => l.trim()) || '',
            blk
        })), { placeHolder: 'Qual trecho?' });
        if (!b) return;
        block = b.blk;
    }
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'php') {
        let code = block.code;
        if (editor.document.getText().trim().length && code.startsWith('<?php')) code = code.replace(/^<\?php\s*\n/, '');
        await editor.edit(e => e.replace(editor.selection, code));
    } else {
        const doc = await vscode.workspace.openTextDocument({ language: 'php', content: block.code.startsWith('<?php') ? block.code : '<?php\n' + block.code });
        await vscode.window.showTextDocument(doc);
    }
}

function markdown(s) {
    const md = new vscode.MarkdownString(s);
    md.isTrusted = { enabledCommands: ['adianti.insertExample'] };
    return md;
}

module.exports = { activate, deactivate };
