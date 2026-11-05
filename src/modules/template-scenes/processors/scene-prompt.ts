import { SceneZones } from '../domain/scene.types';

export interface ScenePromptInput {
  /** Pedido literal do cliente, em português. */
  request: string;
  artWidthCm: number;
  artHeightCm: number;
  widthPx: number;
  heightPx: number;
  zones: SceneZones;
}

const percent = (fraction: number): string => `${Math.round(fraction * 100)}%`;
const cm = (value: number): string => String(value).replace('.', ',');

const isControl = (char: string): boolean => {
  const code = char.charCodeAt(0);
  return code < 32 || code === 127;
};

/** Tira caracteres de controle e espaços repetidos do pedido (o texto continua literal). */
function cleanRequest(request: string): string {
  return [...request]
    .map((char) => (isControl(char) ? ' ' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Prompt da primeira geração: o pedido literal, o formato em cm e a proporção, as zonas que ficam
 * calmas (o cabeçalho, o miolo e o rodapé recebem o conteúdo depois) e as regras fixas (sem texto
 * legível, sem logotipos, sem preços).
 */
export function buildGeneratePrompt(input: ScenePromptInput): string {
  const { zones } = input;
  const ratio = (input.artWidthCm / input.artHeightCm).toFixed(2).replace('.', ',');
  return [
    'Crie a imagem de fundo de um encarte de ofertas de supermercado, para impressão.',
    `Pedido do cliente: "${cleanRequest(input.request)}".`,
    `Formato: ${cm(input.artWidthCm)} x ${cm(input.artHeightCm)} cm (proporção largura/altura ${ratio}), imagem de ${input.widthPx} x ${input.heightPx} px, ocupando toda a área, sem bordas nem molduras.`,
    'Composição, de cima para baixo:',
    `- cabeçalho (faixa superior de ${percent(zones.header.h)} da altura): área limpa e de pouco detalhe, para o título e o logo;`,
    `- miolo (${percent(zones.body.h)} da altura): fundo suave e uniforme, para os produtos e preços colocados depois;`,
    `- rodapé (faixa inferior de ${percent(zones.footer.h)} da altura): área limpa, para o endereço e as informações da loja.`,
    'Regras: sem texto legível, sem letras ou números, sem logotipos, sem preços, sem produtos de marcas reais e sem pessoas identificáveis.',
  ].join('\n');
}
