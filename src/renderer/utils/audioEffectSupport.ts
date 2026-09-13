import type { SpatialAudioEffectEntry } from '../../shared/audio';

// Yan 使用 libmpv 卷积（afir）播放空间音效，没有外部 DSP 引擎注册表，
// 因此这里只保留 builtin / checking 两种引擎形态；VPF 资源在 libmpv 侧无消费路径。
export interface AudioEffectSupport {
  status: 'supported' | 'checking' | 'unsupported';
  reason: string;
}

export type AudioEffectEngineKind = 'builtin' | 'checking';

// 与 libmpv 引擎能力对齐：仅脉冲响应（IR）可被 afir 卷积消费，VPF 无对应滤镜。
export function audioEffectSupport(
  file: SpatialAudioEffectEntry,
  engineKind: AudioEffectEngineKind = 'builtin',
): AudioEffectSupport {
  const needsVpf =
    file.kind === 'community-vpf' || file.kind === 'community-combined' || !!file.vpfPath;
  const needsIr = file.kind !== 'community-vpf' || !!file.impulseResponsePath;
  const unsupported = (reason: string): AudioEffectSupport => ({ status: 'unsupported', reason });
  if ((needsVpf && !file.vpfPath) || (needsIr && !file.impulseResponsePath))
    return unsupported('音效文件不完整，请重新下载或导入');
  if (engineKind === 'checking') return { status: 'checking', reason: '正在检查音效引擎能力' };
  return needsVpf
    ? unsupported('当前播放引擎不支持 VPF 音效，暂不可用')
    : { status: 'supported', reason: '' };
}
