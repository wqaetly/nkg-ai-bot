const COMMANDS: &[&str] = &["products", "purchase", "unfinished", "finish"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .ios_path("ios")
        .build();
}
