# video-piece-speech

A fala do personagem nasce dos produtos da peça: abertura, uma frase por
produto citado e fechamento, com preço por extenso, editável e audível antes
de gerar.

## ADDED Requirements

### Requirement: Fala gerada dos produtos citados

O sistema DEVE gerar a fala com abertura curta, uma frase por produto citado
na ordem da peça e fechamento com convite. Preços DEVEM ser falados por
extenso e iguais aos da peça. A fala NÃO DEVE citar produto, preço, desconto
ou condição que não esteja na peça. Nome da loja e validade do rodapé PODEM
ser citados.

#### Scenario: Peça com 4 produtos

- **WHEN** a peça tem 4 produtos citados e rodapé com validade até sábado
- **THEN** a fala tem 6 frases: abertura, uma por produto com nome e preço por extenso, e fechamento citando "até sábado"

### Requirement: Produtos citados e teto de duração

Até 6 produtos DEVEM poder ser citados; com mais produtos na peça, o usuário
DEVE marcar quais entram na fala (padrão: os 6 primeiros). A soma estimada
das falas DEVE caber em 30 s; acima disso o sistema DEVE encurtar
automaticamente (abertura/fechamento curtos, nomes mais curtos) e, se ainda
não couber, bloquear a geração com `SPEECH_OVER_LENGTH` apontando as frases
longas.

#### Scenario: Oito produtos na peça

- **WHEN** a peça tem 8 produtos
- **THEN** a tela mostra os 6 primeiros marcados para a fala e deixa o usuário trocar a seleção

#### Scenario: Fala longa demais

- **WHEN** a soma estimada passa de 30 s mesmo após o encurtamento
- **THEN** a geração é bloqueada com `SPEECH_OVER_LENGTH` e as frases que mais pesam ficam destacadas

### Requirement: Edição e escuta por frase

Cada frase DEVE ser editável e DEVE poder ser ouvida na voz do kit antes de
gerar. A edição NÃO DEVE mudar a ordem dos produtos na peça. Preço digitado em
número na frase DEVE ser convertido para extenso.

#### Scenario: Ouvir uma frase

- **WHEN** o usuário clica em ouvir na frase do azeite
- **THEN** o sistema toca a frase na voz do kit e mostra a duração medida

### Requirement: Preço alterado depois do vídeo

Quando o preço de um produto muda na peça depois de o vídeo existir, o sistema
DEVE propor a nova frase do produto e, na regeração, refazer só a fala e a
composição; as demais falas DEVEM ser reaproveitadas.

#### Scenario: Preço do presunto muda

- **WHEN** o usuário altera o preço do presunto de 2,99 para 3,49 após a entrega
- **THEN** a tela mostra a nova frase proposta e "gerar de novo" refaz só essa fala e a composição
