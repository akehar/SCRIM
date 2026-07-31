import AVFoundation
import ExpoModulesCore
import UIKit

// A reflected-light meter built on the camera's auto-exposure engine: while
// the session runs, iOS continuously solves exposure for the scene, and the
// solved ISO + shutter + aperture ARE the meter reading. Shown as a full-
// screen viewfinder so metering feels like pointing a real meter.
public final class ScrimMeterModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ScrimMeter")

    // Present the meter screen; resolves with the reading the user accepts,
    // rejects on cancel or when the camera is unavailable.
    AsyncFunction("meterShow") { (promise: Promise) in
      DispatchQueue.main.async { [weak self] in
        guard let host = self?.appContext?.utilities?.currentViewController() else {
          promise.reject("E_NO_UI", "No view controller to present from.")
          return
        }
        let vc = MeterViewController()
        vc.modalPresentationStyle = .fullScreen
        var settled = false
        vc.completion = { result in
          guard !settled else { return }
          settled = true
          switch result {
          case .success(let reading): promise.resolve(reading)
          case .failure(let err): promise.reject("E_METER", err.localizedDescription)
          }
        }
        host.present(vc, animated: true)
      }
    }
  }
}

private enum MeterError: LocalizedError {
  case cancelled
  case denied
  case camera(String)

  var errorDescription: String? {
    switch self {
    case .cancelled: return "Metering cancelled."
    case .denied: return "Camera access is off — enable it in Settings → Scrim."
    case .camera(let m): return m
    }
  }
}

final class MeterViewController: UIViewController {
  var completion: ((Result<[String: Any], Error>) -> Void)?

  private let session = AVCaptureSession()
  private var device: AVCaptureDevice?
  private var previewLayer: AVCaptureVideoPreviewLayer?
  private var timer: Timer?
  private var lastReading: [String: Any]?

  private let evLabel = UILabel()
  private let detailLabel = UILabel()
  private let panel = UIView()
  private let useButton = UIButton(type: .system)
  private let cancelButton = UIButton(type: .system)

  private let paper = UIColor(red: 0.953, green: 0.945, blue: 0.910, alpha: 1)
  private let ink = UIColor(red: 0.098, green: 0.098, blue: 0.075, alpha: 1)
  private let ochre = UIColor(red: 0.651, green: 0.271, blue: 0.176, alpha: 1)

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = ink

    panel.backgroundColor = paper
    view.addSubview(panel)

    evLabel.font = UIFont.monospacedSystemFont(ofSize: 44, weight: .medium)
    evLabel.textColor = ochre
    evLabel.textAlignment = .center
    evLabel.text = "—"
    panel.addSubview(evLabel)

    detailLabel.font = UIFont.monospacedSystemFont(ofSize: 12, weight: .regular)
    detailLabel.textColor = ink
    detailLabel.textAlignment = .center
    detailLabel.text = "point the camera at your subject"
    panel.addSubview(detailLabel)

    useButton.setTitle("USE READING", for: .normal)
    useButton.titleLabel?.font = UIFont.monospacedSystemFont(ofSize: 14, weight: .semibold)
    useButton.setTitleColor(paper, for: .normal)
    useButton.backgroundColor = ochre
    useButton.layer.cornerRadius = 24
    useButton.addTarget(self, action: #selector(usePressed), for: .touchUpInside)
    panel.addSubview(useButton)

    cancelButton.setTitle("✕", for: .normal)
    cancelButton.titleLabel?.font = UIFont.systemFont(ofSize: 22, weight: .medium)
    cancelButton.setTitleColor(paper, for: .normal)
    cancelButton.backgroundColor = ink.withAlphaComponent(0.6)
    cancelButton.layer.cornerRadius = 20
    cancelButton.addTarget(self, action: #selector(cancelPressed), for: .touchUpInside)
    view.addSubview(cancelButton)

    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      setupSession()
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
        DispatchQueue.main.async {
          granted ? self?.setupSession() : self?.finish(.failure(MeterError.denied))
        }
      }
    default:
      DispatchQueue.main.async { [weak self] in self?.finish(.failure(MeterError.denied)) }
    }
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    let safe = view.safeAreaInsets
    let panelH: CGFloat = 168 + safe.bottom
    panel.frame = CGRect(x: 0, y: view.bounds.height - panelH, width: view.bounds.width, height: panelH)
    previewLayer?.frame = CGRect(x: 0, y: 0, width: view.bounds.width, height: view.bounds.height - panelH)
    cancelButton.frame = CGRect(x: 16, y: safe.top + 8, width: 40, height: 40)
    evLabel.frame = CGRect(x: 0, y: 14, width: panel.bounds.width, height: 48)
    detailLabel.frame = CGRect(x: 12, y: 64, width: panel.bounds.width - 24, height: 18)
    useButton.frame = CGRect(x: 24, y: 94, width: panel.bounds.width - 48, height: 48)
  }

  private func setupSession() {
    guard let cam = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
      finish(.failure(MeterError.camera("No back camera available.")))
      return
    }
    do {
      session.sessionPreset = .medium
      let input = try AVCaptureDeviceInput(device: cam)
      guard session.canAddInput(input) else {
        finish(.failure(MeterError.camera("Could not attach the camera.")))
        return
      }
      session.addInput(input)
      try cam.lockForConfiguration()
      if cam.isExposureModeSupported(.continuousAutoExposure) {
        cam.exposureMode = .continuousAutoExposure
      }
      cam.unlockForConfiguration()
      device = cam

      let layer = AVCaptureVideoPreviewLayer(session: session)
      layer.videoGravity = .resizeAspectFill
      view.layer.insertSublayer(layer, at: 0)
      previewLayer = layer
      view.setNeedsLayout()

      DispatchQueue.global(qos: .userInitiated).async { [weak self] in
        self?.session.startRunning()
      }
      timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
        self?.sample()
      }
    } catch {
      finish(.failure(MeterError.camera(error.localizedDescription)))
    }
  }

  private func sample() {
    guard let d = device, session.isRunning else { return }
    let iso = Double(d.iso)
    let shutter = CMTimeGetSeconds(d.exposureDuration)
    let aperture = Double(d.lensAperture)
    guard iso > 0, shutter > 0, aperture > 0 else { return }
    let ev100 = log2((aperture * aperture) / shutter) - log2(iso / 100)
    lastReading = [
      "ev100": ev100,
      "iso": iso,
      "shutter": shutter,
      "aperture": aperture,
      "lux": 2.5 * pow(2, ev100),
    ]
    evLabel.text = String(format: "EV %.1f", ev100)
    let denom = shutter >= 1 ? String(format: "%.0fs", shutter) : "1/\(Int((1 / shutter).rounded()))"
    detailLabel.text = String(format: "ISO %.0f · %@ · f/%.1f", iso, denom, aperture)
  }

  @objc private func usePressed() {
    guard let reading = lastReading else { return }
    finish(.success(reading))
  }

  @objc private func cancelPressed() {
    finish(.failure(MeterError.cancelled))
  }

  private var done = false
  private func finish(_ result: Result<[String: Any], Error>) {
    guard !done else { return }
    done = true
    timer?.invalidate()
    timer = nil
    let s = session
    DispatchQueue.global(qos: .utility).async { s.stopRunning() }
    if presentingViewController != nil {
      dismiss(animated: true) { self.completion?(result) }
    } else {
      completion?(result)
    }
  }
}
