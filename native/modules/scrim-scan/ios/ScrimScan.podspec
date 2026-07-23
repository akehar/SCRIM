Pod::Spec.new do |s|
  s.name           = 'ScrimScan'
  s.version        = '0.1.0'
  s.summary        = 'In-app LiDAR room scanning for Scrim'
  s.description    = 'Walk the space with ARKit scene depth and get a colored point-splat (.splat) with no cloud step.'
  s.author         = 'Scrim'
  s.homepage       = 'https://github.com/akehar/SCRIM'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/akehar/SCRIM.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'ARKit', 'SceneKit'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
