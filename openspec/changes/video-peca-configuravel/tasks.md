# Tasks: peça de ofertas configurável

Ordem de trabalho proposta. As tarefas técnicas (3 em diante) só ganham
detalhe depois da discussão do `design.md`.

## 1. Produto e especificação

- [x] 1.1 Analisar os vídeos de referência (Nini, Piccin) e o vídeo gerado em 21/10
- [x] 1.2 Escrever a visão do cliente e a usabilidade (doc "Comercial de ofertas configurável")
- [x] 1.3 Fechar as decisões de produto (editor próprio, fotos da galeria, limites, formatos)
- [ ] 1.4 Validar as specs desta change com o desenvolvedor (cenários e códigos de erro)

## 2. Design técnico

- [ ] 2.1 Responder as perguntas do `design.md` (descritor da peça, render, personagem na peça, rosto do logo, reaproveitamento, modelos)
- [ ] 2.2 Definir rotas e contratos no `design.md`
- [ ] 2.3 Definir o modelo de dados e as migrations

## 3. Editor de peça (frontend)

- [ ] 3.1 Tela nova de peça: formato, cliente, prévia fiel ao lado
- [ ] 3.2 Fundo: cor, degradê, imagem (enquadramento, desfoque, escurecimento)
- [ ] 3.3 Produtos: busca no cadastro, foto da galeria, edição de nome/gramatura/preço de/por/unidade
- [ ] 3.4 Auto-layout: distribuições 2/3/4/6/8, destaque, "arrumar de novo"
- [ ] 3.5 Edição livre: arrastar para reordenar, redimensionar, selo de preço, fundo da área
- [ ] 3.6 Logo, textos soltos (até 5), rodapé (faixa/pill, validade)
- [ ] 3.7 Guias, área segura, troca de formato sem distorção
- [ ] 3.8 Modelos salvos por conta

## 4. Personagem na peça

- [ ] 4.1 Modo dentro da peça: posicionar e dimensionar o recorte, mínimo de 25% da largura, ordem de camadas
- [ ] 4.2 Modo rosto do logo: caixa do logo confirmada antes de gerar
- [ ] 4.3 Silhueta exata do personagem na prévia

## 5. Fala

- [ ] 5.1 Geração da fala a partir dos produtos citados (até 6, teto 30 s, encurtamento automático)
- [ ] 5.2 Edição por frase, escuta na voz do kit, duração medida
- [ ] 5.3 Preço alterado depois do vídeo: proposta de frase e regeração parcial

## 6. Produção e entrega

- [ ] 6.1 Rasterização da peça e composição com o clipe do personagem; prévia = primeiro quadro
- [ ] 6.2 Custo estimado antes de gerar; progresso por etapa na tela
- [ ] 6.3 Revisão: aprovar, refazer só uma fala
- [ ] 6.4 Entrega Instagram/WhatsApp; duplicar em 4:5 com falas reaproveitadas
- [ ] 6.5 Legendas opcionais (padrão desligadas) e trilha opcional

## 7. Qualidade

- [ ] 7.1 e2e mock da peça completa (sem chamadas pagas)
- [ ] 7.2 Comparação automática prévia × primeiro quadro do vídeo
- [ ] 7.3 Vídeo real com o cliente de referência e revisão lado a lado com o Piccin
