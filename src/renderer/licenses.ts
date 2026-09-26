import { elements } from './dom.js';

export interface LicenseCrawlerEntry {
  licenses: string | string[];
  repository?: string;
  licenseUrl?: string;
  url?: string;
  license?: string;
}

export interface LicenseDisplayEntry {
  name: string;
  license: string;
  link?: string;
  note?: string;
  isSpecial?: boolean;
}

export const buildLicenseEntries = (
  data: Record<string, LicenseCrawlerEntry> | null
): LicenseDisplayEntry[] => {
  const entries: LicenseDisplayEntry[] = [
    {
      name: 'FFmpeg',
      license: 'GPL-2.0-or-later',
      link: 'https://ffmpeg.org/',
      note: 'Bundled GPL static builds include x264, x265, lame, libass, fribidi, freetype, fontconfig, libiconv, enca, and expat. License text: ffmpeg/LICENSE.txt. Source offer: ffmpeg/SOURCE_OFFER.txt.',
      isSpecial: true,
    },
    {
      name: 'FFmpeg license text',
      license: 'GPL-2.0-or-later',
      note: 'Included with this app at ffmpeg/LICENSE.txt.',
      isSpecial: true,
    },
    {
      name: 'FFmpeg source offer',
      license: 'GPLv2 Section 3(b)',
      note: 'Written offer included with this app at ffmpeg/SOURCE_OFFER.txt.',
      isSpecial: true,
    },
    {
      name: 'FFmpeg binaries',
      license: 'GPL-2.0-or-later',
      link: 'https://github.com/BurntToasters/ffmpeg-static-builds/releases/tag/ffmpeg-v8.1.2',
      note: 'Pre-built FFmpeg 8.1.2 GPL static binaries for Windows, macOS, and Linux. Source code available at the linked release.',
      isSpecial: true,
    },
    {
      name: 'Twemoji assets',
      license: 'CC-BY 4.0',
      link: 'https://creativecommons.org/licenses/by/4.0/',
      note: 'Emoji artwork from Twemoji by Twitter and other contributors. Used under CC-BY 4.0; source: github.com/jdecked/twemoji.',
      isSpecial: true,
    },
    {
      name: 'Inter fonts',
      license: 'OFL-1.1',
      link: 'https://github.com/rsms/inter',
      note: 'Bundled font subsets are licensed under OFL-1.1. Full notice: fonts/OFL.txt.',
      isSpecial: true,
    },
    {
      name: 'Outfit fonts',
      license: 'OFL-1.1',
      link: 'https://github.com/Outfitio/Outfit-Fonts',
      note: 'Bundled font subsets are licensed under OFL-1.1. Full notice: fonts/OFL.txt.',
      isSpecial: true,
    },
  ];

  if (!data || typeof data !== 'object') {
    return entries;
  }

  const packageEntries = Object.entries(data)
    .filter(([pkg]) => typeof pkg === 'string')
    .map(([pkg, info]) => {
      const entryInfo =
        typeof info === 'object' && info !== null
          ? (info as LicenseCrawlerEntry)
          : { licenses: String(info) as string };

      const licenses = Array.isArray(entryInfo.licenses)
        ? entryInfo.licenses.join(', ')
        : entryInfo.licenses || entryInfo.license || 'Unknown';

      const link = entryInfo.repository || entryInfo.licenseUrl || entryInfo.url;

      return {
        name: pkg,
        license: licenses,
        link,
      } as LicenseDisplayEntry;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return [...entries, ...packageEntries];
};

export const renderLicenses = (entries: LicenseDisplayEntry[]): void => {
  if (!elements.licensesList) return;

  elements.licensesList.innerHTML = '';

  entries.forEach((entry) => {
    const item = document.createElement('div');
    item.className = `license-item${entry.isSpecial ? ' license-highlight' : ''}`;

    const header = document.createElement('div');
    header.className = 'license-header';

    const nameEl = document.createElement('div');
    nameEl.className = 'license-name';
    nameEl.textContent = entry.name;

    const badge = document.createElement('span');
    badge.className = 'license-badge';
    badge.textContent = entry.license;

    header.appendChild(nameEl);
    header.appendChild(badge);
    item.appendChild(header);

    if (entry.note || entry.link) {
      const meta = document.createElement('div');
      meta.className = 'license-meta';

      if (entry.link && /^https?:\/\//i.test(entry.link)) {
        const linkBtn = document.createElement('button');
        linkBtn.className = 'btn btn-xs license-link';
        linkBtn.textContent = 'View source';
        linkBtn.addEventListener('click', () => window.electronAPI.openExternal(entry.link!));
        meta.appendChild(linkBtn);
      }

      if (entry.note) {
        const note = document.createElement('span');
        note.className = 'license-note';
        note.textContent = entry.note;
        meta.prepend(note);
      }

      item.appendChild(meta);
    }

    elements.licensesList.appendChild(item);
  });
};
