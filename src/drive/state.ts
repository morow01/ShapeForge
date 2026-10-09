import { create } from "zustand";
import { driveConfigured } from "./config";

export type DriveStatus = "signedOut" | "connecting" | "signedIn";

type DriveState = {
  /** Whether a Google client ID has been set up at all. */
  configured: boolean;
  status: DriveStatus;
  email: string | null;
  /** Something is being sent to or fetched from Drive right now. */
  busy: boolean;
  lastError: string | null;
  lastSyncAt: number | null;
  setConfigured: (value: boolean) => void;
  setStatus: (status: DriveStatus, email?: string | null) => void;
  setBusy: (busy: boolean) => void;
  setError: (message: string | null) => void;
  markSynced: () => void;
};

export const useDrive = create<DriveState>((set) => ({
  configured: driveConfigured(),
  status: "signedOut",
  email: null,
  busy: false,
  lastError: null,
  lastSyncAt: null,
  setConfigured: (configured) => set({ configured }),
  setStatus: (status, email) => set((s) => ({ status, email: email === undefined ? s.email : email })),
  setBusy: (busy) => set({ busy }),
  setError: (lastError) => set({ lastError }),
  markSynced: () => set({ lastSyncAt: Date.now(), lastError: null }),
}));
