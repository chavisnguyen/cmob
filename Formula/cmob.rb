class Cmob < Formula
  desc "Watch and control your cmux terminals and coding agents from a phone"
  homepage "https://github.com/chavisnguyen/cmob"
  version "0.2.6"
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
      url "https://github.com/chavisnguyen/cmob/releases/download/v0.2.6/cmob-macos-arm64"
      sha256 "79df06146b6360848d871794b5e5d4ddb2fe90fc5e07995ac0e5680a2def84aa"
    end
    on_intel do
      url "https://github.com/chavisnguyen/cmob/releases/download/v0.2.6/cmob-macos-x64"
      sha256 "f0be98e3a2dfd5b04931fc4bda033604983bfc99bf3881d6e6e92f79e9d8c27f"
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
