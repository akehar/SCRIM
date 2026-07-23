import ARKit
import CoreImage
import ExpoModulesCore
import UIKit

public final class ScrimDepthModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ScrimDepth")

    // LiDAR scene depth: iPhone 12 Pro and later Pro/Pro Max models.
    Function("isSupported") { () -> Bool in
      return ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
    }

    // One shot: start an AR session, let exposure and depth settle for a few
    // frames, then hand back the camera image (JPEG) and the depth map (PNG,
    // brighter = nearer — the same convention as the studio's AI depth).
    AsyncFunction("captureDepthShot") { (promise: Promise) in
      DispatchQueue.main.async {
        DepthShot.begin(promise: promise)
      }
    }
  }
}

private final class DepthShot: NSObject, ARSessionDelegate {
  // Keep the in-flight capture alive; ARSession does not retain its delegate.
  private static var active: DepthShot?

  private let session = ARSession()
  private let promise: Promise
  private var frameCount = 0
  private var done = false

  static func begin(promise: Promise) {
    guard ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) else {
      promise.reject("E_NO_LIDAR", "This device has no LiDAR scene depth (Pro models only).")
      return
    }
    guard active == nil else {
      promise.reject("E_BUSY", "A depth capture is already running.")
      return
    }
    let shot = DepthShot(promise: promise)
    active = shot
    shot.start()
  }

  private init(promise: Promise) {
    self.promise = promise
    super.init()
  }

  private func start() {
    let config = ARWorldTrackingConfiguration()
    config.frameSemantics = ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth)
      ? [.sceneDepth, .smoothedSceneDepth]
      : [.sceneDepth]
    session.delegate = self
    session.run(config)

    DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
      self?.finish(error: ("E_TIMEOUT", "LiDAR capture timed out — try again in better light."))
    }
  }

  func session(_ session: ARSession, didUpdate frame: ARFrame) {
    guard !done else { return }
    frameCount += 1
    // ~0.6 s of frames lets auto-exposure and the depth filter settle.
    guard frameCount >= 18 else { return }
    guard let depth = frame.smoothedSceneDepth ?? frame.sceneDepth else { return }
    done = true

    let capturedImage = frame.capturedImage
    let depthMap = depth.depthMap
    session.pause()

    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      guard let self else { return }
      do {
        let photo = try Self.jpegDataURL(from: capturedImage)
        let (depthURL, near, far) = try Self.depthPNGDataURL(from: depthMap)
        self.resolve([
          "photo": photo,
          "depth": depthURL,
          "nearMeters": near,
          "farMeters": far,
        ])
      } catch {
        self.rejectNow("E_CONVERT", "Could not convert the capture: \(error.localizedDescription)")
      }
    }
  }

  func session(_ session: ARSession, didFailWithError error: Error) {
    finish(error: ("E_ARKIT", error.localizedDescription))
  }

  // MARK: - completion plumbing (each capture resolves or rejects exactly once)

  private var settled = false
  private func resolve(_ value: [String: Any]) {
    DispatchQueue.main.async {
      guard !self.settled else { return }
      self.settled = true
      self.promise.resolve(value)
      Self.active = nil
    }
  }

  private func rejectNow(_ code: String, _ message: String) {
    DispatchQueue.main.async {
      guard !self.settled else { return }
      self.settled = true
      self.promise.reject(code, message)
      Self.active = nil
    }
  }

  private func finish(error: (String, String)) {
    guard !settled else { return }
    done = true
    session.pause()
    rejectNow(error.0, error.1)
  }

  // MARK: - conversions

  // The AR camera streams landscape; the app is portrait — rotate both outputs.
  private static let ciContext = CIContext()

  private static func jpegDataURL(from pixelBuffer: CVPixelBuffer) throws -> String {
    let image = CIImage(cvPixelBuffer: pixelBuffer).oriented(.right)
    guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
          let data = ciContext.jpegRepresentation(of: image, colorSpace: colorSpace)
    else { throw NSError(domain: "ScrimDepth", code: 1, userInfo: [NSLocalizedDescriptionKey: "JPEG encode failed"]) }
    return "data:image/jpeg;base64," + data.base64EncodedString()
  }

  private static func depthPNGDataURL(from depthMap: CVPixelBuffer) throws -> (String, Double, Double) {
    CVPixelBufferLockBaseAddress(depthMap, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(depthMap, .readOnly) }

    let width = CVPixelBufferGetWidth(depthMap)
    let height = CVPixelBufferGetHeight(depthMap)
    let rowBytes = CVPixelBufferGetBytesPerRow(depthMap)
    guard let base = CVPixelBufferGetBaseAddress(depthMap) else {
      throw NSError(domain: "ScrimDepth", code: 2, userInfo: [NSLocalizedDescriptionKey: "depth buffer unreadable"])
    }

    // Metres → disparity, then percentile-normalise so one distant outlier
    // can't flatten the whole map. Brighter = nearer.
    var disparity = [Float](repeating: 0, count: width * height)
    var finite: [Float] = []
    finite.reserveCapacity(width * height)
    var nearM: Float = .greatestFiniteMagnitude
    var farM: Float = 0
    for y in 0..<height {
      let row = base.advanced(by: y * rowBytes).assumingMemoryBound(to: Float32.self)
      for x in 0..<width {
        let metres = row[x]
        let d: Float = (metres.isFinite && metres > 0.01) ? 1.0 / metres : 0
        disparity[y * width + x] = d
        if d > 0 {
          finite.append(d)
          nearM = min(nearM, metres)
          farM = max(farM, metres)
        }
      }
    }
    guard !finite.isEmpty else {
      throw NSError(domain: "ScrimDepth", code: 3, userInfo: [NSLocalizedDescriptionKey: "no depth returned — point at a scene, not the sky"])
    }
    finite.sort()
    let lo = finite[Int(Float(finite.count - 1) * 0.02)]
    let hi = finite[Int(Float(finite.count - 1) * 0.98)]
    let span = max(hi - lo, 1e-6)

    var gray = [UInt8](repeating: 0, count: width * height)
    for i in 0..<(width * height) {
      let v = (disparity[i] - lo) / span
      gray[i] = UInt8(max(0, min(255, v * 255)))
    }

    guard let graySpace = CGColorSpace(name: CGColorSpace.linearGray) else {
      throw NSError(domain: "ScrimDepth", code: 4, userInfo: [NSLocalizedDescriptionKey: "gray colorspace unavailable"])
    }
    let cgImage: CGImage? = gray.withUnsafeMutableBytes { ptr in
      guard let ctx = CGContext(
        data: ptr.baseAddress, width: width, height: height,
        bitsPerComponent: 8, bytesPerRow: width, space: graySpace,
        bitmapInfo: CGImageAlphaInfo.none.rawValue
      ) else { return nil }
      return ctx.makeImage()
    }
    guard let grayCG = cgImage else {
      throw NSError(domain: "ScrimDepth", code: 5, userInfo: [NSLocalizedDescriptionKey: "depth image build failed"])
    }

    let rotated = CIImage(cgImage: grayCG).oriented(.right)
    guard let outCG = ciContext.createCGImage(rotated, from: rotated.extent),
          let png = UIImage(cgImage: outCG).pngData()
    else { throw NSError(domain: "ScrimDepth", code: 6, userInfo: [NSLocalizedDescriptionKey: "PNG encode failed"]) }

    return ("data:image/png;base64," + png.base64EncodedString(), Double(nearM), Double(farM))
  }
}
