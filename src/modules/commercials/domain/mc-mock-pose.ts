/**
 * "Pose" do personagem no provider MOCK do `talk` (change video-fala-continua, 1.9, D14): o clipe
 * mock balança (a figura gira em torno do centro) com o TEMPO — uma onda TRIANGULAR de 8 s (velocidade
 * constante e excursão grande: o fim de um clipe de 2 s está longe do começo do seguinte). Um clipe gerado
 * por chamada recomeça a pose na fase 0 (é o que um motor real faz: cada clipe parte do tile), o que
 * torna o salto do modo de hoje MENSURÁVEL; o trecho que parte do último quadro do anterior continua
 * da fase em que o anterior parou (a fase é o instante absoluto do trecho na timeline do vídeo).
 * Funções PURAS que montam filtros do ffmpeg.
 */

/** Período da onda triangular da pose (s). */
export const MC_MOCK_POSE_PERIOD_S = 8;

/** Amplitude (rad) da pose: grande no clipe liso (a barra), pequena com o tile (a figura não sai do quadro). */
export const MC_MOCK_POSE_AMPLITUDE_RAD = { plain: 0.4, tile: 0.15 } as const;

/** Filtro `rotate` da pose, em torno do centro, sem mudar o tamanho do quadro; os cantos ficam na cor de fundo. */
export function mockPoseRotate(opts: {
  phaseS: number;
  fillHex: string;
  amplitudeRad: number;
}): string {
  const fill = `0x${opts.fillHex.replace('#', '').slice(0, 6).toUpperCase()}`;
  const phase = Number(opts.phaseS.toFixed(3));
  return (
    `rotate=a='${opts.amplitudeRad}*asin(sin(2*PI*(t+${phase})/${MC_MOCK_POSE_PERIOD_S}))*2/PI':` +
    `c=${fill}:ow=iw:oh=ih`
  );
}

/** Barra branca desenhada no clipe liso para a pose ter o que mostrar (o tile já é a figura). */
export const MC_MOCK_POSE_BAR =
  'drawbox=x=iw*0.42:y=ih*0.3:w=iw*0.16:h=ih*0.5:color=white@1:t=fill';

/** Cadeia de filtros da pose do clipe liso (Card, Círculo, rosto do logo). */
export function mockPlainPoseFilters(phaseS: number, fillHex: string): string[] {
  return [
    MC_MOCK_POSE_BAR,
    mockPoseRotate({ phaseS, fillHex, amplitudeRad: MC_MOCK_POSE_AMPLITUDE_RAD.plain }),
  ];
}

/** Pose do clipe com o tile (modo sem fundo): gira a figura sobre a cor-chave. */
export function mockTilePoseFilter(phaseS: number, keyHex: string): string {
  return mockPoseRotate({ phaseS, fillHex: keyHex, amplitudeRad: MC_MOCK_POSE_AMPLITUDE_RAD.tile });
}
