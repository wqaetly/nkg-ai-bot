fn main() {
    println!("cargo:rerun-if-env-changed=ZVEC_LIB_DIR");
    let library_dir = std::env::var("DEP_ZVEC_RUST_LIB_DIR")
        .expect("Prepare the pinned zvec SDK with scripts/cargo.mjs or scripts/tauri.mjs");
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap();
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    let profile = out.ancestors().nth(3).unwrap();
    if target_os == "windows" {
        let source = std::path::Path::new(&library_dir).join("zvec_c_api.dll");
        std::fs::copy(&source, profile.join("zvec_c_api.dll")).unwrap();
        std::fs::create_dir_all(profile.join("deps")).unwrap();
        std::fs::copy(&source, profile.join("deps/zvec_c_api.dll")).unwrap();
    } else if target_os == "linux" {
        println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN");
        println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../lib/nkg-ai-bot");
        println!("cargo:rustc-link-arg=-Wl,-rpath,{library_dir}");
    } else if target_os == "macos" {
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
        println!("cargo:rustc-link-arg=-Wl,-rpath,{library_dir}");
    } else if target_os == "ios" {
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/Frameworks");
    }
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build()
}
