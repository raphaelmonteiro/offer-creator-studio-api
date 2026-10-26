/** Flag do recorte (video-mascote-transparente, D2): lida só pela API; padrão desligada. */
export function isCharacterCutoutEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.MC_CHARACTER_CUTOUT ?? '').trim().toLowerCase() === 'true';
}
