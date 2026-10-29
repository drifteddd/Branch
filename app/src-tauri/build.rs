fn main() {
    // rebuild when the api address changes, since it gets baked into the app
    println!("cargo:rerun-if-env-changed=BRANCH_API_URL");
    tauri_build::build()
}
