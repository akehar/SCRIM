Pod::Spec.new do |s|
  s.name           = 'ScrimArSun'
  s.version        = '0.1.0'
  s.summary        = 'AR sun path for Scrim'
  s.description    = 'The day\'s sun arc drawn through the real location, anchored in space with ARKit.'
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
