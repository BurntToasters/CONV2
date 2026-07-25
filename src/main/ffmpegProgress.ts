import type { ConversionProgress } from './ffmpeg';

/** Parse FFmpeg stderr progress line into a structured update. */
export const parseProgress = (line: string, totalDuration: number): ConversionProgress | null => {
  const frameMatch = line.match(/frame=\s*(\d+)/);
  const fpsMatch = line.match(/fps=\s*([\d.]+)/);
  const timeMatch = line.match(/time=\s*([\d:.]+)/);
  const bitrateMatch = line.match(/bitrate=\s*([\d.]+\s*\w+)/);
  const speedMatch = line.match(/speed=\s*([\d.]+x)/);

  if (timeMatch) {
    const timeParts = timeMatch[1].split(':');
    const [p0, p1, p2] = timeParts.map((p) => parseFloat(p) || 0);
    const seconds =
      timeParts.length >= 3 ? p0 * 3600 + p1 * 60 + p2 : timeParts.length === 2 ? p0 * 60 + p1 : p0;

    const percent = totalDuration > 0 ? Math.min(100, (seconds / totalDuration) * 100) : 0;

    return {
      percent,
      frame: frameMatch ? parseInt(frameMatch[1], 10) : 0,
      fps: fpsMatch ? parseFloat(fpsMatch[1]) : 0,
      time: timeMatch[1],
      bitrate: bitrateMatch ? bitrateMatch[1] : 'N/A',
      speed: speedMatch ? speedMatch[1] : 'N/A',
    };
  }

  return null;
};
