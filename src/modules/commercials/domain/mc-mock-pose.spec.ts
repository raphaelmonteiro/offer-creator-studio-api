import {
  MC_MOCK_POSE_AMPLITUDE_RAD,
  mockPlainPoseFilters,
  mockPoseRotate,
  mockTilePoseFilter,
} from './mc-mock-pose';

describe('pose do provider mock (fala contínua, D14)', () => {
  it('o filtro gira em torno do centro sem mudar o quadro, com os cantos na cor de fundo e a fase pedida', () => {
    expect(mockPoseRotate({ phaseS: 0, fillHex: '#2e5e9e', amplitudeRad: 0.35 })).toBe(
      "rotate=a='0.35*sin(2*PI*(t+0)/4)':c=0x2E5E9E:ow=iw:oh=ih",
    );
  });

  it('um clipe por chamada recomeça na fase 0; o trecho com junção continua da fase do instante absoluto', () => {
    const restart = mockPlainPoseFilters(0, '#2E5E9E')[1];
    const joined = mockPlainPoseFilters(9, '#2E5E9E')[1];
    expect(restart).toContain('(t+0)');
    expect(joined).toContain('(t+9)');
    expect(restart).not.toBe(joined);
  });

  it('clipe liso desenha uma barra; o tile só gira a figura (amplitude menor, não sai do quadro)', () => {
    const plain = mockPlainPoseFilters(0, '#FFFFFF');
    expect(plain[0]).toContain('drawbox');
    expect(mockTilePoseFilter(1.5, '#00B140')).toContain(`${MC_MOCK_POSE_AMPLITUDE_RAD.tile}*sin`);
    expect(MC_MOCK_POSE_AMPLITUDE_RAD.tile).toBeLessThan(MC_MOCK_POSE_AMPLITUDE_RAD.plain);
  });
});
