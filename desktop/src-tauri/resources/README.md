# Bundled runtime resources

This directory is populated by the build, not by hand:

```sh
python scripts/build_desktop_runtime.py build
```

That writes `runtime.json` (the manifest the Rust shell reads) and
`runtime/python/` (a relocatable python-build-standalone tree with AgentOS and
its dependencies already unpacked into `site-packages`). Both are gitignored —
the tree is hundreds of megabytes and is rebuilt per platform per release.

This README is committed so `bundle.resources` in `tauri.conf.json` always has
something to match. A resource glob that matches nothing fails the Tauri build
script, which would otherwise make `cargo check` and `cargo test` depend on
having built a full runtime first.

To run `cargo tauri dev` against a runtime built somewhere else, point
`AGENTOS_DESKTOP_RUNTIME` at the directory holding `runtime.json` instead of
copying it here.
