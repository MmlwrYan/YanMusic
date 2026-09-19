import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EQ_BAND_FREQUENCIES,
  EQ_REFERENCE_SAMPLE_RATE,
  EQ_WIDTH_Q,
  biquadMagnitude,
  computeEqHeadroomGainDb,
  eqCascadeResponseDb,
  peakingBiquad,
} from '../src/main/mpv/eqHeadroom.ts';

const SAMPLE_RATE = EQ_REFERENCE_SAMPLE_RATE;
const NYQUIST = SAMPLE_RATE / 2;

const gainsWith = (entries: Array<[number, number]>): number[] => {
  const gains = new Array<number>(EQ_BAND_FREQUENCIES.length).fill(0);
  for (const [index, gain] of entries) gains[index] = gain;
  return gains;
};

test('全零增益无需补偿', () => {
  assert.equal(computeEqHeadroomGainDb(new Array(10).fill(0), SAMPLE_RATE, EQ_WIDTH_Q), 0);
  assert.equal(computeEqHeadroomGainDb([], SAMPLE_RATE, EQ_WIDTH_Q), 0);
});

test('只做衰减时无需补偿', () => {
  const gains = gainsWith([
    [0, -12],
    [3, -6],
    [7, -3],
  ]);
  assert.equal(computeEqHeadroomGainDb(gains, SAMPLE_RATE, EQ_WIDTH_Q), 0);
});

test('单段提升的前级补偿约等于该段增益', () => {
  // 1 kHz 段 +12 dB：峰值正好落在该段中心，级联峰值应约 +12 dB
  const headroom = computeEqHeadroomGainDb(gainsWith([[4, 12]]), SAMPLE_RATE, EQ_WIDTH_Q);
  assert.ok(
    headroom <= -12 && headroom >= -12.1,
    `单段 +12 dB 的补偿应约为 -12 dB，实际 ${headroom}`,
  );
});

test('多段同时提升的补偿大于单段最大值（频带叠加）', () => {
  const all = computeEqHeadroomGainDb(new Array(10).fill(12), SAMPLE_RATE, EQ_WIDTH_Q);
  assert.ok(all < -12, `全段 +12 dB 的补偿应超过 -12 dB（叠加），实际 ${all}`);

  const neighbors = computeEqHeadroomGainDb(gainsWith([[8, 12], [9, 12]]), SAMPLE_RATE, EQ_WIDTH_Q);
  assert.ok(neighbors < -12, `相邻两段 +12 dB 的补偿应超过 -12 dB，实际 ${neighbors}`);
});

test('补偿后的级联峰值不超过 0 dB（对数网格上）', () => {
  const cases: number[][] = [
    new Array(10).fill(12),
    gainsWith([[4, 12]]),
    gainsWith([[0, 12], [1, 12], [2, 12]]),
    gainsWith([[5, 9], [6, 9], [7, 9], [8, 9], [9, 9]]),
    gainsWith([[0, -12], [4, 12], [9, 6]]),
  ];

  for (const gains of cases) {
    const headroom = computeEqHeadroomGainDb(gains, SAMPLE_RATE, EQ_WIDTH_Q);
    assert.ok(headroom <= 0, `补偿必须 ≤ 0 dB，实际 ${headroom}`);

    // 在对数网格上复核：补偿后任意采样点的响应都不应超过 0 dB（含 0.01 dB 数值余量）
    const logMin = Math.log(10);
    const logSpan = Math.log(NYQUIST) - logMin;
    for (let index = 0; index <= 4096; index += 1) {
      const frequency = Math.exp(logMin + (logSpan * index) / 4096);
      const response = eqCascadeResponseDb(gains, frequency, SAMPLE_RATE, EQ_WIDTH_Q) + headroom;
      assert.ok(response <= 0.01, `频率 ${frequency.toFixed(1)} Hz 处补偿后仍为 ${response} dB`);
    }
  }
});

/**
 * 上游不变式文档记录：线性网格会低估低频窄峰的补偿量
 * （31 Hz 段在 48 kHz/2048 点线性网格下低估约 1.6 dB，192 kHz 下约 7 dB）。
 * 本实现用对数网格 + 显式频带中心，这里用一个高密度线性网格作为参考来验证
 * 估计误差足够小。
 */
test('对数网格估计与高密度参考网格的偏差 < 0.1 dB', () => {
  const referenceHeadroom = (gains: number[], sampleRate: number): number => {
    let peak = 0;
    const steps = 200_000;
    const nyquist = sampleRate / 2;
    for (let index = 1; index < steps; index += 1) {
      const frequency = (nyquist * index) / steps;
      const response = eqCascadeResponseDb(gains, frequency, sampleRate, EQ_WIDTH_Q);
      if (response > peak) peak = response;
    }
    return peak > 0 ? -peak : 0;
  };

  const cases: Array<{ gains: number[]; rate: number }> = [
    { gains: gainsWith([[0, 12]]), rate: SAMPLE_RATE },
    { gains: gainsWith([[0, 12], [1, 12]]), rate: SAMPLE_RATE },
    { gains: new Array(10).fill(12), rate: SAMPLE_RATE },
    { gains: gainsWith([[0, 12]]), rate: 192_000 },
    { gains: gainsWith([[1, 12], [2, 12], [3, 12]]), rate: 44_100 },
  ];

  for (const { gains, rate } of cases) {
    const actual = computeEqHeadroomGainDb(gains, rate, EQ_WIDTH_Q);
    const reference = referenceHeadroom(gains, rate);
    const deviation = Math.abs(actual - reference);
    assert.ok(
      deviation < 0.1,
      `采样率 ${rate}：对数网格 ${actual.toFixed(3)} dB vs 参考 ${reference.toFixed(3)} dB，偏差 ${deviation.toFixed(3)} dB`,
    );
  }
});

test('DC 与 Nyquist 处 peaking 响应为 0 dB', () => {
  const coefficients = peakingBiquad(1000, 12, EQ_WIDTH_Q, SAMPLE_RATE);
  // 直接用 z = ±1 计算
  const dcGain = (coefficients.b0 + coefficients.b1 + coefficients.b2) /
    (coefficients.a0 + coefficients.a1 + coefficients.a2);
  const nyquistGain = (coefficients.b0 - coefficients.b1 + coefficients.b2) /
    (coefficients.a0 - coefficients.a1 + coefficients.a2);
  assert.ok(Math.abs(20 * Math.log10(Math.abs(dcGain))) < 1e-9);
  assert.ok(Math.abs(20 * Math.log10(Math.abs(nyquistGain))) < 1e-9);
});

/**
 * 独立校验双二阶幅度响应：用差分方程生成脉冲响应，再对其做 DFT，
 * 与闭式幅度响应逐点比较。这验证的是实现本身自洽，不依赖同一套公式。
 */
test('闭式幅度响应与脉冲响应 DFT 一致', () => {
  const coefficients = peakingBiquad(1000, 9, EQ_WIDTH_Q, SAMPLE_RATE);
  const { b0, b1, b2, a0, a1, a2 } = coefficients;
  // 归一化（与 FFmpeg 一致：各系数除以 a0）
  const nb0 = b0 / a0;
  const nb1 = b1 / a0;
  const nb2 = b2 / a0;
  const na1 = a1 / a0;
  const na2 = a2 / a0;

  const length = 8192;
  const input = (n: number) => (n === 0 ? 1 : 0);
  const response = new Float64Array(length);
  for (let n = 0; n < length; n += 1) {
    const y1 = n >= 1 ? response[n - 1] : 0;
    const y2 = n >= 2 ? response[n - 2] : 0;
    response[n] =
      nb0 * input(n) + nb1 * input(n - 1) + nb2 * input(n - 2) - na1 * y1 - na2 * y2;
  }

  for (const bin of [1, 16, 64, 171, 512, 1024, 2048]) {
    let real = 0;
    let imag = 0;
    for (let n = 0; n < length; n += 1) {
      const angle = (-2 * Math.PI * bin * n) / length;
      real += response[n] * Math.cos(angle);
      imag += response[n] * Math.sin(angle);
    }
    const dftMagnitude = Math.hypot(real, imag);
    const closedForm = biquadMagnitude(coefficients, (bin * SAMPLE_RATE) / length, SAMPLE_RATE);
    const relativeError = Math.abs(dftMagnitude - closedForm) / Math.max(closedForm, 1e-9);
    assert.ok(
      relativeError < 1e-3,
      `bin ${bin}: DFT ${dftMagnitude.toFixed(6)} vs 闭式 ${closedForm.toFixed(6)}（相对误差 ${relativeError}）`,
    );
  }
});
