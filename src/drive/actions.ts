import { signIn } from "./auth";
import { syncNow } from "./sync";

/** The Connect button: ask Google for permission (a popup), then bring Drive and this browser level. */
export async function connectDrive(): Promise<void> {
  try {
    await signIn();
  } catch {
    return; // signIn has already recorded why in the Drive state
  }
  await syncNow();
}
