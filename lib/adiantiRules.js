'use strict';

/**
 * Regras semânticas específicas do Adianti que o código-fonte sozinho não expressa
 * (o framework usa __callStatic, `new $this->class` e retornos dinâmicos):
 *   Customer::find(1)                  -> Customer
 *   Customer::where(...)               -> TRepository<Customer>
 *   Customer::where(...)->load()       -> Customer[]
 *   new TRepository('Customer')        -> TRepository<Customer>
 *   $sale->hasMany('SaleItem')         -> SaleItem[]
 */

const RECORD_STATIC_SELF = new Set(['find', 'first', 'last', 'firstornew', 'firstorcreate', 'findcache', 'findcacheby', 'create']);
const RECORD_STATIC_LIST = new Set(['all', 'getobjects']);
const RECORD_STATIC_REPO = new Set(['where', 'orwhere', 'select', 'groupby', 'set', 'orderby', 'take', 'skip', 'withtrashed']);
const RECORD_RELATION_LIST = new Set(['hasmany', 'loadcomposite', 'belongstomany', 'loadaggregate']);
const RECORD_RELATION_REPO = new Set(['filtermany']);
const REPO_LIST = new Set(['load', 'get', 'loadstatic', 'transform', 'filter']);
const REPO_ONE = new Set(['first', 'last', 'newobject']);

/** Retorna um tipo, `null` (sabidamente sem tipo de classe) ou `undefined` (regra não se aplica). */
function ruleReturn(index, receiver, methodName, strArg) {
    const lw = methodName.toLowerCase();
    const cls = index.get(receiver.name);
    if (!cls) return undefined;

    if (index.isSubclassOf(cls, 'TRecord')) {
        const model = cls.name;
        if (receiver.static && RECORD_STATIC_SELF.has(lw)) return { name: model };
        if (RECORD_STATIC_LIST.has(lw)) return { name: model, array: 1 };
        if (receiver.static && RECORD_STATIC_REPO.has(lw)) return { name: 'TRepository', of: model };
        if (RECORD_RELATION_LIST.has(lw)) { const c = strArg(0); return c ? { name: c, array: 1 } : null; }
        if (RECORD_RELATION_REPO.has(lw)) { const c = strArg(0); return c ? { name: 'TRepository', of: c } : null; }
        if (!receiver.static && lw === 'load') return { name: model };
    }

    if (receiver.of && index.isSubclassOf(cls, 'TRepository')) {
        if (REPO_LIST.has(lw)) return { name: receiver.of, array: 1 };
        if (REPO_ONE.has(lw)) return { name: receiver.of };
    }
    return undefined;
}

/** Tipo genérico de `new X(...)`: TRepository guarda a classe do modelo. */
function ruleNew(index, clsName, strArg) {
    const cls = index.get(clsName);
    if (cls && index.isSubclassOf(cls, 'TRepository')) {
        const of = strArg(0);
        if (of) return { name: cls.name, of };
    }
    return undefined;
}

// Classificação semântica de parâmetros pelo nome (convenção consistente do framework)
const DB_PARAMS = new Set(['database', 'db', 'dbname', 'connection']);
const MODEL_PARAMS = new Set(['model', 'active_record', 'activerecord', 'composite_class', 'aggregate_class', 'join_class', 'classname']);
const ATTR_PARAMS = new Set(['key', 'value', 'display_field', 'ordercolumn', 'order_column', 'column', 'attribute', 'variable',
    'indexcolumn', 'valuecolumn', 'order', 'group', 'foreign_key', 'foreign_key_parent', 'foreign_key_child', 'receive_key', 'receive_display_field']);
const ICON_PARAMS = new Set(['icon', 'image']);

const ALIGN_VALUES = ['left', 'center', 'right'];

module.exports = {
    ruleReturn,
    ruleNew,
    DB_PARAMS,
    MODEL_PARAMS,
    ATTR_PARAMS,
    ICON_PARAMS,
    ALIGN_VALUES
};
