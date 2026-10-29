# Licenses and credits

## Branch

Branch is made by Drifted and its source code is released under the MIT license. the full text is in the LICENSE file in the source code.

the MIT license only covers Branch's own code and design. it does **not** cover:

- the mods listed in Branch. each mod has its own license, shown on its page.
- Gorilla Tag or any of its art, names or files. those belong to Another Axiom.

## software Branch is built with

the desktop app is built with these open source projects. their licenses still apply to them:

- **Tauri** (MIT or Apache-2.0) and its plugins `tauri-plugin-dialog` and `tauri-plugin-opener` (MIT or Apache-2.0)
- **reqwest**, **tokio**, **serde**, **serde_json**, **futures-util**, **sha2**, **hex**, **url** (MIT or Apache-2.0)
- **window-vibrancy** (MIT or Apache-2.0)
- **Microsoft Edge WebView2** runtime, which Windows provides to show the app's interface (Microsoft's license)

the Branch server uses axum, tokio, sqlx, object_store, image, argon2, tower-http and other Rust crates, mostly under MIT or Apache-2.0. the exact list of every package and version is in each project's Cargo.lock in the source code.

the app uses the fonts that already come with Windows (Segoe UI). no fonts are bundled.

## the Branch icon

the Branch name and leaf-branch icon were made for this project.
