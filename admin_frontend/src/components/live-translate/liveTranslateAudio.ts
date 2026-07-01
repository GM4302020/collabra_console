// FILE: ~/otmega/otmega_app/console/admin_frontend/src/components/live-translate/liveTranslateAudio.ts
// ماموریت: تبدیل PCM/WAV و پخش chunkهای صوتی Live Translate در مرورگر.

export const INPUT_SAMPLE_RATE = 16000;
export const OUTPUT_SAMPLE_RATE = 24000;

export function resampleFloat32(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const sourceIndex = i * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(input.length - 1, left + 1);
    const weight = sourceIndex - left;
    output[i] = input[left] * (1 - weight) + input[right] * weight;
  }
  return output;
}

export function floatToPcm16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

export function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToInt16(value: string): Int16Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

function writeString(view: DataView, offset: number, value: string) {
  for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
}

function concatPcm(chunks: Int16Array[]): Int16Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Int16Array(total);
  let offset = 0;
  chunks.forEach((chunk) => {
    merged.set(chunk, offset);
    offset += chunk.length;
  });
  return merged;
}

export function pcm16ChunksToWavBase64(chunks: Int16Array[], sampleRate: number): string {
  const pcm = concatPcm(chunks);
  const dataSize = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < pcm.length; i += 1) view.setInt16(44 + i * 2, pcm[i], true);
  return int16ToBase64(new Int16Array(buffer));
}

export function playPcm16Chunk(ctx: AudioContext, pcm: Int16Array, sampleRate: number, startAt: number): number {
  const audioBuffer = ctx.createBuffer(1, pcm.length, sampleRate);
  const channel = audioBuffer.getChannelData(0);
  for (let i = 0; i < pcm.length; i += 1) channel[i] = pcm[i] / 0x8000;
  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(ctx.destination);
  source.start(startAt);
  return audioBuffer.duration;
}
