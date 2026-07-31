Pod::Spec.new do |s|
  s.name           = 'ScrimMeter'
  s.version        = '0.1.0'
  s.summary        = 'Light meter for Scrim'
  s.description    = 'Reads the camera\'s live auto-exposure (ISO, shutter, aperture) for EV metering.'
  s.author         = 'Scrim'
  s.homepage       = 'https://github.com/akehar/SCRIM'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/akehar/SCRIM.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
