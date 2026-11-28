/**
 * O link de redirecionamento do Google (`google.com/goto?url=…`) que a Serper devolve no lugar do endereço da foto:
 * só ele passa pela rota de resolução antes do download. Outro endereço, ou texto que não é URL, não é.
 */
export function isGoogleGotoLink(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const google = url.hostname === 'google.com' || url.hostname.endsWith('.google.com');
  return (
    (url.protocol === 'https:' || url.protocol === 'http:') && google && url.pathname === '/goto'
  );
}
