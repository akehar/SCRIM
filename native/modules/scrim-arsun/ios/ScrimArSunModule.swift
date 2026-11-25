import ARKit
import ExpoModulesCore
import SceneKit
import UIKit
import simd

// The day's sun path drawn through the real location: an AR session aligned
// to gravity + compass heading, so an azimuth/altitude from the sun math maps
// directly to a world direction. The page supplies the precomputed path.
public final class ScrimArSunModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ScrimArSun")

    Function("isSupported") { () -> Bool in
      return ARWorldTrackingConfiguration.isSupported
    }

    // payload: { points: [{az, alt, label?, golden?}], now: {az, alt} }
    // Resolves when the user closes the view.
    AsyncFunction("show") { (payload: [String: Any], promise: Promise) in
      DispatchQueue.main.async { [weak self] in
        guard ARWorldTrackingConfiguration.isSupported else {
          promise.reject("E_NO_AR", "AR is not available on this device.")
          return
        }
        guard let host = self?.appContext?.utilities?.currentViewController() else {
          promise.reject("E_NO_UI", "No view controller to present from.")
          return
        }
        let vc = ArSunViewController(payload: payload)
        vc.modalPresentationStyle = .fullScreen
        var settled = false
        vc.completion = {
          guard !settled else { return }
          settled = true
          promise.resolve(true)
        }
        host.present(vc, animated: true)
      }
    }
  }
}

final class ArSunViewController: UIViewController, ARSessionDelegate {
  var completion: (() -> Void)?

  private let payload: [String: Any]
  private let arView = ARSCNView()
  private let hint = UILabel()
  private let closeButton = UIButton(type: .system)
  private var built = false

  private let paper = UIColor(red: 0.953, green: 0.945, blue: 0.910, alpha: 1)
  private let ink = UIColor(red: 0.098, green: 0.098, blue: 0.075, alpha: 1)
  private let ochre = UIColor(red: 0.651, green: 0.271, blue: 0.176, alpha: 1)
  private let gold = UIColor(red: 0.910, green: 0.722, blue: 0.294, alpha: 1)

  init(payload: [String: Any]) {
    self.payload = payload
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = ink

    arView.frame = view.bounds
    arView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    arView.automaticallyUpdatesLighting = true
    view.addSubview(arView)

    hint.font = UIFont.monospacedSystemFont(ofSize: 11.5, weight: .semibold)
    hint.textColor = paper
    hint.backgroundColor = ink.withAlphaComponent(0.55)
    hint.textAlignment = .center
    hint.numberOfLines = 0
    hint.layer.cornerRadius = 12
    hint.layer.masksToBounds = true
    hint.text = "finding north — hold the phone up and look around"
    view.addSubview(hint)

    closeButton.setTitle("✕", for: .normal)
    closeButton.titleLabel?.font = UIFont.systemFont(ofSize: 22, weight: .medium)
    closeButton.setTitleColor(paper, for: .normal)
    closeButton.backgroundColor = ink.withAlphaComponent(0.6)
    closeButton.layer.cornerRadius = 20
    closeButton.addTarget(self, action: #selector(closePressed), for: .touchUpInside)
    view.addSubview(closeButton)
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    let safe = view.safeAreaInsets
    closeButton.frame = CGRect(x: 16, y: safe.top + 8, width: 40, height: 40)
    hint.frame = CGRect(x: 24, y: view.bounds.height - safe.bottom - 54, width: view.bounds.width - 48, height: 40)
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    let config = ARWorldTrackingConfiguration()
    // gravityAndHeading: -Z points true north, +X east, +Y up — sun math
    // drops straight in. Needs location permission for the compass.
    config.worldAlignment = .gravityAndHeading
    arView.session.delegate = self
    arView.session.run(config)
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    arView.session.pause()
  }

  func session(_ session: ARSession, didUpdate frame: ARFrame) {
    guard !built, case .normal = frame.camera.trackingState else { return }
    built = true
    DispatchQueue.main.async { [weak self] in
      self?.buildScene()
      self?.hint.text = "the arc is today's real sun path · ◉ marks now"
    }
  }

  // azimuth measured from north, altitude up; radius in metres from the phone
  private func direction(azDeg: Double, altDeg: Double) -> SCNVector3 {
    let az = azDeg * .pi / 180
    let alt = altDeg * .pi / 180
    return SCNVector3(
      Float(sin(az) * cos(alt)),
      Float(sin(alt)),
      Float(-cos(az) * cos(alt))
    )
  }

  private func buildScene() {
    let root = arView.scene.rootNode
    let radius: Float = 9

    let points = (payload["points"] as? [[String: Any]]) ?? []
    for p in points {
      guard let az = p["az"] as? Double, let alt = p["alt"] as? Double, alt > -2 else { continue }
      let golden = (p["golden"] as? Bool) ?? (alt <= 8 && alt > -1)
      let sphere = SCNSphere(radius: golden ? 0.09 : 0.06)
      sphere.firstMaterial?.diffuse.contents = golden ? gold : ochre
      sphere.firstMaterial?.emission.contents = golden ? gold : ochre.withAlphaComponent(0.6)
      sphere.firstMaterial?.lightingModel = .constant
      let node = SCNNode(geometry: sphere)
      let d = direction(azDeg: az, altDeg: alt)
      node.position = SCNVector3(d.x * radius, d.y * radius, d.z * radius)
      root.addChildNode(node)
      if let label = p["label"] as? String, !label.isEmpty {
        node.addChildNode(makeLabel(label))
      }
    }

    if let now = payload["now"] as? [String: Any],
       let az = now["az"] as? Double, let alt = now["alt"] as? Double, alt > -6 {
      let sun = SCNSphere(radius: 0.32)
      sun.firstMaterial?.diffuse.contents = gold
      sun.firstMaterial?.emission.contents = gold
      sun.firstMaterial?.lightingModel = .constant
      let node = SCNNode(geometry: sun)
      let d = direction(azDeg: az, altDeg: alt)
      node.position = SCNVector3(d.x * radius, d.y * radius, d.z * radius)
      node.addChildNode(makeLabel("now"))
      // a slow breathing pulse so "now" reads at a glance
      let up = SCNAction.scale(to: 1.25, duration: 0.9)
      up.timingMode = .easeInEaseOut
      let down = SCNAction.scale(to: 1.0, duration: 0.9)
      down.timingMode = .easeInEaseOut
      node.runAction(.repeatForever(.sequence([up, down])))
      root.addChildNode(node)
    }

    // horizon ring with N/E/S/W so orientation is legible
    for deg in stride(from: 0, to: 360, by: 5) {
      let dot = SCNSphere(radius: 0.03)
      dot.firstMaterial?.diffuse.contents = paper.withAlphaComponent(0.5)
      dot.firstMaterial?.lightingModel = .constant
      let node = SCNNode(geometry: dot)
      let d = direction(azDeg: Double(deg), altDeg: 0)
      node.position = SCNVector3(d.x * radius, 0, d.z * radius)
      root.addChildNode(node)
    }
    for (label, az) in [("N", 0.0), ("E", 90.0), ("S", 180.0), ("W", 270.0)] {
      let d = direction(azDeg: az, altDeg: 1.5)
      let node = SCNNode()
      node.position = SCNVector3(d.x * radius, d.y * radius, d.z * radius)
      node.addChildNode(makeLabel(label, big: true))
      root.addChildNode(node)
    }
  }

  private func makeLabel(_ text: String, big: Bool = false) -> SCNNode {
    let scn = SCNText(string: text, extrusionDepth: 0.2)
    scn.font = UIFont.monospacedSystemFont(ofSize: big ? 9 : 5, weight: .semibold)
    scn.flatness = 0.3
    scn.firstMaterial?.diffuse.contents = big ? paper : paper.withAlphaComponent(0.95)
    scn.firstMaterial?.lightingModel = .constant
    let node = SCNNode(geometry: scn)
    node.scale = SCNVector3(0.045, 0.045, 0.045)
    // centre the text on its anchor, then billboard it to the camera
    let (minB, maxB) = scn.boundingBox
    node.pivot = SCNMatrix4MakeTranslation((maxB.x - minB.x) / 2, -0.6, 0)
    let billboard = SCNBillboardConstraint()
    billboard.freeAxes = .Y
    node.constraints = [billboard]
    node.position = SCNVector3(0, 0.35, 0)
    return node
  }

  @objc private func closePressed() {
    arView.session.pause()
    dismiss(animated: true) { self.completion?() }
  }
}
