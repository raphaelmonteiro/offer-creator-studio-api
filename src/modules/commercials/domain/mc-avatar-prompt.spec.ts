import { buildActionVideoPrompt, buildAvatarVideoPrompt } from './mc-scene-prompts';

/** Prompt do Avatar (cena falada com ação simples) — validado em uso real 18/09. */
describe('buildAvatarVideoPrompt', () => {
  it('movimento + boca sincronizada + preservação; pontuação final normalizada', () => {
    const p = buildAvatarVideoPrompt('  The mascot   picks the bag and shows it to the camera ');
    expect(p.startsWith('The mascot picks the bag and shows it to the camera. ')).toBe(true);
    expect(p).toContain('mouth moving in sync with the speech');
    expect(p).toContain('Keep exactly the same character design');
    expect(p).toContain('Static camera');
  });

  it('sem movimento: só o sufixo (o Avatar fala parado, comportamento anterior)', () => {
    const p = buildAvatarVideoPrompt('   ');
    expect(p).toContain('mouth moving in sync');
    expect(p.startsWith('The character speaks')).toBe(true);
  });

  it('difere do prompt do motor de ação: o de ação não pede fala', () => {
    expect(buildActionVideoPrompt('waves')).not.toContain('mouth');
  });
});
