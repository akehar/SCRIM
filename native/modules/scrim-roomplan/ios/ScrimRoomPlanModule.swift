import ARKit
import ExpoModulesCore
import RoomPlan
import UIKit
import simd

// RoomPlan capture: the user sweeps the room, Apple's scanner returns clean
// parametric geometry — walls, windows, doors, openings, furniture — which we
// serialize for the web viewer to trace sunlight through the real windows.
public final class ScrimRoomPlanModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ScrimRoomPlan")

    Function("isSupported") { () -> Bool in
      return RoomCaptureSession.isSupported
    }

    // Presents the RoomPlan capture UI; resolves with the serialized room.
    AsyncFunction("capture") { (promise: Promise) in
      DispatchQueue.main.async { [weak self] in
        guard RoomCaptureSession.isSupported else {
          promise.reject("E_NO_ROOMPLAN", "Room capture needs a LiDAR iPhone (Pro models).")
          return
        }
        guard let host = self?.appContext?.utilities?.currentViewController() else {
          promise.reject("E_NO_UI", "No view controller to present from.")
          return
        }
        let vc = RoomScanViewController()
        vc.modalPresentationStyle = .fullScreen
        var settled = false
        vc.completion = { result in
          guard !settled else { return }
          settled = true
          switch result {
          case .success(let room): promise.resolve(room)
          case .failure(let err): promise.reject("E_ROOMSCAN", err.localizedDescription)
          }
        }
        host.present(vc, animated: true)
      }
    }
  }
}

private enum RoomScanError: LocalizedError {
  case cancelled
  case failed(String)

  var errorDescription: String? {
    switch self {
    case .cancelled: return "Room scan cancelled."
    case .failed(let m): return m
    }
  }
}

final class RoomScanViewController: UIViewController, RoomCaptureViewDelegate {
  var completion: ((Result<[String: Any], Error>) -> Void)?

  private var captureView: RoomCaptureView!
  private let doneButton = UIButton(type: .system)
  private let cancelButton = UIButton(type: .system)
  private var stopping = false

  private let paper = UIColor(red: 0.953, green: 0.945, blue: 0.910, alpha: 1)
  private let ink = UIColor(red: 0.098, green: 0.098, blue: 0.075, alpha: 1)
  private let ochre = UIColor(red: 0.651, green: 0.271, blue: 0.176, alpha: 1)

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = ink

    captureView = RoomCaptureView(frame: view.bounds)
    captureView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    captureView.delegate = self
    view.addSubview(captureView)

    doneButton.setTitle("DONE — BUILD ROOM", for: .normal)
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
    cancelButton.frame = CGRect(x: 16, y: safe.top + 8, width: 40, height: 40)
    doneButton.frame = CGRect(x: 24, y: view.bounds.height - safe.bottom - 64, width: view.bounds.width - 48, height: 48)
    view.bringSubviewToFront(doneButton)
    view.bringSubviewToFront(cancelButton)
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    captureView.captureSession.run(configuration: RoomCaptureSession.Configuration())
  }

  @objc private func donePressed() {
    guard !stopping else { return }
    stopping = true
    doneButton.isEnabled = false
    doneButton.setTitle("BUILDING ROOM…", for: .normal)
    captureView.captureSession.stop()
  }

  @objc private func cancelPressed() {
    captureView.captureSession.stop(pauseARSession: true)
    dismiss(animated: true) { self.completion?(.failure(RoomScanError.cancelled)) }
  }

  // MARK: RoomCaptureViewDelegate — let RoomPlan post-process, then take the result

  func captureView(shouldPresent roomDataForProcessing: CapturedRoomData, error: Error?) -> Bool {
    return true
  }

  func captureView(didPresent processedResult: CapturedRoom, error: Error?) {
    if let error {
      dismiss(animated: true) { self.completion?(.failure(RoomScanError.failed(error.localizedDescription))) }
      return
    }
    let room = Self.serialize(processedResult)
    dismiss(animated: true) { self.completion?(.success(room)) }
  }

  // MARK: serialization — metres, y up, column-major transforms

  private static func surf(_ s: CapturedRoom.Surface) -> [String: Any] {
    var t: [Double] = []
    for c in 0..<4 {
      let col = s.transform[c]
      t.append(contentsOf: [Double(col.x), Double(col.y), Double(col.z), Double(col.w)])
    }
    return [
      "w": Double(s.dimensions.x),
      "h": Double(s.dimensions.y),
      "transform": t,
    ]
  }

  private static func serialize(_ room: CapturedRoom) -> [String: Any] {
    let objects: [[String: Any]] = room.objects.map { o in
      var t: [Double] = []
      for c in 0..<4 {
        let col = o.transform[c]
        t.append(contentsOf: [Double(col.x), Double(col.y), Double(col.z), Double(col.w)])
      }
      return [
        "category": String(describing: o.category),
        "w": Double(o.dimensions.x),
        "h": Double(o.dimensions.y),
        "d": Double(o.dimensions.z),
        "transform": t,
      ]
    }
    return [
      "walls": room.walls.map(surf),
      "windows": room.windows.map(surf),
      "doors": room.doors.map(surf),
      "openings": room.openings.map(surf),
      "objects": objects,
    ]
  }
}
