/** O esquema que o servidor aceita buscar: `http:` ou `https:` (o `protocol` do `URL`, com os dois-pontos). */
export function isHttpProtocol(protocol: string): boolean {
  return protocol === 'http:' || protocol === 'https:';
}
