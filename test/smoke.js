'use strict';

/**
 * Teste de fumaça do motor semântico (sem VS Code).
 * Uso: node test/smoke.js [pasta-app-do-tutor]
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { parseFile } = require('../lib/phpParser');
const { ClassIndex } = require('../lib/classIndex');
const { Resolver } = require('../lib/resolver');

const index = new ClassIndex(require('../data/framework.json'));
const appDir = process.argv[2] || path.join(__dirname, '..', '..', 'adianti-tutor-8.7.0', 'tutor', 'app', 'model');
if (fs.existsSync(appDir)) {
    for (const f of fs.readdirSync(appDir)) {
        if (f.endsWith('.php')) index.setFile(path.join(appDir, f), parseFile(fs.readFileSync(path.join(appDir, f), 'utf8')).classes);
    }
}
const resolver = new Resolver(index);

let pass = 0, fail = 0;

/** `src` contém '|' marcando o cursor. */
function at(src) {
    const offset = src.indexOf('|');
    const text = src.slice(0, offset) + src.slice(offset + 1);
    const parsed = parseFile(text);
    return index.withOverlay(parsed.classes, () => {
        const r = resolver.analyze(text.slice(0, offset));
        let names = [];
        if (r && r.type === 'member' && r.recv) names = resolver.members(r.ctx, r.recv, r.ctx.cls).map(m => m.name);
        return { r, names, recv: r && r.recv };
    });
}

function check(label, fn) {
    try { fn(); pass++; console.log('  ok  ' + label); }
    catch (e) { fail++; console.log('  FALHOU ' + label + ': ' + e.message); }
}

const page = body => `<?php
class CustomerList extends TPage
{
    protected $form;
    protected $datagrid;
    use Adianti\\Base\\AdiantiStandardListTrait;

    public function __construct()
    {
        parent::__construct();
        $this->form = new BootstrapFormBuilder('form_search');
        $this->datagrid = new BootstrapDatagridWrapper(new TDataGrid);
        ${body}
    }

    public function onSave($param)
    {
    }

    public static function onChangeType($param)
    {
    }
}`;

check('new TEntry -> métodos de TEntry/TField', () => {
    const { recv, names } = at(page(`$name = new TEntry('name');\n$name->|`));
    assert.strictEqual(recv.name, 'TEntry');
    assert(names.includes('setMask') && names.includes('setSize') && names.includes('addValidation'), names.slice(0, 10).join(','));
});

check('$this->form (propriedade inferida) -> BootstrapFormBuilder', () => {
    const { recv, names } = at(page(`$this->form->|`));
    assert.strictEqual(recv.name, 'BootstrapFormBuilder');
    assert(names.includes('addFields') && names.includes('setFormTitle'));
    assert(names.includes('getData'), 'membros decorados de TForm');
});

check('$this-> mostra propriedades protegidas e métodos herdados de TPage', () => {
    const { names } = at(page(`$this->|`));
    for (const n of ['form', 'datagrid', 'onSave', 'setTargetContainer']) assert(names.includes(n), n);
});

check('datagrid wrapper delega para TDataGrid', () => {
    const { recv, names } = at(page(`$this->datagrid->|`));
    assert.strictEqual(recv.name, 'BootstrapDatagridWrapper');
    assert(names.includes('addColumn') && names.includes('createModel') && names.includes('addAction'), names.join(','));
});

check('encadeamento: $this->form->addAction(...)->', () => {
    const { recv } = at(page(`$this->form->addAction('Save', new TAction([$this, 'onSave']), 'fa:save')->|`));
    assert(recv && recv.name === 'TButton', JSON.stringify(recv));
});

check('TTransaction:: estáticos', () => {
    const { names } = at(page(`TTransaction::|`));
    for (const n of ['open', 'close', 'rollback', 'get']) assert(names.includes(n), n);
    assert(!names.includes('__construct'));
});

check('Model::find() -> Model (workspace TRecord)', () => {
    const { recv, names } = at(page(`$c = Customer::find(1);\n$c->|`));
    assert.strictEqual(recv.name, 'Customer');
    assert(names.includes('store') && names.includes('name'), names.slice(0, 15).join(','));
});

check('Model::where()->load() + foreach -> Model', () => {
    const { recv } = at(page(`$list = Customer::where('id', '>', 1)->orderBy('name')->load();\nforeach ($list as $obj) {\n$obj->|`));
    assert.strictEqual(recv && recv.name, 'Customer');
});

check('new TRepository(\'Customer\')->load() -> Customer[]', () => {
    const { recv } = at(page(`$repo = new TRepository('Customer');\n$objs = $repo->load($criteria);\n$objs[0]->|`));
    assert.strictEqual(recv && recv.name, 'Customer');
});

check('relação get_city() vira propriedade virtual com tipo', () => {
    const { recv, names } = at(page(`$c = new Customer(1);\n$c->|`));
    assert(names.includes('city'), names.join(','));
    const r2 = at(page(`$c = new Customer(1);\n$c->city->|`));
    assert.strictEqual(r2.recv && r2.recv.name, 'City');
});

check('parent:: em TPage', () => {
    const { names } = at(page(`parent::|`));
    assert(names.includes('add') && names.includes('__construct'), names.join(','));
});

check('parâmetro tipado function(TCriteria $c)', () => {
    const { recv } = at(`<?php class X extends TPage { function f(TCriteria $criteria) { $criteria->| } }`);
    assert.strictEqual(recv.name, 'TCriteria');
});

check('callback [$this, \'...\']', () => {
    const offsetSrc = page(`$a = new TAction([$this, 'on|`);
    const off = offsetSrc.indexOf('|');
    const text = offsetSrc.replace('|', '');
    const r = index.withOverlay(parseFile(text).classes, () => resolver.analyze(text.slice(0, off)));
    assert.strictEqual(r.type, 'callback');
    assert.strictEqual(r.cls.name, 'CustomerList');
});

check('argumento $database de TDBCombo', () => {
    const src = page(`$c = new TDBCombo('city_id', '|`);
    const off = src.indexOf('|');
    const text = src.replace('|', '');
    const r = index.withOverlay(parseFile(text).classes, () => resolver.analyze(text.slice(0, off)));
    assert.strictEqual(r.type, 'arg');
    assert.strictEqual(r.call.hit.method.params[r.argIndex].name, '$database');
});

check('TPage::create() -> TPage', () => {
    const { recv } = at(page(`$p = TPage::create();\n$p->|`));
    assert(recv && /TPage/.test(recv.name), JSON.stringify(recv));
});

check('signature help de new TDataGridColumn', () => {
    const src = page(`$col = new TDataGridColumn('name', 'Nome', |`);
    const off = src.indexOf('|');
    const text = src.replace('|', '');
    const r = index.withOverlay(parseFile(text).classes, () => resolver.callAt(text.slice(0, off)));
    assert.strictEqual(r.call.cls.name, 'TDataGridColumn');
    assert.strictEqual(r.argIndex, 2);
});

console.log(`\n${pass} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
