import { signal, withBasePath } from 'amoxi';

interface Screen {
  file: string;
  caption: string;
}

type Device = 'desktop' | 'mobile';

/** Screenshots of one example app: pick a screen, and switch between desktop and phone sizes. */
export default function ScreenshotViewer(props: { screens: Screen[]; brand: string }) {
  const [index, setIndex] = signal(0);
  const [device, setDevice] = signal<Device>('desktop');
  const current = (): Screen => props.screens[index()];
  const src = (s: Screen, d: Device): string => withBasePath(`/shots/${s.file}-${d}.jpg`);

  const onTabKey = (e: KeyboardEvent): void => {
    const n = props.screens.length;
    const next = e.key === 'ArrowRight' ? (index() + 1) % n : e.key === 'ArrowLeft' ? (index() - 1 + n) % n : -1;
    if (next < 0) return;
    e.preventDefault();
    setIndex(next);
    (e.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <div class="viewer">
      <div class="viewer-controls">
        <div role="tablist" aria-label={`${props.brand} screens`} class="viewer-tabs">
          {props.screens.map((s, i) => (
            <button
              type="button"
              role="tab"
              id={`tab-${s.file}`}
              aria-controls="viewer-panel"
              aria-selected={() => String(index() === i)}
              tabindex={() => (index() === i ? '0' : '-1')}
              onClick={() => setIndex(i)}
              onKeyDown={onTabKey}
            >
              {s.caption}
            </button>
          ))}
        </div>
        <div class="viewer-device" role="group" aria-label="Screen size">
          {(['desktop', 'mobile'] as Device[]).map((d) => (
            <button type="button" aria-pressed={() => String(device() === d)} onClick={() => setDevice(d)}>
              {d === 'desktop' ? 'Desktop' : 'Phone'}
            </button>
          ))}
        </div>
      </div>
      <div id="viewer-panel" role="tabpanel" class={() => `viewer-stage ${device()}`} aria-labelledby={() => `tab-${current().file}`}>
        <div class="viewer-frame">
          <img
            src={() => src(current(), device())}
            alt={() => `${props.brand}: ${current().caption} (${device() === 'desktop' ? 'desktop' : 'phone'} screenshot)`}
            width={() => (device() === 'desktop' ? '1440' : '390')}
            height={() => (device() === 'desktop' ? '900' : '844')}
            decoding="async"
          />
        </div>
      </div>
    </div>
  );
}
