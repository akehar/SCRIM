import AVFoundation
import ExpoModulesCore

// A reflected-light meter built on the camera's auto-exposure engine: while
// the session runs, iOS continuously solves exposure for the scene, and the
// solved ISO + shutter + aperture ARE the meter reading.
public final class ScrimMeterModule: Module {
  private var session: AVCaptureSession?
  private var device: AVCaptureDevice?

  public func definition() -> ModuleDefinition {
    Name("ScrimMeter")

    AsyncFunction("start") { (promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async { [weak self] in
        guard let self else { return }
        if self.session != nil {
          promise.resolve(true)
          return
        }
        guard let cam = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
          promise.reject("E_NO_CAMERA", "No back camera available.")
          return
        }
        do {
          let s = AVCaptureSession()
          s.sessionPreset = .medium
          let input = try AVCaptureDeviceInput(device: cam)
          guard s.canAddInput(input) else {
            promise.reject("E_SESSION", "Could not attach the camera.")
            return
          }
          s.addInput(input)
          // an output keeps the pipeline (and auto-exposure) running
          let out = AVCaptureVideoDataOutput()
          if s.canAddOutput(out) { s.addOutput(out) }
          try cam.lockForConfiguration()
          if cam.isExposureModeSupported(.continuousAutoExposure) {
            cam.exposureMode = .continuousAutoExposure
          }
          cam.unlockForConfiguration()
          s.startRunning()
          self.session = s
          self.device = cam
          promise.resolve(true)
        } catch {
          promise.reject("E_SESSION", error.localizedDescription)
        }
      }
    }

    // One sample of the AE solution; the page polls this a few times a second.
    Function("read") { () -> [String: Any] in
      guard let d = self.device, self.session?.isRunning == true else {
        return ["running": false]
      }
      let shutter = CMTimeGetSeconds(d.exposureDuration)
      return [
        "running": true,
        "iso": Double(d.iso),
        "shutter": shutter,
        "aperture": Double(d.lensAperture),
        "bias": Double(d.exposureTargetBias),
        "offset": Double(d.exposureTargetOffset),
      ]
    }

    AsyncFunction("stop") { () in
      let s = self.session
      self.session = nil
      self.device = nil
      DispatchQueue.global(qos: .utility).async {
        s?.stopRunning()
      }
    }

    OnDestroy {
      let s = self.session
      self.session = nil
      self.device = nil
      DispatchQueue.global(qos: .utility).async { s?.stopRunning() }
    }
  }
}
