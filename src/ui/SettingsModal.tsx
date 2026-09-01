import type { AppearancePreference, DisplayUnit } from "../measurement";

interface Props {
  open: boolean;
  unit: DisplayUnit;
  decimals: number;
  appearance: AppearancePreference;
  onUnit: (unit: DisplayUnit) => void;
  onDecimals: (decimals: number) => void;
  onAppearance: (appearance: AppearancePreference) => void;
  onClose: () => void;
}

export function SettingsModal({
  open,
  unit,
  decimals,
  appearance,
  onUnit,
  onDecimals,
  onAppearance,
  onClose,
}: Props) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="modal-header">
          <div className="modal-title-group">
            <h2 id="settings-title">Settings</h2>
            <p className="modal-subtitle">Preferences apply to every design on this device.</p>
          </div>
          <button className="modal-close-btn" onClick={onClose} aria-label="Close settings">×</button>
        </header>
        <div className="settings-body">
          <label className="settings-row">
            <span><strong>Units</strong><small>Used for measurements and typed dimensions</small></span>
            <select value={unit} onChange={(e) => onUnit(e.target.value as DisplayUnit)}>
              <option value="mm">Millimetres (mm)</option>
              <option value="cm">Centimetres (cm)</option>
              <option value="in">Inches (in)</option>
            </select>
          </label>
          <label className="settings-row">
            <span><strong>Decimal places</strong><small>Controls displayed measurement precision</small></span>
            <select value={decimals} onChange={(e) => onDecimals(Number(e.target.value))}>
              {[0, 1, 2, 3].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="settings-row">
            <span><strong>Appearance</strong><small>Dark theme styling will be completed next</small></span>
            <select value={appearance} onChange={(e) => onAppearance(e.target.value as AppearancePreference)}>
              <option value="light">Light</option>
              <option value="dark" disabled>Dark (coming soon)</option>
              <option value="system" disabled>System (coming soon)</option>
            </select>
          </label>
        </div>
      </section>
    </div>
  );
}
