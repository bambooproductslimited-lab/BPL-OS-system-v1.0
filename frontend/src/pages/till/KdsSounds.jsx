import { tr } from '../../lib/i18n.jsx';
import { unlockAudio } from '../../kiosk/kioskSounds';
import { REPEATS, TONES, playTone } from '../../kiosk/kitchenTones';

// The kitchen screen's sounds (KdsPage → 🔔): on or off, the tone for a new
// ticket and for an order all ready (each heard as it is picked), how loud,
// and whether a new ticket keeps ringing until someone touches the screen.
// Set on this tablet only (kiosk/kitchenTones.js).

function ToneGrid({ value, volume, onPick, label }) {
  return (
    <div className="kds-snd-tones" role="radiogroup" aria-label={label}>
      {TONES.map((t) => (
        <button key={t.id} type="button" role="radio" aria-checked={value === t.id} className={'kds-snd-tone' + (value === t.id ? ' is-on' : '')}
          onClick={() => { unlockAudio(); playTone(t.id, volume); onPick(t.id); }}>
          <span className="kds-snd-play" aria-hidden="true">{value === t.id ? '✓' : '▶'}</span>
          <span>{tr(t.name)}</span>
        </button>
      ))}
    </div>
  );
}

export default function KdsSounds({ sounds, onChange, onClose }) {
  const set = (patch) => onChange({ ...sounds, ...patch });
  const pct = Math.round(sounds.volume * 100);
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog tl-dialog kds-snd" role="dialog" aria-modal="true" aria-labelledby="kds-snd-title" onClick={(e) => e.stopPropagation()}>
        <span className="tl-dialog-ico kds-snd-ico" aria-hidden="true">{sounds.on ? '🔔' : '🔕'}</span>
        <h2 id="kds-snd-title">{tr('Sounds on this screen')}</h2>
        <p className="dk-muted">{tr('Set on this tablet only: each kitchen can sound different. Keep the tablet\'s own volume up too.')}</p>

        <button type="button" role="switch" aria-checked={sounds.on} className={'kds-snd-switch' + (sounds.on ? ' is-on' : '')} onClick={() => { unlockAudio(); set({ on: !sounds.on }); if (!sounds.on) playTone(sounds.newTone, sounds.volume); }}>
          <span className="kds-snd-knob" aria-hidden="true" />
          <span><strong>{sounds.on ? tr('Sound on') : tr('Sound off')}</strong><small>{sounds.on ? tr('A tone for each new ticket') : tr('No tone: watch the screen for new tickets')}</small></span>
        </button>

        <fieldset className="kds-snd-sec" disabled={!sounds.on}>
          <legend>{tr('New ticket')}</legend>
          <ToneGrid value={sounds.newTone} volume={sounds.volume} label={tr('New ticket')} onPick={(id) => set({ newTone: id })} />
        </fieldset>
        <fieldset className="kds-snd-sec" disabled={!sounds.on}>
          <legend>{tr('Order all ready')}<small>{tr('In the Expo view')}</small></legend>
          <ToneGrid value={sounds.readyTone} volume={sounds.volume} label={tr('Order all ready')} onPick={(id) => set({ readyTone: id })} />
        </fieldset>
        <fieldset className="kds-snd-sec" disabled={!sounds.on}>
          <legend>{tr('Volume')}<small>{pct}%</small></legend>
          <div className="kds-snd-vol">
            <span aria-hidden="true">🔈</span>
            <input type="range" min="10" max="100" step="5" value={pct} aria-label={tr('Volume')}
              onChange={(e) => set({ volume: Number(e.target.value) / 100 })}
              onPointerUp={() => { unlockAudio(); playTone(sounds.newTone, sounds.volume); }}
              onKeyUp={() => playTone(sounds.newTone, sounds.volume)} />
            <span aria-hidden="true">🔊</span>
            <button type="button" className="btn btn-secondary" onClick={() => { unlockAudio(); playTone(sounds.newTone, sounds.volume); }}>▶ {tr('Test')}</button>
          </div>
        </fieldset>
        <fieldset className="kds-snd-sec" disabled={!sounds.on}>
          <legend>{tr('Keep ringing until someone taps the screen')}</legend>
          <div className="ts-chips kds-snd-repeat" role="radiogroup" aria-label={tr('Keep ringing until someone taps the screen')}>
            {REPEATS.map((r) => (
              <button key={r} type="button" role="radio" aria-checked={sounds.repeat === r} className={sounds.repeat === r ? 'is-on' : ''} onClick={() => set({ repeat: r })}>
                {r === 0 ? tr('No, once') : r === 60 ? tr('Every minute') : tr('Every {n} seconds', { n: r })}
              </button>
            ))}
          </div>
          {sounds.repeat > 0 && <p className="kds-snd-note">{tr('A new ticket rings again every {n} seconds until anyone touches the screen.', { n: sounds.repeat })}</p>}
        </fieldset>

        <div className="dialog-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>{tr('Done')}</button>
        </div>
      </div>
    </div>
  );
}
