/** Por que o download seguro de uma foto de fora recusou ou falhou (spec safe-image-download). */
export type SafeDownloadReason =
  /** URL que o servidor não segue: esquema que não é http(s), usuário e senha, ou a regra a mais do chamador (host e porta do Pixabay). */
  | 'SCHEME'
  /** Algum endereço resolvido é interno (loopback, rede privada, link-local, CGNAT, multicast, IPv6 local...). */
  | 'PRIVATE_ADDRESS'
  | 'TOO_MANY_REDIRECTS'
  /** Não é JPEG, PNG, WebP nem GIF que decodifica, ou passa do teto de pixels. */
  | 'NOT_AN_IMAGE'
  | 'TOO_LARGE'
  | 'TIMEOUT'
  /** A origem respondeu com status que não é sucesso (404, 5xx, redirecionamento sem destino). */
  | 'ORIGIN_STATUS'
  /** Nome que não resolve, conexão recusada ou caída. */
  | 'NETWORK';

/** Recusa ou falha do download seguro; a mensagem nunca leva a URL inteira (consulta e credenciais ficam de fora). */
export class SafeDownloadError extends Error {
  constructor(
    readonly reason: SafeDownloadReason,
    message: string,
  ) {
    super(message);
    this.name = 'SafeDownloadError';
  }
}
