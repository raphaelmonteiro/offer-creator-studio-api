/** Aparado e cortado em `max` caracteres (pontos de código), sem reticências; vazio ou ausente vale `''`. */
export function clipText(text: string | null | undefined, max: number): string {
  return Array.from((text ?? '').trim())
    .slice(0, max)
    .join('');
}
