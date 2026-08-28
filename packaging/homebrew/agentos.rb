# frozen_string_literal: true

# Source of truth for the AgentOS desktop cask.
#
# The double-underscored upper-case tokens below are placeholders.
# `scripts/render_homebrew_cask.py` fills them from the release tag and the
# built `.dmg` files, and the `homebrew` job in
# `.github/workflows/desktop-release.yml` pushes the result to the
# use-agent-os/homebrew-agentos tap. Edit this template, never the copy in the
# tap: the next release overwrites it.
cask "agentos" do
  arch arm: "aarch64", intel: "x64"

  version "__VERSION__"
  sha256 arm:   "__SHA256_ARM__",
         intel: "__SHA256_INTEL__"

  # The tag is substituted rather than derived from `version`, because a
  # post-release tag (`v2026.8.24.post1`) and the version Tauri writes into the
  # filename (`2026.8.24+post1`) do not spell the same release the same way.
  url "https://github.com/use-agent-os/agent-os/releases/download/__TAG__/AgentOS_#{version}_#{arch}.dmg"
  name "AgentOS"
  desc "Local-first agent runtime with a native console"
  homepage "https://github.com/use-agent-os/agent-os"

  # tauri.conf.json pins bundle.macOS.minimumSystemVersion to 11.0. A bare
  # symbol is already a floor -- Cask::DSL::DependsOn#macos= parses it with a
  # ">=" comparator -- and `brew style` rejects spelling it out.
  depends_on macos: :big_sur

  app "AgentOS.app"

  # AgentOS releases are ad-hoc signed but not notarized, so Gatekeeper refuses
  # the quarantined copy Homebrew stages -- the app installs and then will not
  # open. `brew install --cask --no-quarantine` used to be the way around it,
  # but Homebrew deprecated that flag in 4.6.19 and removed it outright in
  # 6.0.14, so clearing the attribute here is what is left.
  #
  # This is a real reduction in what macOS checks for you, which is why it is
  # announced rather than done quietly. It is defensible only because the
  # download is a checksummed asset from the project's own release over HTTPS:
  # `sha256` above is what actually vouches for these bytes.
  postflight do
    ohai "Clearing the quarantine flag on AgentOS.app (releases are not notarized)"
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/AgentOS.app"],
                   sudo: false
  end

  uninstall quit: "com.useagentos.desktop"

  # `~/.agentos` is deliberately absent. It is the shared AgentOS home -- the
  # CLI's config, sessions, agents, skills, and channels live there too -- so
  # zapping the desktop app must not take it.
  zap trash: [
    "~/Library/Application Support/com.useagentos.desktop",
    "~/Library/Caches/com.useagentos.desktop",
    "~/Library/HTTPStorages/com.useagentos.desktop",
    "~/Library/Preferences/com.useagentos.desktop.plist",
    "~/Library/Saved Application State/com.useagentos.desktop.savedState",
    "~/Library/WebKit/com.useagentos.desktop",
  ]
end
