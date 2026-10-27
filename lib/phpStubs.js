'use strict';

/**
 * Stubs mínimos de classes nativas do PHP muito usadas junto com o Adianti
 * (catch de Exception, TTransaction::get() devolvendo PDO, datas).
 */

const m = (name, params = [], returnType, summary, isStatic) => ({
    name,
    static: !!isStatic,
    visibility: 'public',
    params: params.map(p => {
        const [type, n, def] = p.split(' ');
        return { name: n, type: type === '-' ? undefined : type, def };
    }),
    returnType,
    summary
});

function cls(name, kind, methods, extra = {}) {
    return { name, ns: '', kind, extends: [], implements: [], traits: [], methods, properties: [], constants: [], source: 'php', ...extra };
}

const throwableMethods = [
    m('getMessage', [], 'string', 'Mensagem da exceção'),
    m('getCode', [], 'int', 'Código da exceção'),
    m('getFile', [], 'string', 'Arquivo onde a exceção foi criada'),
    m('getLine', [], 'int', 'Linha onde a exceção foi criada'),
    m('getTrace', [], 'array', 'Pilha de chamadas'),
    m('getTraceAsString', [], 'string', 'Pilha de chamadas como texto'),
    m('getPrevious', [], '?Throwable', 'Exceção anterior')
];

module.exports = [
    cls('Throwable', 'interface', throwableMethods),
    cls('Exception', 'class', [m('__construct', ['string $message ""', 'int $code 0', '?Throwable $previous null']), ...throwableMethods], { implements: ['Throwable'] }),
    cls('Error', 'class', [m('__construct', ['string $message ""', 'int $code 0', '?Throwable $previous null']), ...throwableMethods], { implements: ['Throwable'] }),
    cls('RuntimeException', 'class', [], { extends: ['Exception'] }),
    cls('InvalidArgumentException', 'class', [], { extends: ['Exception'] }),
    cls('PDOException', 'class', [], { extends: ['RuntimeException'] }),
    cls('PDO', 'class', [
        m('prepare', ['string $query', 'array $options []'], 'PDOStatement|false', 'Prepara uma instrução SQL'),
        m('query', ['string $query'], 'PDOStatement|false', 'Executa uma consulta SQL'),
        m('exec', ['string $statement'], 'int|false', 'Executa uma instrução SQL e retorna as linhas afetadas'),
        m('lastInsertId', ['?string $name null'], 'string|false', 'Último ID inserido'),
        m('beginTransaction', [], 'bool'),
        m('commit', [], 'bool'),
        m('rollBack', [], 'bool'),
        m('inTransaction', [], 'bool'),
        m('quote', ['string $string'], 'string|false'),
        m('getAttribute', ['int $attribute'], 'mixed'),
        m('setAttribute', ['int $attribute', '- $value'], 'bool')
    ]),
    cls('PDOStatement', 'class', [
        m('execute', ['?array $params null'], 'bool', 'Executa a instrução preparada'),
        m('fetch', ['int $mode PDO::FETCH_DEFAULT'], 'mixed', 'Próxima linha do resultado'),
        m('fetchAll', ['int $mode PDO::FETCH_DEFAULT'], 'array', 'Todas as linhas do resultado'),
        m('fetchObject', ['?string $class "stdClass"'], 'object|false'),
        m('fetchColumn', ['int $column 0'], 'mixed'),
        m('rowCount', [], 'int'),
        m('bindValue', ['- $param', '- $value', 'int $type PDO::PARAM_STR'], 'bool'),
        m('bindParam', ['- $param', '- &$var', 'int $type PDO::PARAM_STR'], 'bool'),
        m('closeCursor', [], 'bool')
    ]),
    cls('DateTimeInterface', 'interface', [
        m('format', ['string $format'], 'string', 'Formata a data'),
        m('getTimestamp', [], 'int'),
        m('diff', ['DateTimeInterface $target', 'bool $absolute false'], 'DateInterval')
    ]),
    cls('DateTime', 'class', [
        m('__construct', ['string $datetime "now"', '?DateTimeZone $timezone null']),
        m('modify', ['string $modifier'], 'static', 'Altera a data (ex.: "+1 day")'),
        m('add', ['DateInterval $interval'], 'static'),
        m('sub', ['DateInterval $interval'], 'static'),
        m('setDate', ['int $year', 'int $month', 'int $day'], 'static'),
        m('setTime', ['int $hour', 'int $minute', 'int $second 0'], 'static'),
        m('createFromFormat', ['string $format', 'string $datetime'], 'DateTime|false', 'Cria a partir de um formato', true)
    ], { implements: ['DateTimeInterface'] }),
    cls('DateInterval', 'class', [
        m('__construct', ['string $duration']),
        m('format', ['string $format'], 'string')
    ]),
    cls('stdClass', 'class', [])
];
