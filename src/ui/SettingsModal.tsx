import type { AppearancePreference, DisplayUnit } from "../measurement";

interface Props {
  open: boolean;
  unit: DisplayUnit;
  decimals: number;
  appearance: AppearancePreference;
  snapToGrid: boolean;
  snapToObjects: boolean;
  showSelectedCollisionContacts: boolean;
  onUnit: (unit: DisplayUnit) => void;
  onDecimals: (decimals: number) => void;
  onAppearance: (appearance: AppearancePreference) => void;
  onSnapToGrid: (enabled: boolean) => void;
  onSnapToObjects: (enabled: boolean) => void;
  onShowSelectedCollisionContacts: (enabled: boolean) => void;
  onClose: () => void;
}

export function SettingsModal({
  open,
  unit,
  decimals,
  appearance,
  snapToGrid,
  snapToObjects,
  showSelectedCollisionContacts,
  onUnit,
  onDecimals,
  onAppearance,
  onSnapToGrid,
  onSnapToObjects,
  onShowSelectedCollisionContacts,
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
          <label className="settings-row">
            <span><strong>Snap to grid</strong><small>Moves objects in 1 mm steps while dragging</small></span>
            <select value={snapToGrid ? "on" : "off"} onChange={(e) => onSnapToGrid(e.target.value === "on")}>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </label>
          <label className="settings-row">
            <span><strong>Snap to objects</strong><small>Aligns nearby object edges and shows Smart Guides</small></span>
            <select value={snapToObjects ? "on" : "off"} onChange={(e) => onSnapToObjects(e.target.value === "on")}>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </label>
          <label className="settings-row">
            <span><strong>Show selected collisions</strong><small>Keeps touching areas highlighted after selecting an object</small></span>
            <select value={showSelectedCollisionContacts ? "on" : "off"} onChange={(e) => onShowSelectedCollisionContacts(e.target.value === "on")}>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </label>
        </div>
      </section>
    </div>
  );
}
