import { open, type FileHandle } from 'fs/promises';
import { basename, extname } from 'path';
import type { PluginAudioMetadata } from '../../shared/plugins';

// 说明：插件「读取音频标签」能力的解析实现。
// 本仓库不依赖第三方标签解析库（package.json 不可改），因此这里内置一个
// 只读、无依赖的尽力解析器，覆盖常见容器（ID3v2/ID3v1 + MPEG、FLAC、Ogg
// Vorbis/Opus、MP4/M4A、WAV/RIFF、AIFF）。无法识别的容器会抛错，由调用方
// 转成 metadataParsed=false + metadataError，标题/歌手仍回退到文件名推断。

const HEAD_BYTES = 1024 * 1024;
const OGG_TAIL_BYTES = 64 * 1024;
const ID3V1_BYTES = 128;

const DEFAULT_GENRES = [
  'Blues',
  'Classic Rock',
  'Country',
  'Dance',
  'Disco',
  'Funk',
  'Grunge',
  'Hip-Hop',
  'Jazz',
  'Metal',
  'New Age',
  'Oldies',
  'Other',
  'Pop',
  'R&B',
  'Rap',
  'Reggae',
  'Rock',
  'Techno',
  'Industrial',
  'Alternative',
  'Ska',
  'Death Metal',
  'Pranks',
  'Soundtrack',
  'Euro-Techno',
  'Ambient',
  'Trip-Hop',
  'Vocal',
  'Jazz+Funk',
  'Fusion',
  'Trance',
  'Classical',
  'Instrumental',
  'Acid',
  'House',
  'Game',
  'Sound Clip',
  'Gospel',
  'Noise',
  'AlternRock',
  'Bass',
  'Soul',
  'Punk',
  'Space',
  'Meditative',
  'Instrumental Pop',
  'Instrumental Rock',
  'Ethnic',
  'Gothic',
  'Darkwave',
  'Techno-Industrial',
  'Electronic',
  'Pop-Folk',
  'Eurodance',
  'Dream',
  'Southern Rock',
  'Comedy',
  'Cult',
  'Gangsta',
  'Top 40',
  'Christian Rap',
  'Pop/Funk',
  'Jungle',
  'Native American',
  'Cabaret',
  'New Wave',
  'Psychadelic',
  'Rave',
  'Showtunes',
  'Trailer',
  'Lo-Fi',
  'Tribal',
  'Acid Punk',
  'Acid Jazz',
  'Polka',
  'Retro',
  'Musical',
  'Rock & Roll',
  'Hard Rock',
  'Folk',
  'Folk-Rock',
  'National Folk',
  'Swing',
  'Fast Fusion',
  'Bebob',
  'Latin',
  'Revival',
  'Celtic',
  'Bluegrass',
  'Avantgarde',
  'Gothic Rock',
  'Progressive Rock',
  'Psychedelic Rock',
  'Symphonic Rock',
  'Slow Rock',
  'Big Band',
  'Chorus',
  'Easy Listening',
  'Acoustic',
  'Humour',
  'Speech',
  'Chanson',
  'Opera',
  'Chamber Music',
  'Sonata',
  'Symphony',
  'Booty Bass',
  'Primus',
  'Porn Groove',
  'Satire',
  'Slow Jam',
  'Club',
  'Tango',
  'Samba',
  'Folklore',
  'Ballad',
  'Power Ballad',
  'Rhythmic Soul',
  'Freestyle',
  'Duet',
  'Punk Rock',
  'Drum Solo',
  'A capella',
  'Euro-House',
  'Dance Hall',
];

/** 从文件名与标签推断标题/歌手，标签缺失时回退到「歌手 - 标题」命名约定。 */
export const resolveAudioTitleAndArtist = (
  fileName: string,
  metadata?: Pick<PluginAudioMetadata, 'title' | 'artist'>,
): { title: string; artist?: string } => {
  const tagTitle = metadata?.title?.trim();
  const tagArtist = metadata?.artist?.trim();
  const baseName = basename(fileName, extname(fileName)).trim();

  if (tagTitle) {
    return { title: tagTitle, artist: tagArtist || undefined };
  }

  if (tagArtist) {
    return { title: baseName, artist: tagArtist };
  }

  const splitIndex = baseName.indexOf(' - ');
  if (splitIndex > 0 && splitIndex < baseName.length - 3) {
    return {
      title: baseName.slice(splitIndex + 3).trim(),
      artist: baseName.slice(0, splitIndex).trim(),
    };
  }

  return { title: baseName };
};

const readRange = async (handle: FileHandle, offset: number, length: number) => {
  if (length <= 0 || offset < 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, offset);
  return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
};

const cleanText = (value: string | undefined) =>
  value === undefined ? undefined : value.replace(/\0/g, '').trim() || undefined;

const parseNumeric = (value: unknown) => {
  const match = /(\d+)/.exec(String(value ?? ''));
  return match ? Number(match[1]) : undefined;
};

const toYear = (value: unknown) => {
  const match = /(\d{4})/.exec(String(value ?? ''));
  return match ? Number(match[1]) : undefined;
};

// ---------------------------------------------------------------------------
// Vorbis comment（FLAC / Ogg Vorbis / Opus 共用）
// ---------------------------------------------------------------------------

const parseVorbisComments = (buffer: Buffer, offset: number): PluginAudioMetadata => {
  const metadata: PluginAudioMetadata = {};
  if (offset + 4 > buffer.length) return metadata;

  let cursor = offset;
  const vendorLength = buffer.readUInt32LE(cursor);
  cursor += 4;
  if (vendorLength > buffer.length - cursor) return metadata;
  cursor += vendorLength;
  if (cursor + 4 > buffer.length) return metadata;

  const count = buffer.readUInt32LE(cursor);
  cursor += 4;

  const tagMap = new Map<string, string>();
  const tagText = (key: string) => cleanText(tagMap.get(key.toUpperCase()));

  for (let index = 0; index < count && cursor + 4 <= buffer.length; index += 1) {
    const length = buffer.readUInt32LE(cursor);
    cursor += 4;
    if (length <= 0 || length > buffer.length - cursor) break;
    const entry = buffer.toString('utf8', cursor, cursor + length);
    cursor += length;
    const equalsIndex = entry.indexOf('=');
    if (equalsIndex <= 0) continue;
    const key = entry.slice(0, equalsIndex).trim().toUpperCase();
    if (!tagMap.has(key)) tagMap.set(key, entry.slice(equalsIndex + 1));
  }

  metadata.title = tagText('TITLE');
  metadata.artist = tagText('ARTIST');
  metadata.album = tagText('ALBUM');
  metadata.year = toYear(tagText('DATE') ?? tagText('YEAR') ?? tagText('ORIGINALDATE'));
  metadata.track = parseNumeric(tagText('TRACKNUMBER'));
  metadata.disk = parseNumeric(tagText('DISCNUMBER'));
  const genre = tagText('GENRE');
  metadata.genre = genre ? [genre] : undefined;

  for (const key of Object.keys(metadata) as (keyof PluginAudioMetadata)[]) {
    if (metadata[key] === undefined) delete metadata[key];
  }
  return metadata;
};

// ---------------------------------------------------------------------------
// FLAC
// ---------------------------------------------------------------------------

const parseFlac = (buffer: Buffer): PluginAudioMetadata => {
  const metadata: PluginAudioMetadata = {};
  let cursor = 4;
  while (cursor + 4 <= buffer.length) {
    const header = buffer[cursor];
    const isLast = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const length = buffer.readUIntBE(cursor + 1, 3);
    const bodyStart = cursor + 4;
    if (length < 0 || bodyStart + length > buffer.length) break;

    if (type === 0 && length >= 18) {
      // STREAMINFO: sampleRate(20bit) channels(3) bitsPerSample(5) totalSamples(36)
      const high = buffer.readUInt32BE(bodyStart + 10);
      const low = buffer.readUInt32BE(bodyStart + 14);
      const sampleRate = high >>> 12;
      const totalSamples = (high & 0x0f) * 2 ** 32 + low;
      if (sampleRate > 0 && totalSamples > 0) {
        metadata.duration = totalSamples / sampleRate;
      }
    } else if (type === 4) {
      Object.assign(metadata, parseVorbisComments(buffer, bodyStart));
    }

    if (isLast) break;
    cursor = bodyStart + length;
  }
  return metadata;
};

// ---------------------------------------------------------------------------
// Ogg（Vorbis / Opus）
// ---------------------------------------------------------------------------

const parseOgg = async (
  handle: FileHandle,
  head: Buffer,
  size: number,
): Promise<PluginAudioMetadata> => {
  const metadata: PluginAudioMetadata = {};

  let sampleRate = 0;
  let preSkip = 0;

  const vorbisId = head.indexOf('vorbis', 0, 'latin1');
  const opusId = head.indexOf('OpusHead', 0, 'latin1');
  if (opusId >= 0) {
    sampleRate = 48_000;
    if (opusId + 12 <= head.length) preSkip = head.readUInt16LE(opusId + 10);
  } else if (vorbisId > 0) {
    // 识别头：\x01 + "vorbis" + version(4) + channels(1) + sampleRate(4 LE)
    // vorbisId 指向 "vorbis" 首字节，采样率在其后 11 字节处。
    const rateOffset = vorbisId + 11;
    if (rateOffset + 4 <= head.length) sampleRate = head.readUInt32LE(rateOffset);
  }

  const opusTags = head.indexOf('OpusTags', 0, 'latin1');
  if (opusTags >= 0) {
    Object.assign(metadata, parseVorbisComments(head, opusTags + 8));
  } else {
    const vorbisComment = head.indexOf('\x03vorbis', 0, 'latin1');
    if (vorbisComment >= 0) {
      Object.assign(metadata, parseVorbisComments(head, vorbisComment + 7));
    }
  }

  if (sampleRate > 0 && size > 0) {
    const tailLength = Math.min(size, OGG_TAIL_BYTES);
    const tail = await readRange(handle, size - tailLength, tailLength);
    const lastPage = tail.lastIndexOf('OggS', undefined, 'latin1');
    if (lastPage >= 0 && lastPage + 14 <= tail.length) {
      const granule = Number(tail.readBigUInt64LE(lastPage + 6));
      const samples = granule - preSkip;
      if (Number.isFinite(samples) && samples > 0) metadata.duration = samples / sampleRate;
    }
  }

  for (const key of Object.keys(metadata) as (keyof PluginAudioMetadata)[]) {
    if (metadata[key] === undefined) delete metadata[key];
  }
  return metadata;
};

// ---------------------------------------------------------------------------
// ID3v2 / ID3v1 / MPEG
// ---------------------------------------------------------------------------

const decodeId3Text = (buffer: Buffer, start: number, end: number) => {
  if (start >= end) return undefined;
  const encoding = buffer[start];
  const body = buffer.subarray(start + 1, end);
  let text: string;
  switch (encoding) {
    case 0:
      text = body.toString('latin1');
      break;
    case 1:
      text = body.toString('utf16le');
      break;
    case 2: {
      const swapped = Buffer.from(body);
      swapped.swap16();
      text = swapped.toString('utf16le');
      break;
    }
    default:
      text = body.toString('utf8');
      break;
  }
  return cleanText(text);
};

const normalizeId3Genre = (value: string | undefined) => {
  if (!value) return undefined;
  const trimmed = value.trim();
  const numeric = /^\((\d+)\)/.exec(trimmed);
  if (numeric) return DEFAULT_GENRES[Number(numeric[1])] ?? undefined;
  if (/^\d+$/.test(trimmed)) return DEFAULT_GENRES[Number(trimmed)] ?? undefined;
  return trimmed.split('\0')[0].trim() || undefined;
};

const parseId3v2 = (buffer: Buffer): { metadata: PluginAudioMetadata; audioStart: number } => {
  const metadata: PluginAudioMetadata = {};
  const version = buffer[3];
  const flags = buffer[5];
  const size =
    ((buffer[6] & 0x7f) << 21) |
    ((buffer[7] & 0x7f) << 14) |
    ((buffer[8] & 0x7f) << 7) |
    (buffer[9] & 0x7f);
  let cursor = 10;
  if ((flags & 0x40) !== 0 && version >= 3 && cursor + 4 <= buffer.length) {
    // 扩展头：v2.3/v2.4 均为 4 字节长度 + 剩余内容
    cursor += 4 + buffer.readUInt32BE(cursor);
  }
  const tagEnd = Math.min(10 + size, buffer.length);

  while (cursor + 6 <= tagEnd) {
    if (buffer[cursor] === 0) break;
    const frameId = buffer.toString('latin1', cursor, cursor + (version === 2 ? 3 : 4));
    const frameSize =
      version === 2
        ? buffer.readUIntBE(cursor + 3, 3)
        : version === 4
          ? ((buffer[cursor + 4] & 0x7f) << 21) |
            ((buffer[cursor + 5] & 0x7f) << 14) |
            ((buffer[cursor + 6] & 0x7f) << 7) |
            (buffer[cursor + 7] & 0x7f)
          : buffer.readUInt32BE(cursor + 4);
    const headerSize = version === 2 ? 6 : 10;
    const bodyStart = cursor + headerSize;
    if (frameSize <= 0 || bodyStart + frameSize > tagEnd) break;

    const bodyEnd = bodyStart + frameSize;
    const text = () => decodeId3Text(buffer, bodyStart, bodyEnd);
    switch (frameId) {
      case 'TIT2':
      case 'TT2':
        metadata.title = text();
        break;
      case 'TPE1':
      case 'TP1':
        metadata.artist = text();
        break;
      case 'TALB':
      case 'TAL':
        metadata.album = text();
        break;
      case 'TYER':
      case 'TDRC':
      case 'TYE':
        metadata.year = toYear(text());
        break;
      case 'TRCK':
      case 'TRK':
        metadata.track = parseNumeric(text());
        break;
      case 'TPOS':
      case 'TPA':
        metadata.disk = parseNumeric(text());
        break;
      case 'TCON':
      case 'TCO': {
        const genre = normalizeId3Genre(text());
        metadata.genre = genre ? [genre] : undefined;
        break;
      }
      case 'TLEN': {
        const ms = parseNumeric(text());
        if (ms && ms > 0) metadata.duration = ms / 1000;
        break;
      }
      default:
        break;
    }

    cursor = bodyEnd;
  }

  for (const key of Object.keys(metadata) as (keyof PluginAudioMetadata)[]) {
    if (metadata[key] === undefined) delete metadata[key];
  }
  return { metadata, audioStart: Math.min(10 + size, buffer.length) };
};

const parseId3v1 = (buffer: Buffer): PluginAudioMetadata => {
  const metadata: PluginAudioMetadata = {};
  metadata.title = cleanText(buffer.toString('latin1', 3, 33));
  metadata.artist = cleanText(buffer.toString('latin1', 33, 63));
  metadata.album = cleanText(buffer.toString('latin1', 63, 93));
  metadata.year = toYear(buffer.toString('latin1', 93, 97));
  const genreIndex = buffer[127];
  if (genreIndex < DEFAULT_GENRES.length) metadata.genre = [DEFAULT_GENRES[genreIndex]];
  // ID3v1.1：注释末两字节为 0x00 + 音轨号
  if (buffer[125] === 0 && buffer[126] !== 0) metadata.track = buffer[126];

  for (const key of Object.keys(metadata) as (keyof PluginAudioMetadata)[]) {
    if (metadata[key] === undefined) delete metadata[key];
  }
  return metadata;
};

const MPEG_BITRATES: Record<string, number[]> = {
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
MPEG_BITRATES['2-3'] = MPEG_BITRATES['2-2'];

type MpegFrame = {
  version: '1' | '2' | '2.5';
  layer: 1 | 2 | 3;
  bitrate: number;
  sampleRate: number;
  samplesPerFrame: number;
  channels: number;
};

const parseMpegFrame = (buffer: Buffer, offset: number): MpegFrame | null => {
  if (offset + 4 > buffer.length) return null;
  if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) return null;

  const versionBits = (buffer[offset + 1] >> 3) & 0x03;
  const layerBits = (buffer[offset + 1] >> 1) & 0x03;
  const bitrateIndex = (buffer[offset + 2] >> 4) & 0x0f;
  const sampleRateIndex = (buffer[offset + 2] >> 2) & 0x03;
  const channelMode = (buffer[offset + 3] >> 6) & 0x03;
  if (versionBits === 1 || layerBits === 0) return null;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null;

  const version: MpegFrame['version'] =
    versionBits === 3 ? '1' : versionBits === 2 ? '2' : '2.5';
  const layer = (4 - layerBits) as 1 | 2 | 3;
  const bitrate =
    MPEG_BITRATES[`${version === '1' ? 1 : 2}-${layer}`]?.[bitrateIndex] ?? 0;
  const baseRate = version === '1' ? [44100, 48000, 32000] : [22050, 24000, 16000];
  const sampleRate = version === '2.5' ? baseRate[sampleRateIndex] / 2 : baseRate[sampleRateIndex];
  if (!bitrate || !sampleRate) return null;

  const samplesPerFrame =
    layer === 1 ? 384 : layer === 2 ? 1152 : version === '1' ? 1152 : 576;

  return {
    version,
    layer,
    bitrate,
    sampleRate,
    samplesPerFrame,
    channels: channelMode === 3 ? 1 : 2,
  };
};

const findMpegFrame = (buffer: Buffer, start: number) => {
  for (let offset = Math.max(0, start); offset + 4 <= buffer.length; offset += 1) {
    const frame = parseMpegFrame(buffer, offset);
    if (frame) return { offset, frame };
  }
  return null;
};

const readXingFrameCount = (buffer: Buffer, offset: number, frame: MpegFrame) => {
  const xingOffset =
    frame.version === '1' ? (frame.channels === 1 ? 17 : 32) : frame.channels === 1 ? 9 : 17;
  const base = offset + 4 + xingOffset;
  if (base + 12 > buffer.length) return 0;
  const marker = buffer.toString('latin1', base, base + 4);
  if (marker !== 'Xing' && marker !== 'Info') return 0;
  const flags = buffer.readUInt32BE(base + 4);
  if ((flags & 0x01) === 0) return 0;
  return buffer.readUInt32BE(base + 8);
};

const computeMpegDuration = (
  buffer: Buffer,
  audioStart: number,
  size: number,
): number | undefined => {
  const found = findMpegFrame(buffer, audioStart);
  if (!found) return undefined;
  const { offset, frame } = found;

  const xingFrames = readXingFrameCount(buffer, offset, frame);
  if (xingFrames > 0) return (xingFrames * frame.samplesPerFrame) / frame.sampleRate;

  const audioBytes = Math.max(0, size - offset);
  if (audioBytes <= 0) return undefined;
  return (audioBytes * 8) / (frame.bitrate * 1000);
};

// ---------------------------------------------------------------------------
// MP4 / M4A
// ---------------------------------------------------------------------------

type AtomHeader = {
  type: string;
  size: number;
  headerSize: number;
  contentStart: number;
  contentEnd: number;
};

const readAtomHeader = async (
  handle: FileHandle,
  offset: number,
  limit: number,
): Promise<AtomHeader | null> => {
  if (offset + 8 > limit) return null;
  const header = await readRange(handle, offset, 16);
  if (header.length < 8) return null;
  const size32 = header.readUInt32BE(0);
  const type = header.toString('latin1', 4, 8);
  let size = size32;
  let headerSize = 8;
  if (size32 === 1) {
    if (header.length < 16) return null;
    size = Number(header.readBigUInt64BE(8));
    headerSize = 16;
  } else if (size32 === 0) {
    size = limit - offset;
  }
  if (size < headerSize || offset + size > limit) return null;
  return {
    type,
    size,
    headerSize,
    contentStart: offset + headerSize,
    contentEnd: offset + size,
  };
};

const findAtom = async (handle: FileHandle, start: number, end: number, type: string) => {
  let cursor = start;
  let guard = 0;
  while (cursor + 8 <= end && guard < 512) {
    guard += 1;
    const atom = await readAtomHeader(handle, cursor, end);
    if (!atom) return null;
    if (atom.type === type) return atom;
    cursor = atom.contentEnd;
  }
  return null;
};

const MP4_TEXT_KEYS: Record<string, keyof PluginAudioMetadata> = {
  '\u00a9nam': 'title',
  '\u00a9ART': 'artist',
  aART: 'artist',
  '\u00a9alb': 'album',
  '\u00a9day': 'year',
  '\u00a9gen': 'genre',
  gnre: 'genre',
  trkn: 'track',
  disk: 'disk',
};

const parseMp4 = async (
  handle: FileHandle,
  size: number,
): Promise<PluginAudioMetadata> => {
  const metadata: PluginAudioMetadata = {};

  const moov = await findAtom(handle, 0, size, 'moov');
  if (!moov) throw new Error('未找到 MP4 moov 结构');

  const mvhd = await findAtom(handle, moov.contentStart, moov.contentEnd, 'mvhd');
  if (mvhd) {
    const body = await readRange(handle, mvhd.contentStart, Math.min(32, mvhd.size));
    if (body.length >= 20) {
      const version = body[0];
      if (version === 1 && body.length >= 28) {
        const timescale = body.readUInt32BE(20);
        const duration = Number(body.readBigUInt64BE(24));
        if (timescale > 0 && duration > 0) metadata.duration = duration / timescale;
      } else {
        const timescale = body.readUInt32BE(12);
        const duration = body.readUInt32BE(16);
        if (timescale > 0 && duration > 0) metadata.duration = duration / timescale;
      }
    }
  }

  const udta = await findAtom(handle, moov.contentStart, moov.contentEnd, 'udta');
  if (udta) {
    let ilst = await findAtom(handle, udta.contentStart, udta.contentEnd, 'ilst');
    if (!ilst) {
      const meta = await findAtom(handle, udta.contentStart, udta.contentEnd, 'meta');
      // meta 是 full atom：跳过 4 字节 version/flags 后再找 ilst
      if (meta) ilst = await findAtom(handle, meta.contentStart + 4, meta.contentEnd, 'ilst');
    }

    if (ilst) {
      let cursor = ilst.contentStart;
      let guard = 0;
      while (cursor + 8 <= ilst.contentEnd && guard < 256) {
        guard += 1;
        const item = await readAtomHeader(handle, cursor, ilst.contentEnd);
        if (!item) break;
        cursor = item.contentEnd;

        const key = MP4_TEXT_KEYS[item.type];
        if (!key) continue;

        const dataAtom = await findAtom(handle, item.contentStart, item.contentEnd, 'data');
        if (!dataAtom) continue;
        const payload = await readRange(
          handle,
          dataAtom.contentStart + 8,
          Math.max(0, dataAtom.size - 16),
        );
        if (payload.length === 0) continue;

        if (item.type === 'trkn' || item.type === 'disk') {
          const index = payload.length >= 4 ? payload.readUInt16BE(2) : 0;
          if (index > 0) {
            if (item.type === 'trkn') metadata.track = index;
            else metadata.disk = index;
          }
          continue;
        }
        if (item.type === 'gnre') {
          if (payload.length >= 2) {
            const index = payload.readUInt16BE(0) - 1;
            metadata.genre = DEFAULT_GENRES[index] ? [DEFAULT_GENRES[index]] : undefined;
          }
          continue;
        }
        const text = cleanText(payload.toString('utf8'));
        if (key === 'year') metadata.year = toYear(text);
        else if (key === 'genre') metadata.genre = text ? [text] : undefined;
        else if (key === 'title') metadata.title = text;
        else if (key === 'artist') metadata.artist = text;
        else if (key === 'album') metadata.album = text;
      }
    }
  }

  for (const key of Object.keys(metadata) as (keyof PluginAudioMetadata)[]) {
    if (metadata[key] === undefined) delete metadata[key];
  }
  return metadata;
};

// ---------------------------------------------------------------------------
// WAV / AIFF
// ---------------------------------------------------------------------------

const parseWav = (buffer: Buffer): PluginAudioMetadata => {
  const metadata: PluginAudioMetadata = {};
  let byteRate = 0;
  let dataSize = 0;
  let cursor = 12;

  while (cursor + 8 <= buffer.length) {
    const chunkId = buffer.toString('latin1', cursor, cursor + 4);
    const chunkSize = buffer.readUInt32LE(cursor + 4);
    const bodyStart = cursor + 8;
    if (chunkSize < 0 || bodyStart > buffer.length) break;
    const bodyEnd = Math.min(bodyStart + chunkSize, buffer.length);

    if (chunkId === 'fmt ' && chunkSize >= 12) {
      byteRate = buffer.readUInt32LE(bodyStart + 8);
    } else if (chunkId === 'data') {
      dataSize = chunkSize;
    } else if (chunkId === 'LIST' && buffer.toString('latin1', bodyStart, bodyStart + 4) === 'INFO') {
      let infoCursor = bodyStart + 4;
      while (infoCursor + 8 <= bodyEnd) {
        const infoId = buffer.toString('latin1', infoCursor, infoCursor + 4);
        const infoSize = buffer.readUInt32LE(infoCursor + 4);
        const infoStart = infoCursor + 8;
        if (infoSize < 0 || infoStart + infoSize > bodyEnd) break;
        const value = cleanText(buffer.toString('utf8', infoStart, infoStart + infoSize));
        if (value) {
          if (infoId === 'INAM') metadata.title = value;
          else if (infoId === 'IART') metadata.artist = value;
          else if (infoId === 'IPRD') metadata.album = value;
          else if (infoId === 'ICRD') metadata.year = toYear(value);
          else if (infoId === 'ITRK') metadata.track = parseNumeric(value);
          else if (infoId === 'IGNR') metadata.genre = [value];
        }
        infoCursor = infoStart + infoSize + (infoSize % 2);
      }
    }

    cursor = bodyStart + chunkSize + (chunkSize % 2);
  }

  if (byteRate > 0 && dataSize > 0) metadata.duration = dataSize / byteRate;

  for (const key of Object.keys(metadata) as (keyof PluginAudioMetadata)[]) {
    if (metadata[key] === undefined) delete metadata[key];
  }
  return metadata;
};

const readExtendedFloat = (buffer: Buffer, offset: number) => {
  const exponent = ((buffer[offset] & 0x7f) << 8) | buffer[offset + 1];
  const mantissa = buffer.readUInt32BE(offset + 2) * 2 ** 32 + buffer.readUInt32BE(offset + 6);
  if (exponent === 0 && mantissa === 0) return 0;
  const sign = (buffer[offset] & 0x80) === 0 ? 1 : -1;
  return sign * mantissa * 2 ** (exponent - 16383 - 63);
};

const parseAiff = (buffer: Buffer): PluginAudioMetadata => {
  const metadata: PluginAudioMetadata = {};
  let cursor = 12;

  while (cursor + 8 <= buffer.length) {
    const chunkId = buffer.toString('latin1', cursor, cursor + 4);
    const chunkSize = buffer.readUInt32BE(cursor + 4);
    const bodyStart = cursor + 8;
    if (chunkSize < 0 || bodyStart > buffer.length) break;
    const bodyEnd = Math.min(bodyStart + chunkSize, buffer.length);

    if (chunkId === 'COMM' && chunkSize >= 18) {
      const sampleFrames = buffer.readUInt32BE(bodyStart + 2);
      const sampleRate = readExtendedFloat(buffer, bodyStart + 8);
      if (sampleFrames > 0 && sampleRate > 0) metadata.duration = sampleFrames / sampleRate;
    } else if (chunkId === 'NAME') {
      metadata.title = cleanText(buffer.toString('utf8', bodyStart, bodyEnd));
    } else if (chunkId === 'AUTH') {
      metadata.artist = cleanText(buffer.toString('utf8', bodyStart, bodyEnd));
    }

    cursor = bodyStart + chunkSize + (chunkSize % 2);
  }

  for (const key of Object.keys(metadata) as (keyof PluginAudioMetadata)[]) {
    if (metadata[key] === undefined) delete metadata[key];
  }
  return metadata;
};

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/** 读取音频文件标签；无法识别的容器会抛错，由调用方降级处理。 */
export const readAudioMetadata = async (filePath: string): Promise<PluginAudioMetadata> => {
  const handle = await open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    if (size <= 0) throw new Error('音频文件为空');

    const head = await readRange(handle, 0, Math.min(size, HEAD_BYTES));
    const signature = head.toString('latin1', 0, Math.min(head.length, 12));

    // ID3v1 位于文件末尾；ID3v2 缺失字段时用它兜底（与常见解析器一致，v2 优先）。
    const readId3v1 = async () => {
      const tailLength = Math.min(size, ID3V1_BYTES);
      const tail = await readRange(handle, size - tailLength, tailLength);
      if (tail.length === ID3V1_BYTES && tail.toString('latin1', 0, 3) === 'TAG') {
        return parseId3v1(tail);
      }
      return null;
    };
    const mergeMissing = (base: PluginAudioMetadata, fallback: PluginAudioMetadata | null) => {
      if (!fallback) return base;
      for (const key of Object.keys(fallback) as (keyof PluginAudioMetadata)[]) {
        if (base[key] === undefined && fallback[key] !== undefined) {
          base[key] = fallback[key] as never;
        }
      }
      return base;
    };

    if (signature.startsWith('fLaC')) return parseFlac(head);
    if (signature.startsWith('OggS')) return await parseOgg(handle, head, size);
    if (signature.slice(4, 8) === 'ftyp') return await parseMp4(handle, size);
    if (signature.startsWith('RIFF') && signature.slice(8, 12) === 'WAVE') return parseWav(head);
    if (signature.startsWith('FORM') && /AIFF|AIFC/.test(signature.slice(8, 12))) {
      return parseAiff(head);
    }

    if (signature.startsWith('ID3')) {
      const parsed = parseId3v2(head);
      const id3v1 = await readId3v1();
      const metadata = mergeMissing(parsed.metadata, id3v1);
      if (metadata.duration === undefined) {
        const duration = computeMpegDuration(
          head,
          parsed.audioStart,
          size - (id3v1 ? ID3V1_BYTES : 0),
        );
        if (duration !== undefined) metadata.duration = duration;
      }
      return metadata;
    }

    const framed = findMpegFrame(head, 0);
    if (framed) {
      const id3v1 = await readId3v1();
      const metadata: PluginAudioMetadata = mergeMissing({}, id3v1);
      const duration = computeMpegDuration(head, 0, size - (id3v1 ? ID3V1_BYTES : 0));
      if (duration !== undefined) metadata.duration = duration;
      return metadata;
    }

    const id3v1 = await readId3v1();
    if (id3v1) return id3v1;

    throw new Error('不支持的音频标签格式');
  } finally {
    await handle.close();
  }
};
