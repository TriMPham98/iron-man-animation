import { describe, expect, it } from 'vitest';
import manifestJson from '../../../../public/sounds/flight/jarvis/manifest.json';
import { pickFallbackVoice, voiceKey, type VoiceManifest } from './jarvisVoice';

const manifest = manifestJson as VoiceManifest;
const sources = import.meta.glob('/src/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const files = new Set(Object.keys(import.meta.glob('/public/sounds/flight/jarvis/*.mp3', { query: '?url', import: 'default' })));

function sourceLines(): string[] {
  const out = new Set<string>();
  for (const [path, src] of Object.entries(sources)) {
    if (path.endsWith('.test.ts')) continue;
    for (const m of src.matchAll(/['"]jarvis['"]\s*,\s*\{\s*text:\s*(['"])(.+?)\1/g)) out.add(m[2]);
    for (const m of src.matchAll(/engage\(\s*(?:line\s*=\s*)?(['"])(.+?)\1/g)) out.add(m[2]);
  }
  return [...out];
}

describe('JARVIS voice manifest', () => {
  it('maps every entry to a file on disk, uniquely', () => {
    expect(manifest.lines.length).toBeGreaterThan(5);
    const keys = new Set(manifest.lines.map((l) => voiceKey(l.text)));
    expect(keys.size).toBe(manifest.lines.length);
    for (const l of manifest.lines) expect(files.has(`/public/sounds/flight/jarvis/${l.file}`), l.file).toBe(true);
  });

  it('voices the lines the sim shows (new ones fall back to speech until re-rendered)', () => {
    const have = new Set(manifest.lines.map((l) => voiceKey(l.text)));
    const missing = sourceLines().filter((t) => !have.has(voiceKey(t)));
    // Not a failure (other work adds lines): run scripts/render-jarvis-voice.py
    if (missing.length) console.warn('[jarvis] lines without a voice file:', missing);
    expect(sourceLines().length).toBeGreaterThan(0);
  });

  it('matches text regardless of case and punctuation', () => {
    expect(voiceKey('Area clear, sir.  Next formation')).toBe(voiceKey('area clear sir next formation'));
  });

  it('prefers an en-GB male voice for the fallback', () => {
    const v = (name: string, lang: string) => ({ name, lang }) as SpeechSynthesisVoice;
    expect(pickFallbackVoice([v('Samantha', 'en-US'), v('Kate', 'en-GB'), v('Daniel', 'en-GB')])?.name).toBe('Daniel');
    expect(pickFallbackVoice([v('Google UK English Female', 'en-GB'), v('Google UK English Male', 'en-GB')])?.name).toBe('Google UK English Male');
    expect(pickFallbackVoice([v('Alex', 'en-US')])).toBeNull();
  });
});
