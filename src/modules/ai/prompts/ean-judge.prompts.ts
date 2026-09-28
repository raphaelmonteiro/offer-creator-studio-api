import { z } from 'zod';

/**
 * Juiz multimodal do vínculo EAN planilha→galeria
 * (openspec vinculo-ean-planilha-alta-confianca, design §6).
 *
 * Dois enquadramentos diferentes para os dois julgamentos independentes: A
 * escolhe direto; B descarta primeiro e só depois escolhe. Concordância entre
 * os dois, com as candidatas em ordens diferentes, é o sinal de confiança —
 * não a "confiança" que o modelo declara.
 *
 * Mudar qualquer texto aqui muda a versão e DESLIGA o auto-aceite até nova
 * calibração. Suba o número ao editar.
 */
export const EAN_JUDGE_PROMPT_VERSION = 'ean-judge-v3';

export type JudgeVariant = 'A' | 'B';

export const JudgeOutputSchema = z
  .object({
    decision: z.enum(['match', 'same-sku-multiple', 'none']),
    images: z.array(z.string().regex(/^[A-Z]$/)),
    labels: z.array(
      z.object({
        image: z.string().regex(/^[A-Z]$/),
        brand: z.string().nullable(),
        variant: z.string().nullable(),
        quantity: z.string().nullable(),
      }),
    ),
    reason: z.string().min(1),
  })
  .superRefine((o, ctx) => {
    const n = new Set(o.images).size;
    if (n !== o.images.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'imagens repetidas' });
    }
    if (o.decision === 'match' && n !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'match exige exatamente 1 imagem' });
    }
    if (o.decision === 'same-sku-multiple' && n < 2) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'same-sku-multiple exige 2+ imagens' });
    }
    if (o.decision === 'none' && n !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'none não leva imagens' });
    }
    const rotuladas = new Set(o.labels.map((l) => l.image));
    for (const img of o.images) {
      if (!rotuladas.has(img)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `falta leitura de rótulo de ${img}` });
      }
    }
  });
export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;

const REGRAS_COMUNS = [
  'Você confere cadastros de supermercado brasileiro. Uma linha do cadastro do cliente traz',
  'um código EAN e a descrição do produto (em geral abreviada, em maiúsculas, como no PDV).',
  'Às vezes vem também o nome completo do produto numa base pública e uma FOTO DE REFERÊNCIA.',
  'Você recebe fotos candidatas da galeria, cada uma identificada por uma letra.',
  '',
  'Sua tarefa: dizer qual candidata mostra EXATAMENTE o produto daquele EAN.',
  '',
  'Critérios, em ordem de importância — leia o RÓTULO na foto, não o nome do arquivo:',
  '1. Marca.',
  '2. Variante: sabor, versão, linha, cor, fragrância, tipo (ex.: "Reserva" ≠ "Gran Reserva",',
  '   "cristal" ≠ "demerara", "ketchup" ≠ "picles", "zero" ≠ "tradicional").',
  '3. Quantidade líquida (180g ≠ 200g; 1L ≠ 500ml). Embalagem diferente (lata × sachê,',
  '   refil × frasco) é produto diferente quando o EAN muda com ela.',
  '',
  'Decisões possíveis:',
  '- "match": exatamente uma candidata é o produto.',
  '- "same-sku-multiple": duas ou mais candidatas são fotos do MESMO produto (mesma marca,',
  '  variante e quantidade), e esse é o produto do EAN.',
  '- "none": nenhuma candidata é o produto. É uma resposta normal e esperada — a galeria',
  '  não tem foto de tudo. Na dúvida entre duas variantes, responda "none".',
  '',
  'Para cada candidata escolhida, transcreva em "labels" o que está IMPRESSO no rótulo da foto:',
  'marca, variante e quantidade, com as palavras do rótulo (null se não estiver visível).',
  'NUNCA copie palavras da descrição do cadastro para "labels": se o rótulo diz "Multi',
  'Inseticida Original" e o cadastro diz "Ação Total", escreva o que o rótulo diz — e, sendo',
  'variantes diferentes, a candidata não é o produto.',
  '',
  'Responda SOMENTE com JSON:',
  '{"decision": "match"|"same-sku-multiple"|"none", "images": ["A"], "labels":',
  ' [{"image": "A", "brand": "...", "variant": "...", "quantity": "..."}], "reason": "..."}',
];

export function buildEanJudgeSystemPrompt(variant: JudgeVariant): string {
  const modo =
    variant === 'A'
      ? [
          '',
          'Método: compare cada candidata com a descrição e escolha a que coincide nos três',
          'critérios.',
        ]
      : [
          '',
          'Método: PRIMEIRO elimine toda candidata que diverge da descrição em marca, variante',
          'ou quantidade, citando o motivo em "reason". SÓ DEPOIS decida entre as que sobraram;',
          'se nenhuma sobrou, a resposta é "none".',
        ];
  return [...REGRAS_COMUNS, ...modo].join('\n');
}

export function buildEanJudgeUserText(input: {
  ean: string;
  descricaoErp: string;
  referencia: {
    source: string;
    name: string | null;
    brand: string | null;
    quantity: string | null;
  } | null;
  temFotoReferencia: boolean;
  letras: string[];
}): string {
  // Referência do cadastro do cliente = a própria descrição: não repete.
  const ref =
    input.referencia?.name && input.referencia.source !== 'erp'
      ? [
          `Nome completo na base pública: ${input.referencia.name}`,
          input.referencia.brand ? `Marca: ${input.referencia.brand}` : null,
          input.referencia.quantity ? `Quantidade: ${input.referencia.quantity}` : null,
        ]
      : [];

  return [
    `EAN: ${input.ean}`,
    `Descrição no cadastro do cliente: ${input.descricaoErp}`,
    ...ref,
    input.temFotoReferencia
      ? 'A primeira imagem é a FOTO DE REFERÊNCIA oficial (não é candidata).'
      : 'Não há foto de referência.',
    `Candidatas, na ordem das imagens seguintes: ${input.letras.join(', ')}.`,
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
}
