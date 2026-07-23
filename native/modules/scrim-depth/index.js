import { requireNativeModule } from "expo-modules-core";

// Resolve softly: on Android, in Expo Go, or in a build made before this
// module existed, the native side is absent and the app must keep working.
let ScrimDepth = null;
try {
  ScrimDepth = requireNativeModule("ScrimDepth");
} catch {}

export default ScrimDepth;
