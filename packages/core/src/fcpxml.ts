import type { TrackReport } from './types/index.js';

export function escapeXml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&apos;');
}
function gcd(a: number, b: number): number { return b ? gcd(b, a % b) : a; }
export function rationalTime(ms: number): string {
  const n = Math.round(ms * 1000), d = 1_000_000, g = gcd(n, d);
  return `${n / g}/${d / g}s`;
}
function frameDuration(rate = '60/1'): string {
  const [n, d] = rate.split('/').map(Number);
  return n > 0 && d > 0 ? `${d}/${n}s` : '1/60s';
}
/** FCPXML 1.10 magnetic spine maps SCREEN→V1, CAMERA lane=1→V2, audio lanes -1/-2→A1/A2. */
export function generateFcpxml(name: string, outputPath: string, tracks: TrackReport[], durationMs: number): string {
  const screen = tracks.find(t => t.kind === 'display')!;
  const formats = tracks.filter(t => t.probe.width).map((t, i) => ({ t, id: `f${i + 1}` }));
  const formatFor = (t: TrackReport) => formats.find(f => f.t === t)?.id;
  const assetId = (t: TrackReport) => `a${tracks.indexOf(t) + 1}`;
  const resources = [
    ...formats.map(({ t, id }) => `    <format id="${id}" name="${escapeXml(t.file)}" frameDuration="${frameDuration(t.nominalFrameRate ?? (t.kind === 'webcam' ? '25/1' : t.probe.frameRate))}" width="${t.probe.width}" height="${t.probe.height}"/>`),
    ...tracks.map(t => `    <asset id="${assetId(t)}" name="${escapeXml(t.file)}" start="0s" duration="${rationalTime(t.actualDurationMs)}"${t.probe.width ? ` hasVideo="1" format="${formatFor(t)}"` : ` hasAudio="1" audioSources="1" audioChannels="${t.probe.channels ?? 2}" audioRate="48000"`}>
      <media-rep kind="original-media" src="../01_MEDIA/${encodeURIComponent(t.file)}"/>
    </asset>`),
  ].join('\n');
  const lane = { webcam: 1, microphone: -1, systemAudio: -2 } as const;
  const connected = tracks.filter(t => t.kind !== 'display').map(t => {
    const audio = t.kind === 'microphone' || t.kind === 'systemAudio';
    return `              <asset-clip name="${escapeXml(t.file)}" ref="${assetId(t)}" lane="${lane[t.kind as keyof typeof lane]}" offset="0s" start="0s" duration="${rationalTime(t.actualDurationMs)}"${audio ? ` audioRole="${t.kind === 'microphone' ? 'dialogue' : 'effects'}"` : ` format="${formatFor(t)}"`}/>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
${resources}
  </resources>
  <library>
    <event name="Screen Studio Bridge">
      <project name="${escapeXml(name)}">
        <sequence format="${formatFor(screen)}" duration="${rationalTime(durationMs)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine>
            <asset-clip name="SCREEN.mp4" ref="${assetId(screen)}" offset="0s" start="0s" duration="${rationalTime(screen.actualDurationMs)}" format="${formatFor(screen)}">
${connected}
            </asset-clip>
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}
