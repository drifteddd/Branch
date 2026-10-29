// hides the extra console window on windows in release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    branch_lib::run()
}
