import { requireNativeModule } from "expo-modules-core";

// Resolve softly: absent on Android, in Expo Go, and in builds made before
// this module existed — the app must keep working without it.
let ScrimMeter = null;
try {
  ScrimMeter = requireNativeModule("ScrimMeter");
} catch {}

export default ScrimMeter;
