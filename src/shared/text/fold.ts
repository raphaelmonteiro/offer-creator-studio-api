/**
 * Minúsculo e sem acento, caractere a caractere (o comprimento não muda). Serve a toda leitura de texto
 * de pedido que compara palavras sem depender de acento ou caixa.
 */
export const fold = (text: string): string =>
  Array.from(text.normalize('NFC'))
    .map((ch) => ch.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase())
    .join('');
