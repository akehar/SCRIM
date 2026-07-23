import { useRef, useState, useCallback, useEffect } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { WebView } from "react-native-webview";
import ScrimDepth from "./modules/scrim-depth";
import ScrimScan from "./modules/scrim-scan";

// LiDAR features: present on iPhone 12 Pro and later Pro models. The page
// reads these flags from window.__SCRIM_NATIVE__ to show its buttons.
const DEPTH_SUPPORTED = (() => {
  try {
    return Platform.OS === "ios" && Boolean(ScrimDepth?.isSupported());
  } catch {
    return false;
  }
})();
const SCAN_SUPPORTED = (() => {
  try {
    return Platform.OS === "ios" && Boolean(ScrimScan?.isSupported());
  } catch {
    return false;
  }
})();

// The native shell hosts the live web app: every deploy to Render updates
// this app instantly, no App Store release needed. Native capabilities
// (LiDAR depth, ARKit capture, push) get added here as modules and exposed
// to the page through window.__SCRIM_NATIVE__ + postMessage.
const APP_URL = "https://scrim-backend-wxcn.onrender.com";

const PAPER = "#F3F1E8";
const INK = "#191913";
const OCHRE = "#A6452D";
const MUTED = "#5C5B50";

export default function App() {
  return (
    <SafeAreaProvider>
      <Shell />
    </SafeAreaProvider>
  );
}

function Shell() {
  const webRef = useRef(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  // Keep Scrim inside the shell; hand every other domain to Safari
  // (OpenStreetMap attribution, Clerk account pages, etc.).
  const routeRequest = useCallback((req) => {
    if (req.url.startsWith(APP_URL) || req.url.startsWith("about:")) return true;
    Linking.openURL(req.url).catch(() => {});
    return false;
  }, []);

  const retry = useCallback(() => {
    setFailed(false);
    setLoading(true);
    webRef.current?.reload();
  }, []);

  // Render's free tier sleeps the server after a quiet spell and answers
  // 5xx while it wakes (~30-60s). Keep knocking on its own instead of
  // making the user mash TRY AGAIN.
  useEffect(() => {
    if (!failed) return;
    const t = setTimeout(retry, 10000);
    return () => clearTimeout(t);
  }, [failed, retry]);

  // Native bridge: the page posts { type, id } and gets the reply through
  // window.__scrimNativeResolve. Big payloads (room scans) stream back in
  // slices through window.__scrimScanChunk.
  const onMessage = useCallback(async (e) => {
    let msg;
    try {
      msg = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    if (!msg || msg.id == null) return;
    const resolve = (reply) => {
      webRef.current?.injectJavaScript(
        `window.__scrimNativeResolve && window.__scrimNativeResolve(${JSON.stringify(reply)}); true;`
      );
    };

    if (msg.type === "captureDepthShot") {
      try {
        if (!ScrimDepth) throw new Error("LiDAR capture needs an app update.");
        const shot = await ScrimDepth.captureDepthShot();
        resolve({ id: msg.id, ok: true, ...shot });
      } catch (err) {
        resolve({ id: msg.id, ok: false, error: String(err?.message || err) });
      }
    }

    if (msg.type === "captureScan") {
      try {
        if (!ScrimScan) throw new Error("Room scanning needs an app update.");
        const scan = await ScrimScan.captureScan();
        // stream the .splat into the page: ~1.5 MB of binary per slice
        const CHUNK = 1.5 * 1024 * 1024;
        let offset = 0;
        let seq = 0;
        for (;;) {
          const b64 = await ScrimScan.readScanChunk(scan.path, offset, CHUNK);
          if (!b64) break;
          webRef.current?.injectJavaScript(
            `window.__scrimScanChunk && window.__scrimScanChunk(${JSON.stringify({ id: msg.id, seq, b64 })}); true;`
          );
          offset += CHUNK;
          seq += 1;
        }
        resolve({ id: msg.id, ok: true, points: scan.points, bytes: scan.bytes, chunks: seq });
      } catch (err) {
        resolve({ id: msg.id, ok: false, error: String(err?.message || err) });
      }
    }
  }, []);

  return (
    <SafeAreaView style={styles.root} edges={["top", "left", "right"]}>
      <StatusBar style="dark" backgroundColor={PAPER} />
      {/* The WebView stays mounted through failures so reload() has
          something to reload; the fallback overlays it. */}
      <WebView
        ref={webRef}
        source={{ uri: APP_URL }}
        style={styles.web}
        // camera viewfinder + AR overlay
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        mediaCapturePermissionGrantType="grant"
        // sun math needs the phone's position
        geolocationEnabled
        // feel like an app, not a browser
        allowsBackForwardNavigationGestures
        bounces={false}
        setSupportMultipleWindows={false}
        onShouldStartLoadWithRequest={routeRequest}
        onError={() => setFailed(true)}
        onHttpError={(e) => {
          if (e.nativeEvent.statusCode >= 500) setFailed(true);
        }}
        onLoadEnd={() => setLoading(false)}
        injectedJavaScriptBeforeContentLoaded={`window.__SCRIM_NATIVE__ = { platform: "ios", shell: 1, depth: ${DEPTH_SUPPORTED ? 1 : 0}, scan: ${SCAN_SUPPORTED ? 1 : 0} }; true;`}
        onMessage={onMessage}
      />
      {failed && (
        <View style={styles.fallback}>
          <Text style={styles.title}>Scrim</Text>
          <Text style={styles.body}>
            Waking up the set — the server naps after a quiet spell and can
            take up to a minute to answer. Retrying on its own; sit tight.
          </Text>
          <Pressable style={styles.btn} onPress={retry}>
            <Text style={styles.btnLabel}>TRY NOW</Text>
          </Pressable>
        </View>
      )}
      {loading && !failed && (
        <View style={styles.loader} pointerEvents="none">
          <ActivityIndicator color={OCHRE} size="large" />
          <Text style={styles.loaderLabel}>READING THE LIGHT</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: PAPER },
  web: { flex: 1, backgroundColor: PAPER },
  loader: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: PAPER,
  },
  loaderLabel: {
    marginTop: 14,
    color: MUTED,
    fontSize: 11,
    letterSpacing: 2.2,
  },
  fallback: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "flex-start",
    justifyContent: "center",
    paddingHorizontal: 32,
    backgroundColor: PAPER,
  },
  title: { fontSize: 34, fontWeight: "600", color: INK, marginBottom: 12 },
  body: { fontSize: 15, lineHeight: 22, color: MUTED, marginBottom: 24 },
  btn: {
    borderWidth: 1.5,
    borderColor: INK,
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 22,
  },
  btnLabel: { color: INK, fontSize: 12, letterSpacing: 1.6, fontWeight: "600" },
});
