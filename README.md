# Adianti IntelliSense

Autocomplete semântico para o **Adianti Framework 8.7** no VS Code. A extensão entende o seu código e sugere o que faz sentido em cada ponto.

O índice vem de duas fontes:
- **o código-fonte do framework** (`lib/adianti` e `vendor/adianti`), com 211 classes e cerca de 2.090 métodos, cada um com assinatura e docblock;
- **os 369 exemplos de código do Adianti Tutor**, de onde saem os exemplos de uso, a ordem das sugestões e os valores mais comuns de cada argumento.

## Instalação

1. Baixe o `.vsix` da versão mais recente em **[Releases](https://github.com/WillGolden80742/adianti-intellisense/releases/latest)**.
2. Instale pelo terminal:
   ```bash
   code --install-extension adianti-intellisense-1.2.0.vsix
   ```
   Ou pelo VS Code: **Extensões** → menu `···` → **Install from VSIX…**
3. Recarregue a janela (**Developer: Reload Window**).

Para atualizar, baixe o `.vsix` novo e instale com `--force`. As mudanças de cada versão estão no [CHANGELOG](CHANGELOG.md) e nas [Releases](https://github.com/WillGolden80742/adianti-intellisense/releases).

## O que ela faz

### Classes
Ao digitar `new T…`, `extends …` ou `TTransaction::`, a extensão sugere as classes do Adianti e do seu projeto. As mais usadas no Tutor aparecem primeiro.

Depois de `extends`, as primeiras sugestões são `TPage`, `TWindow` e `TRecord`.

Depois de `new`, a classe já entra com os argumentos do construtor, e o nome do campo vem da variável:

```php
$peca   = new TCo      // ↵  new TCombo('peca')
$qtd    = new TEnt     // ↵  new TEntry('qtd')
$cidade = new TDBCom   // ↵  new TDBCombo('cidade', 'database', 'model', 'key', 'value')
```

Chamadas estáticas, sem `new`, também aparecem direto na lista. Isso vale para todos os 298 métodos estáticos públicos do framework, para os das classes do seu projeto e para os mais usados de `TRecord` nos seus modelos:

```php
$container->add(TBread   // ↵  TBreadCrumb::create(…)
TTra                     // ↵  TTransaction::open(…)  · close · rollback
$c = Custo               // ↵  Customer::find(…)  · where · all…
```

Use Tab para passar de um argumento ao próximo. A lista abre assim que você digita o espaço depois de `new`.

### Métodos com inferência de tipo
A extensão descobre o tipo de cada variável e sugere os métodos certos depois de `->` e `::`:

```php
$name = new TEntry('name');
$name->            // setMask, setSize, addValidation… (TEntry + TField)

$this->form = new BootstrapFormBuilder('form');
$this->form->      // addFields, setFormTitle… e também getData/setData do TForm decorado

$this->datagrid = new BootstrapDatagridWrapper(new TDataGrid);
$this->datagrid->  // addColumn, createModel… (TDataGrid via __call)

$this->form->addAction('Salvar', $action, 'fa:save')->   // TButton
```

Ela reconhece:
- `new X`, parâmetros tipados, `catch (Exception $e)`, `@var` e `foreach`;
- propriedades atribuídas em qualquer método (`$this->x = …`);
- tipos de retorno declarados, em `@return` ou deduzidos do `return` no corpo do método;
- os wrappers que delegam chamadas via `__call` (decorators);
- chamadas a `parent::` e `self::`.

### Modelos TRecord
```php
$c = Customer::find(1);            // Customer
$c->                               // atributos (addAttribute), store(), delete()…
$c->city->                         // City — via get_city()
Customer::where('active', '=', 'Y')->orderBy('name')->load();   // Customer[]
$repo = new TRepository('Customer'); $repo->load();             // Customer[]
$sale->hasMany('SaleItem');        // SaleItem[]
```

### Sugestões dentro de strings
| Onde | O que sugere |
|---|---|
| `new TAction([$this, '…'])` | métodos da classe atual (`onSave`, `onReload`…) |
| `['OutraClasse', '…']` | métodos da outra classe |
| `TTransaction::open('…')`, `setDatabase('…')`, `$database` dos `TDB*` | conexões de `app/config/*.php` e `*.ini` |
| `new TRepository('…')`, `setActiveRecord('…')`, `$model` dos `TDB*` | modelos `TRecord` do projeto |
| `new TDBCombo('x', 'db', 'Model', '…', '…')`, `Model::where('…')` | atributos do modelo |
| `TApplication::loadPage('…', '…')` | páginas e depois os métodos da página |
| `$icon` em `addAction`, `addHeaderActionLink`… | ícones mais usados no Tutor (`fa:save green`, `far:edit blue`…) |
| `new TMessage('…')`, `TToast::show('…')`, `setMask('…')`… | valores mais usados no Tutor para aquele argumento |

### Outros recursos
- **Assinaturas**: ao digitar `(` ou `,`, mostra os parâmetros, com o parâmetro atual destacado.
- **Hover**: mostra a documentação, a assinatura, o tipo inferido da variável, trechos reais do Tutor e o link **inserir exemplo…**.
- **Ir para definição**: abre classes e métodos do projeto e também do framework, se `lib/adianti` estiver no workspace.
- **Sobrescrever métodos**: em `function ` dentro de uma classe, sugere os métodos do pai (ex.: `onBeforeStore` em `TRecord`).
- **Comando `Adianti: Inserir exemplo do Tutor`**: abre os 337 exemplos e insere o código escolhido.
- **Snippets** (todos começam com `adianti-`):

| Snippet | O que gera |
|---|---|
| `adianti-page`, `adianti-window` | página `TPage` / janela `TWindow` |
| `adianti-form` | formulário com `onSave`, `onEdit` e `onClear` |
| `adianti-list` | listagem com datagrid, paginação e exclusão |
| `adianti-standard-form-list` | formulário + datagrid usando o trait padrão |
| `adianti-record`, `adianti-relation` | modelo `TRecord` e relação `get_`/`set_` |
| `adianti-transaction` | bloco `try` com `TTransaction` |
| `adianti-criteria`, `adianti-where` | consulta com `TCriteria` ou `where()` |
| `adianti-message`, `adianti-question`, `adianti-toast` | mensagem, pergunta e toast |
| `adianti-onchange` | campo com `setChangeAction` e o método estático que ele chama |
| `adianti-dbuniquesearch`, `adianti-dbcombo`, `adianti-fieldlist` | campos ligados ao banco e lista de campos |
| `adianti-loadpage` | `TApplication::loadPage(...)` |

## Configurações
| Chave | Padrão | O que faz |
|---|---|---|
| `adianti.workspace.index` | `true` | indexa as classes do projeto |
| `adianti.workspace.exclude` | `**/{vendor,node_modules,tmp,.git,lib/adianti}/**` | arquivos que a indexação ignora |
| `adianti.workspace.maxFiles` | `5000` | limite de arquivos indexados |
| `adianti.completion.classes` | `true` | liga ou desliga a sugestão de nomes de classe (útil se usar junto com o Intelephense) |
| `adianti.completion.tutorLiterals` | `true` | liga ou desliga as sugestões de valores do Tutor |

## Desenvolvimento
```bash
npm run build-data   # regenera data/ a partir do Tutor e dos SKILL.md
npm test             # testes do motor semântico
npx @vscode/vsce package
```

## Autor
[WillGolden80742](https://github.com/WillGolden80742)
