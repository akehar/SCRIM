import { requireNativeModule } from "expo-modules-core";

// Resolve softly: absent on Android, in Expo Go, and in builds made before
// this module existed — the app must keep working without it.
let ScrimArSun = null;
try {
  ScrimArSun = requireNativeModule("ScrimArSun");
} catch {}

export default ScrimArSun;
