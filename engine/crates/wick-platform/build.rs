fn main() {
    println!("cargo:rerun-if-changed=native/macos.m");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    cc::Build::new()
        .file("native/macos.m")
        .flag("-fobjc-arc")
        .flag("-mmacosx-version-min=14.0")
        .flag("-Wno-unused-parameter")
        .compile("wick_macos");
    for framework in [
        "AppKit",
        "ApplicationServices",
        "CoreFoundation",
        "CoreGraphics",
        "CoreMedia",
        "CoreVideo",
        "Foundation",
        "ScreenCaptureKit",
    ] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
}
