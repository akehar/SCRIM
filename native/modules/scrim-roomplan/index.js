import { requireNativeModule } from "expo-modules-core";

// Resolve softly: absent on Android, in Expo Go, non-LiDAR phones, and in
// builds made before this module existed.
let ScrimRoomPlan = null;
try {
  ScrimRoomPlan = requireNativeModule("ScrimRoomPlan");
} catch {}

export default ScrimRoomPlan;
