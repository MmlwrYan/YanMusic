/**
 * EQ 级联响应的前级补偿（headroom）计算。
 *
 * 背景：`MpvController` 把 10 段 EQ 实现为一串 lavfi `equalizer` 双二阶滤镜。
 * 多段同时提升时，各段频响会在相邻频带处叠加，总增益可能明显超过单段设定值，
 * 从而在滤镜链内部削顶——应用日志中反复出现的
 * `filter: Channel 0 clipping N times. Please reduce gain.`
 * （出自 FFmpeg `af_biquads.c` 的削顶检测）即为该现象。
 *
 * 做法（思路借鉴上游 EchoMusic `native/echo-ffmpeg-player` 的 `eq_headroom_gain`，
 * 按其公开的不变式文档独立实现，未复制其代码）：
 *   1. 按 FFmpeg `equalizer` 的 peaking 双二阶系数公式，重建每一段的频响；
 *   2. 在对数网格上采样「级联总响应」，并显式加入 DC、Nyquist 与各频带中心；
 *   3. 取网格上的最大提升量，反相作为前级增益（≤ 0 dB）。
 *
 * 为什么必须用对数网格：最低频段在 60 Hz、Q=1，其峰值很窄。若用线性网格，
 * 低频峰可能落在两个采样点之间而被严重低估（上游文档记录：31 Hz 段在
 * 48 kHz/2048 点线性网格下低估约 1.6 dB，192 kHz 下约 7 dB），
 * 结果就是「恰好在最听得见的地方削顶」。因此本实现用对数网格 + 显式频带中心，
 * 并采用比上游更密的采样点（4096）以进一步压低估计误差。
 */

/** 与 `MpvController` 的 lavfi `equalizer` 频点表保持一致 */
export const EQ_BAND_FREQUENCIES = [
  60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000,
] as const;

/** lavfi `equalizer` 的 `w` 参数；`width_type` 默认为 `q`，故 w 即 Q */
export const EQ_WIDTH_Q = 1;

/** 与播放引擎的 af 链一致：IR 卷积图内部会 aresample 到 48 kHz */
export const EQ_REFERENCE_SAMPLE_RATE = 48_000;

const EQ_RESPONSE_GRID_POINTS = 4096;
const EQ_RESPONSE_MIN_FREQUENCY = 10;

interface BiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a0: number;
  a1: number;
  a2: number;
}

/**
 * FFmpeg `equalizer`（peaking）双二阶系数。
 * 对应 RBJ Audio EQ Cookbook 的 peaking EQ，其中 A = 10^(gainDb/40)、
 * alpha = sin(w0)/(2Q)；与 FFmpeg `af_biquads.c` 的 PEAKING 分支一致。
 */
export const peakingBiquad = (
  frequency: number,
  gainDb: number,
  q: number,
  sampleRate: number,
): BiquadCoefficients => {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * frequency) / sampleRate;
  const cosW0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);

  return {
    b0: 1 + alpha * A,
    b1: -2 * cosW0,
    b2: 1 - alpha * A,
    a0: 1 + alpha / A,
    a1: -2 * cosW0,
    a2: 1 - alpha / A,
  };
};

/** 单个双二阶在给定频率处的幅度响应（线性） */
export const biquadMagnitude = (
  coefficients: BiquadCoefficients,
  frequency: number,
  sampleRate: number,
): number => {
  const { b0, b1, b2, a0, a1, a2 } = coefficients;
  const w = (2 * Math.PI * frequency) / sampleRate;
  const cos1 = Math.cos(w);
  const sin1 = Math.sin(w);
  const cos2 = Math.cos(2 * w);
  const sin2 = Math.sin(2 * w);

  const numReal = b0 + b1 * cos1 + b2 * cos2;
  const numImag = -(b1 * sin1 + b2 * sin2);
  const denReal = a0 + a1 * cos1 + a2 * cos2;
  const denImag = -(a1 * sin1 + a2 * sin2);

  const num = Math.hypot(numReal, numImag);
  const den = Math.hypot(denReal, denImag);
  if (den === 0) return 1;
  return num / den;
};

/**
 * 计算 10 段 EQ 级联在给定频率处的总响应（dB）。
 * 只计入非零增益的频段——与 `MpvController` 构造 af 串时跳过 `gain === 0`
 * 的行为一致（跳过与保留 0 dB 段在数学上等价，但保持同一约定便于对照）。
 */
export const eqCascadeResponseDb = (
  gains: readonly number[],
  frequency: number,
  sampleRate = EQ_REFERENCE_SAMPLE_RATE,
  q = EQ_WIDTH_Q,
): number => {
  const nyquist = sampleRate / 2;
  if (frequency <= 0 || frequency >= nyquist) return 0;

  let linear = 1;
  const bandCount = Math.min(gains.length, EQ_BAND_FREQUENCIES.length);
  for (let index = 0; index < bandCount; index += 1) {
    const gain = Number(gains[index]) || 0;
    if (gain === 0) continue;
    const bandFrequency = EQ_BAND_FREQUENCIES[index];
    if (bandFrequency >= nyquist) continue;
    linear *= biquadMagnitude(
      peakingBiquad(bandFrequency, gain, q, sampleRate),
      frequency,
      sampleRate,
    );
  }

  return 20 * Math.log10(Math.max(linear, 1e-12));
};

/**
 * 计算前级补偿增益（dB，≤ 0）。返回 0 表示无需补偿。
 *
 * 采样点：对数网格（10 Hz → Nyquist）+ DC + Nyquist + 每个频带中心。
 */
export const computeEqHeadroomGainDb = (
  gains: readonly number[],
  sampleRate = EQ_REFERENCE_SAMPLE_RATE,
  q = EQ_WIDTH_Q,
): number => {
  if (!gains.some((gain) => Number(gain) !== 0)) return 0;

  const nyquist = sampleRate / 2;
  const minFrequency = Math.min(EQ_RESPONSE_MIN_FREQUENCY, nyquist / 1000);
  let peakDb = 0;

  const consider = (frequency: number) => {
    if (!(frequency > 0) || frequency >= nyquist) return;
    const responseDb = eqCascadeResponseDb(gains, frequency, sampleRate, q);
    if (responseDb > peakDb) peakDb = responseDb;
  };

  // 对数网格
  const logMin = Math.log(minFrequency);
  const logSpan = Math.log(nyquist) - logMin;
  for (let index = 0; index <= EQ_RESPONSE_GRID_POINTS; index += 1) {
    consider(Math.exp(logMin + (logSpan * index) / EQ_RESPONSE_GRID_POINTS));
  }

  // 显式加入各频带中心：让估计不依赖网格是否恰好落在峰值上
  for (const frequency of EQ_BAND_FREQUENCIES) consider(frequency);

  if (!Number.isFinite(peakDb) || peakDb <= 0) return 0;
  return -peakDb;
};
