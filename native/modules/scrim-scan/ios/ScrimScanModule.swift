import ARKit
import ExpoModulesCore
import SceneKit
import UIKit
import simd

public final class ScrimScanModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ScrimScan")

    // LiDAR scene depth: iPhone 12 Pro and later Pro/Pro Max models.
    Function("isSupported") { () -> Bool in
      return ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
    }

    // Present the full-screen scan UI. Resolves with the finished scan's
    // file path and stats; rejects on cancel or failure.
    AsyncFunction("captureScan") { (promise: Promise) in
      DispatchQueue.main.async { [weak self] in
        guard ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) else {
          promise.reject("E_NO_LIDAR", "Scanning needs LiDAR (Pro-model iPhones).")
          return
        }
        guard let host = self?.appContext?.utilities?.currentViewController() else {
          promise.reject("E_NO_UI", "No view controller to present from.")
          return
        }
        let vc = ScanViewController()
        vc.modalPresentationStyle = .fullScreen
        var settled = false
        vc.completion = { result in
          guard !settled else { return }
          settled = true
          switch result {
          case .success(let info): promise.resolve(info)
          case .failure(let err): promise.reject("E_SCAN", err.localizedDescription)
          }
        }
        host.present(vc, animated: true)
      }
    }

    // The scan file is far too big for one bridge message — the shell streams
    // it into the WebView in slices. Returns "" past end of file.
    AsyncFunction("readScanChunk") { (path: String, offset: Double, length: Double) -> String in
      guard let handle = FileHandle(forReadingAtPath: path) else {
        throw NSError(domain: "ScrimScan", code: 1, userInfo: [NSLocalizedDescriptionKey: "scan file missing"])
      }
      defer { try? handle.close() }
      try handle.seek(toOffset: UInt64(offset))
      let data = try handle.read(upToCount: Int(length)) ?? Data()
      return data.base64EncodedString()
    }
  }
}

// MARK: - capture screen

private enum ScanError: LocalizedError {
  case cancelled
  case arkit(String)
  case empty

  var errorDescription: String? {
    switch self {
    case .cancelled: return "Scan cancelled."
    case .arkit(let m): return m
    case .empty: return "No points captured — move the phone slowly around the space."
    }
  }
}

final class ScanViewController: UIViewController, ARSessionDelegate {
  var completion: ((Result<[String: Any], Error>) -> Void)?

  private let arView = ARSCNView()
  private let counter = UILabel()
  private let hint = UILabel()
  private let doneButton = UIButton(type: .system)
  private let cancelButton = UIButton(type: .system)

  // Field Notes palette
  private let paper = UIColor(red: 0.953, green: 0.945, blue: 0.910, alpha: 1)
  private let ink = UIColor(red: 0.098, green: 0.098, blue: 0.075, alpha: 1)
  private let ochre = UIColor(red: 0.651, green: 0.271, blue: 0.176, alpha: 1)

  // point store: 2 cm voxel grid so a slow walk doesn't pile up duplicates
  private let processQueue = DispatchQueue(label: "scrim.scan.points")
  private var voxels: [SIMD3<Int32>: (p: SIMD3<Float>, c: SIMD3<UInt8>)] = [:]
  private var frameCount = 0
  private var finished = false
  private let maxPoints = 500_000
  private let voxelSize: Float = 0.02

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = ink

    arView.frame = view.bounds
    arView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    arView.automaticallyUpdatesLighting = true
    view.addSubview(arView)

    counter.font = UIFont.monospacedSystemFont(ofSize: 13, weight: .semibold)
    counter.textColor = paper
    counter.backgroundColor = ink.withAlphaComponent(0.65)
    counter.textAlignment = .center
    counter.layer.cornerRadius = 14
    counter.layer.masksToBounds = true
    counter.text = "  0 points  "
    view.addSubview(counter)

    hint.font = UIFont.monospacedSystemFont(ofSize: 11, weight: .regular)
    hint.textColor = paper
    hint.backgroundColor = ink.withAlphaComponent(0.5)
    hint.textAlignment = .center
    hint.numberOfLines = 0
    hint.text = "walk slowly · sweep the phone across every surface"
    view.addSubview(hint)

    doneButton.setTitle("DONE — BUILD SCENE", for: .normal)
    doneButton.titleLabel?.font = UIFont.monospacedSystemFont(ofSize: 14, weight: .semibold)
    doneButton.setTitleColor(paper, for: .normal)
    doneButton.backgroundColor = ochre
    doneButton.layer.cornerRadius = 24
    doneButton.addTarget(self, action: #selector(donePressed), for: .touchUpInside)
    view.addSubview(doneButton)

    cancelButton.setTitle("✕", for: .normal)
    cancelButton.titleLabel?.font = UIFont.systemFont(ofSize: 22, weight: .medium)
    cancelButton.setTitleColor(paper, for: .normal)
    cancelButton.backgroundColor = ink.withAlphaComponent(0.6)
    cancelButton.layer.cornerRadius = 20
    cancelButton.addTarget(self, action: #selector(cancelPressed), for: .touchUpInside)
    view.addSubview(cancelButton)
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    let safe = view.safeAreaInsets
    counter.frame = CGRect(x: (view.bounds.width - 170) / 2, y: safe.top + 10, width: 170, height: 28)
    cancelButton.frame = CGRect(x: 16, y: safe.top + 8, width: 40, height: 40)
    hint.frame = CGRect(x: 24, y: view.bounds.height - safe.bottom - 120, width: view.bounds.width - 48, height: 34)
    doneButton.frame = CGRect(x: 24, y: view.bounds.height - safe.bottom - 76, width: view.bounds.width - 48, height: 48)
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    let config = ARWorldTrackingConfiguration()
    config.frameSemantics = ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth)
      ? [.sceneDepth, .smoothedSceneDepth]
      : [.sceneDepth]
    config.environmentTexturing = .none
    arView.session.delegate = self
    arView.session.delegateQueue = processQueue
    arView.session.run(config)
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    arView.session.pause()
  }

  @objc private func cancelPressed() {
    guard !finished else { return }
    finished = true
    arView.session.pause()
    dismiss(animated: true) { self.completion?(.failure(ScanError.cancelled)) }
  }

  @objc private func donePressed() {
    guard !finished else { return }
    finished = true
    doneButton.isEnabled = false
    doneButton.setTitle("WRITING SCENE…", for: .normal)
    arView.session.pause()
    processQueue.async { [weak self] in
      guard let self else { return }
      let points = Array(self.voxels.values)
      guard !points.isEmpty else {
        DispatchQueue.main.async {
          self.dismiss(animated: true) { self.completion?(.failure(ScanError.empty)) }
        }
        return
      }
      do {
        let url = try Self.writeSplat(points: points)
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        let bytes = (attrs?[.size] as? Int) ?? 0
        DispatchQueue.main.async {
          self.dismiss(animated: true) {
            self.completion?(.success([
              "path": url.path,
              "points": points.count,
              "bytes": bytes,
            ]))
          }
        }
      } catch {
        DispatchQueue.main.async {
          self.dismiss(animated: true) { self.completion?(.failure(error)) }
        }
      }
    }
  }

  func session(_ session: ARSession, didFailWithError error: Error) {
    DispatchQueue.main.async {
      guard !self.finished else { return }
      self.finished = true
      self.dismiss(animated: true) { self.completion?(.failure(ScanError.arkit(error.localizedDescription))) }
    }
  }

  // MARK: point accumulation (runs on processQueue via session.delegateQueue)

  func session(_ session: ARSession, didUpdate frame: ARFrame) {
    guard !finished, voxels.count < maxPoints else { return }
    frameCount += 1
    guard frameCount % 4 == 0 else { return } // ~15 Hz capture is plenty
    guard let depth = frame.smoothedSceneDepth ?? frame.sceneDepth else { return }

    let depthMap = depth.depthMap
    let confMap = depth.confidenceMap
    let image = frame.capturedImage

    CVPixelBufferLockBaseAddress(depthMap, .readOnly)
    CVPixelBufferLockBaseAddress(image, .readOnly)
    if let confMap { CVPixelBufferLockBaseAddress(confMap, .readOnly) }
    defer {
      CVPixelBufferUnlockBaseAddress(depthMap, .readOnly)
      CVPixelBufferUnlockBaseAddress(image, .readOnly)
      if let confMap { CVPixelBufferUnlockBaseAddress(confMap, .readOnly) }
    }

    let dw = CVPixelBufferGetWidth(depthMap)
    let dh = CVPixelBufferGetHeight(depthMap)
    let dRow = CVPixelBufferGetBytesPerRow(depthMap)
    guard let dBase = CVPixelBufferGetBaseAddress(depthMap) else { return }

    let iw = CVPixelBufferGetWidth(image)
    let ih = CVPixelBufferGetHeight(image)
    guard let yBase = CVPixelBufferGetBaseAddressOfPlane(image, 0),
          let cBase = CVPixelBufferGetBaseAddressOfPlane(image, 1) else { return }
    let yRow = CVPixelBufferGetBytesPerRowOfPlane(image, 0)
    let cRow = CVPixelBufferGetBytesPerRowOfPlane(image, 1)

    var confBase: UnsafeMutableRawPointer? = nil
    var confRow = 0
    if let confMap {
      confBase = CVPixelBufferGetBaseAddress(confMap)
      confRow = CVPixelBufferGetBytesPerRow(confMap)
    }

    // intrinsics are for the full camera image; scale into depth-map pixels
    let K = frame.camera.intrinsics
    let fx = K[0][0], fy = K[1][1], cx = K[2][0], cy = K[2][1]
    let sx = Float(iw) / Float(dw)
    let sy = Float(ih) / Float(dh)
    let camToWorld = frame.camera.transform

    let inv = 1.0 / voxelSize
    for vy in stride(from: 0, to: dh, by: 2) {
      let dLine = dBase.advanced(by: vy * dRow).assumingMemoryBound(to: Float32.self)
      for vx in stride(from: 0, to: dw, by: 2) {
        if let confBase {
          let conf = confBase.advanced(by: vy * confRow).assumingMemoryBound(to: UInt8.self)[vx]
          if conf < 1 { continue } // ARConfidenceLevel.medium or better
        }
        let d = dLine[vx]
        guard d.isFinite, d > 0.2, d < 8.0 else { continue }

        // unproject through the scaled intrinsics; ARKit camera space is
        // +x right, +y up, +z toward the viewer, image origin top-left
        let ix = Float(vx) * sx
        let iy = Float(vy) * sy
        let xc = (ix - cx) * d / fx
        let yc = (iy - cy) * d / fy
        let world4 = camToWorld * SIMD4<Float>(xc, -yc, -d, 1)

        // splat space matches the viewer's convention: gravity along +Y
        let p = SIMD3<Float>(world4.x, -world4.y, -world4.z)
        let key = SIMD3<Int32>(Int32((p.x * inv).rounded()), Int32((p.y * inv).rounded()), Int32((p.z * inv).rounded()))
        if voxels[key] != nil { continue }

        // colour from the YCbCr camera image (full-range BT.601)
        let px = min(max(Int(ix), 0), iw - 1)
        let py = min(max(Int(iy), 0), ih - 1)
        let yv = Float(yBase.advanced(by: py * yRow).assumingMemoryBound(to: UInt8.self)[px])
        let cLine = cBase.advanced(by: (py / 2) * cRow).assumingMemoryBound(to: UInt8.self)
        let cb = Float(cLine[(px / 2) * 2]) - 128
        let cr = Float(cLine[(px / 2) * 2 + 1]) - 128
        let r = UInt8(max(0, min(255, yv + 1.402 * cr)))
        let g = UInt8(max(0, min(255, yv - 0.344136 * cb - 0.714136 * cr)))
        let b = UInt8(max(0, min(255, yv + 1.772 * cb)))

        voxels[key] = (p, SIMD3<UInt8>(r, g, b))
        if voxels.count >= maxPoints { break }
      }
    }

    let n = voxels.count
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.counter.text = n >= self.maxPoints ? "  scene full — hit done  " : "  \(n.formatted()) points  "
    }
  }

  // MARK: .splat encoding — 32 bytes/row: pos(3f) scale(3f) rgba(4b) rot(4b)

  private static func writeSplat(points: [(p: SIMD3<Float>, c: SIMD3<UInt8>)]) throws -> URL {
    var data = Data(capacity: points.count * 32)
    let scale: Float = 0.018 // slightly over the 2 cm voxel so points fuse
    for pt in points {
      withUnsafeBytes(of: pt.p.x.bitPattern.littleEndian) { data.append(contentsOf: $0) }
      withUnsafeBytes(of: pt.p.y.bitPattern.littleEndian) { data.append(contentsOf: $0) }
      withUnsafeBytes(of: pt.p.z.bitPattern.littleEndian) { data.append(contentsOf: $0) }
      for _ in 0..<3 {
        withUnsafeBytes(of: scale.bitPattern.littleEndian) { data.append(contentsOf: $0) }
      }
      data.append(contentsOf: [pt.c.x, pt.c.y, pt.c.z, 255])
      data.append(contentsOf: [255, 128, 128, 128]) // identity rotation
    }
    let stamp = ISO8601DateFormatter().string(from: Date())
      .replacingOccurrences(of: ":", with: "-")
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("scrim-scan-\(stamp).splat")
    try data.write(to: url)
    return url
  }
}
