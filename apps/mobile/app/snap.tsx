/**
 * Snap a receipt (V1, H2). Full-screen camera with a frame guide; it snaps by itself when the phone is held
 * still (accelerometer), or on the shutter, or through the phone's edge-detecting document scanner. The photo
 * is compressed, hashed and queued on the phone first, then uploaded; the receipt card opens at once.
 * Without a camera (simulator, permission refused) the bundled sample receipt stands in, so the flow still runs.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Image, Platform, Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Accelerometer } from "expo-sensors";
import { useReceiptQueue } from "@/receipts/ReceiptQueueProvider";
import { SteadyDetector } from "@/receipts/steady";
import { env } from "@/lib/env";
import { useToast } from "@/ui/Toast";
import { LIGHT } from "@/ui/theme";

const SAMPLE = require("../assets/sample-receipt.jpg") as number;
const CAM = { bg: "#0E130F", fg: "#FFFFFF", hint: "#D7DDD0" };

type Mode = "checking" | "camera" | "sample" | "denied";

export default function Snap(): React.JSX.Element {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queue = useReceiptQueue();
  const { show: toast } = useToast();
  const [permission, requestPermission] = useCameraPermissions();
  const [mode, setMode] = useState<Mode>("checking");
  const [ready, setReady] = useState(false);
  const [auto, setAuto] = useState(true);
  const [busy, setBusy] = useState(false);
  const camera = useRef<CameraView>(null);
  const captured = useRef(false);

  // Permission: ask once; a refusal falls back to the sample in mock mode, or explains in http mode.
  useEffect(() => {
    if (!permission) return;
    if (permission.granted) {
      setMode("camera");
      return;
    }
    if (permission.canAskAgain) {
      void requestPermission().then((r) => setMode(r.granted ? "camera" : env.apiMode === "mock" ? "sample" : "denied"));
    } else {
      setMode(env.apiMode === "mock" ? "sample" : "denied");
    }
  }, [permission, requestPermission]);

  const finish = useCallback(
    async (src: { uri: string; width?: number; height?: number }) => {
      if (captured.current) return;
      captured.current = true;
      setBusy(true);
      try {
        const r = await queue.snap(src);
        if (!r.added) toast("You already snapped this one.");
        router.replace({ pathname: "/receipt/[clientId]", params: { clientId: r.item.clientId } });
      } catch (err) {
        captured.current = false;
        setBusy(false);
        toast(err instanceof Error && err.message ? `Couldn't save the photo: ${err.message}` : "Couldn't save the photo. Try again.");
      }
    },
    [queue, router, toast],
  );

  const takeSample = useCallback(() => {
    const asset = Image.resolveAssetSource(SAMPLE);
    if (!asset) return;
    void finish({ uri: asset.uri, ...(asset.width ? { width: asset.width } : {}), ...(asset.height ? { height: asset.height } : {}) });
  }, [finish]);

  const shutter = useCallback(async () => {
    if (busy) return;
    if (mode !== "camera" || !camera.current) {
      takeSample();
      return;
    }
    try {
      const photo = await camera.current.takePictureAsync({ quality: 0.9, exif: false, shutterSound: false });
      await finish({ uri: photo.uri, width: photo.width, height: photo.height });
    } catch (err) {
      // No camera on this device (simulator): the sample receipt stands in so the flow still works.
      if (env.apiMode === "mock") takeSample();
      else toast(err instanceof Error && err.message ? err.message : "The camera didn't answer. Try again.");
    }
  }, [busy, mode, finish, takeSample, toast]);

  const scanWithEdges = useCallback(async () => {
    if (busy) return;
    try {
      const r = await CameraView.scanDocumentAsync({ quality: 0.9 });
      const page = r?.pages[0];
      if (page) await finish({ uri: page });
    } catch {
      toast("The document scanner isn't available on this phone. Use the shutter instead.");
    }
  }, [busy, finish, toast]);

  // Auto-shutter: hold still for about a second once the camera is up.
  useEffect(() => {
    if (!auto || !ready || mode !== "camera" || busy) return;
    let sub: { remove(): void } | undefined;
    let cancelled = false;
    void Accelerometer.isAvailableAsync().then((ok) => {
      if (!ok || cancelled) return;
      const detector = new SteadyDetector(Date.now());
      Accelerometer.setUpdateInterval(100);
      sub = Accelerometer.addListener((m) => {
        if (detector.sample(m, Date.now())) void shutter();
      });
    });
    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [auto, ready, mode, busy, shutter]);

  // Sample mode (no camera): snap by itself after a moment, like the prototype, unless Auto is off.
  useEffect(() => {
    if (mode !== "sample" || !auto) return;
    const t = setTimeout(() => void shutter(), 2600);
    return () => clearTimeout(t);
  }, [mode, auto, shutter]);

  return (
    <View testID="snap" accessibilityViewIsModal style={{ flex: 1, backgroundColor: CAM.bg, paddingTop: insets.top }}>
      <Text style={{ textAlign: "center", fontSize: 14, color: CAM.hint, paddingHorizontal: 16, paddingTop: 12 }}>
        {mode === "denied" ? "Homestead needs the camera to snap receipts. Turn it on in Settings › Homestead." : auto ? "Hold the receipt in the frame. It snaps by itself when it's steady." : "Hold the receipt in the frame and tap the shutter."}
      </Text>
      <View style={{ flex: 1, margin: 16, borderRadius: 16, overflow: "hidden", backgroundColor: "#000", alignItems: "center", justifyContent: "center" }}>
        {mode === "camera" && (
          <CameraView
            ref={camera}
            style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
            facing="back"
            onCameraReady={() => setReady(true)}
            onMountError={() => setMode(env.apiMode === "mock" ? "sample" : "denied")}
            animateShutter={false}
            testID="camera-view"
          />
        )}
        {mode === "sample" && <Image source={SAMPLE} accessibilityLabel="Sample receipt" style={{ width: "70%", height: "80%", borderRadius: 4, transform: [{ rotate: "-2deg" }] }} resizeMode="contain" />}
        {mode === "checking" && <Text style={{ color: CAM.hint }}>Opening the camera…</Text>}
        <View pointerEvents="none" style={{ position: "absolute", top: "12%", bottom: "12%", left: "10%", right: "10%", borderWidth: 2, borderColor: "rgba(255,255,255,0.7)", borderRadius: 12 }} />
        {busy && (
          <View style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center" }}>
            <Text style={{ color: CAM.fg, fontWeight: "600" }}>Saving…</Text>
          </View>
        )}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 10, paddingBottom: 24 + insets.bottom, gap: 12 }}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Cancel" testID="snap-cancel" style={{ minHeight: 44, minWidth: 80, justifyContent: "center" }}>
          <Text style={{ color: CAM.fg, fontWeight: "600", fontSize: 15 }}>Cancel</Text>
        </Pressable>
        <Pressable
          onPress={() => void shutter()}
          disabled={busy || mode === "denied" || mode === "checking"}
          accessibilityRole="button"
          accessibilityLabel="Take the photo"
          testID="shutter"
          style={({ pressed }) => ({ width: 72, height: 72, borderRadius: 36, backgroundColor: CAM.fg, borderWidth: 6, borderColor: "rgba(255,255,255,0.4)", opacity: pressed ? 0.8 : busy || mode === "denied" || mode === "checking" ? 0.5 : 1 })}
        />
        <View style={{ minWidth: 80, alignItems: "flex-end", gap: 6 }}>
          {mode === "camera" && Platform.OS !== "web" && (
            <Pressable onPress={() => void scanWithEdges()} accessibilityRole="button" accessibilityLabel="Scan with edge detection" style={{ minHeight: 44, justifyContent: "center" }}>
              <Text style={{ color: CAM.fg, fontWeight: "600", fontSize: 15 }}>Scan edges</Text>
            </Pressable>
          )}
          <Pressable onPress={() => setAuto((a) => !a)} accessibilityRole="switch" accessibilityState={{ checked: auto }} accessibilityLabel="Snap by itself when steady" style={{ minHeight: 44, justifyContent: "center" }}>
            <Text style={{ color: auto ? LIGHT.wheat : CAM.hint, fontWeight: "600", fontSize: 13 }}>{auto ? "Auto: on" : "Auto: off"}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}
