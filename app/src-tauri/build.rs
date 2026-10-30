fn main() {
    println!("cargo:rerun-if-env-changed=BRANCH_API_URL");
    tauri_build::build()
}
