# Changelog

## 1.2.1
- Publisher alterado para `WillGolden80742` (o ID da extensão passa a ser `WillGolden80742.adianti-intellisense`).

## 1.2.0
- Chamadas estáticas sem `new`: ao digitar o nome da classe, a lista já oferece `Classe::metodo(...)` para todos os métodos estáticos públicos do framework (298 em 74 classes, ex.: `TBreadCrumb::create`, `TTransaction::open`, `TSession::getValue`, `TPanelGroup::pack`), os das classes do projeto e os mais usados de TRecord nos modelos (`Customer::find`, `Customer::where`…). Ordenados pelo uso no Tutor; não aparecem em posições de tipo (parâmetros, catch, retorno).

## 1.1.1
- Ordem das classes no `new`: primeiro os componentes mais instanciados no Tutor (TLabel, TAction, TEntry, TMessage, TDataGridColumn…), depois os modelos do projeto; páginas do projeto vão para o fim.
- Classes com construtor privado (ex.: TTransaction) não aparecem depois de `new`.

## 1.1.0
- Autocomplete de classes com construtor: `$peca = new TCo` → `TCombo('peca')`, preenchendo os argumentos obrigatórios e usando o nome da variável como nome do campo.
- A lista de classes abre ao digitar espaço depois de `new`, `extends` e `implements`.
- Classes também aparecem ao digitar em minúsculas após `=`, `(`, `,` e `return` (ex.: `ttrans` → `TTransaction`).

## 1.0.0
- Primeira versão: autocomplete semântico de classes e métodos, modelos TRecord, sugestões dentro de strings (conexões, modelos, atributos, callbacks, ícones), assinaturas, hover, ir para definição, snippets e exemplos do Tutor.
