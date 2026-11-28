/** Os hosts de onde o servidor baixa a foto escolhida no Pixabay (a busca devolve `previewURL` do CDN e `largeImageURL` do site). */
const PIXABAY_HOSTS = ['pixabay.com', 'cdn.pixabay.com'];

/**
 * A regra do Pixabay para `POST /v1/ai/image-download` (D-11, D-orq-259): só `https` em `pixabay.com` ou `cdn.pixabay.com`, na
 * porta padrão. Vale no primeiro endereço e em cada salto de redirecionamento, antes de conectar (`allowUrl` do download
 * seguro). `url.port` é vazio na porta padrão: o `URL` do WHATWG tira o `:443` do https.
 */
export function isPixabayImageUrl(url: URL): boolean {
  return url.protocol === 'https:' && url.port === '' && PIXABAY_HOSTS.includes(url.hostname);
}
