class Cmob < Formula
  desc "Watch and control your cmux terminals and coding agents from a phone"
  homepage "https://github.com/chavisnguyen/cmob"
  version "0.2.8"
  license "MIT"

  # This file is generated from packaging/homebrew/cmob.rb.template by the
  # "bump-tap" job of .github/workflows/release.yml on every published Release.
  # Do not edit it by hand.
  livecheck do
    url :homepage
    strategy :github_latest
  end

  on_macos do
    on_arm do
      url "https://github.com/chavisnguyen/cmob/releases/download/v0.2.8/cmob-macos-arm64"
      sha256 "af6ce36ef7126d2b43a04da266f1bd70903b0f73f9771701906e97e20a1713e1"
    end
    on_intel do
      url "https://github.com/chavisnguyen/cmob/releases/download/v0.2.8/cmob-macos-x64"
      sha256 "126def53f21a048f5a1ce5eb76ce2c9becbb4b6d64c005f7e50138c883d4be8a"
    end
  end

  def install
    asset = Hardware::CPU.arm? ? "cmob-macos-arm64" : "cmob-macos-x64"
    bin.install asset => "cmob"
  end

  def caveats
    <<~EOS
      Next steps, in a terminal inside cmux:
        cmob setup            # one time: token, autostart, gateway
        cmob qr --tailscale   # pair your phone
      Needs the cmux app and Tailscale. Run `cmob status` if anything looks off.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/cmob --version")
  end
end
