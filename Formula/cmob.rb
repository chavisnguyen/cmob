class Cmob < Formula
  desc "Watch and control your cmux terminals and coding agents from a phone"
  homepage "https://github.com/chavisnguyen/cmob"
  version "0.2.2"
  license "MIT"

  # This file is generated from packaging/homebrew/cmob.rb.template by the
  # "bump-formula" job of .github/workflows/release.yml on every published Release.
  # Do not edit it by hand.
  livecheck do
    url :homepage
    strategy :github_latest
  end

  on_macos do
    on_arm do
      url "https://github.com/chavisnguyen/cmob/releases/download/v0.2.2/cmob-macos-arm64"
      sha256 "80774ea4468bfaa9ae43d66a817ad8630a1784db62e4caf4ca65a49798587775"
    end
    on_intel do
      url "https://github.com/chavisnguyen/cmob/releases/download/v0.2.2/cmob-macos-x64"
      sha256 "0904c819e3341ddcd823381620f1d85342c64679332c08decf7af412ea59ebbc"
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
