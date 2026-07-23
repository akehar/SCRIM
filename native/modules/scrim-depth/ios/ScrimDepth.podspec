Pod::Spec.new do |s|
  s.name           = 'ScrimDepth'
  s.version        = '0.1.0'
  s.summary        = 'LiDAR depth capture for Scrim'
  s.description    = 'One-shot ARKit scene-depth capture: photo plus ground-truth depth map.'
  s.author         = 'Scrim'
  s.homepage       = 'https://github.com/akehar/SCRIM'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/akehar/SCRIM.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'ARKit'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
